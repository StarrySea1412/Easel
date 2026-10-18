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
        for key in ('result', 'message', 'response', 'payload', 'data'):
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
    def __init__(self, client, client_factory, params, timeout, on_compaction=None, on_tool=None, on_accepted=None):
        self.client = client
        self.client_factory = client_factory
        self.params = dict(params)
        self.timeout = timeout
        self.on_compaction = on_compaction
        self.on_tool = on_tool
        self.on_accepted = on_accepted
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
        # A dropped socket is not proof that the gateway stopped writing history.
        # Never re-dispatch a paid request; retain the lock until abort or final.
        while True:
            try:
                if self._abort_confirmed.is_set():
                    return
                if self._abort():
                    return
                client = self.client_factory()
                try:
                    result = client._rpc('agent.wait', {'runId': self._office_run_id, 'timeoutMs': 1000}, timeout=5)
                    if (isinstance(result, dict) and result.get('status') in ('ok', 'error')
                            and result.get('runId') == self._office_run_id):
                        return
                finally:
                    client.close()
            except Exception:
                pass
            time.sleep(2)

    def _run(self):
        try:
            self.result = self.client._rpc('agent', self.params, timeout=self.timeout + 30,
                                           expect_final=True, on_accepted=self._accepted, on_event=self._on_event)
            self.stop_reason = _normalized_stop_reason(self.result)
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
            if not getattr(exc, 'rpc_response', False):
                self._settle_disconnected_run()
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
