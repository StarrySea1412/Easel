"""Read-only office projection of durable Codex turns and Easel worker identities.

No native RPC, recovery, dispatch or controls. Scheduled workers are not native
subagents; completion of a native turn does not approve its stage or the goal.
"""
from datetime import datetime, timezone
import hashlib
import re
import sqlite3

from fastapi import HTTPException

import agent_office as office
from easel.execution import codex_rows, public_text
from easel.task_graph import parallel
from easel.task_store import TaskStore, TaskConflict
from model_identity import observation, unknown_model

MAX_MEMBERS = 32
MAX_EVENTS = 80
TEXT_LIMIT = 8000


def _binding(service, session):
    # Legacy OpenClaw session IDs also allow dots; native IDs do not.
    return service.binding(session) if re.fullmatch(r'[A-Za-z0-9_-]{1,120}', session) else None


def context(web, session):
    try:
        return TaskStore(web.OUTPUTS_DIR).office_context(session)
    except TaskConflict as exc:
        raise HTTPException(410, str(exc)) from None
    except (sqlite3.Error, OSError, ValueError):
        raise HTTPException(503, '任务成员记录暂不可读。') from None


def owns(web, session, task=None):
    if not office.SAFE_ID.fullmatch(session):
        raise HTTPException(400, '无效的会话标识')
    service = getattr(web, '_codex_service', None)
    if service is None:
        return False
    if (_binding(service, session) or {}).get('engine') == 'codex':
        return True
    task = task if task is not None else context(web, session)
    return (task.get('goal') or {}).get('engine') == 'codex'


def _state(service, session, turn=None, run=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', session):
        return None
    try:
        value = service.snapshot(session, turn)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        return None
    if value.get('status') == 'none':
        return None
    if run and (run.get('providerRunId') and value.get('codexTurnId') != run['providerRunId']
                or (value.get('taskGoal') or {}).get('id') != run['goalId']):
        return None
    return value


def _status(state):
    if not state or state.get('outcome') == 'unconfirmed':
        return 'unknown'
    if state.get('status') == 'running':
        return 'waiting' if state.get('pending') else 'thinking' if state.get('thinkingStatus') == 'waiting' and not state.get('items') else 'running'
    if state.get('status') != 'done':
        return 'unknown'
    return {'completed': 'completed', 'interrupted': 'stopped', 'failed': 'failed', 'rejected': 'failed'}.get(state.get('outcome'), 'unknown')


def _process(state):
    thinking, text = state.get('thinking', ''), state.get('text', '')
    thinking = thinking if isinstance(thinking, str) else ''
    text = text if isinstance(text, str) else ''
    return {'sessionId': state['sessionId'], 'turnId': state['turn_id'],
            'thinking': public_text(thinking, limit=TEXT_LIMIT), 'text': public_text(text, limit=TEXT_LIMIT),
            'thinkingStatus': state.get('thinkingStatus'), 'outcome': state.get('outcome'),
            'plan': [{'step': office._safe_text(row.get('step'), 300), 'status': row.get('status')}
                     for row in state.get('plan', [])[:32] if isinstance(row, dict)],
            'truncated': len(thinking) > TEXT_LIMIT or len(text) > TEXT_LIMIT}


def _member(service, session, *, run=None, goal=None, stage=None, parent=None):
    state = _state(service, session, run['turnId'] if run else None, run)
    turn = run['turnId'] if run else state.get('turn_id') if state else None
    historical = bool(run and run.get('stageId') and (stage or {}).get('turnId') != run['turnId'])
    if historical:
        stage = None
    agent = {'id': 'worker:' + session if parent else 'root:' + session, 'role': 'worker' if parent else 'root',
             'name': office._safe_text((stage or {}).get('title'), 80) or 'Codex',
             'task': office._safe_text((stage or {}).get('objective') or
                                      ((state or {}).get('requestSummary') if historical else (goal or {}).get('objective')) or
                                      (state or {}).get('requestSummary'), 500),
             'status': _status(state), 'engine': 'codex', 'observedModel': unknown_model(),
             'evidence': '原生执行状态；交接和质量验收以任务记录为准。'}
    if parent:
        agent['parentId'] = parent
    if turn:
        agent['execution'] = {'engine': 'codex', 'sessionId': session, 'turnId': turn}
    if run:
        role = (run.get('role') if historical else (stage or {}).get('role')) or {}
        agent['assignment'] = {'goalId': goal['id'], 'stageId': run.get('stageId'),
                               'role': office._safe_text(role.get('shortName') or run.get('roleId') or '执行', 80),
                               'handoff': 'historical' if historical else stage['status'] if stage else 'review' if goal['phase'] == 'review' else goal['status'],
                               'attempts': 0 if historical else (stage or {}).get('attempts', run.get('iteration', 1))}
    if state:
        agent['process'] = _process(state)
        stamp = state.get('usageAt') or state.get('startedAt') or (state.get('recovery') or {}).get('checkedAt')
        agent['observedModel'] = observation({'model': state.get('actualModel')}, stamp)
    return agent, state


def _events(agent, state, limit):
    if not state:
        return []
    rows = codex_rows(state)[-limit:]
    events = []
    for row in rows:
        name = row['name'] if re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', row['name']) else 'native_tool'
        ident = hashlib.sha256(f"{state['sessionId']}:{state['turn_id']}:{row['id']}".encode()).hexdigest()[:24]
        base = {'agentId': agent['id'], 'operationId': ident, 'toolName': name}
        if row.get('startedAt'):
            events.append({**base, 'id': ident + ':call', 'kind': 'call', 'status': 'called',
                           'title': '调用工具：' + name, 'at': row['startedAt']})
        # Completion-only records remain unpaired receipts; never invent a call.
        if row['status'] in ('completed', 'failed', 'denied', 'stopped'):
            events.append({**base, 'id': ident + ':result', 'kind': 'result',
                           'status': 'failed' if row['status'] in ('failed', 'denied') else 'returned',
                           'title': ('工具已停止：' if row['status'] == 'stopped' else '工具返回：') + name,
                           **({'at': row['finishedAt']} if row.get('finishedAt') else {})})
    return events


def snapshot(web, session):
    try:
        return _snapshot(web, session)
    except (OSError, ValueError, sqlite3.Error):
        raise HTTPException(503, '原生成员记录暂不可读。') from None


def _snapshot(web, session):
    if not office.SAFE_ID.fullmatch(session):
        raise HTTPException(400, '无效的会话标识')
    task = context(web, session)
    if not owns(web, session, task):
        return None
    service, goal = web._codex_service, task['goal']
    binding = _binding(service, session)
    if (goal and goal['sessionId'] == session and goal['status'] in ('completed', 'cancelled')
            and (binding or {}).get('lastTurnId')
            and not any(r['turnId'] == binding['lastTurnId'] and r['sessionId'] == session for r in task['runs'])):
        goal = None
    stages = {row['id']: row for row in (goal or {}).get('stages', [])}
    runs = [r for r in task['runs'] if r.get('stageId') in stages and stages[r['stageId']].get('turnId') == r['turnId']]
    workers = {}
    for run in runs:
        if run['sessionId'] != session:
            workers.setdefault(run['sessionId'], run)
    aggregate = goal and goal['sessionId'] == session and parallel(goal)
    truncated = task.get('truncated', False) or len(workers) >= MAX_MEMBERS
    if aggregate:
        root = {'id': 'root:' + session, 'role': 'root', 'engine': 'scheduler', 'name': 'Easel 调度',
                'task': office._safe_text(goal['objective'], 500),
                'status': 'completed' if goal['status'] == 'completed' else 'stopped' if goal['status'] in ('paused', 'cancelled') else 'waiting',
                'evidence': office._safe_text(goal.get('reason'), 500), 'observedModel': unknown_model()}
        agents, events, states = [root], [], []
        for sid, run in list(workers.items())[:MAX_MEMBERS - 1]:
            agent, state = _member(service, sid, run=run, goal=goal, stage=stages[run['stageId']], parent=root['id'])
            agents.append(agent); states.append((agent, state))
        turn = goal.get('currentTurnId')
    else:
        run = next((r for r in task['runs'] if r['sessionId'] == session), None) if goal else None
        if run and goal['sessionId'] == session and run['state'] not in ('queued', 'running', 'unconfirmed') and (binding or {}).get('lastTurnId') not in (None, run['turnId']):
            run, goal = None, None
        agent, state = _member(service, session, run=run, goal=goal, stage=stages.get((run or {}).get('stageId')))
        agents, states = [agent], [(agent, state)]
        turn = (agent.get('execution') or {}).get('turnId')
    events = [event for agent, state in reversed(states) for event in _events(agent, state, max(1, 40 // len(states)))]
    stage_agents = {(a.get('assignment') or {}).get('stageId'): a for a in agents if a.get('assignment')}
    links = [{'from': a['parentId'], 'to': a['id'], 'kind': 'assignment'} for a in agents if a.get('parentId')]
    for stage_id, agent in stage_agents.items():
        for dependency in stages.get(stage_id, {}).get('dependsOn', []):
            if dependency in stage_agents:
                links.append({'from': stage_agents[dependency]['id'], 'to': agent['id'], 'kind': 'dependency',
                              'delivered': stages[dependency]['status'] == 'completed'})
    # Do not merge a roster read before a replan, deletion, or worker switch.
    if task != context(web, session) or binding != _binding(service, session):
        value = office.updating_snapshot(session)
        value['source'] = 'codex'
        return value
    return {'sessionId': session, 'turnId': turn, 'source': 'codex',
            'observedAt': datetime.now(timezone.utc).isoformat(), 'agents': agents,
            'events': events[-MAX_EVENTS:], 'links': links,
            'coverage': {'observedAgentCount': len(agents), 'identityScanLimited': truncated,
                         'detail': 'Easel 调度的任务成员，状态来自各自原生轮次。' if aggregate else '当前 Codex 轮次的持久执行记录。'},
            'warnings': ['成员或工具记录已截取，完整轮次见运行记录。'] if truncated or any(len(codex_rows(s)) > max(1, 40 // len(states)) for _, s in states if s) else []}
