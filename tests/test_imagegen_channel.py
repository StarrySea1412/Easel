"""Image gallery readiness must match the dedicated generation channel; no API calls."""
import asyncio
import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "web")]
import app as web


@pytest.mark.parametrize("image_key,configured", [("", False), ("test-image-secret-key-value", True)])
def test_gallery_reports_dedicated_image_channel(tmp_path, monkeypatch, image_key, configured):
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path / "outputs")
    env = {"IMG_BASE_URL": "https://images.example.test/v1", "IMG_MODEL": "image-test",
           "IMG_API_KEY": image_key, "OPENAI_API_KEY": "chat-secret-must-not-be-used"}
    monkeypatch.setattr(web, "_read_env", lambda: env)
    monkeypatch.setattr(web, "IMAGEGEN_DIR", tmp_path / "missing-gallery")
    result = asyncio.run(web.api_imagegen_gallery())
    channel = result["channel"]
    assert channel["configured"] is configured
    assert web._imagegen_channel_ready()[0] is configured
    assert channel["baseUrl"] == env["IMG_BASE_URL"] and channel["model"] == "image-test"
    assert channel["keyMasked"] == web._mask_key(image_key)
    assert env["OPENAI_API_KEY"] not in str(result)
    assert not image_key or image_key not in str(result)
    assert result["images"] == []


def test_chat_model_cannot_make_an_incomplete_image_channel_ready(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path / "outputs")
    monkeypatch.setattr(web, "_read_env", lambda: {"IMG_BASE_URL": "https://images.example.test/v1",
        "IMG_API_KEY": "test-key", "OPENAI_MODEL": "chat-model"})
    monkeypatch.setattr(web, "IMAGEGEN_DIR", tmp_path / "missing-gallery")
    assert not web._imagegen_channel_ready()[0]
    assert asyncio.run(web.api_imagegen_gallery())["channel"]["configured"] is False


@pytest.fixture
def imagegen_stub(tmp_path, monkeypatch):
    """Run jobs inline with a fake provider; never load credentials or call an API."""
    monkeypatch.setattr(web, "_read_env", lambda: {
        "IMG_BASE_URL": "https://images.example.test/v1",
        "IMG_MODEL": "image-test", "IMG_API_KEY": "test-image-key",
    })
    monkeypatch.setattr(web, "child_env", lambda *_: {})
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path / "outputs")
    monkeypatch.setattr(web, "IMAGEGEN_DIR", tmp_path / "gallery")
    monkeypatch.setattr(web, "_IMAGEGEN_JOBS", {})

    class ImmediateThread:
        def __init__(self, *, target, **_):
            self.target = target

        def start(self):
            self.target()

    monkeypatch.setattr(web.threading, "Thread", ImmediateThread)
    calls = []

    def generate(cmd, **_):
        calls.append(cmd)
        Image.new("RGB", (120, 80)).save(Path(cmd[cmd.index("--output") + 1]))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(web.subprocess, "run", generate)
    return calls


@pytest.mark.parametrize("size", [
    "1024x1024", "768x1024", "1024x768", "864x1536", "1536x864",
    "1024x1280", "1280x1024", "1024x1536", "1536x1024", "auto",
])
def test_imagegen_preserves_requested_size_and_reports_actual_dimensions(imagegen_stub, size):
    started = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="测试画面", size=size)))
    job = asyncio.run(web.api_imagegen_status(started["jobId"]))
    cmd = imagegen_stub[0]
    assert cmd[cmd.index("--size") + 1] == size
    assert job["state"] == "done"
    assert job["size"] == size
    # Provider output can differ: report real pixels and leave the image untouched.
    assert (job["width"], job["height"]) == (120, 80)
    with Image.open(web.IMAGEGEN_DIR / Path(job["url"]).name) as image:
        assert image.size == (120, 80)


@pytest.mark.parametrize("size", ["", "16:9", "0x1024", "2048x2048", "999999x999999"])
def test_imagegen_rejects_invalid_size_before_starting_job(imagegen_stub, size):
    with pytest.raises(web.HTTPException) as exc:
        asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="测试画面", size=size)))
    assert exc.value.status_code == 400
    assert not imagegen_stub
    assert not web._IMAGEGEN_JOBS


@pytest.mark.parametrize("extension", ["jpg", "webp"])
def test_imagegen_finds_provider_output_with_its_actual_extension(imagegen_stub, monkeypatch, extension):
    def generate(cmd, **_):
        output = Path(cmd[cmd.index("--output") + 1]).with_suffix(f".{extension}")
        Image.new("RGB", (90, 160)).save(output)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(web.subprocess, "run", generate)
    started = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="测试画面", size="864x1536")))
    job = asyncio.run(web.api_imagegen_status(started["jobId"]))
    assert job["state"] == "done"
    assert job["url"].endswith(f".{extension}")
    assert (job["width"], job["height"]) == (90, 160)


@pytest.mark.parametrize("size", ["864x1536", "auto"])
def test_imagegen_preserves_provider_size_error(imagegen_stub, monkeypatch, size):
    monkeypatch.setattr(web.subprocess, "run", lambda *_args, **_kwargs:
        SimpleNamespace(returncode=1, stdout="", stderr=f"model does not support size {size}"))
    started = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="测试画面", size=size)))
    job = asyncio.run(web.api_imagegen_status(started["jobId"]))
    assert job["state"] == "error"
    assert job["size"] == size
    assert job["url"] is None
    assert job['errorCode'] == 'unsupported_size'
    assert job['errorDetail'] == f'model does not support size {size}'
    assert "width" not in job and "height" not in job


@pytest.mark.parametrize("size", ["768x1024", "auto"])
def test_imagegen_retains_size_while_job_is_running(imagegen_stub, monkeypatch, size):
    pending = []

    class DeferredThread:
        def __init__(self, *, target, **_):
            pending.append(target)

        def start(self):
            pass

    monkeypatch.setattr(web.threading, "Thread", DeferredThread)
    started = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="测试画面", size=size)))
    job = asyncio.run(web.api_imagegen_status(started["jobId"]))
    assert job["state"] == "running"
    assert job["size"] == size
    assert not imagegen_stub and len(pending) == 1


@pytest.mark.parametrize("base,asynchronous", [
    ("https://images.example.test/v1", False),
    ("https://api.apimart.ai/v1", True),
])
def test_auto_reaches_provider_protocol_without_fixed_size_fallback(monkeypatch, capsys, base, asynchronous):
    spec = importlib.util.spec_from_file_location('imagegen_auto_helper', ROOT / 'skills/shared/scripts/ai_image.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    monkeypatch.setattr(helper, 'load_and_require', lambda: (base, 'test-model', 'test-key', None))
    calls = []
    monkeypatch.setattr(helper, 'http_post', lambda endpoint, key, payload, **kwargs: calls.append(payload) or {})
    monkeypatch.setattr(helper, 'run_async', lambda *args: pytest.fail('Unsupported auto must fail before submitting'))
    monkeypatch.setattr(helper, 'save_sync_data', lambda *args: [])
    args = SimpleNamespace(prompt='test image', mode=None, size='auto', n=1, resolution='2k',
                           output='unused.png', format='png', quality=None, poll_interval=5, timeout=60)
    if asynchronous:
        with pytest.raises(SystemExit):
            helper.cmd_text2img(args)
        assert '不支持自动尺寸' in capsys.readouterr().err
        assert calls == []
    else:
        helper.cmd_text2img(args)
        assert len(calls) == 1 and calls[0]['size'] == 'auto'


def test_auto_metadata_and_actual_dimensions_survive_finished_job(imagegen_stub):
    started = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt='auto image', size=' AUTO ')))
    job = asyncio.run(web.api_imagegen_status(started['jobId']))
    image = web.IMAGEGEN_DIR / Path(job['url']).name
    assert web._read_imagegen_metadata(image)['size'] == 'auto'
    gallery = asyncio.run(web.api_imagegen_gallery())['images'][0]
    assert (gallery['width'], gallery['height']) == (120, 80)


def test_imagegen_finds_numbered_results_for_multiple_images(imagegen_stub, monkeypatch):
    def generate(cmd, **_):
        assert cmd[cmd.index("--n") + 1] == "2"
        output = Path(cmd[cmd.index("--output") + 1])
        for index in (1, 2):
            path = output.with_name(f"{output.stem}-20260930-120000-{index:02d}.png")
            Image.new("RGB", (120, 80)).save(path)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(web.subprocess, "run", generate)
    started = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="测试画面", n=2)))
    job = asyncio.run(web.api_imagegen_status(started["jobId"]))
    assert job["state"] == "done"
    assert job["url"].endswith("-01.png")
    assert len(asyncio.run(web.api_imagegen_gallery())["images"]) == 2


def test_gallery_returns_real_dimensions_for_all_supported_image_formats(imagegen_stub):
    web.IMAGEGEN_DIR.mkdir()
    expected = {}
    for index, extension in enumerate(("png", "jpg", "jpeg", "webp")):
        path = web.IMAGEGEN_DIR / f"image.{extension}"
        dimensions = (90 + index, 120 + index)
        Image.new("RGB", dimensions).save(path)
        os.utime(path, (1000 + index, 1000 + index))
        expected[path.name] = dimensions
    (web.IMAGEGEN_DIR / "notes.txt").write_text("not an image", encoding="utf-8")
    images = asyncio.run(web.api_imagegen_gallery())["images"]
    assert [item["name"] for item in images] == ["image.webp", "image.jpeg", "image.jpg", "image.png"]
    for item in images:
        assert (item["width"], item["height"]) == expected[item["name"]]


def test_unreadable_gallery_image_does_not_break_listing(imagegen_stub):
    web.IMAGEGEN_DIR.mkdir()
    (web.IMAGEGEN_DIR / "broken.png").write_bytes(b"not an image")
    images = asyncio.run(web.api_imagegen_gallery())["images"]
    assert len(images) == 1
    assert "width" not in images[0] and "height" not in images[0]


def test_custom_model_reaches_provider_environment_and_saved_job_metadata(imagegen_stub, monkeypatch):
    calls = []
    def generate(cmd, **kwargs):
        calls.append(kwargs['env'])
        Image.new('RGB', (40, 30)).save(Path(cmd[cmd.index('--output') + 1]))
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    monkeypatch.setattr(web.subprocess, 'run', generate)
    result = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt='custom image', model='custom/image-v2')))
    job = asyncio.run(web.api_imagegen_status(result['jobId']))
    assert calls[0]['IMG_MODEL'] == job['model'] == 'custom/image-v2'
    assert calls[0]['IMG_BASE_URL'] == 'https://images.example.test/v1'
    assert calls[0]['IMG_API_KEY'] == 'test-image-key'
    metadata = web._read_imagegen_metadata(web.IMAGEGEN_DIR / Path(job['url']).name)
    assert metadata['model'] == 'custom/image-v2'
    assert 'test-image-key' not in str(job) + str(metadata)


def test_queued_image_keeps_channel_snapshot_when_settings_change(imagegen_stub, monkeypatch):
    pending, calls = [], []
    class Deferred:
        def __init__(self, *, target, **_): pending.append(target)
        def start(self): pass
    monkeypatch.setattr(web.threading, 'Thread', Deferred)
    asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt='queued', model='chosen-model')))
    monkeypatch.setattr(web, '_read_env', lambda: {'IMG_MODEL': 'new-model', 'IMG_BASE_URL': 'https://other.test', 'IMG_API_KEY': 'new-key'})
    def generate(cmd, **kwargs):
        calls.append(kwargs['env'])
        return SimpleNamespace(returncode=1, stdout='', stderr='controlled')
    monkeypatch.setattr(web.subprocess, 'run', generate)
    pending[0]()
    assert calls[0]['IMG_MODEL'] == 'chosen-model'
    assert calls[0]['IMG_BASE_URL'] == 'https://images.example.test/v1'
    assert calls[0]['IMG_API_KEY'] == 'test-image-key'


@pytest.mark.parametrize('model', ['', 'a' * 201, 'bad\nIMG_API_KEY=x', 'bad\x00id'])
def test_custom_model_validation_prevents_provider_jobs(imagegen_stub, model):
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt='test', model=model)))
    assert not imagegen_stub and not web._IMAGEGEN_JOBS


def test_image_model_save_persists_without_overwriting_channel_credentials(tmp_path, monkeypatch):
    env_file = tmp_path / '.env'
    env_file.write_text('IMG_MODEL=old\nIMG_API_KEY=test-secret\nIMG_BASE_URL=https://images.example.test/v1\n', encoding='utf-8')
    monkeypatch.setattr(web, 'ENV_FILE', env_file)
    result = asyncio.run(web.api_env_save(web.EnvUpdateRequest(updates={'IMG_MODEL': 'custom/model-v2'})))
    assert result['ok']
    content = env_file.read_text(encoding='utf-8')
    assert 'IMG_MODEL=custom/model-v2\n' in content
    assert 'IMG_API_KEY=test-secret\n' in content
    for value in ['bad\nIMG_API_KEY=changed', 'x' * 201]:
        with pytest.raises(web.HTTPException):
            asyncio.run(web.api_env_save(web.EnvUpdateRequest(updates={'IMG_MODEL': value})))
        assert env_file.read_text(encoding='utf-8') == content
