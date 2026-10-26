"""Reconcile interrupted web supervisors without resending an agent request."""
from __future__ import annotations

import json
import re

SAFE_ID = re.compile(r'[A-Za-z0-9_.-]{1,160}\Z')


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


def settle_resources(web, session_id, *, provider_settled):
    """Confirm chat producer/browser cleanup; image jobs settle separately."""
    browser_settled = False
    try:
        if web._browser_service.has_pages(session_id):
            web._browser_service.call('cancel_agents', session_id)
        browser_settled = True
    except Exception:
        # Failed cleanup is pending work, never proof of release.
        pass
    return {'provider': provider_settled is True, 'browser': browser_settled}


def _saved_content(web, turn_id, marker):
    events = web._read_job_events(turn_id)
    text, thinking = '', ''
    saw_text = saw_thinking = False
    for event in events:
        value = event.get('data')
        if event.get('event') == 'text_snapshot' and isinstance(value, str):
            text, saw_text = value, True
        elif event.get('event') == 'token' and isinstance(value, str):
            text += value
            saw_text = True
        elif event.get('event') == 'thinking' and isinstance(value, str):
            thinking += value
            saw_thinking = True
    return events, text if saw_text else marker.get('text', ''), thinking if saw_thinking else marker.get('thinking', '')


def _finish_replay(web, turn_id, events, session_id, aborted, error):
    if any(event.get('event') == 'done' for event in events):
        return
    sequence = max((event['id'] for event in events), default=0)
    final = []
    if error and not any(event.get('event') == 'error' for event in events):
        final.append({'event': 'error', 'data': error})
    final.append({'event': 'done', 'data': {'sessionKey': session_id, 'stopped': aborted}})
    path = web._job_event_file(turn_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Do not glue a recovered terminal onto a partial UTF-8/JSON tail.
    with path.open('a+b') as stream:
        stream.seek(0, 2)
        if stream.tell():
            stream.seek(-1, 2)
            if stream.read(1) != b'\n':
                stream.write(b'\n')
        for offset, event in enumerate(final, 1):
            stream.write((json.dumps({'id': sequence + offset, **event}, ensure_ascii=False) + '\n').encode('utf-8'))


def reconcile_orphan(web, session_id, turn_id, *, stop=False):
    """Reconcile an exact orphan. Passive checks never start or abort an agent."""
    result = lambda status, settled=False: {'stopped': settled, 'status': status}
    if not isinstance(session_id, str) or not SAFE_ID.fullmatch(session_id) or not isinstance(turn_id, str) or not SAFE_ID.fullmatch(turn_id):
        return result('unavailable')
    lock = web._CrossProcLock(session_id)
    client = None
    try:
        if not lock.acquire(timeout=0):
            return result('owned')
        ledger = web.run_ledger.read(web._run_ledger_root(), turn_id)
        if ledger and ledger.get('sessionId') != session_id:
            return result('unavailable')
        path = web._turn_file(f'web:{session_id}')
        try:
            marker = json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            if not ledger:
                return result('unavailable')
            marker = {'turn_id': turn_id, 'status': 'running'}
        if marker.get('turn_id') != turn_id:
            return result('superseded')
        prior = marker.get('recovery') or {}
        final = bool(ledger and ledger.get('settled') and ledger.get('resourceSettled')
                     and ledger.get('status') in web.run_ledger.TERMINAL_STATUSES)
        if ((final or prior.get('resourceSettled') is True) and marker.get('status') == 'done'
                and any(event.get('event') == 'done' for event in web._read_job_events(turn_id))):
            from easel.task_store import TaskStore
            TaskStore(web.OUTPUTS_DIR).release_chat(session_id, turn_id)
            return result('already_finished', True)
        provider_settled = final or (ledger or {}).get('resourceFacts', {}).get('provider') is True or prior.get('providerSettled') is True
        run_id = ((ledger or {}).get('providerRunId') or marker.get('gateway_run_id') or _legacy_run_id(web, turn_id))
        aborted = (ledger or {}).get('status') == 'stopped' or prior.get('aborted') is True
        if not provider_settled:
            if (ledger or {}).get('transport') not in (None, 'native'):
                return result('unavailable')
            if not isinstance(run_id, str) or not SAFE_ID.fullmatch(run_id):
                return result('unavailable')
            client = web._native_agent_client(web.gateway_credentials())
            if client is None:
                return result('unavailable')
            if stop:
                receipt = client._rpc('chat.abort', {'sessionKey': f'agent:main:{session_id}',
                    'runId': run_id, 'agentId': 'main'}, timeout=5)
                aborted = (isinstance(receipt, dict) and receipt.get('aborted') is True
                           and run_id in receipt.get('runIds', []))
                provider_settled = aborted or (isinstance(receipt, dict) and receipt.get('ok') is True
                    and receipt.get('aborted') is False and receipt.get('runIds') == [])
            if not provider_settled:
                receipt = client._rpc('agent.wait', {'runId': run_id, 'timeoutMs': 1000}, timeout=5)
                provider_settled = (isinstance(receipt, dict) and receipt.get('runId') == run_id
                                    and receipt.get('status') in ('ok', 'error'))
                if not provider_settled:
                    return result('active' if isinstance(receipt, dict) and receipt.get('runId') == run_id
                                  and receipt.get('status') == 'timeout' else 'unconfirmed')
        events, text, thinking = _saved_content(web, turn_id, marker)
        prior_terminal = bool(ledger and ledger.get('settled') and ledger.get('status') in web.run_ledger.TERMINAL_STATUSES)
        saved_reply = marker.get('status') == 'done' and marker.get('clean_end') is True
        error = (ledger or {}).get('error') if prior_terminal else marker.get('error') if saved_reply else None
        if not prior_terminal and not saved_reply and not aborted:
            error = {'code': 'chat_supervisor_lost', 'category': 'connection', 'retryable': True,
                     'message': '后台已确认结束，已保留收到的内容；本轮连接中断，未自动重发。'}
        status = ledger['status'] if prior_terminal else 'stopped' if aborted else 'completed' if saved_reply else 'failed'
        # Persist the exact provider receipt before browser cleanup. A retry can
        # finish failed cleanup without another abort, even after a web restart.
        marker.update(status='done', text=text, thinking=thinking, gateway_run_id=run_id,
                      clean_end=(status == 'completed' and marker.get('clean_end') is True),
                      stop_reason=(ledger or {}).get('stopReason') if prior_terminal else 'user_stopped' if aborted else 'supervisor_lost',
                      error=error, recovery={'providerSettled': True, 'resourceSettled': False, 'aborted': aborted})
        if path.is_file() and json.loads(path.read_text(encoding='utf-8')).get('turn_id') != turn_id:
            return result('superseded')
        if ledger:
            ledger = web.run_ledger.mark(web._run_ledger_root(), turn_id, event='provider_reconciled', status=status,
                expected_revision=ledger['eventSeq'], settled=True, resource_facts={'provider': True},
                stop_reason=marker['stop_reason'], error=error)
        web._save_turn(f'web:{session_id}', 'done', text, marker)
        facts = settle_resources(web, session_id, provider_settled=True)
        if not all(facts.values()):
            if ledger:
                web.run_ledger.mark(web._run_ledger_root(), turn_id, event='resources_pending', resource_facts=facts)
            return result('unconfirmed')
        _finish_replay(web, turn_id, events, session_id, aborted, error)
        marker['recovery']['resourceSettled'] = True
        web._save_turn(f'web:{session_id}', 'done', text, marker)
        if ledger:
            web.run_ledger.mark(web._run_ledger_root(), turn_id, event='resources_settled',
                settled=True, resource_settled=True, resource_facts=facts,
                last_event_id=max((e['id'] for e in web._read_job_events(turn_id)), default=0))
        from easel.task_store import TaskStore
        TaskStore(web.OUTPUTS_DIR).release_chat(session_id, turn_id)
        return result('stopped' if aborted and stop else 'already_finished', True)
    except (OSError, ValueError, TypeError):
        return result('unavailable')
    except Exception:
        # Provider exceptions may contain credentials or unrelated diagnostics.
        return result('unconfirmed')
    finally:
        try:
            if client is not None:
                client.close()
        finally:
            lock.release()


def stop_orphan(web, session_id, turn_id):
    return reconcile_orphan(web, session_id, turn_id, stop=True)
