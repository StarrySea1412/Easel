"""The workbench check must never borrow or print chat credentials."""
import importlib.util
from argparse import Namespace
from pathlib import Path
import sys
import pytest

scripts = Path(__file__).resolve().parents[1] / 'skills/shared/scripts'
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location('easel_image_check', scripts / 'ai_image.py')
image = importlib.util.module_from_spec(spec); spec.loader.exec_module(image)


def test_dedicated_check_does_not_use_chat_aliases_or_print_credentials(monkeypatch, capsys):
    for key in (*image.ENV_ALIASES, *(alias for aliases in image.ENV_ALIASES.values() for alias in aliases)):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv('OPENAI_API_KEY', 'PRIVATE_CHAT_KEY')
    monkeypatch.setenv('OPENAI_BASE_URL', 'https://PRIVATE_CHAT_ENDPOINT')
    monkeypatch.setenv('IMG_MODEL', 'PRIVATE_MODEL')
    with pytest.raises(SystemExit) as error:
        image.cmd_check(Namespace(dedicated_channel=True))
    assert error.value.code == 2
    assert 'PRIVATE_' not in capsys.readouterr().out
    monkeypatch.setenv('IMG_API_KEY', 'PRIVATE_IMAGE_KEY')
    monkeypatch.setenv('IMG_BASE_URL', 'https://PRIVATE_IMAGE_ENDPOINT')
    image.cmd_check(Namespace(dedicated_channel=True))
    output = capsys.readouterr().out
    assert 'PRIVATE_' not in output and '尚未联网测通' in output
