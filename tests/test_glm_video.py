"""CogVideoX async contract; never submits a paid generation request."""
import argparse
import io
import json
import socket
import sys
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/shared/scripts'))
import ai_video as video


def args(tmp_path, **changes):
    values = dict(model='cogvideox-3', prompt='A cat', ratio='16:9', duration=5,
                                    timeout=60, poll_interval=0, output=str(tmp_path / 'out.mp4'),
                                    native_audio=None, audio_reference=None)
    values.update(changes)
    return argparse.Namespace(**values)


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    values = {'GLM_VIDEO_API_KEY': 'simulated-private-key'}
    monkeypatch.setattr(video, 'env_lookup', lambda key: values.get(key, ''))
    return values


def test_text_submission_processing_and_download_use_separate_auth(tmp_path, monkeypatch):
    calls = []
    responses = iter([{'id': 'job-123', 'task_status': 'PROCESSING'}, {'task_status': 'PROCESSING'},
                      {'task_status': 'SUCCESS', 'video_result': [{'url': 'https://cdn.example/video.mp4'}]}])
    def request(url, headers, **options):
        calls.append((url, headers, options))
        return next(responses)
    monkeypatch.setattr(video, '_glm_api_request', request)
    downloads = []
    monkeypatch.setattr(video, '_download_glm_video', lambda url, path, **kw: downloads.append((url, path)) or path)
    result = video.generate_glm(args(tmp_path), None)
    assert result == tmp_path / 'out.mp4'
    assert calls[0][0].endswith('/paas/v4/videos/generations')
    assert calls[0][2]['payload'] == {'model': 'cogvideox-3', 'prompt': 'A cat', 'quality': 'speed',
                                      'fps': 30, 'size': '1920x1080', 'duration': 5, 'with_audio': True}
    assert calls[1][0].endswith('/async-result/job-123')
    assert all(call[1]['Authorization'] == 'Bearer simulated-private-key' for call in calls)
    assert downloads == [('https://cdn.example/video.mp4', result)]


@pytest.mark.parametrize('result', [{'task_status': 'FAIL'}, {'task_status': 'UNKNOWN'}, {},
                                    {'task_status': 'SUCCESS', 'video_result': []}])
def test_failure_and_incomplete_results_do_not_download(result, tmp_path, monkeypatch):
    responses = iter([{'id': 'job-123'}, result])
    monkeypatch.setattr(video, '_glm_api_request', lambda *a, **k: next(responses))
    monkeypatch.setattr(video, '_download_glm_video', lambda *a, **k: pytest.fail('must not download'))
    with pytest.raises(SystemExit):
        video.generate_glm(args(tmp_path), None)


@pytest.mark.parametrize('changes', [{'model': 'glm-chat'}, {'prompt': 'x' * 513}, {'duration': 8},
                                    {'model': 'cogvideox-2'}, {'timeout': 0}])
def test_invalid_parameters_reject_before_submission(changes, tmp_path, monkeypatch):
    options = args(tmp_path)
    for key, value in changes.items():
        setattr(options, key, value)
    monkeypatch.setattr(video, '_glm_api_request', lambda *a, **k: pytest.fail('must not submit'))
    with pytest.raises(SystemExit):
        video.generate_glm(options, None)


def test_image_is_encoded_as_png_and_bounded(tmp_path, monkeypatch):
    image = tmp_path / 'reference.jpg'
    Image.new('RGB', (20, 20), 'red').save(image)
    assert video._glm_reference(str(image)).startswith('data:image/png;base64,')
    monkeypatch.setattr(video, 'GLM_VIDEO_MAX_IMAGE_BYTES', 10)
    with pytest.raises(SystemExit):
        video._glm_reference(str(image))


@pytest.mark.parametrize('model', ['cogvideox-3', 'cogvideox-2', 'cogvideox-flash'])
def test_image_submission_uses_selected_model_and_omits_unsupported_duration(model, tmp_path, monkeypatch):
    image = tmp_path / 'reference.png'
    Image.new('RGB', (10, 10), 'blue').save(image)
    calls = []
    responses = iter([{'id': 'image-job'}, {'task_status': 'SUCCESS',
                       'video_result': [{'url': 'https://cdn.example/result.mp4'}]}])
    def request(url, headers, **options):
        calls.append(options)
        return next(responses)
    monkeypatch.setattr(video, '_glm_api_request', request)
    monkeypatch.setattr(video, '_download_glm_video', lambda url, path, **kw: path)
    video.generate_glm(args(tmp_path, model=model, duration=None, ratio='9:16'), str(image))
    payload = calls[0]['payload']
    assert payload['model'] == model and payload['size'] == '1080x1920'
    assert payload['image_url'].startswith('data:image/png;base64,')
    assert 'duration' not in payload


@pytest.mark.parametrize('address', ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1'])
def test_download_cannot_use_private_addresses(address, monkeypatch):
    monkeypatch.setattr(video.socket, 'getaddrinfo', lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))])
    with pytest.raises(SystemExit):
        video._glm_public_video_url('https://cdn.example/video.mp4')


@pytest.mark.parametrize('length,body', [('100', b'short'), ('0', b''), (None, b'')])
def test_incomplete_download_keeps_existing_output_and_cleans_temp(length, body, tmp_path, monkeypatch):
    target = tmp_path / 'out.mp4'
    target.write_bytes(b'existing')
    response = io.BytesIO(body)
    response.headers = {'Content-Type': 'video/mp4'}
    if length is not None:
        response.headers['Content-Length'] = length
    monkeypatch.setattr(video, '_glm_public_video_url', lambda _: [])
    monkeypatch.setattr(video.urllib.request, 'build_opener', lambda *a: SimpleNamespace(open=lambda *a, **k: response))
    with pytest.raises(SystemExit):
        video._download_glm_video('https://cdn.example/video.mp4', target)
    assert target.read_bytes() == b'existing'
    assert not target.with_name('out.mp4.glm-download').exists()


def test_api_errors_do_not_echo_provider_body_or_credentials(capsys, monkeypatch):
    def fail(*a, **k):
        raise urllib.error.HTTPError('https://api.example', 401, 'secret', {}, io.BytesIO(b'simulated-private-key'))
    monkeypatch.setattr(video.urllib.request, 'build_opener', lambda *a: SimpleNamespace(open=fail))
    with pytest.raises(SystemExit):
        video._glm_api_request('https://api.example', {'Authorization': 'Bearer simulated-private-key'})
    assert 'simulated-private-key' not in capsys.readouterr().err


def test_timeout_does_not_retry_a_submitted_job(tmp_path, monkeypatch):
    clock = iter([0, 0, 61])
    monkeypatch.setattr(video.time, 'monotonic', lambda: next(clock))
    calls = []
    monkeypatch.setattr(video, '_glm_api_request', lambda *a, **k: calls.append(a) or {'id': 'job-123'})
    with pytest.raises(SystemExit):
        video.generate_glm(args(tmp_path), None)
    assert len(calls) == 1
