"""Local video jobs backed by the shared, configured ai_video CLI.

Only a verified downloaded MP4 is published. Cancelling terminates local work;
the provider API has no shared remote cancellation contract.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
import urllib.parse
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from image_inputs import reference_path
from model_registry import MODEL_GROUPS, configured_providers

RATIOS = ["16:9", "9:16", "1:1"]
TERMINAL = {"done", "error", "cancelled"}
CANCEL_HINT = "已停止本地等待和下载；服务商任务可能仍在生成并计费。"
DEFAULT_MODELS = {
    "dashscope": "wan2.1-t2v-turbo", "ark": "doubao-seedance-1-0-lite-t2v",
    "openai-compatible": "", "xhs-maas": "happyhorse-1.0-t2v",
    "agnes": "agnes-video-2.5-flash", "kling": "",
}
MODEL_KEYS = {
    "dashscope": ("DASHSCOPE_VIDEO_MODEL", "DASHSCOPE_MODEL"),
    "ark": ("ARK_MODEL",), "openai-compatible": ("VIDEO_MODEL", "VIDEO_MODEL_NAME"),
    "xhs-maas": ("XHS_MAAS_T2V_MODEL",), "agnes": ("AGNES_MODEL",),
}
# Conservative presets accepted by the adapters; actual model constraints are
# still enforced by the provider. None omits --duration and uses its default.
DURATIONS = {"dashscope": [5], "ark": [5, 10], "kling": [5, 10],
             "openai-compatible": [4, 8, 12], "xhs-maas": [5, 10],
             "agnes": list(range(4, 13))}


class VideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=2000)
    mode: Literal["text2video", "image2video"] = "text2video"
    provider: str = Field(min_length=1, max_length=60)
    ratio: Literal["16:9", "9:16", "1:1"]
    duration: StrictInt | None = None
    referenceId: str | None = None


def provider_config(env: dict[str, str]) -> dict:
    # Do not mistake a configured chat endpoint for a dedicated video gateway.
    video_env = dict(env)
    if not all(env.get(key, "").strip() for key in ("VIDEO_API_KEY", "VIDEO_BASE_URL")):
        for key in ("VIDEO_API_KEY", "VIDEO_BASE_URL", "OPENAI_API_KEY", "API_KEY",
                    "OPENAI_BASE_URL", "BASE_URL"):
            video_env.pop(key, None)
    ready = {entry["id"] for entry in configured_providers("video", video_env)}
    providers = []
    for entry in MODEL_GROUPS["video"]["providers"]:
        identifier = entry["id"]
        model = next((env[key].strip() for key in MODEL_KEYS.get(identifier, ())
                      if env.get(key, "").strip()), DEFAULT_MODELS[identifier])
        image_model = (env.get("XHS_MAAS_I2V_MODEL", "").strip() or "happyhorse-1.0-i2v"
                       if identifier == "xhs-maas" else model)
        modes = ["text2video", "image2video"]
        if identifier in {"dashscope", "ark"}:
            if "t2v" in model.lower():
                modes = ["text2video"]
            elif "i2v" in model.lower():
                modes = ["image2video"]
        hint = ("配置完整；实际支持的时长和画幅以所选模型为准，生成按服务商计费。"
                if identifier in ready else "视频通道未配置，请前往设置 → 生视频通道填写凭据。")
        if identifier in {"dashscope", "kling"}:
            hint += " 图生视频画幅随参考图，参考图比例需与所选画幅一致。"
        if len(modes) == 1:
            hint += " 当前模型仅用于" + ("文生视频。" if modes[0] == "text2video" else "图生视频。")
        ratios = RATIOS
        if identifier == "openai-compatible":
            ratios = ["16:9", "9:16"]
            hint += " 兼容历史 Videos 协议；参考图等比缩放并补黑边至所选画幅的 720p 尺寸。"
            if not model:
                ready.discard(identifier)
                hint = "请填写 VIDEO_MODEL，使用兼容视频服务商实际提供的模型。" + hint
            if urllib.parse.urlsplit(env.get("VIDEO_BASE_URL", "")).hostname == "api.openai.com":
                ready.discard(identifier)
                hint = "OpenAI 官方 Videos API 已于 2026-09-24 下线；请配置仍提供视频服务的兼容网关或选择其他服务。"
        providers.append({"id": identifier, "name": entry["name"], "configured": identifier in ready,
                          "model": model, "imageModel": image_model, "modes": modes,
                          "ratios": ratios, "durations": DURATIONS[identifier], "hint": hint})
    preferred = env.get("VIDEO_PROVIDER", "").strip()
    default = preferred if preferred in ready else next(iter(ready)) if len(ready) == 1 else ""
    return {"providers": providers, "defaultProvider": default,
            "cancelHint": CANCEL_HINT, "billingHint": "提交任务会调用已配置的视频服务，可能产生费用。"}


def redact_error(message: str, env: dict[str, str]) -> str:
    text = str(message)
    for key, value in env.items():
        if re.search(r"KEY|TOKEN|SECRET|PASSWORD|AUTH", key, re.I) and value:
            text = text.replace(value, "[已隐藏]")
    text = re.sub(r"https?://[^\s\"'<>]+", "[服务地址]", text)
    text = re.sub(r"Bearer\s+[\w.\-]+", "Bearer [已隐藏]", text, flags=re.I)
    return text[-600:]


def validate_mp4(path: Path) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 32:
        raise ValueError("生成服务未返回有效视频文件")
    # Check ISO BMFF boxes, not a filename or URL alone. Full playback remains a
    # browser/provider acceptance check; reject HTML, empty and truncated files.
    size = path.stat().st_size
    found = set()
    with path.open("rb") as stream:
        offset = 0
        while offset < size:
            header = stream.read(8)
            if len(header) != 8:
                raise ValueError("返回的视频文件不完整")
            length, kind = int.from_bytes(header[:4], "big"), header[4:]
            minimum = 8
            if length == 1:
                extra = stream.read(8)
                if len(extra) != 8:
                    raise ValueError("返回的视频文件不完整")
                length, minimum = int.from_bytes(extra, "big"), 16
            if length == 0:
                length = size - offset
            if length < minimum or offset + length > size:
                raise ValueError("返回的视频文件不完整")
            found.add(kind)
            offset += length
            stream.seek(offset)
    if not {b"ftyp", b"moov", b"mdat"}.issubset(found):
        raise ValueError("服务返回的文件不是可识别的 MP4 视频")
    import cv2
    capture = cv2.VideoCapture(str(path))
    try:
        readable, frame = capture.read()
        if not readable or frame is None or not frame.size:
            raise ValueError("视频文件无法解码，未保存为成功结果")
    finally:
        capture.release()


class VideoService:
    def __init__(self, project_root, output_getter, reference_getter, env_getter, child_env_getter):
        self.project_root = Path(project_root)
        self.output_getter = output_getter
        self.reference_getter = reference_getter
        self.env_getter = env_getter
        self.child_env_getter = child_env_getter
        self.jobs: dict[str, dict] = {}
        self.events: dict[str, threading.Event] = {}
        self.lock = threading.RLock()
        self.timeout = 1200

    @property
    def directory(self):
        return self.output_getter() / "AI生视频"

    def environment(self):
        env = dict(self.child_env_getter())
        # Freeze the same settings seen in the UI for this job, including quotes.
        env.update({key: str(value).strip().strip("\"'") for key, value in self.env_getter().items()})
        env["PYTHONIOENCODING"] = "utf-8"
        return env

    def _safe_directory(self):
        directory = self.directory
        if directory.is_symlink() or directory.resolve().parent != self.output_getter().resolve():
            raise HTTPException(400, "视频输出目录不安全，请检查存储位置")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _save(self, job):
        directory = self._safe_directory()
        path = directory / f".{job['jobId']}.easel-video.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)

    def _load(self):
        directory = self.directory
        if not directory.is_dir() or directory.is_symlink():
            return
        for path in directory.glob(".*.easel-video.json"):
            try:
                if path.is_symlink() or path.stat().st_size > 64 * 1024:
                    continue
                value = json.loads(path.read_text(encoding="utf-8"))
                identifier = value.get("jobId", "")
                if not re.fullmatch(r"[0-9a-f]{32}", identifier) or identifier in self.jobs:
                    continue
                if value.get("state") not in TERMINAL | {"running"}:
                    continue
                if value.get("state") == "running":
                    value.update(state="error", url=None,
                                 error="工作台已重启，本地任务中断；服务商可能仍在生成并计费。")
                    self._save(value)
                self.jobs[identifier] = value
            except (ValueError, OSError, AttributeError):
                continue

    def _result_path(self, job):
        filename = job.get("filename", "")
        if not isinstance(filename, str) or not filename or Path(filename).name != filename:
            return None
        path = self.directory / filename
        if (path.is_symlink() or not path.is_file() or path.stat().st_size == 0
                or path.resolve().parent != self.directory.resolve()):
            return None
        return path

    def _reconcile_result(self, job):
        if job.get("state") == "done" and self._result_path(job) is None:
            job.update(state="error", url=None, error="视频结果文件已删除或移动，请到内容库检查")
            self._save(job)

    def snapshot(self):
        with self.lock:
            self._load()
            jobs = sorted(self.jobs.values(), key=lambda job: job.get("started", 0), reverse=True)
            videos = []
            for job in jobs:
                self._reconcile_result(job)
                if job.get("state") != "done":
                    continue
                path = self._result_path(job)
                videos.append({"name": path.name, "url": job["url"],
                               "mtime": int(path.stat().st_mtime), "generation": dict(job)})
            return {**provider_config(self.environment()), "videos": videos[:60],
                    "jobs": [dict(job) for job in jobs[:40]]}

    def start(self, req: VideoRequest):
        prompt = req.prompt.strip()
        if not prompt:
            raise HTTPException(400, "请填写视频画面或运动描述")
        env = self.environment()
        provider = next((item for item in provider_config(env)["providers"] if item["id"] == req.provider), None)
        if not provider:
            raise HTTPException(400, "不支持的视频服务")
        if req.mode not in provider["modes"]:
            raise HTTPException(400, "当前视频模型不支持所选模式，请在设置中切换相应模型")
        if req.ratio not in provider["ratios"]:
            raise HTTPException(400, "当前视频协议不支持所选画幅，请选择横版或竖版")
        if req.duration is not None and req.duration not in provider["durations"]:
            raise HTTPException(400, "不支持的时长，请选择服务默认或当前服务列出的时长")
        reference = None
        if req.mode == "text2video" and req.referenceId:
            raise HTTPException(400, "使用参考图时请选择图生视频")
        if req.mode == "image2video":
            try:
                reference = reference_path(self.reference_getter(), req.referenceId)
                if req.provider in {"dashscope", "kling"}:
                    from PIL import Image
                    with Image.open(reference) as source:
                        width, height = (int(value) for value in req.ratio.split(":"))
                        if abs(source.width / source.height - width / height) > 0.03:
                            raise ValueError("当前服务图生视频画幅随参考图，请上传与所选画幅一致的图片")
            except (ValueError, OSError) as exc:
                raise HTTPException(400, str(exc)) from exc
        if not provider["configured"]:
            raise HTTPException(400, provider["hint"])
        with self.lock:
            self._load()
            if sum(job.get("state") == "running" for job in self.jobs.values()) >= 2:
                raise HTTPException(429, "最多同时生成两个视频，请等待现有任务结束")
            identifier = uuid.uuid4().hex
            directory = self._safe_directory()
            model = provider["imageModel"] if req.mode == "image2video" else provider["model"]
            filename = f"{time.strftime('%m%d-%H%M%S')}-{identifier[:12]}.mp4"
            job = {"jobId": identifier, "state": "running", "prompt": prompt,
                   "mode": req.mode, "provider": req.provider, "model": model,
                   "ratio": req.ratio, "duration": req.duration, "referenceId": req.referenceId,
                   "started": time.time(), "url": None, "error": None, "filename": filename}
            self._save(job)
            self.jobs[identifier] = job
            event = threading.Event()
            self.events[identifier] = event
        try:
            threading.Thread(target=self._run, args=(dict(job), reference, env, event, directory),
                             daemon=True, name=f"easel-video-{identifier[:8]}").start()
        except Exception:
            with self.lock:
                job.update(state="error", error="视频任务无法启动，请重试")
                self.events.pop(identifier, None)
                self._save(job)
            raise HTTPException(503, "视频任务无法启动，请重试") from None
        return {"jobId": identifier, "state": "running"}

    def _run(self, job, reference, env, event, directory):
        identifier = job["jobId"]
        partial = directory / f".{identifier}.partial.mp4"
        target = directory / job["filename"]
        cmd = [sys.executable, str(self.project_root / "skills/shared/scripts/ai_video.py"), job["mode"],
               "--provider", job["provider"], "--prompt", job["prompt"], "--ratio", job["ratio"],
               "--output", str(partial), "--timeout", "900", "--poll-interval", "5"]
        if job["model"]:
            cmd += ["--model", job["model"]]
        if job["duration"] is not None:
            cmd += ["--duration", str(job["duration"])]
        if reference:
            cmd += ["--image", str(reference)]
        process = None
        state, error, url = "error", None, None
        try:
            if event.is_set():
                state, error = "cancelled", CANCEL_HINT
                return
            kwargs = {"cwd": str(self.project_root), "env": env, "stdout": subprocess.PIPE,
                      "stderr": subprocess.PIPE, "text": True, "encoding": "utf-8", "errors": "replace"}
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
            process = subprocess.Popen(cmd, **kwargs)
            started = time.monotonic()
            while True:
                if event.is_set():
                    state, error = "cancelled", CANCEL_HINT
                    break
                if time.monotonic() - started > self.timeout:
                    error = "视频任务等待超时；服务商可能仍在生成并计费，请先核查服务商任务，避免重复提交。"
                    break
                try:
                    stdout, stderr = process.communicate(timeout=0.5)
                    if process.returncode != 0:
                        raise ValueError(redact_error(stderr or stdout or "视频生成失败", env))
                    validate_mp4(partial)
                    # Cancellation and publishing are mutually exclusive.
                    with self.lock:
                        if event.is_set():
                            state, error = "cancelled", CANCEL_HINT
                        else:
                            os.replace(partial, target)
                            state, url = "done", f"/api/media/{directory.name}/{target.name}"
                            self.jobs[identifier].update(state=state, url=url)
                    break
                except subprocess.TimeoutExpired:
                    continue
        except Exception as exc:
            error = redact_error(str(exc), env)
        finally:
            if process is not None and process.poll() is None:
                try:
                    process.kill()
                    process.communicate(timeout=5)
                except (OSError, subprocess.SubprocessError):
                    pass
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
            with self.lock:
                current = self.jobs[identifier]
                # A completed publish wins over a later cancellation request.
                current.update(state=state, error=error, url=url, finished=time.time())
                self.events.pop(identifier, None)
                try:
                    self._save(current)
                except OSError:
                    current.update(state="error", url=None, error="视频结果状态保存失败，请检查输出目录权限")

    def status(self, identifier):
        with self.lock:
            self._load()
            job = self.jobs.get(identifier)
            if not job:
                raise HTTPException(404, "视频任务不存在或已过期")
            self._reconcile_result(job)
            return dict(job)

    def cancel(self, identifier):
        with self.lock:
            job = self.status(identifier)
            if job["state"] in TERMINAL:
                return job
            self.events[identifier].set()
            current = self.jobs[identifier]
            current.update(state="cancelled", error=CANCEL_HINT, url=None, finished=time.time())
            self._save(current)
            return dict(current)


def create_router(service: VideoService):
    router = APIRouter(prefix="/api/videogen")

    @router.get("")
    async def gallery():
        return await asyncio.to_thread(service.snapshot)

    @router.post("")
    async def start(request: VideoRequest):
        return await asyncio.to_thread(service.start, request)

    @router.get("/{job_id}")
    async def status(job_id: str):
        return await asyncio.to_thread(service.status, job_id)

    @router.post("/{job_id}/cancel")
    async def cancel(job_id: str):
        return await asyncio.to_thread(service.cancel, job_id)

    return router
