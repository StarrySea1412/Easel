"""Version-bound task decomposition; the runner, not the model, admits workers."""
from copy import deepcopy
import hashlib
import json
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from easel.agent_roles import get_role, list_roles, role_snapshot
from easel.artifacts import file_path
from easel.task_rules import Criterion, check_goal


IDENTIFIER = r'^[A-Za-z0-9_-]{1,40}$'
RESERVED = {'decompose', 'review', 'deliver'}
DEVICE_NAMES = {'con', 'prn', 'aux', 'nul'} | {f'{prefix}{i}' for prefix in ('com', 'lpt') for i in range(1, 10)}


class PlanGroup(BaseModel):
    model_config = {'extra': 'forbid', 'strict': True, 'str_strip_whitespace': True}
    id: str = Field(pattern=IDENTIFIER)
    title: str = Field(min_length=1, max_length=100)
    parentId: str | None


class PlanNode(BaseModel):
    model_config = {'extra': 'forbid', 'strict': True, 'str_strip_whitespace': True}
    id: str = Field(pattern=IDENTIFIER)
    title: str = Field(min_length=1, max_length=160)
    objective: str = Field(min_length=3, max_length=3000)
    roleId: str
    groupId: str | None
    dependsOn: list[str] = Field(max_length=6)
    access: Literal['read', 'write']
    criteria: list[Criterion] = Field(max_length=3)

    @model_validator(mode='after')
    def contract(self):
        if not get_role(self.roleId):
            raise ValueError('计划使用了未登记角色。')
        if any(c.type == 'review' for c in self.criteria):
            raise ValueError('计划节点不能代替最终人工质量验收。')
        if len(self.dependsOn) != len(set(self.dependsOn)):
            raise ValueError('任务依赖重复。')
        return self


class TaskPlan(BaseModel):
    model_config = {'extra': 'forbid', 'strict': True}
    contract: dict
    groups: list[PlanGroup] = Field(max_length=4)
    nodes: list[PlanNode] = Field(min_length=1, max_length=6)


def plan_contract(goal, run):
    digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {'schemaVersion': 1, 'goalId': goal['id'], 'revision': run['revision'], 'turnId': run['turnId'],
            'objectiveHash': digest(goal['objective']), 'criteriaHash': digest(goal['criteria']),
            'maxNodes': min(6, goal['maxIterations'] - run['iteration'] - 2), 'maxGroups': 4, 'maxDepth': 3,
            'maxParallel': 2, 'roles': [role['id'] for role in list_roles()],
            'limits': {key: goal[key] for key in ('maxIterations', 'maxSeconds', 'maxTools', 'maxImages')}}


def plan_prompt(run):
    if not run.get('planContract'):
        return ''
    example = {'contract': run['planContract'], 'groups': [{'id': 'work', 'title': '目标交付', 'parentId': None}],
               'nodes': [{'id': 'prepare', 'title': '准备目标产物', 'objective': '实际完成目标要求的产物并记录验证方式',
                          'roleId': 'builder', 'groupId': 'work', 'dependsOn': [], 'access': 'write', 'criteria': []}]}
    return ('\n本阶段只生成指定plan.json，不开始执行拆出的工作。输出单个JSON对象，contract原样保留。'
            '根据实际总目标拆为1至contract.maxNodes个任务；不要为了填满名额拆分。'
            '每项明确目标、登记角色、依赖、分组和read/write。read只读取共享材料并写自己的交接文件；'
            '需要修改共享产物时必须选write，运行器会排他调度；这不是操作系统权限隔离。'
            'groups最多4个、层级最多3层，parentId指向组；groupId可为null。'
            'dependsOn只能引用其他任务ID且不能成环；任务ID和组ID不能重复，禁用decompose/review/deliver。'
            'criteria写需要实际核验的附加文件/文字条件，文件路径须相对作品目录；可为空，运行器始终分配独立交接文件。'
            '只拆总目标授权的工作，不创建目标之外的任务、不增加预算、不调用派生或排期工具。'
            '独立结构化审查、整理交付和人工验收由运行器追加，不用写进nodes。'
            '\n计划格式示例（按实际目标替换groups和nodes）：\n' + json.dumps(example, ensure_ascii=False))


def _unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('计划JSON字段重复。')
        result[key] = value
    return result


def _ordered_nodes(plan, contract):
    groups = {group['id']: group for group in plan['groups']}
    nodes = {node['id']: node for node in plan['nodes']}
    all_ids = [item['id'].casefold() for item in plan['groups'] + plan['nodes']]
    if len(all_ids) != len(set(all_ids)) or (RESERVED | DEVICE_NAMES).intersection(all_ids):
        raise ValueError('计划任务/组ID重复或使用保留名称，请使用可跨平台保存的不同名称。')
    if len(nodes) > contract['maxNodes']:
        raise ValueError('剩余轮次不足以执行计划及最终审查/交付。')
    paths = {}
    for group in groups.values():
        path, seen, current = [], set(), group
        while current is not None:
            if current['id'] in seen:
                raise ValueError('计划分组包含循环。')
            seen.add(current['id']); path.insert(0, current['title'])
            if len(path) > contract['maxDepth']:
                raise ValueError('计划分组层级超出上限。')
            parent = current['parentId']
            if parent is not None and parent not in groups:
                raise ValueError('计划分组引用不存在的父组。')
            current = groups.get(parent)
        paths[group['id']] = path
    populated = set()
    for node in nodes.values():
        if node['groupId'] is not None and node['groupId'] not in groups:
            raise ValueError('计划任务引用不存在的分组。')
        group = groups.get(node['groupId'])
        while group:
            populated.add(group['id']); group = groups.get(group['parentId'])
        if any(key not in nodes or key == node['id'] for key in node['dependsOn']):
            raise ValueError('计划任务依赖不存在或引用自身。')
    if set(groups) != populated:
        raise ValueError('计划不能包含没有工作任务的空分组。')
    ordered, done = [], set()
    while len(done) < len(nodes):
        ready = [node for node in nodes.values() if node['id'] not in done and set(node['dependsOn']).issubset(done)]
        if not ready:
            raise ValueError('计划任务依赖包含循环。')
        ordered.extend(ready); done.update(node['id'] for node in ready)
    return ordered, paths


def read_plan(outputs, goal, run, stage, checks):
    contract = run.get('planContract')
    if not contract or contract != plan_contract(goal, run) or contract['maxNodes'] < 1:
        raise ValueError('计划不属于当前目标版本或轮次，未派发子任务。')
    path, _ = file_path(outputs, stage['criteria'][0]['value'])
    with path.open('rb') as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('计划JSON超过64KiB，请精简后重新规划。')
    try:
        plan = TaskPlan.model_validate(json.loads(raw.decode('utf-8-sig'), object_pairs_hook=_unique_fields), strict=True).model_dump()
    except (UnicodeError, ValueError):
        raise ValueError('计划JSON格式或任务字段不完整，未派发子任务。') from None
    if json.dumps(plan['contract'], sort_keys=True) != json.dumps(contract, sort_keys=True):
        raise ValueError('计划契约与当前轮次不一致，未派发子任务。')
    ordered, paths = _ordered_nodes(plan, contract)
    folder = f"workflows/{goal['id']}"
    stages = []
    for node in ordered:
        for criterion in node['criteria']:
            if criterion['type'] == 'file':
                _, normalized = file_path(outputs, criterion['value'])
                if normalized.replace('\\', '/').casefold().startswith(folder.casefold() + '/'):
                    raise ValueError('附加产物条件不能占用运行器分配的协作交接目录。')
        handoff = f"{folder}/nodes/{node['id']}.md"
        if any(c['type'] == 'file' and c['value'] == handoff for c in node['criteria']):
            raise ValueError('附加产物条件不能重复当前交接文件。')
        stages.append({**node, 'groupPath': paths.get(node['groupId'], []),
                       'dependsOn': ['decompose', *node['dependsOn']],
                       'criteria': [{'type': 'file', 'label': node['title'] + '交接文件', 'value': handoff}, *node['criteria']]})
    stages.extend([
        {'id': 'review', 'title': '审查结果', 'roleId': 'reviewer', 'access': 'read',
         'objective': '按总目标逐项检查所有工作分支的实际产物、交接及局限；计划覆盖不足时明确阻塞，不猜测通过。',
         'dependsOn': [node['id'] for node in ordered],
         'criteria': [{'type': 'file', 'label': '审查JSON', 'value': f'{folder}/review.json'}],
         'reviewGate': {'schemaVersion': 1, 'maxAutoReworks': 1}},
        {'id': 'deliver', 'title': '整理交付', 'roleId': 'publisher', 'access': 'write',
         'objective': '汇总总目标的实际产物、验证和未完成项，生成交付清单；不执行外部发布。',
         'dependsOn': ['review'], 'criteria': [{'type': 'file', 'label': '交付清单', 'value': f'{folder}/deliver.md'}]},
    ])
    # Recheck after parsing and path/graph validation, before transaction expansion.
    current, _ = check_goal(outputs, stage, '')
    if any(c['state'] != 'passed' for c in current) or [c.get('evidence') for c in current] != [c.get('evidence') for c in checks]:
        raise ValueError('计划文件在核验期间已变化，未派发子任务。')
    materialized = [{**s, 'status': 'pending', 'checks': [], 'role': role_snapshot(s['roleId']),
                     'attempts': goal.get('retiredStageAttempts', {}).get(s['id'], 0)} for s in stages]
    receipt = {'contract': deepcopy(contract), 'groups': plan['groups'], 'nodeIds': [node['id'] for node in ordered],
               'evidence': current[0].get('evidence'), 'sourceTurnId': run['turnId']}
    return materialized, receipt
