"""Structured, bounded task plans. Tool receipts never imply task completion."""
import json
import os
from pathlib import Path
import shlex
import sys

from .execution import public_text

NATIVE = {'easel_plan_update', 'easel_goal_update', 'update_plan', 'todowrite', 'todo_write'}
COMMANDS = {'exec', 'exec_command', 'bash', 'shell', 'commandExecution'}
MARKER = 'EASEL_PLAN '


def _quote_argument(value, windows):
    if windows:
        return "'" + str(value).replace("'", "''") + "'"
    return shlex.quote(str(value))


def normalize(value, credentials=None):
    if not isinstance(value, dict):
        return None
    rows = value.get('plan', value.get('todos'))
    if not isinstance(rows, list) or not 1 <= len(rows) <= 32:
        return None
    result = []
    for row in rows:
        if not isinstance(row, dict):
            return None
        title = row.get('step', row.get('content', row.get('title')))
        raw_status = row.get('status')
        if not isinstance(raw_status, str):
            return None
        status = {'in_progress': 'inProgress'}.get(raw_status, raw_status)
        if not isinstance(title, str) or not title.strip() or len(title) > 500 or status not in {'pending', 'inProgress', 'completed', 'blocked', 'failed'}:
            return None
        result.append({'step': public_text(title.strip(), credentials, 500), 'status': status})
    if sum(row['status'] == 'inProgress' for row in result) > 1:
        return None
    return result


def receipt_plan(name, args, result, credentials=None):
    """Only explicit plan tools or an exact command-output marker are accepted."""
    if not isinstance(result, dict) or result.get('isError') is True:
        return None
    tool = name.split('.')[-1]
    if tool == 'easel_goal_update':
        steps = args.get('steps') if isinstance(args, dict) else None
        if not isinstance(steps, list) or any(not isinstance(row, dict) for row in steps):
            return None
        return normalize({'plan': [{'step': row.get('title'), 'status': row.get('status')}
                                   for row in steps]}, credentials)
    if tool.lower() in NATIVE:
        return normalize(args, credentials)
    if tool not in COMMANDS:
        return None
    content = result.get('content', result.get('output', ''))
    if isinstance(content, list):
        content = '\n'.join(item.get('text', '') for item in content if isinstance(item, dict) and item.get('type') == 'text')
    if not isinstance(content, str) or len(content) > 64000:
        return None
    found = None
    for line in content.splitlines():
        if not line.startswith(MARKER):
            continue
        try:
            plan = normalize(json.loads(line[len(MARKER):]), credentials)
        except (ValueError, TypeError):
            continue
        if plan is not None:
            found = plan
    return found


def instructions():
    script = Path(__file__).resolve().parents[1] / 'skills/shared/scripts/update_plan.py'
    windows = os.name == 'nt'
    command = ('& ' if windows else '') + _quote_argument(sys.executable, windows) + ' ' + _quote_argument(script, windows)
    return ('\n\n〔任务规划与进度〕复杂、多步骤或长任务在开始执行前主动制定3至8项可验收checklist；'
            '简短问答不必建计划。优先调用easel_plan_update（参数plan，步骤字段step/status），不可用时用已有update_plan/TodoWrite工具；状态pending/in_progress/completed/blocked/failed，'
            '同时至多一项in_progress。没有规划工具时，用exec运行 '
            + command + ' --plan-file "实际UTF-8 JSON文件路径"；文件格式为 '
            '{"plan":[{"step":"具体步骤","status":"in_progress"},{"step":"核验结果","status":"pending"}]}。'
            '脚本输出结构化进度回执；不要只在回复中手写勾选。每次阶段变更提交完整清单。'
            '只有实际核验后才标completed；工具返回不等于任务完成，失败/待确认保留未完成步骤，'
            '不为更新清单触发额外模型、发布或越过授权。不向清单放凭据或私密正文。'
            '本轮checklist与持续目标不同：只有已有正在执行的目标时，使用easel_goal_update更新steps（id/title/status/detail）；'
            '普通对话不要擅自创建或启动持续目标。')


def collaboration_instructions(runtime):
    """Use saved configuration as a ceiling, never enable delegation by prompt."""
    intro = ('\n\n〔可见工作说明与协作〕开始复杂任务时先用一两句说明将检查什么、要得到什么结果；'
             '工具操作前简要说明动作与用途，连续同类读取可合并说明。重要发现、失败或更换方法时更新简短进度；'
             '不要长时间只调用工具。说明可核实的工作计划、证据和结论，不输出或编造内部推理链。')
    if not runtime.get('ready') or runtime.get('maxSpawnDepth', 0) == 0:
        return intro + '当前配置未开放子Agent启动；由主Agent处理，遇到适合分工的任务说明当前限制，不绕过禁用或模型限制。' + ('持续目标使用easel_goal_update更新步骤。' if runtime.get('goalManaged') else '')
    return (intro + '当前配置允许子Agent；当复杂任务包含至少两个相互独立的资料核查、内容分析或校验子任务时，'
            '主动用sessions_spawn委派其中可独立完成的一项，同时主Agent推进其余工作，不必等用户点名。'
            '简短问答、单一步骤或强串行依赖不必委派，不为展示协作而凑任务。'
            f'本轮最多{runtime.get("maxChildrenPerAgent", 3)}个子Agent，并发上限{runtime.get("maxConcurrent", 4)}；'
            '沿用已配置的启动模型与时限，不指定其他模型；只传子任务必要材料，不共享凭据、其他账号或画像。'
            '子Agent只在原任务授权内工作；付费媒体、真实发布与其他需要用户确认的动作仍遵守原门禁。'
            '明确子任务目标与返回证据，按真实回执汇总核验，启动成功不等于任务完成。工具不可用或委派失败时说明原因并继续可独立推进的工作。')
