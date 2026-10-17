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

