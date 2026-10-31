"""Rejoin the exact live native turn; snapshot facts never replay tool effects."""
from __future__ import annotations

import copy
import hashlib
import json
import queue
import threading
import time

from .codex_client import CodexError
from .codex_recovery import read_turn, project
from . import codex_settlement


def background_tasks(client, state):
    cursor, seen, rows = None, set(), []
    for _ in range(20):
        batch = client.rpc('thread/backgroundTerminals/list', {'threadId': state['threadId'], 'limit': 50,
            **({'cursor': cursor} if cursor else {})}, timeout=10)
        data = batch.get('data')
        if not isinstance(data, list) or any(not isinstance(row, dict)
                or not isinstance(row.get('itemId'), str) or not isinstance(row.get('processId'), str) for row in data):
            raise CodexError('原线程后台任务无法核对，未确认资源释放。')
        rows.extend(data)
        cursor = batch.get('nextCursor')
        if not cursor:
            return rows
        if not isinstance(cursor, str) or cursor in seen:
            break
        seen.add(cursor)
    raise CodexError('原线程后台任务分页不完整，未确认资源释放。')


def stop_backgrounds(client, state):
    native = read_turn(client, state, allow_active=True)
    owned = {item['id'] for item in native['items']}
    for row in background_tasks(client, state):
        if row['itemId'] in owned:
            client.rpc('thread/backgroundTerminals/terminate', {
                'threadId': state['threadId'], 'processId': row['processId']}, timeout=10)


def stop_orphan(service, sid, tid):
    """Control a stranded original turn without replaying its pending tools."""
    if not tid:
        return {'stopped': False}
    client, confirmed = None, False
    try:
        with service._owner(sid):
            state = service.snapshot(sid, tid)
            if not state.get('nativeRuntime'):
                return {'stopped': False}
            client = (service.native_runtime.connect_original(state)
                      if service.native_runtime else service.factory(service.root))
            if getattr(client, 'runtime_instance', None) != state['nativeRuntime']:
                raise CodexError('原执行器身份变化，停止请求未发送。')
            native = read_turn(client, state, allow_active=True)
            if native['status'] == 'inProgress':
                client.rpc('turn/interrupt', {'threadId': state['threadId'], 'turnId': state['codexTurnId']})
            stop_backgrounds(client, state)
            deadline = time.monotonic() + 10
            while native['status'] == 'inProgress' and time.monotonic() < deadline:
                native = read_turn(client, state, allow_active=True)
                if native['status'] == 'inProgress':
                    time.sleep(.1)
            confirmed = native['status'] in ('interrupted', 'completed', 'failed')
    finally:
        if client:
            client.close()
    if confirmed:
        service.reconcile(sid, tid)
    return {'stopped': confirmed}


def begin_request(service, run, event):
    """Persist receipt before sending it; never retry an ambiguous side effect."""
    state = run['state']
    signature = hashlib.sha256(json.dumps({'method': event['method'], 'params': event.get('params')},
        sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    ident = str(event['id'])
    with service.lock:
        journal = state.setdefault('nativeRequests', {})
        previous = journal.get(ident)
        if previous:
            if previous.get('signature') != signature:
                raise CodexError('原生工具请求身份变化，未执行或回复。')
            if previous.get('status') == 'replied':
                if previous.get('replayable') is not True:
                    raise CodexError('工具回执包含未保留的内容，未用不完整回执继续执行。')
                run['client'].reply(event['id'], previous['result'])
                return True
            if previous.get('status') == 'started':
                raise CodexError('工具前次执行结果尚未确认，未重复执行；原轮次仍可停止。')
        service._require_session(state['sessionId'])
        journal[ident] = {'signature': signature,
            'status': 'started' if event['method'] == 'item/tool/call' else 'awaiting'}
        service._persist(state)
    return False


def reply(service, run, ident, result):
    with service.lock:
        record = run['state'].get('nativeRequests', {}).get(str(ident))
        if record is not None:
            from .codex_service import safe
            retained = safe(result)
            record.update(status='replied', result=retained, replayable=retained == result)
            service._persist(run['state'])
    run['client'].reply(ident, result)


def _project_live(service, state, turn):
    from .codex_service import safe
    # The history is read as data. Do not call _consume on old commands,
    # dynamic calls or EASEL_PRESENT markers to rebuild the screen.
    previous = {item['id']: item for item in state.get('items', [])}
    state['items'] = [{**previous.get(item['id'], {}), **safe(item)} for item in turn['items']]
    state['text'] = '\n\n'.join(item.get('text', '') for item in state['items']
        if item['type'] == 'agentMessage' and item.get('phase') != 'commentary')
    summaries = [text for item in state['items'] if item['type'] == 'reasoning' for text in item.get('summary', [])]
    if summaries:
        state.update(thinking='\n\n'.join(summaries), thinkingStatus='available')
    state.update(status='running', outcome='running')
    state.pop('error', None)
    started = turn.get('startedAt')
    if type(started) is int and started >= 0:
        state['startedAt'] = started * 1000
        state['elapsedMs'] = max(0, int(time.time() * 1000) - state['startedAt'])


def attach(service, original, client, owner):
    sid, tid = original['sessionId'], original['turn_id']
    service._require_session(sid)
    if not original.get('nativeRuntime') or getattr(client, 'runtime_instance', None) != original['nativeRuntime']:
        raise CodexError('原轮次独立执行器身份不匹配，未接回活跃运行。')
    loaded = client.rpc('thread/loaded/list', {}, timeout=15).get('data')
    if not isinstance(loaded, list) or original['threadId'] not in loaded:
        raise CodexError('原线程不在原执行器活跃列表，未重新启动。')
    # Native resume may replay pending requests BEFORE returning its response.
    events = client.subscribe(original['threadId'])
    response = client.rpc('thread/resume', {'threadId': original['threadId'], 'excludeTurns': True}, timeout=20)
    thread = response.get('thread') or {}
    from pathlib import Path
    if thread.get('id') != original['threadId'] or Path(thread.get('cwd', '')).resolve() != Path(original['workspace']).resolve():
        raise CodexError('接回原线程时身份或目录变化，未采用结果。')
    current = read_turn(client, original, allow_active=True)
    state = copy.deepcopy(original)
    state['pending'] = []
    if current['status'] == 'inProgress':
        _project_live(service, state, current)
    state['recovery'] = {'source': 'codex-live-thread', 'status': 'observing', 'checkedAt': int(time.time() * 1000)}
    run = {'state': state, 'client': client, 'queue': events, 'requests': {},
        'browserJobs': set(), 'browserFinished': False, 'browserStop': threading.Event(),
        'finished': threading.Event(), 'controlLock': threading.Lock(), 'owner': owner, 'liveObservation': True}
    with service.lock:
        if sid in service.active:
            raise CodexError('原会话已被另一个观察者接回。')
        service.active[sid] = run
        try:
            service._persist(state)
            # Older error/done events stay in the durable prefix but cannot
            # terminate a newly attached SSE stream ahead of this snapshot.
            state['recoveryEventAfter'] = state['seq']
            service._event(state, 'text_snapshot', state['text'])
            service._execution_event(state)
            threading.Thread(target=_watch, args=(service, run, current), daemon=True,
                name='easel-codex-live').start()
        except Exception:
            service.active.pop(sid, None)
            raise
    return copy.deepcopy(state)


def _watch(service, run, current):
    from .codex_service import safe
    state, client = run['state'], run['client']
    sid, tid = state['sessionId'], state['turn_id']
    try:
        while True:
            if current['status'] != 'inProgress':
                recovered = copy.deepcopy(state)
                project(recovered, current, safe)
                recovered['recovery'] = {'source': 'codex-persisted-turn', 'status': 'adopted',
                    'checkedAt': int(time.time() * 1000)}
                with service.lock:
                    codex_settlement.prepare(service, state, recovered)
                    state = codex_settlement.finish(service, sid, tid)
                    run['state'] = state
                break
            if client._closed.is_set():
                raise CodexError('原运行观察连接中断，未重新派发。')
            try:
                service._require_session(sid)
            except Exception:
                # A deleted session must not gain new tool effects on rejoin.
                with run['controlLock']:
                    client.rpc('turn/interrupt', {'threadId': state['threadId'], 'turnId': state['codexTurnId']})
            for _ in range(128):
                try:
                    event = run['queue'].get_nowait()
                except queue.Empty:
                    break
                params = event.get('params') or {}
                if (params.get('threadId') != state['threadId']
                        or params.get('turnId') and params['turnId'] != state['codexTurnId']):
                    continue
                with service.lock:
                    if 'id' in event:
                        service._request(run, event)
                    elif event.get('method') in ('serverRequest/resolved', 'turn/plan/updated',
                                                'turn/diff/updated', 'thread/tokenUsage/updated'):
                        service._consume(run, event)
            current = read_turn(client, state, allow_active=True)
            if current['status'] == 'inProgress':
                with service.lock:
                    before = state['text'], copy.deepcopy(state['items'])
                    _project_live(service, state, current)
                    if before != (state['text'], state['items']):
                        service._event(state, 'text_snapshot', state['text'])
                        service._execution_event(state)
                    service._persist(state)
                run['finished'].wait(.5)
    except Exception as exc:
        with service.lock:
            state.update(status='done', outcome='unconfirmed', pending=[],
                error={'message': safe(str(exc))[:1500]})
            state['recovery'] = {'source': 'codex-live-thread', 'status': 'unconfirmed',
                'checkedAt': int(time.time() * 1000)}
            service._persist(state)
            service._event(state, 'error', state['error'])
    finally:
        try:
            try:
                service._cancel_browser_jobs(run)
                service._native_cleanup_receipt(run)
            finally:
                client.unsubscribe(state['threadId'])
                client.close()
                run['clientClosed'] = True
        finally:
            with service.lock:
                service._task_cleanup_receipt(run)
                if service.active.get(sid) is run:
                    service.active.pop(sid, None)
                run['finished'].set()
            run['owner'].__exit__(None, None, None)
