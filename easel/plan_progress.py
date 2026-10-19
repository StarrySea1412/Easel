"""Structured, bounded task plans. Tool receipts never imply task completion."""
import json
import os
from pathlib import Path
import shlex
import sys

from .execution import public_text

NATIVE = {'update_plan', 'todowrite', 'todo_write'}
COMMANDS = {'exec', 'exec_command', 'bash', 'shell', 'commandExecution'}
MARKER = 'EASEL_PLAN '


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
    quote = (lambda v: "'" + str(v).replace("'", "''") + "'") if os.name == 'nt' else shlex.quote
    command = ('& ' if os.name == 'nt' else '') + quote(sys.executable) + ' ' + quote(script)
    return ('\n\n〔任务规划与进度〕复杂、多步骤或长任务在开始执行前主动制定3至8项可验收checklist；'
            '简短问答不必建计划。优先调用已有update_plan/TodoWrite工具，状态仅pending/in_progress/completed，'
            '同时至多一项in_progress。没有规划工具时，用exec运行 '
            + command + ' --plan-file "实际UTF-8 JSON文件路径"；文件格式为 '
            '{"plan":[{"step":"具体步骤","status":"in_progress"},{"step":"核验结果","status":"pending"}]}。'
            '脚本输出结构化进度回执；不要只在回复中手写勾选。每次阶段变更提交完整清单。'
            '只有实际核验后才标completed；工具返回不等于任务完成，失败/待确认保留未完成步骤，'
            '不为更新清单触发额外模型、发布或越过授权。不向清单放凭据或私密正文。')
