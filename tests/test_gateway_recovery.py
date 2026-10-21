import threading

from easel.gateway_recovery import GatewayRecovery


def wait_finished(recovery):
    for _ in range(200):
        if recovery.snapshot()['state'] != 'starting':
            return recovery.snapshot()
        threading.Event().wait(.005)
    raise AssertionError('recovery did not finish')


def test_healthy_gateway_is_not_started_or_stopped():
    recovery = GatewayRecovery()
    calls = []
    recovery.request(lambda: True, lambda: calls.append('start'))
    assert wait_finished(recovery)['state'] == 'connected'
    assert calls == []


def test_concurrent_requests_share_one_offline_start():
    recovery = GatewayRecovery()
    entered, release = threading.Event(), threading.Event()
    state = {'ready': False, 'starts': 0}

    def start():
        state['starts'] += 1
        entered.set()
        assert release.wait(2)
        state['ready'] = True

    recovery.request(lambda: state['ready'], start)
    assert entered.wait(2)
    for _ in range(10):
        assert recovery.request(lambda: state['ready'], start)['state'] == 'starting'
    release.set()
    assert wait_finished(recovery)['state'] == 'connected'
    assert state['starts'] == 1


def test_failure_backoff_and_retry_never_expose_raw_error():
    now = [100.0]
    recovery = GatewayRecovery(lambda: now[0])
    calls = []

    def fail():
        calls.append(1)
        raise RuntimeError('PRIVATE_TOKEN=secret')

    recovery.request(lambda: False, fail)
    result = wait_finished(recovery)
    assert result['retryAfter'] == 15
    assert 'PRIVATE' not in result['note'] and 'secret' not in result['note']
    recovery.request(lambda: False, fail)
    assert len(calls) == 1
    now[0] += 16
    recovery.request(lambda: False, fail)
    assert wait_finished(recovery)['retryAfter'] == 30
    assert len(calls) == 2


def test_missing_runtime_has_actionable_message():
    recovery = GatewayRecovery()

    def missing():
        raise FileNotFoundError('private/path')

    recovery.request(lambda: False, missing)
    assert 'OpenClaw 或 Node' in wait_finished(recovery)['note']


def test_timeout_has_bounded_retry_without_stopping_process():
    recovery = GatewayRecovery()

    def timeout():
        raise TimeoutError()

    recovery.request(lambda: False, timeout)
    result = wait_finished(recovery)
    assert '超时' in result['note'] and result['retryAfter'] == 15
