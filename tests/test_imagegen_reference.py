"""Reference uploads and edit routing use real images with an isolated fake provider."""
import asyncio
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "web")]
import app as web
from image_inputs import store_reference, validate_mask, reference_path


def png(size=(30, 20), alpha=255):
    output = io.BytesIO()
    Image.new("RGBA", size, (40, 80, 100, alpha)).save(output, format="PNG")
    return output.getvalue()


@pytest.fixture
def studio(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "IMAGEGEN_INPUT_DIR", tmp_path / "references")
    monkeypatch.setattr(web, "IMAGEGEN_DIR", tmp_path / "outputs")
    monkeypatch.setattr(web, "_IMAGEGEN_JOBS", {})
    monkeypatch.setattr(web, "_read_env", lambda: {"IMG_BASE_URL": "https://images.example.test/v1",
        "IMG_MODEL": "image-test", "IMG_API_KEY": "fake-key"})
    monkeypatch.setattr(web, "child_env", lambda *_: {})
    calls = []
    class Inline:
        def __init__(self, *, target, **_): self.target = target
        def start(self): self.target()
    def generate(cmd, **_):
        calls.append(cmd)
        Path(cmd[cmd.index("--output") + 1]).write_bytes(png())
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    monkeypatch.setattr(web.threading, "Thread", Inline)
    monkeypatch.setattr(web.subprocess, "run", generate)
    return calls


def test_reference_upload_roundtrip_and_edit_metadata(studio):
    # Thread replacement is only for the job, not TestClient's event-loop portal.
    reference = store_reference(web.IMAGEGEN_INPUT_DIR, png(), "../参考图.png")
    assert reference["name"] == "参考图.png" and reference["width"] == 30
    result = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(
        prompt="保留主体，背景改为海边", mode="img2img", referenceId=reference["id"], size="auto")))
    job = asyncio.run(web.api_imagegen_status(result["jobId"]))
    assert job["state"] == "done" and job["mode"] == "img2img"
    cmd = studio[0]
    assert cmd[2] == "img2img" and cmd[cmd.index("--size") + 1] == "auto"
    assert Path(cmd[cmd.index("--image") + 1]) == reference_path(web.IMAGEGEN_INPUT_DIR, reference["id"])
    image = web.IMAGEGEN_DIR / Path(job["url"]).name
    metadata = web._read_imagegen_metadata(image)
    assert metadata["referenceId"] == reference["id"] and metadata["mode"] == "img2img"
    assert reference_path(web.IMAGEGEN_INPUT_DIR, reference["id"]).exists()


@pytest.mark.parametrize("identifier", [None, "../../secrets", "", "a" * 32])
def test_missing_or_untrusted_reference_never_starts_provider(studio, identifier):
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="edit", mode="img2img", referenceId=identifier)))
    assert failure.value.status_code == 400 and not studio


def test_text_mode_cannot_silently_ignore_reference(studio):
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="edit", referenceId="a" * 32)))
    assert not studio


def test_valid_mask_routed_and_wrong_masks_rejected(studio):
    original = store_reference(web.IMAGEGEN_INPUT_DIR, png(), "original.png")
    mask = store_reference(web.IMAGEGEN_INPUT_DIR, png(alpha=0), "mask.png")
    asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="edit", mode="img2img",
        referenceId=original["id"], maskId=mask["id"])))
    assert "--mask" in studio[0]
    opaque = reference_path(web.IMAGEGEN_INPUT_DIR, original["id"])
    with pytest.raises(ValueError, match="透明"):
        validate_mask(opaque, opaque)
    partial = store_reference(web.IMAGEGEN_INPUT_DIR, png(alpha=128), "partial.png")
    with pytest.raises(ValueError, match="完全透明"):
        validate_mask(opaque, reference_path(web.IMAGEGEN_INPUT_DIR, partial["id"]))
    small = store_reference(web.IMAGEGEN_INPUT_DIR, png((10, 10), 0), "small.png")
    with pytest.raises(ValueError, match="尺寸"):
        validate_mask(opaque, reference_path(web.IMAGEGEN_INPUT_DIR, small["id"]))


def test_async_mask_not_silently_discarded(studio, monkeypatch):
    original = store_reference(web.IMAGEGEN_INPUT_DIR, png(), "ref.png")
    mask = store_reference(web.IMAGEGEN_INPUT_DIR, png(alpha=0), "mask.png")
    monkeypatch.setattr(web, "_read_env", lambda: {"IMG_BASE_URL": "https://api.apimart.ai/v1"})
    with pytest.raises(web.HTTPException, match="不支持蒙版"):
        asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt="edit", mode="img2img",
            referenceId=original["id"], maskId=mask["id"])))
    assert not studio


def test_http_upload_decodes_bytes_and_enforces_local_write_guard(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "IMAGEGEN_INPUT_DIR", tmp_path)
    client = TestClient(web.app, base_url="http://127.0.0.1:7860", client=("127.0.0.1", 50123))
    response = client.post("/api/imagegen/references", files={"file": ("test.jpg", png(), "image/jpeg")})
    assert response.status_code == 200
    data = response.json()
    retrieved = client.get(data["url"])
    assert retrieved.status_code == 200 and retrieved.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(retrieved.content)).size == (30, 20)
    assert client.post("/api/imagegen/references", files={"file": ("x.png", b"not an image", "image/png")}).status_code == 400
    assert client.post("/api/imagegen/references", headers={"Origin": "https://evil.example"},
                       files={"file": ("x.png", png(), "image/png")}).status_code == 403


def test_upload_size_and_animation_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="10 MB"):
        store_reference(tmp_path, b"x" * (10 * 1024 * 1024 + 1), "big.png")
    with pytest.raises(ValueError):
        store_reference(tmp_path, b"<svg></svg>", "fake.png")
    animation = io.BytesIO()
    Image.new("RGBA", (10, 10), "red").save(animation, format="PNG", save_all=True,
        append_images=[Image.new("RGBA", (10, 10), "blue")], duration=100, loop=0)
    with pytest.raises(ValueError, match="静态图片"):
        store_reference(tmp_path, animation.getvalue(), "animated.png")


def test_images_edits_wire_contains_reference_and_mask_without_generation_fallback(tmp_path, monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location("reference_ai_image", ROOT / "skills/shared/scripts/ai_image.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    original, mask = tmp_path / "reference.png", tmp_path / "mask.png"
    original.write_bytes(png())
    mask.write_bytes(png(alpha=0))
    requests = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self): return b'{"data":[{"b64_json":"test-response"}]}'
    def open_request(request, timeout):
        requests.append(request)
        return Response()
    monkeypatch.setattr(helper, "_open", open_request)
    helper._post_edits_multipart("https://images.example.test/v1", "fake-test-key", "image-test", "keep subject",
        SimpleNamespace(image=str(original), mask=str(mask), n=1, size="auto"))
    request = requests[0]
    assert request.full_url == "https://images.example.test/v1/images/edits"
    assert request.get_method() == "POST"
    assert b'name="image"' in request.data and b'name="mask"' in request.data
    assert original.read_bytes() in request.data and mask.read_bytes() in request.data
    assert b"keep subject" in request.data and b"auto" in request.data
    assert b"fake-test-key" not in request.data
