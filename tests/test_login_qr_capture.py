"""Observed-image QR export checks: offline pixels, no platform/login IO."""
import base64
import io
import sys
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/shared/scripts'))
import login_qr
import web_publisher


def code_bytes(text='offline-login-fixture'):
    pixels = cv2.QRCodeEncoder_create().encode(text)
    output = io.BytesIO()
    Image.fromarray(pixels).resize((240, 240), Image.Resampling.NEAREST).save(output, format='PNG')
    return output.getvalue()


def image_bytes(image):
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


def test_full_login_page_exports_scannable_code_without_page_background(tmp_path):
    page = Image.new('RGB', (1280, 720), '#66bbdd')
    page.paste(Image.open(io.BytesIO(code_bytes())), (370, 290))
    output = tmp_path / 'qr.png'
    metadata = login_qr.capture_page(SimpleNamespace(screenshot=lambda **_kw: image_bytes(page)), output)
    assert metadata['qrKind'] == 'qr' and metadata['qrWidth'] < 320 and metadata['qrHeight'] < 320
    image = np.array(Image.open(output))
    assert np.all(image[:12] == 255)
    assert cv2.QRCodeDetector().detectAndDecode(image)[0] == 'offline-login-fixture'


def test_logo_or_error_page_is_only_a_preview(tmp_path):
    page = Image.new('RGB', (1280, 720), 'white')
    page.paste(Image.new('RGB', (240, 240), '#0055aa'), (300, 200))
    output = tmp_path / 'preview.png'
    metadata = login_qr.capture_page(SimpleNamespace(screenshot=lambda **_kw: image_bytes(page)), output)
    assert metadata == {'qrKind': 'page', 'qrWidth': 1280, 'qrHeight': 720}


def test_small_dom_uses_official_data_image_at_original_resolution(tmp_path):
    src = 'data:image/png;base64,' + base64.b64encode(code_bytes()).decode()
    element = SimpleNamespace(is_visible=lambda: True, get_attribute=lambda _key: src,
                              evaluate=lambda js: 'IMG' if js == 'e => e.tagName' else True,
                              screenshot=lambda **_kw: (_ for _ in ()).throw(AssertionError('must use original asset')))
    output = tmp_path / 'qr.png'
    metadata = login_qr.capture_element(element, output)
    assert metadata['qrKind'] == 'qr' and metadata['qrWidth'] >= 240
    assert cv2.QRCodeDetector().detectAndDecode(np.array(Image.open(output)))[0] == 'offline-login-fixture'


def test_hidden_or_not_loaded_image_cannot_be_ready(tmp_path):
    for visible, loaded in ((False, True), (True, False)):
        element = SimpleNamespace(is_visible=lambda: visible,
            evaluate=lambda js: 'IMG' if js == 'e => e.tagName' else loaded,
            screenshot=lambda **_kw: (_ for _ in ()).throw(AssertionError('must not capture')))
        output = tmp_path / 'qr.png'
        assert login_qr.capture_element(element, output) is None
        assert not output.exists()


def test_same_code_preserves_cache_key_and_rotation_changes_content(tmp_path):
    output = tmp_path / 'qr.png'
    element = SimpleNamespace(is_visible=lambda: True, evaluate=lambda _js: 'CANVAS',
                              screenshot=lambda **_kw: code_bytes())
    login_qr.capture_element(element, output)
    before = output.stat().st_mtime_ns, output.read_bytes()
    login_qr.capture_element(element, output)
    assert before == (output.stat().st_mtime_ns, output.read_bytes())
    element.screenshot = lambda **_kw: code_bytes('offline-rotated-fixture')
    login_qr.capture_element(element, output)
    assert output.read_bytes() != before[1]


def test_unknown_dom_uses_page_detection_instead_of_whole_page_qr(tmp_path):
    image = Image.new('RGB', (1280, 720), 'white')
    image.paste(Image.open(io.BytesIO(code_bytes())), (400, 300))
    page = SimpleNamespace(query_selector_all=lambda _selector: [],
                           screenshot=lambda **_kw: image_bytes(image))
    result = web_publisher._crop_qr(page, tmp_path / 'qr.png', {})
    assert result['qrKind'] == 'qr' and result['qrWidth'] < 320
