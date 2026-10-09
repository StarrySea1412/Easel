"""Offline login failures: synthetic pages only, no platform or credential IO."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/shared/scripts'))
import xhs_publish as publisher

ERROR_URL = 'https://www.xiaohongshu.com/website-login/error'


@pytest.mark.parametrize('url,title,body,expected', [
    (ERROR_URL, '登录错误', '', 'login_page_error'),
    (ERROR_URL, '安全限制', '', 'security_verification'),
    (ERROR_URL, '', '请完成安全验证', 'security_verification'),
    (ERROR_URL + '?code=300012', '', '', 'network_risk'),
    (ERROR_URL + '?errorCode=300012', '', '', 'network_risk'),
    (ERROR_URL, '安全限制', '错误码 300012', 'network_risk'),
    (ERROR_URL, '', 'IP 存在风险，请切换可靠网络环境', 'network_risk'),
    (ERROR_URL + '?code=300013', '登录错误', '', 'login_page_error'),
    (ERROR_URL + '?redirectPath=%2Fexplore%3Fcode%3D300012', '', '', 'login_page_error'),
    (ERROR_URL, '', '工单 1300012', 'login_page_error'),
    (publisher.EXPLORE_URL, '小红书', '普通笔记提及 IP 存在风险 300012', None),
    (publisher.EXPLORE_URL + '?code=300012', '小红书', '', None),
    ('https://xiaohongshu.com.evil.test/website-login/error?code=300012', '安全限制', '', None),
    ('https://notxiaohongshu.com/website-login/error', '安全限制', 'IP 存在风险', None),
    ('https://[invalid/', '安全限制', 'IP 存在风险', None),
])
def test_risk_requires_first_party_error_page_and_explicit_evidence(url, title, body, expected):
    assert publisher._classify_login_page_error(url, title, body) == expected


class Page:
    def __init__(self, url=ERROR_URL, title='登录错误', body=''):
        self.url, self.page_title, self.body = url, title, body
        self.body_reads = 0
        self.waits = []
        self.navigation_error = False

    def title(self):
        return self.page_title

    def locator(self, selector):
        assert selector == 'body'
        return self

    def inner_text(self, **kwargs):
        self.body_reads += 1
        assert kwargs == {'timeout': 1000}
        return self.body

    def goto(self, *_args, **_kwargs):
        if self.navigation_error:
            raise RuntimeError('synthetic network timeout; PRIVATE_ERROR_DETAIL')

    def query_selector(self, _selector):
        return None

    def wait_for_timeout(self, delay):
        self.waits.append(delay)


def runner(monkeypatch, tmp_path, page, on_close=None):
    closed = []

    def close():
        closed.append(True)
        if on_close:
            on_close()

    context = SimpleNamespace(pages=[page], close=close)

    class Playwright:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

    api = ModuleType('playwright.sync_api')
    api.sync_playwright = Playwright
    monkeypatch.setitem(sys.modules, 'playwright.sync_api', api)
    monkeypatch.setattr(publisher, '_launch', lambda *_a, **_kw: context)
    monkeypatch.setattr(publisher, '_proxy', lambda *_a: '')
    args = SimpleNamespace(qr_out=str(tmp_path / 'qr.png'), status_file=str(tmp_path / 'status.json'),
                           timeout=10, headed=False, profile_base=str(tmp_path), proxy=None, no_proxy=True)
    return args, closed


def read_status(args):
    return json.loads(Path(args.status_file).read_text(encoding='utf-8'))


def test_generic_error_is_reported_once_without_invented_ip_advice(monkeypatch, tmp_path, capsys):
    page = Page(ERROR_URL + '?token=PRIVATE_URL_TOKEN', body='PRIVATE_PAGE_DETAIL')
    args, closed = runner(monkeypatch, tmp_path, page)
    with pytest.raises(SystemExit) as failure:
        publisher.cmd_login(args)
    assert failure.value.code == 4
    status = read_status(args)
    assert status['state'] == 'error' and '尚未确认具体原因' in status['message']
    assert 'IP' not in status['message'] and '代理' not in status['message']
    assert page.waits == [800] and page.body_reads == 1 and closed == [True]
    output = capsys.readouterr()
    assert output.err.count('ERROR:') == 1
    assert 'PRIVATE_' not in output.err + json.dumps(status)


def test_explicit_platform_risk_stops_without_changing_network_or_exposing_page(monkeypatch, tmp_path):
    args, closed = runner(monkeypatch, tmp_path, Page(body='IP存在风险 300012 PRIVATE_PAGE_DETAIL'))
    with pytest.raises(SystemExit):
        publisher.cmd_login(args)
    status = read_status(args)
    assert '明确提示当前网络存在风险' in status['message']
    assert '官方客户端' in status['message'] and closed == [True]
    assert 'PRIVATE_' not in json.dumps(status)


def test_navigation_failure_is_not_claimed_to_be_ip_risk(monkeypatch, tmp_path):
    page = Page(publisher.EXPLORE_URL, '小红书')
    page.navigation_error = True
    args, closed = runner(monkeypatch, tmp_path, page)
    with pytest.raises(SystemExit):
        publisher.cmd_login(args)
    message = read_status(args)['message']
    assert '无法打开小红书登录页面' in message and 'IP' not in message and 'PRIVATE_' not in message
    assert closed == [True] and page.body_reads == 0


def test_browser_launch_failure_has_its_own_actionable_status(monkeypatch, tmp_path):
    args, closed = runner(monkeypatch, tmp_path, Page())

    def fail(*_args, **_kwargs):
        raise RuntimeError('PRIVATE_BINARY_PATH')

    monkeypatch.setattr(publisher, '_launch', fail)
    with pytest.raises(SystemExit) as failure:
        publisher.cmd_login(args)
    assert failure.value.code == 3
    status = read_status(args)
    assert status['state'] == 'error' and '无法启动登录浏览器' in status['message']
    assert 'PRIVATE_' not in json.dumps(status) and not closed


def test_qr_wait_failure_does_not_guess_network_risk(monkeypatch, tmp_path):
    args, closed = runner(monkeypatch, tmp_path, Page(publisher.EXPLORE_URL, '小红书'))

    def missing(*_args):
        raise TimeoutError('synthetic missing QR')

    monkeypatch.setattr(publisher, '_wait_sel', missing)
    with pytest.raises(SystemExit):
        publisher.cmd_login(args)
    message = read_status(args)['message']
    assert '未提供二维码' in message and 'IP' not in message and closed == [True]


def test_late_security_redirect_after_qr_is_terminal(monkeypatch, tmp_path):
    page = Page(publisher.EXPLORE_URL, '小红书')
    args, closed = runner(monkeypatch, tmp_path, page)

    def screenshot(*_args, **_kwargs):
        page.url = ERROR_URL
        page.page_title = '安全验证'

    monkeypatch.setattr(publisher, '_wait_sel', lambda *_a: SimpleNamespace(screenshot=screenshot))
    with pytest.raises(SystemExit):
        publisher.cmd_login(args)
    message = read_status(args)['message']
    assert '额外安全验证' in message and '网络存在风险' not in message
    assert closed == [True]


def test_navigation_context_failure_does_not_invent_a_platform_rejection(tmp_path):
    class Navigating:
        url = ERROR_URL

        def title(self):
            raise RuntimeError('Execution context was destroyed')

    target = tmp_path / 'status.json'
    publisher._stop_on_login_page_error(Navigating(), str(target))
    assert not target.exists()


class InteractivePage(Page):
    def __init__(self, *, qr=False, security=False, risk=False):
        super().__init__(ERROR_URL if security or risk else publisher.EXPLORE_URL,
                         '安全验证' if security else '小红书', 'IP 存在风险 300012' if risk else '')
        self.clock = 0
        self.logged = False
        self.closed = False
        self.qr = qr
        self.screenshots = []
        self.after_wait = lambda: None

    def is_closed(self):
        return self.closed

    def query_selector(self, selector):
        if selector == publisher.SELECTORS['login_ok']:
            return object() if self.logged else None
        if selector == publisher.SELECTORS['qrcode']:
            return self if self.qr else None
        raise AssertionError('Unexpected DOM access')

    def screenshot(self, *, path, timeout):
        assert timeout == 1500
        self.screenshots.append(path)
        Path(path).write_bytes(b'synthetic QR')

    def wait_for_timeout(self, delay):
        self.waits.append(delay)
        self.clock += delay / 1000
        self.after_wait()

    def finish(self):
        self.url, self.page_title, self.body = publisher.EXPLORE_URL, '小红书', ''
        self.logged = True


def visible_runner(monkeypatch, tmp_path, page, on_close=None):
    args, closed = runner(monkeypatch, tmp_path, page, on_close)
    args.headed = True
    monkeypatch.setattr(publisher.time, 'monotonic', lambda: page.clock)
    transitions = []
    write = publisher.login_state.write_status

    def track(path, state, message='', qr=''):
        transitions.append(state)
        write(path, state, message, qr)

    monkeypatch.setattr(publisher.login_state, 'write_status', track)
    return args, closed, transitions


def test_visible_window_allows_manual_login_without_a_qr_and_flushes_before_success(monkeypatch, tmp_path):
    page = InteractivePage()
    before_close = []
    args, closed, states = visible_runner(monkeypatch, tmp_path, page,
        on_close=lambda: before_close.append(read_status(args)['state']))
    page.after_wait = page.finish
    monkeypatch.setattr(publisher, '_wait_sel', lambda *_a: pytest.fail('manual mode must not require a QR'))

    assert publisher.cmd_login(args) == 0

    assert states == ['starting', 'verifying', 'success']
    assert before_close == ['verifying'] and closed == [True]
    assert read_status(args)['state'] == 'success'


def test_visible_official_security_step_is_left_for_user_to_complete(monkeypatch, tmp_path):
    page = InteractivePage(security=True)
    args, closed, states = visible_runner(monkeypatch, tmp_path, page)
    page.after_wait = page.finish

    assert publisher.cmd_login(args) == 0

    assert states == ['starting', 'verifying', 'success'] and closed == [True]
    assert page.body_reads == 1


def test_visible_mode_still_stops_at_explicit_network_risk(monkeypatch, tmp_path):
    page = InteractivePage(risk=True)
    args, closed, states = visible_runner(monkeypatch, tmp_path, page)

    with pytest.raises(SystemExit) as failure:
        publisher.cmd_login(args)

    assert failure.value.code == 4
    assert states == ['starting', 'error'] and not page.waits and closed == [True]
    assert '当前网络存在风险' in read_status(args)['message']


def test_visible_mode_exports_available_qr_and_clears_it_only_after_profile_flush(monkeypatch, tmp_path):
    page = InteractivePage(qr=True)
    at_close = []
    args, closed, states = visible_runner(monkeypatch, tmp_path, page,
        on_close=lambda: at_close.append((read_status(args)['state'], Path(args.qr_out).is_file())))
    page.after_wait = page.finish

    assert publisher.cmd_login(args) == 0

    assert states == ['starting', 'qr_ready', 'success']
    assert at_close == [('qr_ready', True)] and closed == [True]
    assert len(page.screenshots) == 1 and not Path(args.qr_out).exists()


def test_qr_screenshot_failure_keeps_visible_login_usable(monkeypatch, tmp_path):
    page = InteractivePage(qr=True)
    args, closed, states = visible_runner(monkeypatch, tmp_path, page)
    page.after_wait = page.finish
    monkeypatch.setattr(page, 'screenshot', lambda **_kw: (_ for _ in ()).throw(RuntimeError('synthetic screenshot failure')))

    assert publisher.cmd_login(args) == 0

    assert states == ['starting', 'verifying', 'success'] and closed == [True]


@pytest.mark.parametrize('raise_during_wait', [False, True])
def test_closing_visible_window_ends_attempt_without_false_success(monkeypatch, tmp_path, raise_during_wait):
    page = InteractivePage()
    args, closed, states = visible_runner(monkeypatch, tmp_path, page)

    def close_window():
        page.closed = True
        if raise_during_wait:
            raise RuntimeError('Target page, context or browser has been closed')

    page.after_wait = close_window
    assert publisher.cmd_login(args) == 1
    assert states == ['starting', 'verifying', 'expired'] and closed == [True]
    assert '窗口已关闭' in read_status(args)['message']


def test_visible_login_timeout_stops_instead_of_claiming_success(monkeypatch, tmp_path):
    page = InteractivePage()
    args, closed, states = visible_runner(monkeypatch, tmp_path, page)
    args.timeout = 2

    assert publisher.cmd_login(args) == 1

    assert states == ['starting', 'verifying', 'expired'] and closed == [True]
    assert page.waits == [1000, 1000] and '超时' in read_status(args)['message']


def test_failed_profile_flush_cannot_announce_success(monkeypatch, tmp_path):
    page = InteractivePage()
    page.logged = True

    def fail_close():
        raise RuntimeError('synthetic profile flush failure')

    args, closed, states = visible_runner(monkeypatch, tmp_path, page, on_close=fail_close)

    with pytest.raises(SystemExit) as failure:
        publisher.cmd_login(args)

    assert failure.value.code == 3 and closed == [True]
    assert states == ['starting', 'error'] and '未能保存完成' in read_status(args)['message']


def test_manual_login_success_is_not_accepted_on_an_unrelated_origin(monkeypatch, tmp_path):
    page = InteractivePage()
    page.url, page.logged = 'https://example.test/explore', True
    args, closed, states = visible_runner(monkeypatch, tmp_path, page)
    args.timeout = 1

    assert publisher.cmd_login(args) == 1

    assert states == ['starting', 'verifying', 'expired'] and closed == [True]
