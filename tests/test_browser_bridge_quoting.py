"""Regression for the Linux Path -> shlex.quote crash before chat admission."""
from pathlib import Path
import shlex

from easel import browser_bridge


def test_path_arguments_are_quoted_as_text_for_posix_and_powershell():
    path = Path("folder with spaces") / "owner's file.py"
    assert browser_bridge._shell_quote(path, 'posix') == shlex.quote(str(path))
    assert browser_bridge._shell_quote(path, 'nt') == "'" + str(path).replace("'", "''") + "'"
    assert shlex.split(browser_bridge._shell_quote(path, 'posix')) == [str(path)]


def test_instructions_use_quoting_boundary_for_every_command_argument(monkeypatch):
    arguments = []
    original = browser_bridge._shell_quote
    def quote(value, platform=None):
        arguments.append(value)
        # Exercise the actual POSIX quoting branch without globally changing os.name.
        return original(value, 'posix')
    monkeypatch.setattr(browser_bridge, '_shell_quote', quote)
    result = browser_bridge.instructions('session-test')
    assert 'browser_page.py' in result and 'session-test' in result
    assert any(isinstance(arg, Path) for arg in arguments)
    assert len(arguments) == 3
