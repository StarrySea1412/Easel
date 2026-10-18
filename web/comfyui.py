"""Fail-closed ComfyUI video workflow adapter.

ComfyUI is intentionally kept separate from the paid video providers. A user
must configure an API-format workflow and a reachable ComfyUI URL before a
request can be submitted.
"""
from __future__ import annotations

import copy
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt

try:
    from .cinematic_prompt import FIELDS as CINEMATIC_FIELDS, build_cinematic_prompt, normalize_cinematic_brief
except ImportError:  # Loaded as a top-level module by the legacy web launcher.
    from cinematic_prompt import FIELDS as CINEMATIC_FIELDS, build_cinematic_prompt, normalize_cinematic_brief
from easel.artifacts import ArtifactStore, scope
def validate_mp4(path: Path) -> None:
    """Reuse the existing strict validator without importing videogen at module load."""
    try:
        from .videogen import validate_mp4 as _validate
    except ImportError:  # Loaded as a top-level module by the legacy web launcher.
        from videogen import validate_mp4 as _validate
    _validate(path)

_DEMO_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
)


def _demo_font(size: int):
    from PIL import ImageFont
    for path in _DEMO_FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # 旧 Pillow 的 load_default 没有 size 参数
        return ImageFont.load_default()


def _wrap_text(draw, text: str, font, max_px: float, max_lines: int) -> list[str]:
    """贪心按像素换行；超出上限的行尾加省略号。"""
    lines: list[str] = []
    current = ""
    consumed = 0
    for char in text:
        candidate = current + char
        if current and draw.textlength(candidate, font=font) > max_px:
            lines.append(current)
            current = char
        else:
            current = candidate
        consumed += 1
        if len(lines) == max_lines:
            break
    if len(lines) < max_lines and current:
        lines.append(current)
    if lines and consumed < len(text):
        lines[-1] = lines[-1][:-1] + "…" if lines[-1] else "…"
    return lines


def _demo_frame(prompt: str, cinematic: Any, target: Path) -> None:
    """渲染占位帧：把实际输入（提示词与已填写的镜头语言参数）写进画面。"""
    from PIL import Image, ImageDraw
    width, height = 768, 432
    image = Image.new("RGB", (width, height), "#0f172a")
    draw = ImageDraw.Draw(image)
    title_font, sub_font, body_font, small_font = (_demo_font(24), _demo_font(14), _demo_font(19), _demo_font(13))
    margin = 36
    max_px = width - margin * 2
    draw.rectangle((0, 0, width, 5), fill="#f59e0b")
    draw.text((margin, 26), "Easel · ComfyUI 模拟输出", font=title_font, fill="#f8fafc")
    draw.text((margin, 60), "非模型生成 · 本地占位视频", font=sub_font, fill="#f59e0b")
    draw.text((margin, 98), "提示词", font=small_font, fill="#94a3b8")
    body = _wrap_text(draw, prompt or "（未填写提示词）", body_font, max_px, 7)
    y = 120
    for line in body:
        draw.text((margin, y), line, font=body_font, fill="#e2e8f0")
        y += 27
    brief = normalize_cinematic_brief(cinematic)
    labels = dict(CINEMATIC_FIELDS)
    summary = " · ".join(f"{labels.get(key, key)}：{value}" for key, value in brief.items()) or "未填写镜头语言参数（可选）"
    draw.text((margin, 330), "镜头语言", font=small_font, fill="#94a3b8")
    summary_y = 350
    for line in _wrap_text(draw, summary, sub_font, max_px, 2):
        draw.text((margin, summary_y), line, font=sub_font, fill="#cbd5e1")
        summary_y += 20
    draw.text((margin, 398), time.strftime("模拟运行不调用任何模型服务 · %m-%d %H:%M"), font=small_font, fill="#64748b")
    image.save(target, format="PNG")

SAFE_NODE = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
SAFE_PROMPT_ID = re.compile(r"^[A-Za-z0-9_.-]{1,200}$")
VIDEO_EXTS = {".mp4"}
TERMINAL = {"done", "error", "cancelled"}


class ComfyError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


class ComfyVideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=2000)
    negativePrompt: str = Field(default="", max_length=1000)
    workflow: dict[str, Any] | None = None
    cinematic: dict[str, Any] | None = None
    promptNodeId: str | None = Field(default=None, max_length=120)
    promptInput: str = Field(default="text", max_length=80)
    negativeNodeId: str | None = Field(default=None, max_length=120)
    negativeInput: str = Field(default="text", max_length=80)
    overrides: dict[str, Any] = Field(default_factory=dict)
    sessionId: str | None = Field(default=None, max_length=120)
    turnId: str | None = Field(default=None, max_length=200)
    demo: bool = False


def _base_url(env: dict[str, str]) -> str:
    value = (env.get("COMFYUI_BASE_URL") or env.get("COMFYUI_URL") or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return value


def _headers(env: dict[str, str]) -> dict[str, str]:
    key = env.get("COMFYUI_API_KEY", "").strip()
    return {"Accept": "application/json", **({"X-Api-Key": key} if key else {})}


def _workflow_path(root: Path, env: dict[str, str]) -> Path | None:
    raw = env.get("COMFYUI_WORKFLOW_PATH", "").strip()
    if not raw:
        return None
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = root / candidate
    return candidate.resolve()


def load_workflow(root: Path, env: dict[str, str], provided: dict[str, Any] | None = None) -> dict[str, Any]:
    if provided is not None:
        workflow = copy.deepcopy(provided)
    else:
        path = _workflow_path(root, env)
        if not path or not path.is_file():
            raw = env.get("COMFYUI_WORKFLOW_JSON", "").strip()
            if not raw:
                raise ComfyError("尚未配置 ComfyUI API 工作流 JSON")
            try:
                workflow = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ComfyError("COMFYUI_WORKFLOW_JSON 不是有效 JSON") from exc
        else:
            try:
                workflow = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ComfyError("ComfyUI 工作流文件无法读取或不是有效 JSON") from exc
    if not isinstance(workflow, dict) or not workflow:
        raise ComfyError("ComfyUI 工作流必须是非空 API 格式节点对象")
    for node_id, node in workflow.items():
        if not SAFE_NODE.fullmatch(str(node_id)) or not isinstance(node, dict):
            raise ComfyError("ComfyUI 工作流包含无效节点")
        if not isinstance(node.get("class_type"), str) or not isinstance(node.get("inputs"), dict):
            raise ComfyError("ComfyUI 工作流必须使用 API 格式的 class_type/inputs")
    return workflow


def _find_text_nodes(workflow: dict[str, Any]) -> list[str]:
    result = []
    for node_id, node in workflow.items():
        klass = str(node.get("class_type", "")).lower()
        inputs = node.get("inputs", {})
        if ("textencode" in klass or "cliptext" in klass) and isinstance(inputs, dict) and "text" in inputs:
            result.append(node_id)
    return result


def prepare_workflow(workflow: dict[str, Any], *, prompt: str, negative: str = "",
                     prompt_node: str | None = None, prompt_input: str = "text",
                     negative_node: str | None = None, negative_input: str = "text",
                     overrides: dict[str, Any] | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Inject only explicitly addressed scalar inputs into an API workflow."""
    value = copy.deepcopy(workflow)
    env = env or {}
    selected = prompt_node or env.get("COMFYUI_VIDEO_PROMPT_NODE", "").strip()
    text_nodes = _find_text_nodes(value)
    if not selected:
        if len(text_nodes) != 1:
            raise ComfyError("无法唯一确定正向提示词节点，请配置 COMFYUI_VIDEO_PROMPT_NODE")
        selected = text_nodes[0]
    if selected not in value or prompt_input not in value[selected]["inputs"]:
        raise ComfyError("正向提示词节点或输入字段不存在")
    value[selected]["inputs"][prompt_input] = prompt

    negative_node = negative_node or env.get("COMFYUI_VIDEO_NEGATIVE_NODE", "").strip() or None
    if negative:
        if not negative_node:
            candidates = [node for node in text_nodes if node != selected]
            if len(candidates) == 1:
                negative_node = candidates[0]
        if not negative_node or negative_node not in value or negative_input not in value[negative_node]["inputs"]:
            raise ComfyError("负向提示词已填写，但无法唯一确定负向节点")
        value[negative_node]["inputs"][negative_input] = negative

    for raw_key, raw_value in (overrides or {}).items():
        if not isinstance(raw_key, str) or "." not in raw_key or not isinstance(raw_value, (str, int, float, bool)):
            raise ComfyError("工作流参数覆盖只允许 nodeId.input 与基础值")
        node_id, input_name = raw_key.split(".", 1)
        if node_id not in value or not SAFE_NODE.fullmatch(node_id) or not input_name or input_name not in value[node_id]["inputs"]:
            raise ComfyError(f"工作流参数不存在：{raw_key}")
        value[node_id]["inputs"][input_name] = raw_value
    return value


def _json_request(url: str, *, method: str = "GET", payload: Any = None,
                  headers: dict[str, str] | None = None, timeout: float = 20) -> Any:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read(500).decode("utf-8", errors="replace")
        raise ComfyError(f"ComfyUI 请求失败（HTTP {exc.code}）：{detail}", status=exc.code) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ComfyError("无法连接 ComfyUI，请检查服务地址和服务状态") from exc
    try:
        return json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ComfyError("ComfyUI 返回了无法解析的 JSON") from exc


def _bytes_request(url: str, *, headers: dict[str, str] | None = None, timeout: float = 60) -> bytes:
    request = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ComfyError("ComfyUI 视频文件下载失败") from exc


class ComfyVideoService:
    def __init__(self, project_root, output_getter, env_getter, request_json=_json_request, request_bytes=_bytes_request, demo_render=None):
        self.root = Path(project_root).resolve()
        self.output_getter = output_getter
        self.env_getter = env_getter
        self.request_json = request_json
        self.request_bytes = request_bytes
        self.demo_render = demo_render
        self.jobs: dict[str, dict[str, Any]] = {}
        self.events: dict[str, threading.Event] = {}
        self.lock = threading.RLock()
        self.timeout = 1800
        self.poll_interval = 2
        self.demo_delay = 0.8

    @property
    def directory(self) -> Path:
        return self.output_getter() / "AI生视频" / "comfyui"

    def _env(self) -> dict[str, str]:
        return {str(k): str(v).strip().strip("\"'") for k, v in self.env_getter().items()}

    def _save(self, job: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self.directory / f".{job['jobId']}.easel-comfy.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, target)

    def _load(self) -> None:
        if not self.directory.is_dir():
            return
        for path in self.directory.glob(".*.easel-comfy.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                ident = data.get("jobId", "")
                if not SAFE_PROMPT_ID.fullmatch(ident) or ident in self.jobs:
                    continue
                if data.get("state") == "running":
                    data.update(state="error", error="Easel 重启时本地任务中断；ComfyUI 队列可能仍在运行。", url=None)
                    self._save(data)
                if data.get("state") in TERMINAL:
                    self.jobs[ident] = data
            except (OSError, ValueError, TypeError):
                continue

    def config(self) -> dict[str, Any]:
        env = self._env()
        base = _base_url(env)
        workflow = None
        error = ""
        try:
            workflow = load_workflow(self.root, env)
        except ComfyError as exc:
            error = str(exc)
        nodes = _find_text_nodes(workflow or {})
        return {"configured": bool(base and workflow and not error), "baseUrl": base,
                "workflowPath": str(_workflow_path(self.root, env) or ""),
                "workflowNodeCount": len(workflow or {}), "promptNodes": nodes,
                "promptNode": env.get("COMFYUI_VIDEO_PROMPT_NODE", "") or (nodes[0] if len(nodes) == 1 else ""),
                "error": error or None,
                "demoAvailable": bool(shutil.which("ffmpeg")),
                "note": "ComfyUI 只使用已配置工作流，不会自动切换到付费视频服务；未配置时可用本地模拟运行体验流程。"}

    def health(self) -> dict[str, Any]:
        env = self._env(); base = _base_url(env)
        if not base:
            return {"ok": False, "kind": "unconfigured", "detail": "未配置 COMFYUI_BASE_URL"}
        try:
            value = self.request_json(f"{base}/system_stats", headers=_headers(env), timeout=10)
            return {"ok": True, "kind": "ready", "detail": "ComfyUI 可访问", "system": value if isinstance(value, dict) else {}}
        except ComfyError as exc:
            return {"ok": False, "kind": "connection", "detail": str(exc)}

    def start(self, req: ComfyVideoRequest) -> dict[str, str]:
        env = self._env(); base = _base_url(env)
        if req.sessionId:
            try:
                scope(req.sessionId)
                if req.turnId:
                    scope(req.turnId)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        prompt = build_cinematic_prompt(req.prompt, req.cinematic)
        if not prompt:
            raise HTTPException(400, "请填写视频提示词")
        if req.demo:
            return self._start_demo(req, prompt)
        if not base:
            raise HTTPException(400, "ComfyUI 未配置，请设置 COMFYUI_BASE_URL；想先体验流程可用面板里的本地模拟运行")
        try:
            workflow = load_workflow(self.root, env, req.workflow)
            prepared = prepare_workflow(workflow, prompt=prompt, negative=req.negativePrompt,
                                        prompt_node=req.promptNodeId, prompt_input=req.promptInput,
                                        negative_node=req.negativeNodeId, negative_input=req.negativeInput,
                                        overrides=req.overrides, env=env)
        except ComfyError as exc:
            raise HTTPException(400, str(exc)) from exc
        try:
            result = self.request_json(f"{base}/prompt", method="POST",
                                       payload={"prompt": prepared, "client_id": env.get("COMFYUI_CLIENT_ID", "easel")},
                                       headers=_headers(env), timeout=30)
        except ComfyError as exc:
            raise HTTPException(502, str(exc)) from exc
        prompt_id = str(result.get("prompt_id", "")) if isinstance(result, dict) else ""
        if not SAFE_PROMPT_ID.fullmatch(prompt_id):
            raise HTTPException(502, "ComfyUI 未返回有效 prompt_id，任务未进入队列")
        with self.lock:
            self._load()
            ident = uuid.uuid4().hex
            job = {"jobId": ident, "state": "running", "mode": "live", "promptId": prompt_id,
                   "prompt": prompt, "negativePrompt": req.negativePrompt,
                   "cinematic": normalize_cinematic_brief(req.cinematic),
                   "sessionId": req.sessionId, "turnId": req.turnId or f"comfy-{ident}",
                   "started": time.time(), "finished": None, "url": None, "error": None,
                   "filename": f"{time.strftime('%m%d-%H%M%S')}-{ident[:12]}.mp4"}
            event = threading.Event(); self.jobs[ident] = job; self.events[ident] = event; self._save(job)
        threading.Thread(target=self._run, args=(dict(job), event, env), daemon=True,
                         name=f"easel-comfy-{ident[:8]}").start()
        return {"jobId": ident, "state": "running"}

    def _start_demo(self, req: ComfyVideoRequest, prompt: str) -> dict[str, str]:
        """Local placeholder run so the panel stays usable without ComfyUI."""
        with self.lock:
            self._load()
            ident = uuid.uuid4().hex
            job = {"jobId": ident, "state": "running", "mode": "demo", "promptId": f"demo-{ident[:12]}",
                   "prompt": prompt, "negativePrompt": req.negativePrompt,
                   "cinematic": normalize_cinematic_brief(req.cinematic),
                   "sessionId": req.sessionId, "turnId": req.turnId or f"comfy-{ident}",
                   "started": time.time(), "finished": None, "url": None, "error": None,
                   "filename": f"demo-{time.strftime('%m%d-%H%M%S')}-{ident[:8]}.mp4"}
            event = threading.Event(); self.jobs[ident] = job; self.events[ident] = event; self._save(job)
        threading.Thread(target=self._run_demo, args=(dict(job), event), daemon=True,
                         name=f"easel-comfy-demo-{ident[:8]}").start()
        return {"jobId": ident, "state": "running"}

    def _history(self, env: dict[str, str], prompt_id: str) -> dict[str, Any] | None:
        base = _base_url(env)
        value = self.request_json(f"{base}/history/{urllib.parse.quote(prompt_id, safe='')}", headers=_headers(env), timeout=20)
        if not isinstance(value, dict):
            return None
        item = value.get(prompt_id)
        return item if isinstance(item, dict) else value if "outputs" in value or "status" in value else None

    @staticmethod
    def _video_ref(history: dict[str, Any]) -> dict[str, str] | None:
        outputs = history.get("outputs") if isinstance(history, dict) else None
        if not isinstance(outputs, dict):
            return None
        for node in outputs.values():
            if not isinstance(node, dict):
                continue
            for key in ("gifs", "videos", "video", "images"):
                entries = node.get(key)
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    filename = str(entry.get("filename", ""))
                    if Path(filename).suffix.lower() in VIDEO_EXTS and Path(filename).name == filename:
                        return {"filename": filename, "subfolder": str(entry.get("subfolder", "")),
                                "type": str(entry.get("type", "output"))}
        return None

    def _run(self, job: dict[str, Any], event: threading.Event, env: dict[str, str]) -> None:
        ident = job["jobId"]; deadline = time.monotonic() + self.timeout
        try:
            while time.monotonic() < deadline and not event.is_set():
                history = self._history(env, job["promptId"])
                if history:
                    status = history.get("status") if isinstance(history.get("status"), dict) else {}
                    status_str = str(status.get("status_str", "")).lower()
                    if status_str in {"error", "failed"} or status.get("completed") is False and history.get("outputs") is None and status_str:
                        raise ComfyError("ComfyUI 工作流执行失败，请查看 ComfyUI 队列日志")
                    reference = self._video_ref(history)
                    if reference:
                        if event.is_set():
                            self._finish(ident, state="cancelled", url=None,
                                         error="已停止本地轮询；ComfyUI 队列可能仍在运行。")
                            return
                        query = urllib.parse.urlencode(reference)
                        data = self.request_bytes(f"{_base_url(env)}/view?{query}", headers=_headers(env), timeout=120)
                        self.directory.mkdir(parents=True, exist_ok=True)
                        partial = self.directory / f".{ident}.partial.mp4"
                        target = self.directory / job["filename"]
                        partial.write_bytes(data)
                        validate_mp4(partial)
                        if event.is_set():
                            partial.unlink(missing_ok=True)
                            self._finish(ident, state="cancelled", url=None,
                                         error="已停止本地轮询；ComfyUI 队列可能仍在运行。")
                            return
                        os.replace(partial, target)
                        relative = target.relative_to(self.output_getter().resolve()).as_posix()
                        if job.get("sessionId") and job.get("turnId"):
                            ArtifactStore(self.output_getter()).present(job["sessionId"], job["turnId"],
                                [{"path": relative, "description": "ComfyUI 视频工作流输出"}],
                                source="comfyui", call=job["promptId"])
                        self._finish(ident, state="done", url=f"/api/media/{urllib.parse.quote(relative)}", error=None)
                        return
                event.wait(self.poll_interval)
            if event.is_set():
                self._finish(ident, state="cancelled", url=None,
                             error="已停止本地轮询；ComfyUI 队列可能仍在运行。")
            else:
                self._finish(ident, state="error", url=None, error="ComfyUI 任务等待超时，未发布不完整视频。")
        except Exception as exc:
            if event.is_set():
                self._finish(ident, state="cancelled", url=None, error="已停止本地轮询；ComfyUI 队列可能仍在运行。")
            else:
                self._finish(ident, state="error", url=None, error=str(exc)[:600])

    def _render_demo(self, target: Path, job: dict[str, Any] | None = None) -> None:
        """Render an obviously synthetic placeholder clip; never a model output.

        占位画面会写入本次实际输入（提示词与已填写的镜头语言参数），让模拟运行
        也能完整演练“输入 → 产物”的链路；帧渲染失败时回退到无文字的测试图案。
        """
        if self.demo_render is not None:
            self.demo_render(target)
            return
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise ComfyError("模拟运行需要本机 ffmpeg；安装后重试，或配置 ComfyUI 后提交真实任务")
        job = job or {}
        frame = target.with_suffix(".png")
        try:
            _demo_frame(str(job.get("prompt") or ""), job.get("cinematic"), frame)
            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                       "-loop", "1", "-i", str(frame), "-t", "4", "-r", "24",
                       "-pix_fmt", "yuv420p", str(target)]
        except Exception:
            frame.unlink(missing_ok=True)
            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                       "-f", "lavfi", "-i", "testsrc2=duration=4:size=768x432:rate=24",
                       "-pix_fmt", "yuv420p", str(target)]
        try:
            completed = subprocess.run(command, capture_output=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ComfyError("模拟视频渲染失败") from exc
        finally:
            frame.unlink(missing_ok=True)
        if completed.returncode != 0 or not target.is_file():
            raise ComfyError("模拟视频渲染失败：ffmpeg 未生成文件")

    def _run_demo(self, job: dict[str, Any], event: threading.Event) -> None:
        ident = job["jobId"]
        try:
            if event.wait(self.demo_delay):
                self._finish(ident, state="cancelled", url=None, error="已取消模拟任务；未生成占位视频。")
                return
            self.directory.mkdir(parents=True, exist_ok=True)
            target = self.directory / job["filename"]
            self._render_demo(target, job)
            validate_mp4(target)
            if event.is_set():
                target.unlink(missing_ok=True)
                self._finish(ident, state="cancelled", url=None, error="已取消模拟任务；占位视频已清理。")
                return
            relative = target.relative_to(self.output_getter().resolve()).as_posix()
            if job.get("sessionId") and job.get("turnId"):
                ArtifactStore(self.output_getter()).present(job["sessionId"], job["turnId"],
                    [{"path": relative, "description": "模拟输出：本地占位视频（非模型生成）"}],
                    source="comfyui-demo", call=str(job.get("promptId") or ident))
            self._finish(ident, state="done", url=f"/api/media/{urllib.parse.quote(relative)}", error=None)
        except Exception as exc:
            if event.is_set():
                self._finish(ident, state="cancelled", url=None, error="已取消模拟任务。")
            else:
                self._finish(ident, state="error", url=None, error=str(exc)[:600])

    def _finish(self, ident: str, *, state: str, url: str | None, error: str | None) -> None:
        with self.lock:
            job = self.jobs.get(ident)
            if not job:
                return
            if job.get("state") == "cancelled" and state != "cancelled":
                return
            job.update(state=state, url=url, error=error, finished=time.time())
            self._save(job); self.events.pop(ident, None)

    def status(self, ident: str) -> dict[str, Any]:
        if not SAFE_PROMPT_ID.fullmatch(ident):
            raise HTTPException(404, "ComfyUI 任务不存在")
        with self.lock:
            self._load(); job = self.jobs.get(ident)
            if not job:
                raise HTTPException(404, "ComfyUI 任务不存在")
            return dict(job)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            self._load(); jobs = sorted(self.jobs.values(), key=lambda item: item.get("started", 0), reverse=True)
            return {"config": self.config(), "jobs": [dict(item) for item in jobs[:40]]}

    def cancel(self, ident: str) -> dict[str, Any]:
        with self.lock:
            job = self.jobs.get(ident)
            if not job:
                raise HTTPException(404, "ComfyUI 任务不存在")
            if job["state"] in TERMINAL:
                return dict(job)
            self.events.setdefault(ident, threading.Event()).set()
            message = ("已取消模拟任务；未生成占位视频。" if job.get("mode") == "demo"
                       else "已停止本地轮询；ComfyUI 队列可能仍在运行。")
            job.update(state="cancelled", url=None, error=message, finished=time.time())
            self._save(job)
            return dict(job)


def create_router(service: ComfyVideoService) -> APIRouter:
    router = APIRouter(prefix="/api/comfyui/video")

    @router.get("")
    def snapshot():
        return service.snapshot()

    @router.get("/config")
    def config():
        return service.config()

    @router.get("/health")
    def health():
        return service.health()

    @router.post("/prompt-preview")
    def prompt_preview(req: ComfyVideoRequest):
        return {"prompt": build_cinematic_prompt(req.prompt, req.cinematic),
                "cinematic": normalize_cinematic_brief(req.cinematic)}

    @router.post("")
    def start(req: ComfyVideoRequest):
        return service.start(req)

    @router.get("/{job_id}")
    def status(job_id: str):
        return service.status(job_id)

    @router.post("/{job_id}/cancel")
    def cancel(job_id: str):
        return service.cancel(job_id)

    return router

