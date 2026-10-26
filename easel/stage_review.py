"""Version-bound reviewer recommendations, never proof of semantic quality."""
import json
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from easel.artifacts import file_path
from easel.task_rules import check_goal
from easel.task_graph import parallel, ancestors


class ReviewDecision(BaseModel):
    model_config = {'extra': 'forbid', 'strict': True, 'str_strip_whitespace': True}
    contract: dict
    decision: Literal['pass', 'revise', 'blocked']
    summary: str = Field(min_length=3, max_length=1600)
    targetStageId: str | None
    findings: list[str] = Field(max_length=8)


def review_contract(goal, run):
    upstream = []
    targets = []
    required = ancestors(goal, run['stageId']) if parallel(goal) else None
    for stage in goal['stages']:
        if required is None and stage['id'] == run['stageId']:
            break
        if required is not None and stage['id'] not in required:
            continue
        if stage['status'] != 'completed':
            raise ValueError('审查前的协作阶段尚未完成。')
        upstream.append({'stageId': stage['id'], 'turnId': stage['turnId'],
                         'checks': [{k: c.get(k, '') for k in ('type', 'label', 'value', 'evidence')}
                                    for c in stage['checks']]})
        if not stage.get('planGate'):
            targets.append(stage['id'])
    return {'schemaVersion': 1, 'goalId': goal['id'], 'revision': run['revision'], 'turnId': run['turnId'],
            'inputs': upstream, 'allowedTargets': targets}


def review_prompt(stage, run):
    if not stage.get('reviewGate'):
        return ''
    example = {'contract': run.get('reviewContract'), 'decision': '<pass|revise|blocked>',
               'summary': '实际审查结论与局限', 'targetStageId': None, 'findings': []}
    return ('\n本阶段必须在指定review.json写入单个JSON对象，不能用普通Markdown代替。'
            '先实际读取并检查上游产物；contract原样保留。decision只选pass、revise、blocked之一。'
            'pass表示模型建议通过，不能代替用户质量验收；pass的findings必须为空且targetStageId为null。'
            '有具体可修复问题时选revise，findings列出1至8条具体问题，targetStageId选contract.allowedTargets中的上游起点。'
            '材料/权限/可验证性不足时选blocked，列出具体缺口且targetStageId为null，不猜测通过。'
            '每条问题3至1200字符，summary为3至1600字符。最多自动返工一次，预算不重置。'
            '\nJSON形状（替换结论字段，保留contract）：\n' + json.dumps(example, ensure_ascii=False))


def _unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('审查JSON字段重复，请检查后继续。')
        result[key] = value
    return result


def read_review(outputs, goal, run, stage, checks):
    """Read and recheck against the runner's frozen contract and handoff hashes."""
    contract = run.get('reviewContract')
    if not contract or contract != review_contract(goal, run):
        raise ValueError('审查输入版本不完整或已变化，未进入交付。')
    path, _ = file_path(outputs, stage['criteria'][0]['value'])
    with path.open('rb') as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('审查JSON超过64KiB，请精简后继续。')
    try:
        payload = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=_unique_fields)
        review = ReviewDecision.model_validate(payload).model_dump()
    except (UnicodeError, json.JSONDecodeError, ValidationError):
        raise ValueError('审查JSON缺失必要字段或格式不完整，请检查后继续。') from None
    # Canonical comparison also distinguishes JSON booleans, numbers and strings.
    if json.dumps(review['contract'], sort_keys=True) != json.dumps(contract, sort_keys=True):
        raise ValueError('审查引用不属于当前轮次和产物版本，未进入交付。')
    if any(not 3 <= len(item.strip()) <= 1200 for item in review['findings']):
        raise ValueError('审查问题需为3至1200字符的具体说明。')
    if review['decision'] == 'pass':
        valid = not review['findings'] and review['targetStageId'] is None
    elif review['decision'] == 'revise':
        valid = bool(review['findings']) and review['targetStageId'] in contract['allowedTargets']
    else:
        valid = bool(review['findings']) and review['targetStageId'] is None
    if not valid:
        raise ValueError('审查结论、具体问题与返工起点不一致，未进入交付。')
    from easel.task_stages import validate_handoffs
    validate_handoffs(outputs, goal)
    current, _ = check_goal(outputs, stage, '')
    if any(c['state'] != 'passed' for c in current) or [c.get('evidence') for c in current] != [c.get('evidence') for c in checks]:
        raise ValueError('审查文件在核验期间已变化，请重新检查。')
    return review
