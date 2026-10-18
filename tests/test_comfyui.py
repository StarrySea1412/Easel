import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from web import comfyui


def workflow():
    return {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "old", "clip": ["4", 0]}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "negative", "clip": ["4", 0]}},
        "3": {"class_type": "SaveVideo", "inputs": {"filename_prefix": "easel", "images": ["5", 0]}},
    }


def test_prepare_workflow_requires_an_unambiguous_prompt_node():
    with pytest.raises(comfyui.ComfyError):
        comfyui.prepare_workflow({"1": {"class_type": "SaveVideo", "inputs": {}}}, prompt="x")
    result = comfyui.prepare_workflow(workflow(), prompt="主体", negative="不要文字", prompt_node="1", negative_node="2")
    assert result["1"]["inputs"]["text"] == "主体"
    assert result["2"]["inputs"]["text"] == "不要文字"
    with pytest.raises(comfyui.ComfyError):
        comfyui.prepare_workflow(workflow(), prompt="主体", overrides={"3.missing": 1})


def test_cinematic_prompt_is_bounded_and_labeled():
    value = comfyui.build_cinematic_prompt("海边", {"movement": "缓慢推进", "shot": "中景", "unknown": "drop"})
    assert value.startswith("海边；景别：中景；运镜：缓慢推进")
    assert "unknown" not in value
    assert len(comfyui.build_cinematic_prompt("x", {"style": "a" * 1000})) <= 2000


def test_service_submits_polls_downloads_and_registers_artifact(tmp_path, monkeypatch):
    calls = []
    history_calls = 0

    def request_json(url, **kwargs):
        nonlocal history_calls
        calls.append((url, kwargs))
        if url.endswith("/prompt"):
            assert kwargs["payload"]["prompt"]["1"]["inputs"]["text"].startswith("海边")
            return {"prompt_id": "comfy-run-1"}
        if "/history/" in url:
            history_calls += 1
            return {"comfy-run-1": {"status": {"status_str": "success", "completed": True},
                                     "outputs": {"3": {"gifs": [{"filename": "result.mp4", "subfolder": "", "type": "output"}]}}}}
        return {"system": "ok"}

    monkeypatch.setattr(comfyui, "validate_mp4", lambda path: None)
    service = comfyui.ComfyVideoService(tmp_path, lambda: tmp_path,
                                        lambda: {"COMFYUI_BASE_URL": "http://comfy.test", "COMFYUI_WORKFLOW_JSON": __import__("json").dumps(workflow()), "COMFYUI_VIDEO_PROMPT_NODE": "1", "COMFYUI_VIDEO_NEGATIVE_NODE": "2"},
                                        request_json=request_json, request_bytes=lambda *a, **k: b"video")
    service.poll_interval = 0.01
    started = service.start(comfyui.ComfyVideoRequest(prompt="海边", cinematic={"movement": "推进"}, sessionId="chat", turnId="turn"))
    for _ in range(100):
        job = service.status(started["jobId"])
        if job["state"] != "running":
            break
        time.sleep(0.01)
    assert job["state"] == "done"
    assert job["url"].startswith("/api/media/")
    assert history_calls >= 1
    assert (tmp_path / "AI生视频" / "comfyui" / job["filename"]).is_file()
    assert any("/prompt" in url for url, _ in calls)


def test_service_is_fail_closed_without_configured_workflow(tmp_path):
    service = comfyui.ComfyVideoService(tmp_path, lambda: tmp_path, lambda: {"COMFYUI_BASE_URL": "http://comfy.test"})
    with pytest.raises(Exception) as failure:
        service.start(comfyui.ComfyVideoRequest(prompt="x"))
    assert getattr(failure.value, "status_code", None) == 400


def test_router_exposes_config_and_health_without_submitting(tmp_path):
    from fastapi import FastAPI
    service = comfyui.ComfyVideoService(tmp_path, lambda: tmp_path, lambda: {})
    app = FastAPI()
    app.include_router(comfyui.create_router(service))
    client = TestClient(app)
    assert client.get("/api/comfyui/video/config").status_code == 200
    response = client.get("/api/comfyui/video/health")
    assert response.status_code == 200 and response.json()["kind"] == "unconfigured"



# A real 64x64 H.264 clip (1.7 KB) so the demo path exercises the actual MP4 checks.
TINY_MP4_B64 = """
AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAyVtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gy
NjQgLSBjb3JlIDE2NSByMzIyMyAwNDgwY2IwIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAt
IGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBh
bmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3Jhbmdl
PTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21h
X3FwX29mZnNldD0tMiB0aHJlYWRzPTIgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9
MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJf
YWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRf
bWluPTEwIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4w
IHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAIWWIhAAQ//73
gb8yy2Q/qslx+ed8UPyh0qwairOl4CszsQAAAApBmiRsQ7/+qZ00AAAACEGeQniHfwW9AAAACAGeYXRDfwd8AAAACAGeY2pDfwd9
AAAAEEGaZUmoQWiZTAhv//6nj4kAAAOBbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAlgAAQAAAQAAAAAAAAAAAAAAAAEA
AAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAqx0cmFrAAAAXHRr
aGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAlgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABA
AAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAJYAAAIAAABAAAAAAIkbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAA
AAAoAAAAGABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABz21pbmYAAAAUdm1oZAAA
AAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAY9zdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9h
dmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAA
AAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwBQPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAAB
AAAAFGJ0cnQAAAAAAAApggAAAAAAAAAYc3R0cwAAAAAAAAABAAAABgAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAAEBjdHRzAAAA
AAAAAAYAAAABAAAIAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAACAAAAAAcc3RzYwAAAAAAAAABAAAAAQAA
AAYAAAABAAAALHN0c3oAAAAAAAAAAAAAAAYAAALXAAAADgAAAAwAAAAMAAAADAAAABQAAAAUc3RjbwAAAAAAAAABAAAAMAAAAGF1
ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAA
AQAAAABMYXZmNjMuMS4xMDE=
"""


def test_demo_mode_renders_a_labeled_placeholder_without_comfyui(tmp_path, monkeypatch):
    import base64 as _base64
    fixture = _base64.b64decode(TINY_MP4_B64)
    monkeypatch.setattr(comfyui, "validate_mp4", lambda path: None)

    def render(target):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(fixture)

    service = comfyui.ComfyVideoService(tmp_path, lambda: tmp_path, lambda: {}, demo_render=render)
    service.demo_delay = 0.01
    started = service.start(comfyui.ComfyVideoRequest(prompt="海边日落", cinematic={"movement": "缓慢推进"}, demo=True))
    for _ in range(200):
        job = service.status(started["jobId"])
        if job["state"] != "running":
            break
        time.sleep(0.02)
    assert job["state"] == "done" and job["mode"] == "demo"
    assert job["prompt"].startswith("海边日落；运镜：缓慢推进")
    assert job["url"].startswith("/api/media/")
    assert (tmp_path / "AI生视频" / "comfyui" / job["filename"]).is_file()
    # The placeholder is clearly labeled for other surfaces (artifact description).
    saved = __import__("json").loads((tmp_path / "AI生视频" / "comfyui" / f".{job['jobId']}.easel-comfy.json").read_text(encoding="utf-8"))
    assert saved["mode"] == "demo" and saved["state"] == "done"


def test_demo_cancel_before_render_leaves_no_placeholder(tmp_path, monkeypatch):
    monkeypatch.setattr(comfyui, "validate_mp4", lambda path: None)
    rendered = []
    service = comfyui.ComfyVideoService(tmp_path, lambda: tmp_path, lambda: {},
                                        demo_render=lambda target: rendered.append(target))
    service.demo_delay = 30
    started = service.start(comfyui.ComfyVideoRequest(prompt="x", demo=True))
    service.cancel(started["jobId"])
    for _ in range(200):
        job = service.status(started["jobId"])
        if job["state"] != "running":
            break
        time.sleep(0.02)
    assert job["state"] == "cancelled" and "已取消模拟" in job["error"] and not rendered
    assert list((tmp_path / "AI生视频" / "comfyui").glob("*.mp4")) == []


def test_demo_flag_keeps_live_requests_fail_closed_without_config(tmp_path):
    service = comfyui.ComfyVideoService(tmp_path, lambda: tmp_path, lambda: {"COMFYUI_BASE_URL": "http://comfy.test"})
    with pytest.raises(Exception) as failure:
        service.start(comfyui.ComfyVideoRequest(prompt="x", demo=False))
    assert getattr(failure.value, "status_code", None) == 400


def test_demo_frame_carries_the_actual_prompt_and_cinematic(tmp_path):
    from PIL import Image
    frame = tmp_path / "frame.png"
    comfyui._demo_frame("海边日落，海浪轻拍沙滩", {"movement": "缓慢拉远", "lighting": "柔光"}, frame)
    assert frame.is_file() and frame.stat().st_size > 2000
    with Image.open(frame) as image:
        assert image.size == (768, 432)
    other = tmp_path / "other.png"
    comfyui._demo_frame("完全不同的一段提示词", None, other)
    assert other.read_bytes() != frame.read_bytes(), "不同输入应产生不同的占位帧"
    # 超长提示词按行截断，不抛错、不留帧内溢出（大小有界）。
    long_frame = tmp_path / "long.png"
    comfyui._demo_frame("很长的提示词内容" * 200, {"style": "纪录片"}, long_frame)
    assert long_frame.is_file() and long_frame.stat().st_size < 2_000_000
