"""Offline tests for actual image decoding, metadata and saved-provider vision requests."""
from __future__ import annotations

import base64
import io
import json
import socket
import sys
import urllib.error
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'web')]
import app as web
import image_reverse as reverse


def image_bytes(format='PNG', metadata=None, size=(30, 40)):
    output = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    for key, value in (metadata or {}).items():
        info.add_text(key, json.dumps(value) if isinstance(value, dict) else value)
    Image.new('RGB', size, '#735346').save(output, format=format, pnginfo=info)
    return output.getvalue()


def provider(protocol='openai', base='https://vision.example.test/v1'):
    return reverse.Provider('vision', '测试视觉通道', 'vision-model', protocol, base, 'test-secret-private')


class FakeResponse:
    def __init__(self, body):
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()

    def read(self, n):
        return self.body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def fake_open(monkeypatch, fn):
    class Opener:
        def open(self, request, timeout):
            return fn(request, timeout)
    monkeypatch.setattr(reverse.urllib.request, 'build_opener', lambda *args: Opener())


@pytest.fixture(autouse=True)
def no_live_model(monkeypatch):
    def reject(*args, **kwargs):
        raise AssertionError('Tests must never call a live model API')
    monkeypatch.setattr(reverse.urllib.request, 'build_opener', reject)


def test_a1111_metadata_succeeds_without_provider_or_network():
    raw = image_bytes(metadata={'parameters': 'a red fox in snow\nNegative prompt: blurry, watermark\n'
                                             'Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42, Model: demo'})
    result = reverse.reverse_image(raw, [])
    assert result == {'prompt': 'a red fox in snow', 'negativePrompt': 'blurry, watermark',
                      'source': 'metadata', 'metadataFormat': 'AUTOMATIC1111', 'model': 'demo',
                      'width': 30, 'height': 40}


def test_comfyui_follows_sampler_links_and_separates_negative():
    graph = {'1': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'forest path'}},
             '2': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'blurry'}},
             '3': {'class_type': 'ConditioningCombine', 'inputs': {'conditioning_1': ['1', 0]}},
             '4': {'class_type': 'KSampler', 'inputs': {'positive': ['3', 0], 'negative': ['2', 0]}}}
    result = reverse.reverse_image(image_bytes(metadata={'prompt': graph}), [])
    assert result['prompt'] == 'forest path'
    assert result['negativePrompt'] == 'blurry'
    assert result['metadataFormat'] == 'ComfyUI'


def test_comfy_cycle_does_not_recurse_forever():
    graph = {'1': {'inputs': {'conditioning': ['1', 0]}},
             '2': {'inputs': {'positive': ['1', 0], 'negative': ['1', 0]}}}
    assert reverse.extract_metadata({'prompt': json.dumps(graph)}) is None


@pytest.mark.parametrize('key', ['invokeai_metadata', 'sd-metadata', 'metadata'])
def test_invoke_metadata(key):
    metadata = {'positive_prompt': '柔和光线下的花瓶', 'negative_prompt': '模糊',
                'model': {'model_name': 'demo-model'}}
    result = reverse.reverse_image(image_bytes(metadata={key: metadata}), [])
    assert result['prompt'] == metadata['positive_prompt']
    assert result['negativePrompt'] == metadata['negative_prompt']
    assert result['metadataFormat'] == 'InvokeAI'
    assert result['model'] == 'demo-model'


def test_malformed_workflow_can_fall_back_to_simple_metadata():
    result = reverse.reverse_image(image_bytes(metadata={'prompt': '{broken', 'Description': 'mountains'}), [])
    assert result['prompt'] == 'mountains'
    assert result['metadataFormat'] == 'text'


def test_jpeg_unicode_exif_prompt():
    exif = Image.Exif()
    parameters = '晨雾中的森林\nNegative prompt: 水印\nSteps: 20, Model: demo'
    exif[34665] = {37510: b'UNICODE\x00' + parameters.encode('utf-16-be')}
    output = io.BytesIO()
    Image.new('RGB', (20, 30)).save(output, format='JPEG', exif=exif)
    result = reverse.reverse_image(output.getvalue(), [])
    assert result['prompt'] == '晨雾中的森林' and result['negativePrompt'] == '水印'
    assert result['metadataFormat'] == 'AUTOMATIC1111'


@pytest.mark.parametrize('base', ['https://[invalid', 'file:///tmp/image', 'https://user:pass@example.test',
                                'https://example.test:invalid', 'https://example.test?apiKey=secret'])
def test_invalid_saved_provider_is_not_configured(base):
    assert provider(base=base).configured is False


def test_redirects_never_forward_authorization():
    assert reverse._NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'https://other.test') is None


@pytest.mark.parametrize('format', ['PNG', 'JPEG', 'WEBP'])
def test_actual_image_formats_decode(format):
    image, _ = reverse.decode_image(image_bytes(format))
    assert image.size == (30, 40)
    image.close()


@pytest.mark.parametrize('raw,status', [(b'', 400), (b'not an image', 400),
                                      (b'x' * (reverse.MAX_BYTES + 1), 413)], ids=['empty', 'invalid', 'oversize'])
def test_invalid_image_and_byte_limits(raw, status):
    with pytest.raises(HTTPException) as error:
        reverse.reverse_image(raw, [])
    assert error.value.status_code == status


def test_gif_rejected_and_pixel_limit_checked_before_loading(monkeypatch):
    with pytest.raises(HTTPException, match='400'):
        reverse.decode_image(image_bytes('GIF'))
    monkeypatch.setattr(reverse, 'MAX_PIXELS', 100)
    with pytest.raises(HTTPException, match='413'):
        reverse.decode_image(image_bytes())


def test_truncated_image_is_rejected():
    with pytest.raises(HTTPException) as error:
        reverse.decode_image(image_bytes('JPEG')[:100])
    assert error.value.status_code == 400


@pytest.mark.parametrize('kwargs', [{'mode': 'unknown'}, {'language': 'unknown'}, {'instruction': '字' * 1001}])
def test_input_validation(kwargs):
    with pytest.raises(HTTPException) as error:
        reverse.reverse_image(image_bytes(), [], **kwargs)
    assert error.value.status_code == 400


def test_no_metadata_without_model_is_honest_and_unknown_provider_rejected():
    with pytest.raises(HTTPException) as error:
        reverse.reverse_image(image_bytes(), [])
    assert error.value.status_code == 503
    assert '支持图片理解' in error.value.detail
    with pytest.raises(HTTPException) as error:
        reverse.reverse_image(image_bytes(), [], provider_id='https://attacker.test')
    assert error.value.status_code == 400


def test_openai_vision_uses_saved_credentials_and_sanitized_image(monkeypatch):
    seen = {}
    def reply(request, timeout):
        seen.update(url=request.full_url, headers=dict(request.header_items()), body=json.loads(request.data), timeout=timeout)
        return FakeResponse({'choices': [{'message': {'content': '```json\n{"prompt":"暖色调的森林","negativePrompt":"水印"}\n```'}}]})
    fake_open(monkeypatch, reply)
    result = reverse.reverse_image(image_bytes(metadata={'Description': 'original prompt'}), [provider()],
                                   'vision', mode='vision', instruction='侧重光线')
    assert result['source'] == 'vision' and result['prompt'] == '暖色调的森林'
    assert result['negativePrompt'] == '水印' and result['width'] == 30 and result['height'] == 40
    assert seen['url'] == 'https://vision.example.test/v1/chat/completions'
    assert seen['headers']['Authorization'] == 'Bearer test-secret-private'
    assert seen['body']['model'] == 'vision-model' and seen['timeout'] == 60
    content = seen['body']['messages'][1]['content']
    assert '侧重光线' in content[0]['text']
    encoded = content[1]['image_url']['url'].split(',', 1)[1]
    pixels = base64.b64decode(encoded)
    assert b'original prompt' not in pixels
    with Image.open(io.BytesIO(pixels)) as image:
        assert image.format == 'JPEG' and 'Description' not in image.info


@pytest.mark.parametrize('base', ['https://vision.example.test', 'https://vision.example.test/v1/'])
def test_anthropic_messages_protocol(monkeypatch, base):
    def reply(request, timeout):
        assert request.full_url == 'https://vision.example.test/v1/messages'
        headers = {k.lower(): v for k, v in request.header_items()}
        assert headers['x-api-key'] == 'test-secret-private' and 'authorization' not in headers
        assert headers['anthropic-version'] == '2023-06-01'
        body = json.loads(request.data)
        assert 'English' in body['system']
        assert body['messages'][0]['content'][0]['source']['media_type'] == 'image/jpeg'
        return FakeResponse({'content': [{'type': 'text', 'text': 'A quiet forest, soft morning light.'}]})
    fake_open(monkeypatch, reply)
    result = reverse.reverse_image(image_bytes(), [provider('anthropic', base)], 'vision', language='en')
    assert result['prompt'] == 'A quiet forest, soft morning light.'


@pytest.mark.parametrize('status', [400, 401, 403, 404, 422, 429, 500, 302])
def test_upstream_errors_never_expose_body_or_key(monkeypatch, status):
    def reject(request, timeout):
        raise urllib.error.HTTPError(request.full_url, status, 'test-secret-private', {},
                                     io.BytesIO(b'test-secret-private data:image/png;base64,aabb'))
    fake_open(monkeypatch, reject)
    with pytest.raises(HTTPException) as error:
        reverse.reverse_image(image_bytes(), [provider()], 'vision')
    assert error.value.status_code == 502
    assert 'test-secret-private' not in error.value.detail and 'base64' not in error.value.detail


@pytest.mark.parametrize('exception,status', [(TimeoutError('private'), 504),
                                             (urllib.error.URLError(socket.timeout('private')), 504),
                                             (urllib.error.URLError('test-secret-private'), 502),
                                             (ConnectionResetError('test-secret-private'), 502)])
def test_timeout_and_network_errors(monkeypatch, exception, status):
    def reject(request, timeout):
        raise exception
    fake_open(monkeypatch, reject)
    with pytest.raises(HTTPException) as error:
        reverse.reverse_image(image_bytes(), [provider()], 'vision')
    assert error.value.status_code == status and 'private' not in error.value.detail


@pytest.mark.parametrize('body', [b'not json', {}, {'choices': []}, {'choices': [{'message': {'content': ''}}]}])
def test_invalid_or_empty_response_is_not_a_fake_success(monkeypatch, body):
    fake_open(monkeypatch, lambda *args: FakeResponse(body))
    with pytest.raises(HTTPException) as error:
        reverse.reverse_image(image_bytes(), [provider()], 'vision')
    assert error.value.status_code == 502


def test_upstream_success_cannot_echo_key(monkeypatch):
    fake_open(monkeypatch, lambda *args: FakeResponse({'choices': [{'message': {'content': 'prompt test-secret-private'}}]}))
    assert 'test-secret-private' not in reverse.reverse_image(image_bytes(), [provider()], 'vision')['prompt']


def test_public_config_and_multipart_routes(monkeypatch):
    monkeypatch.setattr(web, '_image_reverse_providers', lambda: [provider()])
    client = TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234))
    config = client.get('/api/image-reverse/config')
    assert config.status_code == 200
    item = config.json()['providers'][0]
    assert set(item) == {'id', 'name', 'model', 'protocol', 'configured'}
    assert item['configured'] is True
    assert 'test-secret-private' not in config.text and 'example.test' not in config.text
    response = client.post('/api/image-reverse', files={'image': ('fox.png', image_bytes(metadata={'Prompt': 'fox'}), 'image/png')},
                           data={'mode': 'auto', 'language': 'zh'})
    assert response.status_code == 200 and response.json()['source'] == 'metadata'
    assert client.post('/api/image-reverse').status_code == 422
    assert client.post('/api/image-reverse', files={'image': ('fake.png', b'fake', 'image/png')}).status_code == 400


def test_saved_channel_adapter_uses_chat_credentials_only(monkeypatch):
    monkeypatch.setattr(web, '_model_channels', lambda: {'chat': {'rows': [
        {'slot': 'openai', 'name': 'OpenAI', 'model': 'vision-model', 'protocol': 'openai'},
        {'slot': 'custom', 'name': 'studio', 'model': 'other-vision', 'protocol': 'anthropic'}]}})
    monkeypatch.setattr(web, '_read_env', lambda: {'OPENAI_API_KEY': 'chat-only', 'OPENAI_BASE_URL': 'https://chat.test/v1',
                                                 'IMG_API_KEY': 'never-use-image-secret'})
    monkeypatch.setattr(web, '_openclaw_provider_creds', lambda: {'studio': ('https://custom.test', 'custom-key')})
    result = web._image_reverse_providers()
    assert [(p.id, p.key, p.base_url) for p in result] == [
        ('openai', 'chat-only', 'https://chat.test/v1'), ('studio', 'custom-key', 'https://custom.test')]
