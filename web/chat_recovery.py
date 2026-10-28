"""Reconcile interrupted web supervisors without resending an agent request."""
from __future__ import annotations

import json
import re

SAFE_ID = re.compile(r'[A-Za-z0-9_.-]{1,160}\Z')


def _release_finished(web, store, session_id, turn_id, marker, ledger):
    # A lost HTTP connection, a terminal label alone, or an expired lease is
    # not proof that the producer stopped. Require exact durable settlement.
    if (not isinstance(marker, dict) or marker.get('turn_id') != turn_id
            or marker.get('status') != 'done' or not isinstance(ledger, dict)
            or ledger.get('sessionId') != session_id or ledger.get('turnId') != turn_id
            or ledger.get('status') not in ('completed', 'failed', 'stopped')
            or ledger.get('settled') is not True or ledger.get('resourceSettled') is not True):
        return False
    if any(job[0] == session_id for job in web._CHAT_JOBS.values()) or session_id in web._RUNNING_CHAT:
        return False
    store.release_chat(session_id, turn_id)
    return True


def release_finished_chat(web, store, session_id):
    """Repair an old terminal reservation without starting or aborting a run."""
    lock = web._CrossProcLock(session_id)
    try:
        if not lock.acquire(timeout=0):
            return False
        turn_id = store.chat_lease(session_id)
        if not turn_id:
            return False
        marker = json.loads(web._turn_file(f'web:{session_id}').read_text(encoding='utf-8'))
        ledger = web.run_ledger.read(web._run_ledger_root(), turn_id)
        return _release_finished(web, store, session_id, turn_id, marker, ledger)
    except (OSError, ValueError, TypeError):
        return False
    finally:
        lock.release()


def _legacy_run_id(web, turn_id):
    # Older markers omitted the accepted ID. Accept only the same unique ID
    # witnessed in the gateway stream; never abort an unscoped session.
    try:
        with web.SHARED_RAW_STREAM.open('rb') as stream:
            stream.seek(0, 2)
            start = max(0, stream.tell() - 16 * 1024 * 1024)
            stream.seek(start)
            if start:
                stream.readline()
            for line in stream:
                try:
                    event = json.loads(line)
                    if isinstance(event, dict) and event.get('runId') == turn_id:
                        return turn_id
                except (ValueError, UnicodeError):
                    continue
    except OSError:
        pass
    return None


def stop_orphan(web, session_id, turn_id):
    """An explicit stop may settle an exact old run after the web process died."""
    if not SAFE_ID.fullmatch(session_id) or not turn_id or not SAFE_ID.fullmatch(turn_id):
        return {'stopped': False, 'status': 'unavailable'}
    lock = web._CrossProcLock(session_id)
    client = None
    try:
        if not lock.acquire(timeout=0):
            return {'stopped': False, 'status': 'unconfirmed'}
        path = web._turn_file(f'web:{session_id}')
        marker = json.loads(path.read_text(encoding='utf-8'))
        if marker.get('turn_id') != turn_id:
            return {'stopped': False, 'status': 'superseded'}
        ledger = None
        try:
            ledger = web.run_ledger.read(web._run_ledger_root(), turn_id)
        except (AttributeError, OSError, TypeError):
            ledger = None
        if ledger and (ledger.get('sessionId') != session_id or ledger.get('turnId') != turn_id):
            return {'stopped': False, 'status': 'unavailable'}
        if marker.get('status') == 'done':
            from easel.task_store import TaskStore
            _release_finished(web, TaskStore(web.OUTPUTS_DIR), session_id, turn_id, marker, ledger)
            return {'stopped': True, 'status': 'already_finished'}
        if (isinstance(ledger, dict) and ledger.get('status') in ('completed', 'failed', 'stopped')
                and ledger.get('settled') is True and ledger.get('resourceSettled') is True):
            # The process may have died between ledger settlement and finishing
            # the replay. Repair only this same-turn marker, keeping its text.
            marker.update(status='done', error=ledger.get('error'),
                          stop_reason=ledger.get('stopReason'),
                          clean_end=ledger['status'] == 'completed' and marker.get('clean_end') is True)
            web._save_turn(f'web:{session_id}', 'done', marker.get('text', ''), marker)
            from easel.task_store import TaskStore
            _release_finished(web, TaskStore(web.OUTPUTS_DIR), session_id, turn_id, marker, ledger)
            return {'stopped': True, 'status': 'already_finished'}
        run_id = (marker.get('gateway_run_id') or
                  (ledger or {}).get('providerRunId') or
                  _legacy_run_id(web, turn_id))
        if not isinstance(run_id, str) or not SAFE_ID.fullmatch(run_id):
            return {'stopped': False, 'status': 'unavailable'}
        client = web._native_agent_client(web.gateway_credentials())
        if client is None:
            return {'stopped': False, 'status': 'unavailable'}
        receipt = client._rpc('chat.abort', {'sessionKey': f'agent:main:{session_id}',
                                           'runId': run_id, 'agentId': 'main'}, timeout=5)
        aborted = (isinstance(receipt, dict) and receipt.get('aborted') is True
                   and run_id in receipt.get('runIds', []))
        inactive = (isinstance(receipt, dict) and receipt.get('ok') is True
                    and receipt.get('aborted') is False and receipt.get('runIds') == [])
        if not aborted and not inactive:
            result = client._rpc('agent.wait', {'runId': run_id, 'timeoutMs': 1000}, timeout=5)
            if not (isinstance(result, dict) and result.get('runId') == run_id
                    and result.get('status') in ('ok', 'error')):
                return {'stopped': False, 'status': 'unconfirmed'}
        # Preserve all received text, including a replacement snapshot, before
        # making the old replay terminal. No completed answer is invented.
        events = web._read_job_events(turn_id)
        text, thinking = '', ''
        for event in events:
            value = event.get('data')
            if event.get('event') == 'text_snapshot' and isinstance(value, str):
                text = value
            elif event.get('event') == 'token' and isinstance(value, str):
                text += value
            elif event.get('event') == 'thinking' and isinstance(value, str):
                thinking += value
        error = {'code': 'chat_supervisor_lost', 'category': 'connection', 'retryable': True,
                 'message': '本轮连接因服务重启中断，后台已确认结束。已保留收到的内容；未自动重发，可手动继续。'}
        marker.update(status='done', text=text or marker.get('text', ''), thinking=thinking or marker.get('thinking', ''),
                      gateway_run_id=run_id, clean_end=False,
                      stop_reason='user_stopped' if aborted else 'supervisor_lost', error=None if aborted else error)
        if json.loads(path.read_text(encoding='utf-8')).get('turn_id') != turn_id:
            return {'stopped': False, 'status': 'superseded'}
        web._save_turn(f'web:{session_id}', 'done', marker['text'], marker)
        if isinstance(ledger, dict):
            web.run_ledger.mark(
                web._run_ledger_root(), turn_id, event='terminal',
                status='stopped' if aborted else 'failed', provider_run_id=run_id,
                stop_reason='user_stopped' if aborted else 'supervisor_lost',
                error=None if aborted else error, settled=True, resource_settled=True,
            )
        sequence = max((event.get('id', 0) for event in events), default=0)
        final = ([{'event': 'error', 'data': error}] if not aborted else [])
        final.append({'event': 'done', 'data': {'sessionKey': session_id, 'stopped': aborted}})
        with web._job_event_file(turn_id).open('a', encoding='utf-8') as stream:
            for offset, event in enumerate(final, 1):
                stream.write(json.dumps({'id': sequence + offset, **event}, ensure_ascii=False) + '\n')
        # The original supervisor's on_done callback died with its process.
        # Release only this confirmed run after its final state is durable.
        from easel.task_store import TaskStore
        TaskStore(web.OUTPUTS_DIR).release_chat(session_id, turn_id)
        return {'stopped': True, 'status': 'stopped' if aborted else 'already_finished'}
    except (OSError, ValueError, TypeError):
        return {'stopped': False, 'status': 'unavailable'}
    except Exception:
        # Gateway exceptions may contain credentials or unrelated diagnostics.
        return {'stopped': False, 'status': 'unconfirmed'}
    finally:
        if client is not None:
            client.close()
        lock.release()
