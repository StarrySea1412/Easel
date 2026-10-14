"""Upstream B regressions with temporary profiles and controlled platform data."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / 'skills/shared/scripts'
sys.path.insert(0, str(SCRIPTS))
import account_stats as stats
import profile_lock
import web_publisher
import xhs_account
import xhs_publish


def test_profile_lock_excludes_another_process_and_releases_after_close(tmp_path):
    profile = tmp_path / '中文 空格账号'
    context = profile_lock.launch_locked(profile, lambda: SimpleNamespace(close=lambda: None, pages=[]))
    program = '''import sys
sys.path.insert(0, sys.argv[1])
from profile_lock import ProfileLock
from pathlib import Path
lock = ProfileLock(Path(sys.argv[2]))
try:
    lock.acquire(0.1)
except TimeoutError:
    sys.exit(12)
lock.release()
'''
    command = [sys.executable, '-c', program, str(SCRIPTS), str(profile)]
    assert subprocess.run(command, capture_output=True, timeout=5).returncode == 12
    context.close()
    assert subprocess.run(command, capture_output=True, timeout=5).returncode == 0
    assert (profile / '.easel.lock').is_file(), 'lock inode must remain stable'


@pytest.mark.parametrize('failure', ['launch', 'close'])
def test_profile_failures_release_ownership(tmp_path, failure):
    def fail():
        raise RuntimeError('synthetic browser failure')
    with pytest.raises(RuntimeError):
        context = profile_lock.launch_locked(tmp_path, fail if failure == 'launch' else lambda: SimpleNamespace(close=fail))
        context.close()
    lock = profile_lock.ProfileLock(tmp_path)
    lock.acquire(0)
    lock.release()
    lock.release()


def test_xhs_all_launches_use_the_same_profile_lock(tmp_path):
    observed = []
    playwright = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=lambda profile, **kw:
        observed.append((profile, kw)) or SimpleNamespace(close=lambda: None)))
    context = xhs_publish._launch(playwright, False, str(tmp_path), None)
    competing = profile_lock.ProfileLock(tmp_path / 'XiaohongshuProfile')
    with pytest.raises(TimeoutError):
        competing.acquire(0)
    context.close()
    assert '--no-proxy-server' in observed[0][1]['args']
    competing.acquire(0)
    competing.release()


def test_poll_deadline_includes_body_read_cost_and_zero_can_stabilize(monkeypatch):
    clock, timeouts, waits = [0.0], [], []
    monkeypatch.setattr(stats.time, 'monotonic', lambda: clock[0])
    def read(_selector, timeout):
        timeouts.append(timeout)
        clock[0] += timeout / 1000
        raise RuntimeError('synthetic body timeout')
    def wait(delay):
        waits.append(delay)
        clock[0] += delay / 1000
    page = SimpleNamespace(inner_text=read, wait_for_timeout=wait)
    assert stats._poll_stable(page, lambda lines: None, max_ms=1500) == []
    assert clock[0] <= 1.501 and max(timeouts) <= 1000
    clock[0] = 0
    page.inner_text = lambda *_a, **_kw: '0\n粉丝数'
    assert stats._poll_stable(page, lambda lines: stats.num_by_label(lines, ['粉丝数'], 'before')) == ['0', '粉丝数']


def state_html(user_id='account-one', logged=True):
    return '<script>window.__INITIAL_STATE__=' + json.dumps({'user': {
        'loggedIn': logged, 'userInfo': {'value': {'userId': user_id, 'nickname': '本人'}}}}) + ';</script>'


@pytest.mark.parametrize('html', ['<script>alert(1)</script>', '<script>window.__INITIAL_STATE__=unknown;</script>', 'x' * 2_000_001], ids=['script', 'invalid-json', 'oversized'])
def test_identity_parser_rejects_unbounded_or_non_json_state(html):
    assert xhs_account._initial_state(html) == {}


def test_identity_parser_requires_an_authenticated_owner():
    assert xhs_account._state_account(xhs_account._initial_state(state_html()))['userId'] == 'account-one'
    assert xhs_account._state_account(xhs_account._initial_state(state_html(logged=False))) is None
    assert xhs_account._state_account(xhs_account._initial_state(state_html(user_id='../other'))) is None


@pytest.mark.parametrize('kind', ['creator', 'web', 'logout', 'unknown', 'redirect'])
def test_session_uses_bounded_first_party_identity_and_distinguishes_unknown_from_logout(kind):
    calls = []
    def get(url, **kwargs):
        calls.append((url, kwargs['timeout']))
        if url == xhs_account.CREATOR_ACCOUNT_URL:
            payload = {'success': kind == 'creator', 'data': {'userId': 'account-one'}}
            status = 200 if kind == 'creator' else 401 if kind == 'logout' else 503
            return SimpleNamespace(url='https://other.test/' if kind == 'redirect' else url, status=status, json=lambda: payload)
        return SimpleNamespace(url='https://other.test/' if kind == 'redirect' else url, status=200,
            text=lambda: state_html(logged=kind == 'web') if kind in ('web', 'logout') else '<html>maintenance</html>')
    context = SimpleNamespace(request=SimpleNamespace(get=get))
    if kind in ('unknown', 'redirect'):
        with pytest.raises(RuntimeError):
            stats._xhs_session(context)
    else:
        account, creator = stats._xhs_session(context)
        assert creator is (kind == 'creator')
        assert bool(account) is (kind != 'logout')
    assert all(timeout <= 5000 for _, timeout in calls)


def empty_result():
    return {'nickname': '', 'followers': None, 'likes': None, 'following': None,
            'posts': None, 'metrics': [], 'notes': [], 'logged_in': True}


@pytest.mark.parametrize('case', ['success', 'switched', 'empty', 'notes_failed', 'creator_expired'])
def test_xhs_collection_keeps_owner_and_does_not_turn_failure_into_an_empty_success(monkeypatch, case):
    sessions = [({'userId': 'account-one', 'nickname': '本人'}, case != 'creator_expired'),
                ({'userId': 'account-two' if case == 'switched' else 'account-one'}, True)]
    monkeypatch.setattr(stats, '_xhs_session', lambda *_: sessions.pop(0))
    monkeypatch.setattr(stats, '_xhs_creator_stats', lambda *_: {} if case == 'empty' else {'followers': 0})
    monkeypatch.setattr(stats, '_xhs_own_stats', lambda *_: {})
    monkeypatch.setattr(stats, '_poll_stable', lambda *_: [])
    monkeypatch.setattr(stats, '_login_wall', lambda *_: False)
    def notes(*_):
        if case == 'notes_failed':
            raise RuntimeError('synthetic list not loaded')
        return [{'note_id': 'real-note-id', 'title': '已发布内容'}]
    monkeypatch.setattr(stats, '_scrape_notes', notes)
    removed = []
    page = SimpleNamespace(on=lambda *_: None, goto=lambda *_a, **_kw: None,
                           remove_listener=lambda *_: removed.append(True))
    if case == 'success':
        result = stats._scrape_xhs(None, page, empty_result())
        assert result['account_id'] == 'account-one' and result['followers'] == 0
        assert result['notes'][0]['note_id'] == 'real-note-id' and result['warning']
    else:
        with pytest.raises(RuntimeError):
            stats._scrape_xhs(None, page, empty_result())
    assert removed == ([] if case == 'creator_expired' else [True])


@pytest.mark.parametrize('note,expected', [
    ({'title': '作品', 'text': '已发布'}, True),
    ({'title': '作品', 'text': '草稿'}, False),
    ({'title': '无笔记标题'}, False),
    ({'title': '作品', 'href': '/publish/publish'}, False),
])
def test_unpublished_xhs_cards_are_not_account_evidence(note, expected):
    assert stats.is_public_xhs_note(note) is expected


@pytest.mark.parametrize('url,visible,expected', [
    ('https://www.xiaohongshu.com/explore', True, True),
    ('https://www.xiaohongshu.com/explore', False, False),
    ('https://www.xiaohongshu.com/website-login/error', True, False),
    ('https://xiaohongshu.com.evil.test/explore', True, False),
    ('about:blank', True, False),
])
def test_xhs_login_requires_a_visible_first_party_identity(url, visible, expected):
    page = SimpleNamespace(url=url, query_selector=lambda selector:
        SimpleNamespace(is_visible=lambda: visible) if selector == xhs_publish.SELECTORS['login_ok'] else None)
    assert xhs_publish._login_visible(page) is expected


@pytest.mark.parametrize('url,expected', [('about:blank', False), ('https://evil.test/', False),
    ('https://example.test/profile', True), ('https://example.test/signin', False)])
def test_anonymous_redirect_is_not_a_successful_platform_login(url, expected):
    cfg = {'login_url': 'https://example.test', 'publish_url': 'https://example.test/create'}
    page = SimpleNamespace(url=url, query_selector=lambda *_: None)
    assert web_publisher._is_logged_in(page, cfg) is expected


@pytest.mark.skipif(os.name != 'nt', reason='Windows PATH expression')
def test_setup_path_keeps_process_tools_after_registry_refresh():
    source = (SCRIPTS.parents[2] / 'setup.ps1').read_text(encoding='utf-8-sig')
    replacements = [line.strip() for line in source.splitlines() if "$env:Path = $env:Path + ';' + [Environment]" in line]
    assert len(replacements) == 2
    executable = Path(os.environ['SYSTEMROOT']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    for expression in replacements:
        script = "$env:Path='EASEL_PROCESS_SENTINEL'; " + expression + "; [Console]::Write($env:Path)"
        result = subprocess.run([str(executable), '-NoProfile', '-NonInteractive', '-Command', script],
                                capture_output=True, timeout=10)
        assert result.returncode == 0 and result.stdout.startswith(b'EASEL_PROCESS_SENTINEL;')


@pytest.mark.parametrize('ready', [True, False])
def test_hidden_qr_does_not_prevent_opening_login_dialog(ready):
    clicked = []
    qr = SimpleNamespace(is_visible=lambda: ready or bool(clicked))
    entry = SimpleNamespace(is_visible=lambda: True, click=lambda **kw: clicked.append('entry'))
    page = SimpleNamespace(query_selector=lambda selector: qr if selector == xhs_publish.SELECTORS['qrcode']
                           else entry if selector == xhs_publish.SELECTORS['login_entry'] else None,
                           wait_for_timeout=lambda *_: None)
    xhs_publish._open_qr_login(page)
    assert clicked == ([] if ready else ['entry'])


@pytest.mark.parametrize('cards,body,success', [
    ([], '暂无笔记', True), ([], '加载中', False),
    ([{'title': '草稿作品', 'text': '草稿'}], '', False),
    ([{'title': '作品', 'text': '已发布', 'noteId': 'note-one'}], '', True),
])
def test_notes_require_published_content_or_a_confirmed_empty_state(cards, body, success):
    removed = []
    page = SimpleNamespace(url='https://creator.xiaohongshu.com/new/note-manager',
        on=lambda *_: None, remove_listener=lambda *_: removed.append(True),
        goto=lambda *_a, **_kw: None, query_selector_all=lambda *_: [],
        wait_for_selector=lambda *_a, **_kw: None, wait_for_timeout=lambda *_: None,
        evaluate=lambda js: cards if js == stats._XHS_NOTES_JS else True,
        inner_text=lambda *_a, **_kw: body)
    if success:
        assert len(stats._scrape_notes('xiaohongshu', page, {})) == len(cards)
    else:
        with pytest.raises(RuntimeError):
            stats._scrape_notes('xiaohongshu', page, {})
    assert removed == [True]
