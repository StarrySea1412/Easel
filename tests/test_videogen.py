"""Video studio contracts; external generation is always mocked, never billed."""
import importlib.util
import base64
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "web"), str(ROOT / "skills/shared/scripts")]
import app as web
import videogen
from image_inputs import store_reference

VIDEO = ROOT / "web/static/showcase/demo/jilong-news.mp4"
ENV = {"AGNES_API_KEY": "test-private-key", "VIDEO_PROVIDER": "agnes"}


def request(**changes):
    return videogen.VideoRequest(**{"prompt": "海边慢镜头", "provider": "agnes", "ratio": "16:9", **changes})


@pytest.fixture
def service(tmp_path):
    return videogen.VideoService(ROOT, lambda: tmp_path / "outputs", lambda: tmp_path / "references",
                                 lambda: dict(ENV), lambda: {})


@pytest.fixture
def inline(monkeypatch):
    class InlineThread:
        def __init__(self, *, target, args, **_):
            self.target, self.args = target, args
        def start(self):
            self.target(*self.args)
    monkeypatch.setattr(videogen.threading, "Thread", InlineThread)


def fake_generator(monkeypatch, *, content=None, returncode=0, stderr=""):
    calls = []
    class Process:
        def __init__(self, cmd, **kwargs):
            self.returncode = returncode
            self.killed = False
            calls.append((cmd, kwargs))
            if content is not False:
                path = Path(cmd[cmd.index("--output") + 1])
                if content is None:
                    shutil.copyfile(VIDEO, path)
                else:
                    path.write_bytes(content)
        def communicate(self, **_): return "", stderr
        def poll(self): return self.returncode
        def kill(self): self.killed = True
    monkeypatch.setattr(videogen.subprocess, "Popen", Process)
    return calls


def test_configuration_uses_video_settings_and_never_exposes_credentials():
    result = videogen.provider_config({**ENV, "ARK_API_KEY": "ark-secret"})
    assert result["defaultProvider"] == "agnes"
    encoded = json.dumps(result)
    assert "test-private-key" not in encoded and "ark-secret" not in encoded
    assert len(result["providers"]) == 6
    ark = next(p for p in result["providers"] if p["id"] == "ark")
    assert ark["model"] == "doubao-seedance-1-0-lite-t2v" and ark["modes"] == ["text2video"]
    result = videogen.provider_config({"OPENAI_API_KEY": "chat-secret", "OPENAI_BASE_URL": "https://chat.test"})
    assert not any(provider["configured"] for provider in result["providers"])
    assert result["defaultProvider"] == ""
    assert videogen.provider_config({"ARK_API_KEY": "a", "AGNES_API_KEY": "b"})["defaultProvider"] == ""


def test_compatible_video_requires_model_restricts_ratio_and_disables_retired_official_api():
    env = {"VIDEO_API_KEY": "key", "VIDEO_BASE_URL": "https://gateway.test/v1"}
    provider = lambda values: next(p for p in videogen.provider_config(values)["providers"]
                                  if p["id"] == "openai-compatible")
    assert not provider(env)["configured"]
    ready = provider({**env, "VIDEO_MODEL": "gateway-video"})
    assert ready["configured"] and ready["ratios"] == ["16:9", "9:16"]
    retired = provider({**env, "VIDEO_MODEL": "sora-2", "VIDEO_BASE_URL": "https://api.openai.com/v1"})
    assert not retired["configured"] and "2026-09-24" in retired["hint"]


def test_text_video_is_downloaded_verified_and_persisted(service, inline, monkeypatch):
    calls = fake_generator(monkeypatch)
    started = service.start(request(duration=5))
    job = service.status(started["jobId"])
    assert job["state"] == "done" and job["url"].startswith("/api/media/AI生视频/")
    cmd, kwargs = calls[0]
    assert cmd[2] == "text2video" and cmd[cmd.index("--ratio") + 1] == "16:9"
    assert cmd[cmd.index("--duration") + 1] == "5"
    assert kwargs["env"]["AGNES_API_KEY"] == "test-private-key"
    assert "test-private-key" not in " ".join(cmd)
    assert (service.directory / job["filename"]).is_file()
    assert not list(service.directory.glob("*.partial.mp4"))
    assert service.snapshot()["videos"][0]["generation"]["prompt"] == "海边慢镜头"
    reloaded = videogen.VideoService(ROOT, service.output_getter, service.reference_getter,
                                     service.env_getter, service.child_env_getter)
    assert reloaded.status(job["jobId"])["state"] == "done"
    assert service.cancel(job["jobId"])["state"] == "done"


def test_image_video_uses_sanitized_uploaded_reference(service, inline, monkeypatch):
    calls = fake_generator(monkeypatch)
    image = io.BytesIO()
    Image.new("RGB", (32, 18), "red").save(image, "PNG")
    reference = store_reference(service.reference_getter(), image.getvalue(), "../image.png")
    started = service.start(request(mode="image2video", referenceId=reference["id"]))
    assert service.status(started["jobId"])["state"] == "done"
    cmd = calls[0][0]
    assert cmd[2] == "image2video" and "--duration" not in cmd
    assert Path(cmd[cmd.index("--image") + 1]).parent == service.reference_getter()


def test_removed_result_is_reported_instead_of_returning_dead_success_url(service, inline, monkeypatch):
    fake_generator(monkeypatch)
    identifier = service.start(request())["jobId"]
    filename = service.status(identifier)["filename"]
    (service.directory / filename).unlink()
    job = service.status(identifier)
    assert job["state"] == "error" and job["url"] is None and "已删除" in job["error"]
    assert service.snapshot()["videos"] == []


def test_unsafe_output_directory_is_rejected_before_engine(service, inline, monkeypatch):
    calls = fake_generator(monkeypatch)
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == service.directory or original(path))
    with pytest.raises(HTTPException, match="输出目录不安全"):
        service.start(request())
    assert not calls


def test_image_ratio_cannot_be_silently_ignored_by_kling(service, inline, monkeypatch):
    calls = fake_generator(monkeypatch)
    service.env_getter = lambda: {"KLING_ACCESS_KEY": "ak", "KLING_SECRET_KEY": "sk"}
    image = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(image, "PNG")
    reference = store_reference(service.reference_getter(), image.getvalue(), "square.png")
    with pytest.raises(HTTPException, match="画幅一致"):
        service.start(request(provider="kling", mode="image2video", referenceId=reference["id"], ratio="16:9"))
    assert not calls


@pytest.mark.parametrize("changes", [
    {"prompt": "  "}, {"provider": "unknown"}, {"duration": 999},
    {"referenceId": "a" * 32}, {"mode": "image2video"},
    {"mode": "image2video", "referenceId": "../../private"},
    {"mode": "image2video", "referenceId": "a" * 32},
])
def test_invalid_request_never_starts_provider(service, inline, monkeypatch, changes):
    calls = fake_generator(monkeypatch)
    with pytest.raises(HTTPException) as failure:
        service.start(request(**changes))
    assert failure.value.status_code == 400 and not calls and not service.jobs


@pytest.mark.parametrize("changes", [{"duration": 5.5}, {"duration": True}, {"duration": "5"},
                                        {"ratio": "auto"}, {"model": "unconfigured"}, {"audio": "on"}])
def test_unsupported_or_coerced_options_rejected(changes):
    with pytest.raises(ValidationError):
        request(**changes)


def test_unconfigured_channel_and_model_mode_fail_without_engine(service, inline, monkeypatch):
    calls = fake_generator(monkeypatch)
    service.env_getter = lambda: {}
    with pytest.raises(HTTPException, match="未配置"):
        service.start(request())
    service.env_getter = lambda: {"ARK_API_KEY": "test"}
    with pytest.raises(HTTPException, match="不支持所选模式"):
        service.start(request(provider="ark", mode="image2video", referenceId="a" * 32))
    assert not calls


@pytest.mark.parametrize("content,returncode", [(b"<html>error</html>", 0), (b"", 0), (False, 0), (None, 1)])
def test_provider_failure_empty_missing_or_html_is_not_published(service, inline, monkeypatch, content, returncode):
    fake_generator(monkeypatch, content=content, returncode=returncode,
                   stderr="failed test-private-key https://service.test/private?token=abc")
    job = service.status(service.start(request())["jobId"])
    assert job["state"] == "error" and job["url"] is None
    assert "test-private-key" not in job["error"] and "token=abc" not in job["error"]
    assert service.snapshot()["videos"] == []
    assert not list(service.directory.glob("*.mp4"))


def test_truncated_and_fake_container_are_rejected(tmp_path):
    path = tmp_path / "fake.mp4"
    path.write_bytes(VIDEO.read_bytes()[:100])
    with pytest.raises(ValueError):
        videogen.validate_mp4(path)
    path.write_bytes(b"".join((16).to_bytes(4, "big") + kind + b"12345678"
                              for kind in (b"ftyp", b"moov", b"mdat")))
    with pytest.raises(ValueError):
        videogen.validate_mp4(path)


def test_cancel_before_worker_start_does_not_contact_provider(service, monkeypatch):
    targets = []
    class HeldThread:
        def __init__(self, *, target, args, **_): targets.append((target, args))
        def start(self): pass
    monkeypatch.setattr(videogen.threading, "Thread", HeldThread)
    calls = fake_generator(monkeypatch)
    identifier = service.start(request())["jobId"]
    stopped = service.cancel(identifier)
    assert stopped["state"] == "cancelled" and "计费" in stopped["error"]
    target, args = targets[0]
    target(*args)
    assert not calls and service.status(identifier)["state"] == "cancelled"


@pytest.mark.parametrize("cancel", [False, True])
def test_timeout_and_cancellation_kill_process_and_do_not_publish(service, inline, monkeypatch, cancel):
    processes = []
    class WaitingProcess:
        returncode = None
        def __init__(self, *_, **__): processes.append(self)
        def communicate(self, **_):
            if self.returncode is not None: return "", ""
            if cancel: next(iter(service.events.values())).set()
            raise subprocess.TimeoutExpired("test", 0.5)
        def poll(self): return self.returncode
        def kill(self): self.returncode = -1
    monkeypatch.setattr(videogen.subprocess, "Popen", WaitingProcess)
    service.timeout = 30 if cancel else -1
    job = service.status(service.start(request())["jobId"])
    assert job["state"] == ("cancelled" if cancel else "error")
    assert job["url"] is None and "计费" in job["error"]
    assert processes[0].returncode == -1


def test_restart_marks_interrupted_task_failed_and_cap_keeps_active_jobs(service, monkeypatch):
    class HeldThread:
        def __init__(self, **_): pass
        def start(self): pass
    monkeypatch.setattr(videogen.threading, "Thread", HeldThread)
    identifier = service.start(request())["jobId"]
    service.start(request())
    with pytest.raises(HTTPException) as error:
        service.start(request())
    assert error.value.status_code == 429
    reloaded = videogen.VideoService(ROOT, service.output_getter, service.reference_getter,
                                     service.env_getter, service.child_env_getter)
    job = reloaded.status(identifier)
    assert job["state"] == "error" and "重启" in job["error"] and job["url"] is None
    with pytest.raises(HTTPException) as error:
        reloaded.status("../bad")
    assert error.value.status_code == 404


def test_routes_use_same_origin_guard_and_return_unconfigured_state(service, monkeypatch):
    original = web._VIDEO_SERVICE
    for name in ("output_getter", "reference_getter", "env_getter", "child_env_getter", "jobs", "events"):
        monkeypatch.setattr(original, name, getattr(service, name))
    monkeypatch.setattr(original, "env_getter", lambda: {})
    client = TestClient(web.app, base_url="http://127.0.0.1:7860", client=("127.0.0.1", 50123))
    response = client.get("/api/videogen")
    assert response.status_code == 200 and response.json()["videos"] == []
    assert client.post("/api/videogen", json=request().model_dump()).status_code == 400
    assert client.post("/api/videogen", json=request().model_dump(),
                       headers={"Origin": "https://untrusted.test"}).status_code == 403
    assert client.get("/api/videogen/missing").status_code == 404
    assert client.post("/api/videogen/missing/cancel").status_code == 404


@pytest.fixture
def helper(monkeypatch):
    spec = importlib.util.spec_from_file_location("video_test_helper", ROOT / "skills/shared/scripts/ai_video.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    monkeypatch.setattr(helper, "require_env", lambda key: "https://fake.test" if "BASE" in key else "test-key")
    monkeypatch.setattr(helper, "_put_audio", lambda *args: None)
    return helper


def test_dashscope_ratio_is_pixel_size_and_image_mode_does_not_send_size(helper, monkeypatch):
    calls = []
    monkeypatch.setattr(helper, "http_request", lambda *args, **kwargs: calls.append(kwargs) or {"output": {"task_id": "id"}})
    monkeypatch.setattr(helper, "_poll", lambda *args, **kwargs: {"video_url": "https://fake.test/video.mp4"})
    monkeypatch.setattr(helper, "download_video", lambda url, output: output)
    args = SimpleNamespace(model="test", ratio="9:16", prompt="test", duration=5,
                           poll_interval=5, timeout=900, output="/unused.mp4")
    helper.generate_dashscope(args, None)
    assert calls[0]["payload"]["parameters"]["size"] == "720*1280"
    helper.generate_dashscope(args, "https://fake.test/reference.png")
    assert "size" not in calls[1]["payload"]["parameters"]


@pytest.mark.parametrize("status", ["", "queued", "in_progress", "failed", "cancelled"])
def test_openai_adapter_never_downloads_url_from_unfinished_or_failed_task(helper, monkeypatch, status):
    downloads, polls = [], []
    monkeypatch.setattr(helper, "http_request", lambda *args, **kwargs:
                        {"id": "id", "status": status, "url": "https://fake.test/input.png"})
    monkeypatch.setattr(helper, "_poll", lambda *args, **kwargs:
                        polls.append(args) or {"video_url": "https://fake.test/completed.mp4"})
    monkeypatch.setattr(helper, "download_video", lambda url, output: downloads.append(url) or output)
    args = SimpleNamespace(model="test", ratio="16:9", prompt="test", duration=4,
                           poll_interval=5, timeout=900, output="/unused.mp4")
    if status in {"failed", "cancelled"}:
        with pytest.raises(SystemExit): helper.generate_openai_compatible(args, None)
        assert not downloads and not polls
    else:
        helper.generate_openai_compatible(args, None)
        assert polls and downloads == ["https://fake.test/completed.mp4"]


@pytest.mark.parametrize("with_image", [False, True])
def test_videos_standard_json_wire_and_authenticated_content_download(helper, monkeypatch, tmp_path, with_image):
    requests, downloads = [], []
    class Response:
        def __init__(self, content): self.content = content
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self): return self.content
    def json_open(req, **_):
        requests.append(req)
        return Response(json.dumps({"id": "video_123", "status": "queued" if req.get_method() == "POST"
                                   else "completed"}).encode())
    def download_open(req, **_):
        downloads.append(req)
        return Response(VIDEO.read_bytes())
    monkeypatch.setattr(helper.urllib.request, "urlopen", json_open)
    monkeypatch.setattr(helper.urllib.request, "build_opener", lambda *_: SimpleNamespace(open=download_open))
    reference = tmp_path / "reference.png"
    Image.new("RGB", (48, 48), "red").save(reference)
    args = SimpleNamespace(model="gateway-video", ratio="16:9", prompt="test", duration=8,
                           poll_interval=0, timeout=900, output=str(tmp_path / "result.mp4"))
    helper.generate_openai_compatible(args, str(reference) if with_image else None)
    assert len(requests) == 2 and requests[0].get_method() == "POST"
    payload = json.loads(requests[0].data)
    assert payload["size"] == "1280x720" and payload["seconds"] == "8"
    assert payload["model"] == "gateway-video" and "image" not in payload
    if with_image:
        data = payload["input_reference"]["image_url"]
        assert data.startswith("data:image/png;base64,")
        with Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1]))) as image:
            assert image.size == (1280, 720)
            assert image.getpixel((0, 0)) == (0, 0, 0)
            assert image.getpixel((640, 360)) == (255, 0, 0)
    else:
        assert "input_reference" not in payload
    assert requests[1].full_url == "https://fake.test/videos/video_123"
    assert downloads[0].full_url == "https://fake.test/videos/video_123/content"
    assert downloads[0].get_header("Authorization") == "Bearer test-key"
    assert Path(args.output).read_bytes() == VIDEO.read_bytes()


def test_completed_response_without_url_downloads_content_without_poll(helper, monkeypatch, tmp_path):
    downloads = []
    monkeypatch.setattr(helper, "http_request", lambda *_args, **_kwargs: {"id": "video_id", "status": "completed"})
    monkeypatch.setattr(helper, "_poll", lambda *_args, **_kwargs: pytest.fail("completed job must not poll"))
    monkeypatch.setattr(helper, "download_video", lambda url, output, **kwargs:
                        downloads.append((url, kwargs)) or output)
    args = SimpleNamespace(model="gateway-video", ratio="9:16", prompt="test", duration=None,
                           poll_interval=0, timeout=900, output=str(tmp_path / "result.mp4"))
    helper.generate_openai_compatible(args, None)
    assert downloads == [("https://fake.test/videos/video_id/content", {"headers": {"Authorization": "Bearer test-key"}})]


@pytest.mark.parametrize("changes", [{"ratio": "1:1"}, {"duration": 5}])
def test_standard_videos_rejects_unsupported_parameters_before_request(helper, monkeypatch, changes):
    monkeypatch.setattr(helper, "http_request", lambda *_args, **_kwargs: pytest.fail("must validate before billing"))
    args = SimpleNamespace(**{"model": "gateway-video", "ratio": "16:9", "prompt": "test", "duration": 4,
                              "poll_interval": 0, "timeout": 900, "output": "/unused.mp4", **changes})
    with pytest.raises(SystemExit): helper.generate_openai_compatible(args, None)


def test_official_retired_videos_endpoint_is_not_called(helper, monkeypatch):
    monkeypatch.setattr(helper, "require_env", lambda key: "https://api.openai.com/v1" if "BASE" in key else "test-key")
    monkeypatch.setattr(helper, "http_request", lambda *_args, **_kwargs: pytest.fail("retired API must not be called"))
    with pytest.raises(SystemExit):
        helper.generate_openai_compatible(SimpleNamespace(model="sora-2"), None)


def test_content_download_redirect_does_not_leak_provider_credentials(helper):
    req = helper.urllib.request.Request("https://gateway.test/v1/videos/id/content",
                                       headers={"Authorization": "Bearer private", "Api-key": "also-private"})
    handler = helper._DownloadRedirectHandler()
    external = handler.redirect_request(req, None, 302, "Found", {}, "https://cdn.test/video.mp4")
    assert not external.get_header("Authorization") and not external.get_header("Api-key")
    internal = handler.redirect_request(req, None, 302, "Found", {}, "https://gateway.test/content.mp4")
    assert internal.get_header("Authorization") == "Bearer private"
