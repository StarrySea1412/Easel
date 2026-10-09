"""Native agent RPC without starting a Node CLI for every message.

Uses the same session, model override and thinking contract as the audited CLI.
The process facade keeps existing stream supervision and session locks intact.
"""
from __future__ import annotations

import queue
import subprocess
import threading
import time


class GatewayAgentProc:
    def __init__(self, client, client_factory, params, timeout, on_compaction=None):
        self.client = client
        self.client_factory = client_factory
        self.params = dict(params)
        self.timeout = timeout
        self.on_compaction = on_compaction
        self._office_run_id = params['idempotencyKey']
        self._done = threading.Event()
        self._stop = threading.Event()
        self._abort_lock = threading.Lock()
        self._lines = queue.Queue()
        self.stdout = self._stdout()
        self.error_text = None
        self.result = None
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
        if self._stop.is_set():
            self._abort()

    def _on_event(self, frame):
        if frame.get('event') != 'agent' or self.on_compaction is None:
            return
        payload = frame.get('payload')
        if not isinstance(payload, dict) or payload.get('runId') != self._office_run_id:
            return
        if payload.get('sessionKey') not in (None, self.params['sessionKey']):
            return
        data = payload.get('data')
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
                return (isinstance(result, dict) and result.get('aborted') is True
                        and ('runIds' not in result or self._office_run_id in result['runIds']))
            finally:
                client.close()

    def _settle_disconnected_run(self):
        # A dropped socket is not proof that the gateway stopped writing history.
        # Never re-dispatch a paid request; retain the lock until abort or final.
        while True:
            try:
                if self._abort():
                    return
                client = self.client_factory()
                try:
                    result = client._rpc('agent.wait', {'runId': self._office_run_id, 'timeoutMs': 1000}, timeout=5)
                    if isinstance(result, dict) and result.get('status') in ('ok', 'error'):
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
        if not self._done.is_set():
            try:
                self._abort()
            except Exception:
                pass  # Worker waits for final or reconciles after disconnection.

    kill = terminate

    def wait(self, timeout=None):
        if not self._done.wait(timeout):
            raise subprocess.TimeoutExpired('gateway-agent', timeout)
        return self.returncode
