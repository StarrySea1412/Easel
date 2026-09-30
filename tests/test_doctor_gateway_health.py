"""Bounded doctor health retries; no real OpenClaw service or credentials."""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from easel.commands import doctor


class Reply:
    def __init__(self, status): self.status = status
    def __enter__(self): return self
    def __exit__(self, *args): pass


def test_transient_oserror_then_real_success_requires_second_request(monkeypatch):
    attempts, sleeps = [], []
    monkeypatch.setattr(doctor, 'healthz_url', lambda: 'http://127.0.0.1:12345/healthz')
    monkeypatch.setattr(doctor.time, 'sleep', sleeps.append)
    def request(url, timeout):
        attempts.append((url, timeout))
        if len(attempts) == 1:
            raise OSError('temporary connection failure')
        return Reply(200)
    monkeypatch.setattr(doctor.urllib.request, 'urlopen', request)
    assert doctor._gateway_healthy() is True
    assert attempts == [('http://127.0.0.1:12345/healthz', 5)] * 2
    assert sleeps == [1]


def test_persistent_connection_failure_is_bounded_and_false(monkeypatch):
    attempts, sleeps = [], []
    monkeypatch.setattr(doctor.time, 'sleep', sleeps.append)
    def request(url, timeout):
        attempts.append(timeout)
        raise OSError('still unavailable')
    monkeypatch.setattr(doctor.urllib.request, 'urlopen', request)
    assert doctor._gateway_healthy() is False
    assert attempts == [5, 5, 5] and sleeps == [1, 1]


@pytest.mark.parametrize('status', [204, 301, 404, 503])
def test_non_200_responses_never_count_as_healthy(monkeypatch, status):
    attempts, sleeps = [], []
    monkeypatch.setattr(doctor.time, 'sleep', sleeps.append)
    def request(url, timeout):
        attempts.append(timeout)
        return Reply(status)
    monkeypatch.setattr(doctor.urllib.request, 'urlopen', request)
    assert doctor._gateway_healthy() is False
    assert len(attempts) == 3 and sleeps == [1, 1]


def test_first_http_200_does_not_sleep_or_retry(monkeypatch):
    attempts = []
    monkeypatch.setattr(doctor.time, 'sleep', lambda seconds: pytest.fail('successful probe must not wait'))
    def request(url, timeout):
        attempts.append(timeout)
        return Reply(200)
    monkeypatch.setattr(doctor.urllib.request, 'urlopen', request)
    assert doctor._gateway_healthy() is True and attempts == [5]


def test_local_http_transient_503_then_200(monkeypatch):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(503 if len(requests) == 1 else 200)
            self.end_headers()
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(doctor, 'healthz_url', lambda: f'http://127.0.0.1:{server.server_port}/healthz')
    monkeypatch.setattr(doctor.time, 'sleep', lambda seconds: None)
    try:
        assert doctor._gateway_healthy() is True
        assert requests == ['/healthz', '/healthz']
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
