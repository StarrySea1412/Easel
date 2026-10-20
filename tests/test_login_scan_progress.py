"""Offline visible platform acknowledgements; no real QR or account access."""
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/shared/scripts'))
import login_state


def frame(text, visible=True):
    def get_by_text(pattern):
        assert isinstance(pattern, re.Pattern)
        return SimpleNamespace(first=SimpleNamespace(is_visible=lambda **_: bool(pattern.search(text)) and visible))
    return SimpleNamespace(get_by_text=get_by_text)


@pytest.mark.parametrize('text', ['扫码成功', '已扫码，请在手机确认', '扫描成功\n请确认', '请在微信上确认登录'])
def test_visible_acknowledgement_reports_scan_in_child_frame(tmp_path, text):
    path = tmp_path / 'status.json'
    page = SimpleNamespace(frames=[frame('请扫描二维码'), frame(text)])
    assert login_state.report_scan(str(path), page)
    assert json.loads(path.read_text(encoding='utf-8'))['state'] == 'scanned'


@pytest.mark.parametrize('text,visible', [('扫码成功后请返回此页面', True), ('请扫码登录', True), ('扫码成功', False), ('', True)])
def test_instructions_missing_qr_and_hidden_messages_do_not_manufacture_scan(tmp_path, text, visible):
    path = tmp_path / 'status.json'
    assert not login_state.report_scan(str(path), SimpleNamespace(frames=[frame(text, visible)]))
    assert not path.exists()
