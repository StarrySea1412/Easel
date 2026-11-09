"""Qizhi's remote Agent protocol, deliberately separate from local LLM tools."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import httpx

from .base import Descriptor, HarnessError

DEFAULT_BASE = "http://43.153.92.169:3001"
DEFAULT_PROJECT = "/home/cloudcli/projects/qizhi-agent"
DEFAULT_MODEL = "gpt-6-sol"
MAX_RESPONSE = 8 * 1024 * 1024


def config(env):
    base = env.get("CLOUDCLI_BASE_URL", DEFAULT_BASE).strip().rstrip("/")
    project = env.get("CLOUDCLI_PROJECT_PATH", DEFAULT_PROJECT).strip()
    model = env.get("CLOUDCLI_MODEL", DEFAULT_MODEL).strip()
    key = env.get("CLOUDCLI_API_KEY", "").strip()
    try:
        url = urlsplit(base)
        valid = (url.scheme in ("http", "https") and bool(url.hostname) and url.port != 0
                 and not url.username and not url.password and not url.query and not url.fragment
                 and url.path in ("", "/") and not any(c.isspace() for c in base))
    except ValueError:
        valid = False
    if not valid:
        raise HarnessError("Qizhi 服务地址必须是 HTTP(S) 根地址，不包含认证、路径或查询参数。")
    if (not project.startswith("/") or "\\" in project or ".." in PurePosixPath(project).parts
            or any(ord(c) < 32 for c in project)):
        raise HarnessError("Qizhi 项目目录必须是服务器上的绝对路径。")
    if not model or len(model) > 240 or any(c.isspace() for c in model):
        raise HarnessError("请填写 Qizhi 账号实际支持的模型。")
    if not key or len(key) > 4096 or any(c.isspace() for c in key) or not key.isascii():
        raise HarnessError("请先配置 Qizhi API Key。")
    return base, project, model, key


def public_config(env):
    try:
        config(env)
        ready = True
    except HarnessError:
        ready = False
    return {"baseUrl": env.get("CLOUDCLI_BASE_URL", DEFAULT_BASE),
            "projectPath": env.get("CLOUDCLI_PROJECT_PATH", DEFAULT_PROJECT),
            "model": env.get("CLOUDCLI_MODEL", DEFAULT_MODEL),
            "keyStored": bool(env.get("CLOUDCLI_API_KEY")), "configured": ready}


def pending_path(outputs, session):
    digest = hashlib.sha256(session.encode()).hexdigest()
    return Path(outputs) / "_harness" / "qizhi-pending" / (digest + ".json")


def pending(outputs, session):
    return pending_path(outputs, session).exists()


class QizhiAdapter:
    descriptor = Descriptor("qizhi", "Qizhi 远程 Agent", "Qizhi HTTP Agent",
                            "配置公网服务、远程项目目录与后端 API Key；工具在远程执行")

    async def run(self, request, emit, ask, bind):
        base, project, configured_model, key = config(request.env)
        model = request.model or configured_model
        if model != configured_model:
            raise HarnessError("Qizhi 模型已变化，请保存底座模型并新建对话。")
        target = hashlib.sha256(json.dumps([base, project, model, key]).encode()).hexdigest()
        session = ""
        if request.native_id:
            try:
                identity = json.loads(request.native_id)
                session = identity["sessionId"]
                if identity["target"] != target or not re.fullmatch(r"[\w.:-]{1,240}", session):
                    raise ValueError
            except (ValueError, TypeError, KeyError):
                raise HarnessError("Qizhi 会话或渠道配置不匹配，请使用原配置继续或新建对话。") from None
        outputs = Path(request.env.get("EASEL_OUTPUTS_DIR") or
                       Path(request.env.get("EASEL_DATA_DIR") or request.cwd) / "outputs")
        fence = pending_path(outputs, request.session_key or session or "console")
        fence.parent.mkdir(parents=True, exist_ok=True)
        request_id = uuid.uuid4().hex
        try:
            with fence.open("x", encoding="utf-8") as stream:
                # Local diagnostic identity only; never invent an upstream task ID.
                json.dump({"state": "unconfirmed", "sessionId": session, "target": target,
                           "localRequestId": request_id, "startedAt": time.time(),
                           "timeoutSeconds": request.timeout}, stream)
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            raise HarnessError("Qizhi 上次请求的远端终态尚未确认；请核查原任务，不要重复提交。") from None
        body = dict(projectPath=project, provider="codex", model=model,
                    stream=False, cleanup=False, createBranch=False, createPR=False,
                    message=request.prompt)
        if session:
            body["sessionId"] = session
        confirmed = False
        emit("activity", "Qizhi 远程执行中；本机技能与文件未自动上传。")
        try:
            # /api/agent returns one JSON result after the remote task finishes.
            # A 180-second read cap cut valid long-running tasks off prematurely.
            # The caller already bounds the whole turn with asyncio.wait_for.
            timeout = httpx.Timeout(request.timeout, connect=10, write=30, pool=10)
            async with httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False) as client:
                async with client.stream("POST", base + "/api/agent", json=body,
                                         headers={"X-API-Key": key}) as response:
                    if response.status_code != 200:
                        confirmed = response.status_code in (400, 401, 403, 404, 422)
                        raise HarnessError(f"Qizhi 返回 HTTP {response.status_code}；请核查认证、模型与任务状态。")
                    chunks, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_RESPONSE:
                            raise HarnessError("Qizhi 响应超出读取上限，远端任务结果待核实。")
                        chunks.append(chunk)
            try:
                result = json.loads(b"".join(chunks))
            except (ValueError, UnicodeError):
                raise HarnessError("Qizhi 返回的不是有效 JSON，远端任务结果待核实。") from None
            if not isinstance(result, dict) or type(result.get("success")) is not bool:
                raise HarnessError("Qizhi 缺少明确终态，远端任务结果待核实。")
            if result["success"] is False:
                confirmed = True
                raise HarnessError("Qizhi 已返回失败终态；请在远程工作台核查本轮错误。")
            returned = result.get("sessionId")
            if not isinstance(returned, str) or not re.fullmatch(r"[\w.:-]{1,240}", returned):
                raise HarnessError("Qizhi 未返回有效应用会话 ID，远端任务结果待核实。")
            if session and returned != session:
                raise HarnessError("Qizhi 返回了不同的应用会话，不替换原历史。")
            bind(json.dumps({"sessionId": returned, "target": target}, sort_keys=True))
            confirmed = True
            messages = result.get("messages")
            text = "\n".join(m["content"] for m in messages if isinstance(m, dict)
                             and m.get("kind") == "text" and m.get("role") == "assistant"
                             and isinstance(m.get("content"), str)) if isinstance(messages, list) else ""
            if not text.strip():
                raise HarnessError("Qizhi 返回成功但没有助手文本，不视为对话成功。")
            emit("token", text.replace(key, "[REDACTED_SECRET]"))
        except (httpx.HTTPError, asyncio.CancelledError) as exc:
            emit("activity", "Qizhi 连接已结束，远端是否停止尚未确认；本轮不会自动重发。")
            if isinstance(exc, asyncio.CancelledError):
                raise
            if isinstance(exc, httpx.ReadTimeout):
                detail = f"Qizhi 等待远端响应超过本轮 {request.timeout} 秒上限"
            elif isinstance(exc, httpx.ConnectTimeout):
                detail = "连接 Qizhi 服务超时"
            elif isinstance(exc, httpx.WriteTimeout):
                detail = "向 Qizhi 发送请求超时"
            elif isinstance(exc, httpx.PoolTimeout):
                detail = "等待 Qizhi 可用连接超时"
            else:
                detail = "Qizhi 网络连接中断或响应传输失败"
            raise HarnessError(detail + "，远端任务状态未知；请核查原任务，不要重复提交。") from None
        finally:
            if confirmed:
                fence.unlink(missing_ok=True)
