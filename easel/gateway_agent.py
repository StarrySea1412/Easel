"""Native agent RPC without starting a Node CLI for every message.

Uses the same session, model override and thinking contract as the audited CLI.
The process facade keeps existing stream supervision and session locks intact.
"""
from __future__ import annotations

import queue
import subprocess
import threading
import time


def _normalized_stop_reason(value, depth=0):
    """Extract a bounded provider terminal reason from a Gateway result."""
    if depth > 4:
        return None
    if isinstance(value, dict):
        for key in ('stopReason', 'stop_reason', 'finishReason', 'finish_reason'):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                return 'max_tokens' if candidate == 'max_output_tokens' else candidate
        incomplete = value.get('incomplete_details')
        if isinstance(incomplete, dict) and incomplete.get('reason') == 'max_output_tokens':
            return 'max_tokens'
        for key in ('result', 'meta', 'completion', 'message', 'response', 'payload', 'data'):
            found = _normalized_stop_reason(value.get(key), depth + 1)
            if found:
                return found
        payloads = value.get('payloads')
        if isinstance(payloads, list):
            for payload in payloads[:32]:
                found = _normalized_stop_reason(payload, depth + 1)
                if found:
                    return found
    elif isinstance(value, list):
        for item in value[:32]:
            found = _normalized_stop_reason(item, depth + 1)
            if found:
                return found
    return None


class GatewayAgentProc:
    def __init__(self, client, client_factory, params, timeout, on_compaction=None, on_tool=None, on_accepted=None,
                 continuation=None, on_continue=None):
        self.client = client
        self.client_factory = client_factory
        self.params = dict(params)
        self.timeout = timeout
        self.on_compaction = on_compaction
        self.on_tool = on_tool
        self.on_accepted = on_accepted
        self.continuation = continuation
        self.on_continue = on_continue
        self.continuations = 0
        self._pending_question = False
        self._office_run_id = params['idempotencyKey']
        self._done = threading.Event()
        self._stop = threading.Event()
        self._abort_lock = threading.Lock()
        self._abort_confirmed = threading.Event()
        self._accepted_run = threading.Event()
        self._lines = queue.Queue()
        self.stdout = self._stdout()
        self.error_text = None
        self.result = None
        self.stop_reason = None
        self.clean_end = False
        self.returncode = None
        threading.Thread(target=self._run, daemon=True, name='easel-agent-rpc').start()

    def _stdout(self):
        while True:
            line = self._lines.get()
            if line is None:
                return
            yield line

    def _accepted(self, payload):
        if payload.get('runId'):
            self._office_run_id = payload['runId']
            self._accepted_run.set()
            if self.on_accepted is not None:
                self.on_accepted(self._office_run_id)
        if self._stop.is_set():
            if self._abort():
                self.client.close()

    def _on_event(self, frame):
        if frame.get('event') != 'agent':
            return
        payload = frame.get('payload')
        if not isinstance(payload, dict) or payload.get('runId') != self._office_run_id:
            return
        if payload.get('sessionKey') not in (None, self.params['sessionKey']):
            return
        data = payload.get('data')
        if payload.get('stream') in ('question', 'approval'):
            self._pending_question = True
        if payload.get('stream') == 'tool' and self.on_tool is not None and isinstance(data, dict):
            self.on_tool(payload)
            return
        if self.on_compaction is None:
            return
        if payload.get('stream') != 'compaction' or not isinstance(data, dict):
            return
        if data.get('phase') == 'start':
            self.on_compaction({'phase': 'start'})
        elif data.get('phase') == 'end':
            outcome = data.get('outcome')
            if data.get('completed') is True:
                outcome = 'completed'
            if outcome in ('completed', 'failed', 'skipped', 'aborted'):
                self.on_compaction({'phase': 'end', 'outcome': outcome})

    def _abort(self):
        # Separate connection: the original receiver must keep waiting for final.
        with self._abort_lock:
            if self._done.is_set():
                return True
            client = self.client_factory()
            try:
                result = client._rpc('chat.abort', {
                    'sessionKey': self.params['sessionKey'],
                    'runId': self._office_run_id,
                    'agentId': self.params['agentId'],
                }, timeout=5)
                confirmed = (isinstance(result, dict) and result.get('aborted') is True
                             and self._office_run_id in result.get('runIds', []))
                confirmed = confirmed or (isinstance(result, dict) and result.get('ok') is True
                                           and result.get('aborted') is False and result.get('runIds') == []
                                           and self._accepted_run.is_set())
                if confirmed:
                    self._abort_confirmed.set()
                return confirmed
            finally:
                client.close()

    def _settle_disconnected_run(self):
        # A lost receiver does not cancel a running request. Reconnect only to
        # observe its exact identity; abort remains an explicit user action.
        from easel.gateway_reconciliation import wait_outcome
        while True:
            try:
                if self._abort_confirmed.is_set():
                    return
                if self._stop.is_set() and self._accepted_run.is_set() and self._abort():
                    return
                client = self.client_factory()
                try:
                    result = client._rpc('agent.wait', {'runId': self._office_run_id, 'timeoutMs': 1000}, timeout=5)
                    outcome = wait_outcome(result, self._office_run_id, self.params.get('sessionId'))
                    if outcome is not None:
                        return outcome
                finally:
                    client.close()
            except Exception:
                pass
            time.sleep(2)

    def _terminal_confirmed(self):
        if not self._accepted_run.is_set():
            return False
        client = self.client_factory()
        try:
            result = client._rpc('agent.wait', {'runId': self._office_run_id, 'timeoutMs': 1000}, timeout=5)
            return (isinstance(result, dict) and result.get('runId') == self._office_run_id
                    and result.get('status') in ('ok', 'error'))
        except Exception:
            return False
        finally:
            client.close()

    def _recover_outcome(self, outcome):
        self.stop_reason = outcome['stopReason']
        text = outcome['text']
        self.result = {'status': 'ok' if outcome['complete'] else 'error',
                       'result': {'payloads': [{'text': text}] if text is not None else []}}
        if text is not None:
            self._lines.put(text + '\n')
        self.clean_end = outcome['complete']
        self.error_text = None if self.clean_end else outcome['error']['message']
        self.returncode = 0 if self.clean_end else 1

    def _run(self):
        from .chat_continuation import CONTINUE_MESSAGE, MAX_CONTINUATIONS
        started = time.monotonic()
        all_payloads = []
        try:
            while True:
                terminal = False
                attempt_error = ''
                try:
                    self.result = self.client._rpc('agent', self.params, timeout=max(1, self.timeout - (time.monotonic() - started)) + 30,
                        expect_final=True, on_accepted=self._accepted, on_event=self._on_event)
                    terminal = isinstance(self.result, dict) and self.result.get('status') in ('ok', 'error')
                    if isinstance(self.result, dict) and self.result.get('status') != 'ok':
                        attempt_error = str(self.result.get('summary', 'Gateway returned no final agent result'))
                except Exception as exc:
                    # A response error is not by itself evidence the accepted run ended.
                    if not getattr(exc, 'rpc_response', False):
                        raise
                    attempt_error = str(exc)
                    terminal = self._terminal_confirmed()
                    if not terminal:
                        outcome = self._settle_disconnected_run()
                        if outcome is not None and not self._stop.is_set():
                            self._recover_outcome(outcome)
                            return
                    self.result = {'status': 'error', 'summary': attempt_error}
                result = self.result.get('result') if isinstance(self.result, dict) else None
                payloads = result.get('payloads', []) if isinstance(result, dict) else []
                if not isinstance(payloads, list):
                    payloads = []
                if not attempt_error:
                    attempt_error = '\n'.join(row.get('text', '') for row in payloads
                        if isinstance(row, dict) and row.get('isError') and isinstance(row.get('text'), str))
                text = '\n'.join(row['text'] for row in payloads if isinstance(row, dict) and isinstance(row.get('text'), str))
                reason = None
                if (terminal and self.continuation is not None and not self._stop.is_set()
                        and not self._pending_question and self.continuations < MAX_CONTINUATIONS
                        and time.monotonic() - started < self.timeout):
                    reason = self.continuation(error=attempt_error, text=text, stop_reason=_normalized_stop_reason(self.result))
                if not reason:
                    all_payloads.extend(payloads)
                    break
                all_payloads.extend(row for row in payloads if not (isinstance(row, dict) and row.get('isError')))
                self.continuations += 1
                if self.on_continue is not None:
                    self.on_continue(self.continuations, reason)
                self.client.close()
                # Backoff is interruptible. Original prompt is never replayed.
                if self._stop.wait(min(2 * self.continuations, 4)):
                    break
                self.client = self.client_factory()
                if self._stop.is_set():
                    break
                self.params = {**self.params, 'message': CONTINUE_MESSAGE,
                    'idempotencyKey': self.params['idempotencyKey'].split(':continue:')[0] + f':continue:{self.continuations}',
                    'timeout': max(1, int(self.timeout - (time.monotonic() - started)))}
                self._accepted_run.clear()
                self._abort_confirmed.clear()
                self._office_run_id = self.params['idempotencyKey']
            self.stop_reason = _normalized_stop_reason(self.result)
            if isinstance(self.result, dict) and self.result.get('status') == 'ok' and isinstance(self.result.get('result'), dict):
                self.result = {**self.result, 'result': {**self.result['result'], 'payloads': all_payloads}}
            if not isinstance(self.result, dict) or self.result.get('status') != 'ok':
                self.error_text = str((self.result or {}).get('summary', 'Gateway returned no final agent result')) if isinstance(self.result, dict) else 'Gateway returned no final agent result'
                self.returncode = 1
            else:
                result = self.result.get('result') or {}
                payloads = (result.get('payloads') or []) if isinstance(result, dict) else []
                failures = [row.get('text', '') for row in payloads if isinstance(row, dict) and row.get('isError')]
                if failures:
                    self.error_text = '\n'.join(failures)
                    self.returncode = 1
                    return
                text = '\n'.join(row['text'] for row in payloads
                                 if isinstance(row, dict) and isinstance(row.get('text'), str))
                if text:
                    self._lines.put(text + '\n')
                self.clean_end = not self._stop.is_set()
                self.returncode = 0
        except Exception as exc:
            self.error_text = str(exc)
            outcome = None
            if not getattr(exc, 'rpc_response', False):
                outcome = self._settle_disconnected_run()
            if outcome is not None and not self._stop.is_set():
                self._recover_outcome(outcome)
            else:
                self.returncode = 1
        finally:
            self.client.close()
            self._lines.put(None)
            self._done.set()

    def poll(self):
        return self.returncode if self._done.is_set() else None

    def terminate(self):
        self._stop.set()
        if not self._done.is_set() and self._accepted_run.is_set():
            try:
                if self._abort():
                    # An exact abort receipt is enough to stop waiting on a
                    # receiver whose final response may never arrive.
                    self.client.close()
            except Exception:
                pass  # Worker waits for final or reconciles after disconnection.

    kill = terminate

    def wait(self, timeout=None):
        if not self._done.wait(timeout):
            raise subprocess.TimeoutExpired('gateway-agent', timeout)
        return self.returncode
