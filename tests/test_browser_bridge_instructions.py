"""Regression for host 138's pre-model Linux chat crash; no network/model calls."""
from pathlib import Path, PurePosixPath, PureWindowsPath
import shlex
from types import SimpleNamespace

import pytest

from easel import browser_bridge as bridge


@pytest.mark.parametrize('path', [
    PurePosixPath("/app/folder with spaces/user's file.py"),
    PureWindowsPath("C:/folder with spaces/user's file.py"),
])
def test_path_arguments_round_trip_through_posix_shell(path):
    assert shlex.split(bridge._shell_quote(path, 'posix')) == [str(path)]


def test_powershell_path_escapes_apostrophe():
    path = PureWindowsPath("C:/user's files/browser.py")
    assert bridge._shell_quote(path, 'nt') == "'C:\\user''s files\\browser.py'"


@pytest.mark.parametrize('platform', ['posix', 'nt'])
def test_complete_browser_instructions_keep_session_and_script(monkeypatch, tmp_path, platform):
    module = tmp_path / 'source with spaces' / 'easel' / 'browser_bridge.py'
    monkeypatch.setattr(bridge, '__file__', str(module))
    monkeypatch.setattr(bridge, 'os', SimpleNamespace(name=platform))
    monkeypatch.setattr(bridge, 'sys', SimpleNamespace(executable='python with spaces'))
    text = bridge.instructions('hotfix-session')
    command = text.split('通过exec运行 ', 1)[1].split(' --args-json ', 1)[0]
    script = str(module.resolve().parents[1] / 'skills/shared/scripts/browser_page.py')
    if platform == 'posix':
        assert shlex.split(command) == ['python with spaces', script, '--session', 'hotfix-session']
    else:
        assert command.startswith("& 'python with spaces' ")
        assert bridge._shell_quote(Path(script), 'nt') in command
        assert command.endswith("--session 'hotfix-session'")
    assert 'downloadCandidates' in text and 'sha256' in text


def test_chat_context_assembles_on_posix_before_model_admission(monkeypatch):
    import web.app as web

    monkeypatch.setattr(bridge, 'os', SimpleNamespace(name='posix'))
    monkeypatch.setattr(web, '_read_env', lambda: {})
    text = web._chat_message(web.ChatRequest(message='diagnostic request', sessionId='hotfix-session'))
    assert 'diagnostic request' in text
    assert '当前对话共享浏览器' in text
    assert '--session hotfix-session' in text
