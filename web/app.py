"""Easel Web — FastAPI 后端（含 SSE 流式输出）."""
from __future__ import annotations

import asyncio
import os
if os.name == "nt":
    import msvcrt
else:
    import fcntl
import hashlib
import ipaddress
import json
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
import math
from sse_starlette.sse import EventSourceResponse

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = Path(__file__).resolve().parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(PROJECT_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

from easel.gateway_endpoint import healthz_url, chat_completions_url, describe
from easel.openclaw_cmd import openclaw_base_cmd
from easel.openclaw_workspace import state_dir as openclaw_state_dir
from easel.paths import child_env, data_root
from easel import local_records, publish_receipts, publish_followup
from easel.reasoning_stream import ReasoningStream, ThinkingTextStream, provider_reasoning, visible_text
from easel.gateway_auth import resolve_credentials as gateway_credentials, gateway_error, redact_gateway_text
try:
    sys.path.insert(0, str(PROJECT_ROOT / "mcp" / "easel-notify"))
    from notify_hook import notify_completion as _notify_email_completion, \
        notify_web_turn as _notify_email_web_turn
except Exception:  # 邮箱通知未安装/依赖缺失：钩子降级为空操作
    _notify_email_completion = None  # type: ignore
    _notify_email_web_turn = None  # type: ignore
from easel.persona import load_profile_text, persona_prefix, chat_turn_message, profile_exists, _FILE_ORDER
from easel.timeouts import TIMEOUT_CHAT, TIMEOUT_DIRECT, TIMEOUT_PRODUCE
from image_reverse import (
    Provider as ImageReverseProvider, reverse_image,
    MAX_BYTES as IMAGE_REVERSE_MAX_BYTES, MAX_PIXELS as IMAGE_REVERSE_MAX_PIXELS,
    FORMATS as IMAGE_REVERSE_FORMATS,
)
import model_health
import channel_profiles
try:
    from easel.gateway_questions import (
        GatewayClient, GatewayQuestionError, GatewayUnsupportedError,
        question_bridge_supported)
except Exception:  # 兼容缺失依赖：问答题桥接降级为关闭
    GatewayClient = None  # type: ignore
    GatewayQuestionError = None  # type: ignore
    GatewayUnsupportedError = None  # type: ignore
    question_bridge_supported = None  # type: ignore

# 问答题桥接的一次性诊断标记：连接失败/旧版本无 question RPC 的告警每进程只打一次，
# 避免每开一个新会话就在后端刷一行同样的错（用户反馈的噪音）。
_QBRIDGE_WARNED: set[str] = set()
# 进程级熔断：一旦确认桥接不可用（旧版本无 question RPC、或 connect 持续失败如
# NOT_PAIRED/scope-upgrade），就彻底停掉桥接，后续每轮直接跳过——不再连接，也就不再
# 每轮在网关上触发新的配对/权限申请。恢复需重启 easel web。
_QBRIDGE_DISABLED = False


def _qbridge_warn_once(key: str, message: str) -> None:
    if key in _QBRIDGE_WARNED:
        return
    _QBRIDGE_WARNED.add(key)
    print(message, file=sys.stderr, flush=True)

DATA_DIR = data_root(PROJECT_ROOT)
PROFILES_DIR = DATA_DIR / "profiles"
SKILLS_DIR = PROJECT_ROOT / "skills"
OUTPUTS_DIR = DATA_DIR / "outputs"

STATIC_DIR = Path(__file__).resolve().parent / "static"
REACT_DIR = Path(__file__).resolve().parent / "frontend" / "dist"
OPENCLAW_PROFILE = "easel"
# 对话传输层：http＝直连常驻 gateway 的 OpenAI 兼容端点，agent 在 gateway 进程里直接跑，
# 省掉每轮 spawn `openclaw agent` 瘦客户端的冷启动（本机实测同一句话：CLI 7.1-7.6s/轮，
# HTTP 4.1-4.5s/轮，差值就是客户端冷启动）；cli＝每轮 spawn 的老路径。
#
# 默认 http，但**只对新会话生效**：见 _resolve_transport。同一会话绝不中途换边——两条路径
# 写的是不同的 transcript，换边等于静默清空整段对话记忆（实测拿 CLI 去续一个 HTTP 起的会话，
# agent 直接答"无历史"）。设 EASEL_CHAT_TRANSPORT=cli 可整机回到老路径。
CHAT_TRANSPORT = os.environ.get("EASEL_CHAT_TRANSPORT", "http").strip().lower()
# 这里曾有个 OPENCLAW_WORKSPACE 常量，写死的是 2026.6.x 布局（~/.openclaw/workspace-<profile>）。
# 全仓无人引用，但留着迟早会被新代码拿去用，而 OpenClaw 的布局 2026.9.x 起已经变成
# <state 目录>/workspace（issue #19）。要用 workspace 路径请走 easel.openclaw_workspace.workspace_dir()，
# 它直接问 openclaw 要运行时真值，不猜版本。
# OpenClaw 会话历史（transcript）目录：<profile 配置目录>/agents/main/sessions/<session-id>.jsonl
OPENCLAW_SESSIONS_DIR = openclaw_state_dir() / "agents" / "main" / "sessions"

# 思考档位（每轮 --thinking）。前后端已完整支持展示思考：后端把 thinking_delta 转成 SSE
# `thinking` 事件，前端 MessageBubble 渲染「💭 思考过程」并在流式结束后持久保留。面板里有没有
# 内容取决于网关——支持 extended-thinking 的网关会按档位回传思考流；不支持的（如内网 codewiz，
# 实测 transcript 里 assistant 只有 text 块、thinking 恒为 0）面板留空，调高档位也不会有内容。
# 默认 medium：让支持思考的部署直接显示较完整思考；EASEL_THINKING_LEVEL 可覆盖（low 提速 / high 更详尽）。
THINKING_LEVEL = (os.environ.get("EASEL_THINKING_LEVEL", "").strip() or "medium")

# gateway 进程把原始事件流（token/thinking/收尾）写到的**单个共享文件**。
# 关键：`openclaw agent` 只是瘦客户端，没有 --raw-stream 标志——只有常驻 gateway 按它自己
# 的 OPENCLAW_RAW_STREAM/OPENCLAW_RAW_STREAM_PATH 写这个文件（见 scripts/gateway.sh）。
# web 侧 tail 它做流式；默认值必须与 gateway.sh 里 EASEL_RAW_STREAM_PATH 的默认一致。
SHARED_RAW_STREAM = Path(os.environ.get("EASEL_RAW_STREAM_PATH") or
                         (str(DATA_DIR / "logs" / "raw-stream.jsonl") if os.name == "nt" else "/tmp/easel-raw-stream.jsonl"))


class _GatewayHttpProc:
    """HTTP 直连模式下的「伪进程」：给主循环 / 停止逻辑提供 poll/wait/kill 兼容面。"""

    def __init__(self) -> None:
        self._done = False
        self._task = None

    def finish(self) -> None:
        self._done = True

    def poll(self):
        return 0 if self._done else None

    def terminate(self) -> None:
        self._done = True
        if self._task is not None:
            try:
                self._task.cancel()
            except Exception:  # noqa: BLE001
                pass

    def kill(self) -> None:
        self.terminate()

    def wait(self, timeout=None):  # 兼容 await asyncio.to_thread(proc.wait, ...)
        # 必须真的等：主循环拿它来决定「能不能放掉会话双锁」。提前返回会让下一轮在
        # 上一轮可能还在写同一份 transcript 时就启动 —— 正是双锁要防的并发写。
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self._done:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired("gateway-http-turn", timeout)
            time.sleep(0.05)
        return 0


def _native_agent_client(credentials):
    """Reuse existing approved identity only for the audited native contract."""
    import office_controls
    if GatewayClient is None:
        return None
    client = office_controls._model_probe_client('cli', credentials)
    if client.server_version == '2026.9.6' and {'agent', 'chat.abort', 'agent.wait'}.issubset(client.methods):
        return client
    client.close()
    return None


_HTTP_READY_CACHE: dict = {"at": -1e9, "ok": False}
_HTTP_READY_TTL = 60.0          # 探针要打一次真端点，别每轮都付这个 RTT


def _gateway_http_ready(force: bool = False) -> bool:
    """探测 gateway 的 /v1/chat/completions 到底挂没挂上。

    **不能探 /v1/models**：那个路径会被 gateway 控制台 SPA 的 catch-all 接走，端点没开也照样
    返回 200（body 是 OpenClaw Control 的 HTML 首页）—— 探了等于没探，只要网关活着就恒为 True。
    这里直接打真端点：openclaw 要求 gateway.http.endpoints.chatCompletions.enabled === true
    才挂这条路由（默认 false），没开就是 404；开了则因为 body 缺 messages 返回 400。用 400 当
    "端点在"的证据，既走完整条路由又不消耗一次模型调用。
    """
    now = time.monotonic()
    credentials = gateway_credentials()
    auth_key = credentials.fingerprint()
    endpoint = chat_completions_url()
    if (not force and _HTTP_READY_CACHE.get('auth') == auth_key
            and _HTTP_READY_CACHE.get('endpoint') == endpoint
            and now - _HTTP_READY_CACHE["at"] < _HTTP_READY_TTL):
        return bool(_HTTP_READY_CACHE["ok"])
    ok = False
    try:
        import httpx  # noqa: F401  HTTP 路径全靠它做 SSE；没装就当端点不可用，回退 CLI
        rq = urllib.request.Request(
            endpoint, data=b"{}",
            headers={"Content-Type": "application/json"}, method="POST")
        for name, value in credentials.headers().items():
            rq.add_unredirected_header(name, value)
        try:
            with urllib.request.urlopen(rq, timeout=3):
                ok = False       # 空 body 还给 200 说明这不是我们要的端点，不敢用
        except urllib.error.HTTPError as e:
            ok = e.code == 400   # 400 Missing user message ⇒ 端点在；404 ⇒ 没开
    except Exception:  # noqa: BLE001
        ok = False
    _HTTP_READY_CACHE.update(at=now, ok=ok, auth=auth_key, endpoint=endpoint)
    return ok


def _heal_openclaw_session(sk: str) -> None:
    """每轮 spawn openclaw 前，清洗该会话历史里的无签名 thinking 块 + 空消息（自愈防回放失效）。

    best-effort：任何异常都不阻断对话（清洗失败大不了退回原样，仍可 /new）。
    """
    try:
        import session_heal  # scripts/session_heal.py（已加入 sys.path）
        p = OPENCLAW_SESSIONS_DIR / f"{_openclaw_session_id(sk)}.jsonl"
        if p.is_file():
            st = session_heal.sanitize_history_file(p)
            if st.get("changed"):
                print(f"[session-heal] {p.name}: -{st['thinking_removed']} thinking / "
                      f"-{st['msgs_dropped']} empty", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[session-heal] 跳过（{e}）", file=sys.stderr, flush=True)


# 制作层/直接执行层/chat 超时统一走 easel/timeouts.py（CLI/Web/skill 三入口单一真相源）

SHARED_SCRIPTS = PROJECT_ROOT / "skills" / "shared" / "scripts"
if str(SHARED_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SHARED_SCRIPTS))

from model_registry import model_group

BROWSER_PROFILES = Path.home() / ".easel-browser-profiles"
LOGIN_DIR = OUTPUTS_DIR / "_login"
PUBLISH_DIR = OUTPUTS_DIR / "_publish"   # 异步发布的状态/验证码文件（抖音发布可能触发短信墙）
PROFILE_BUILD_DIR = OUTPUTS_DIR / "_profile_build"   # 异步画像构建的状态文件（避免长请求被代理超时）
DEBUG_DIR = OUTPUTS_DIR / "_debug"   # 诊断日志（对话流收尾情况等），_ 前缀不进内容库
SESSIONS_DIR = OUTPUTS_DIR / "_sessions"   # 每会话最近一轮的完整结果，供 SSE 连接中断后前端取回
# 非 _ 前缀的历史系统目录（归因层数据），内容库不展示（真产物一律在项目目录内）
SYSTEM_TOPLEVEL_DIRS = {"analytics"}
LOGIN_TIMEOUT = 240
LOGIN_PROCESSES: dict[str, subprocess.Popen] = {}

# whoami 真校验（起 headless 浏览器，数秒）的进程内缓存：避免账号页 + 工作台重复起浏览器。
WHOAMI_TTL = 600  # 秒
_WHOAMI_CACHE: dict[str, tuple[float, dict, str | None]] = {}
_WHOAMI_LOCK = threading.Lock()
_ACCOUNT_GENERATIONS: dict[str, str] = {}
_ACCOUNT_CLEARING: set[str] = set()
_WHOAMI_PROCESSES: dict[str, list[subprocess.Popen]] = {}

LOGIN_RUNNERS: dict[str, dict] = {
    "xiaohongshu": {"name": "小红书", "backend": "xhs", "profile": "XiaohongshuProfile"},
    "kuaishou": {"name": "快手", "backend": "web", "wp": "kuaishou", "profile": "KuaishouProfile"},
    "weixin-channels": {"name": "微信视频号", "backend": "web", "wp": "weixin-channels", "profile": "ChannelsProfile"},
    "zhihu": {"name": "知乎", "backend": "web", "wp": "zhihu", "profile": "ZhihuProfile"},
    "bilibili": {"name": "B站", "backend": "biliup"},
    "douyin": {"name": "抖音", "backend": "douyin", "profile": "DouyinProfile"},
    # 微信公众号：扫码登录后台会话（发布+数据都走它），backend=='wechat-oa' 在各处单独分支处理。
    "wechat-oa": {"name": "微信公众号", "backend": "wechat-oa"},
}

# ---- 微信公众号（wechat-oa）凭证式接入 ----
# 复用 skill-wechat-publisher 的发布引擎与配置：凭证存在其 wechat-publisher.yaml，
# 发布/取数脚本都从这里读账号。web 侧统一用账号 key "web"。
WECHAT_SKILL_DIR = PROJECT_ROOT / "skills" / "openclaw" / "skill-wechat-publisher"
WECHAT_SKILL_SCRIPTS = WECHAT_SKILL_DIR / "scripts"
WECHAT_PUBLISH_SCRIPT = WECHAT_SKILL_SCRIPTS / "publish.py"
WECHAT_CONFIG_YAML = WECHAT_SKILL_DIR / "wechat-publisher.yaml"
WECHAT_WEB_ACCOUNT = "web"   # web 端配置写入/读取的账号 key


def _wechat_load_yaml() -> dict:
    """读 wechat-publisher.yaml（不存在或损坏则返回空 dict）。"""
    if not WECHAT_CONFIG_YAML.is_file():
        return {}
    try:
        import yaml
        data = yaml.safe_load(WECHAT_CONFIG_YAML.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _wechat_web_account() -> dict:
    """返回 web 端配置的公众号账号（accounts.web），无则空 dict。"""
    cfg = _wechat_load_yaml()
    accts = cfg.get("accounts") if isinstance(cfg.get("accounts"), dict) else {}
    acc = accts.get(WECHAT_WEB_ACCOUNT)
    return acc if isinstance(acc, dict) else {}


def _wechat_has_credentials() -> bool:
    acc = _wechat_web_account()
    return bool(acc.get("app_id") and acc.get("app_secret"))


def _wechat_save_credentials(app_id: str, app_secret: str, name: str = "", author: str = "") -> None:
    """把 AppID/AppSecret 写入 wechat-publisher.yaml 的 accounts.web（原子写，保留其它账号）。"""
    import yaml
    cfg = _wechat_load_yaml()
    if not isinstance(cfg.get("accounts"), dict):
        cfg["accounts"] = {}
    acc = cfg["accounts"].get(WECHAT_WEB_ACCOUNT)
    if not isinstance(acc, dict):
        acc = {}
    acc["name"] = name or acc.get("name") or "微信公众号"
    acc["app_id"] = app_id
    acc["app_secret"] = app_secret
    if author:
        acc["author"] = author
    acc.setdefault("author", "")
    cfg["accounts"][WECHAT_WEB_ACCOUNT] = acc
    # web 账号存在即设为默认，方便 CLI 直接用
    cfg.setdefault("default", WECHAT_WEB_ACCOUNT)
    WECHAT_CONFIG_YAML.parent.mkdir(parents=True, exist_ok=True)
    tmp = WECHAT_CONFIG_YAML.with_suffix(".yaml.tmp")
    tmp.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")
    os.replace(tmp, WECHAT_CONFIG_YAML)


def _wechat_clear_credentials() -> None:
    """删除 accounts.web 及其 token 缓存。"""
    import yaml
    try:
        cfg = yaml.safe_load(WECHAT_CONFIG_YAML.read_text(encoding='utf-8')) if WECHAT_CONFIG_YAML.is_file() else {}
    except yaml.YAMLError as exc:
        raise OSError('公众号凭据配置无法解析，未执行清理') from exc
    if cfg is None:
        cfg = {}
    if not isinstance(cfg, dict):
        raise OSError('公众号凭据配置格式无效，未执行清理')
    owned_default = cfg.get('default') == WECHAT_WEB_ACCOUNT
    accts = cfg.get("accounts")
    if isinstance(accts, dict) and WECHAT_WEB_ACCOUNT in accts:
        accts.pop(WECHAT_WEB_ACCOUNT, None)
        if cfg.get("default") == WECHAT_WEB_ACCOUNT:
            cfg["default"] = next(iter(accts), "") if accts else ""
        tmp = WECHAT_CONFIG_YAML.with_suffix(".yaml.tmp")
        tmp.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")
        os.replace(tmp, WECHAT_CONFIG_YAML)
    caches = [WECHAT_SKILL_SCRIPTS / f".token_cache_{WECHAT_WEB_ACCOUNT}.json"]
    if owned_default:
        caches.append(WECHAT_SKILL_SCRIPTS / '.token_cache.json')
    for cache in caches:
        cache.unlink(missing_ok=True)


def _wechat_verify_token() -> tuple[bool, str]:
    """用当前 accounts.web 凭证调官方 token 接口验证。返回 (ok, message)。
    在子进程里跑，避免把 skill 的 import 副作用带进 web 进程。"""
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "from config import set_account\n"
        "from wechat_token import get_access_token\n"
        "set_account(%r)\n"
        "try:\n"
        "    t = get_access_token(force_refresh=True)\n"
        "    print('OK' if t else 'EMPTY')\n"
        "except Exception as e:\n"
        "    print('ERR:' + str(e))\n"
    ) % (str(WECHAT_SKILL_SCRIPTS), WECHAT_WEB_ACCOUNT)
    try:
        proc = subprocess.run([sys.executable, "-c", code], cwd=str(WECHAT_SKILL_SCRIPTS),
                              env=_wechat_env(), capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return False, "验证超时（网络或 IP 白名单问题）"
    out = (proc.stdout or "").strip().splitlines()
    last = out[-1] if out else ""
    if last == "OK":
        return True, ""
    if last.startswith("ERR:"):
        return False, last[4:].strip()[:200]
    err = (proc.stderr or "").strip().splitlines()[-1:] or ["验证失败"]
    return False, err[0][:200]


def _k(env, label, required=True, secret=True, aliases=None):
    return {"env": env, "label": label, "required": required, "secret": secret, "aliases": aliases or []}


def _media_ui_spec(group: str) -> dict:
    """The workbench uses dedicated media channels, not implicit chat credentials.

    Legacy CLI aliases remain supported by model_registry for explicit CLI use.
    """
    import copy
    spec = copy.deepcopy(model_group(group))
    generic = {'OPENAI_API_KEY', 'API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'BASE_URL'}
    for provider in spec['providers']:
        for key in provider['keys']:
            key['aliases'] = [alias for alias in key.get('aliases', ()) if alias not in generic]
            if key['env'] == 'IMG_MODEL':
                key['required'] = True
    return spec


def _model_spec(group: str, label: str | None = None) -> dict:
    spec = _media_ui_spec(group)
    return {
        "label": label or spec["label"],
        "settings": spec.get("settings", []),
        "providers": spec["providers"],
    }


def _short_drama_spec() -> dict:
    """Image is required; video and cloud voice settings remain optional enhancements."""
    image = _media_ui_spec("image")
    optional = []
    for group_name in ("video", "voice"):
        group = _media_ui_spec(group_name)
        optional.extend({**key, "required": False} for key in group.get("settings", []))
        for provider in group["providers"]:
            optional.extend({**key, "required": False} for key in provider["keys"])
    seen = set()
    optional = [key for key in optional if not (key["env"] in seen or seen.add(key["env"]))]
    return {
        "label": "AI 短剧（生图必需 + 生视频/云配音可选）",
        "settings": [],
        "providers": [{
            "id": "drama",
            "name": "关键帧生图（必需）+ 视频生成与闭源配音（可选）",
            "keys": [*image["providers"][0]["keys"], *optional],
        }],
    }

SKILL_API_REQUIREMENTS: dict[str, dict] = {
    "ai-image-gen": _model_spec("image"),
    "ecom-details-image": _model_spec("image", "电商配图（AI 生图）"),
    "ai-video-gen": _model_spec("video"),
    "ai-music": _model_spec("music"),
    "voice-clone": _model_spec("voice", "声音克隆 / 云端 TTS"),
    # AI 短剧：编排 ai-image-gen(关键帧,必需) + ai-video-gen(生视频,可选,缺则退化图片短剧)。
    # 以生图为「已配置」基线（缺生图无法出关键帧）；生视频 key 同框可选填，也可在 ai-video-gen 卡片配。
    "short-drama": _short_drama_spec(),
    # 邮箱通知（skill-email-notify）：设置页「通知中心」可视化配置 + 测试发送。
    # 这些键同时进 _ENV_ALLOWLIST，/api/env 才能写入；skill 端按同名环境变量读取。
    "skill-email-notify": {
        "label": "邮箱通知（生成/发布完成后推送）",
        "providers": [
            {
                "id": "smtp",
                "name": "SMTP 邮箱通道",
                "keys": [
                    _k("EASEL_NOTIFY_EMAIL", "收件人邮箱（多个逗号分隔）", required=True, secret=False),
                    _k("EASEL_NOTIFY_SMTP_HOST", "SMTP 主机（如 smtp.qq.com）", required=True, secret=False),
                    _k("EASEL_NOTIFY_SMTP_PORT", "端口（默认 465）", required=False, secret=False),
                    _k("EASEL_NOTIFY_SMTP_USER", "认证账号（缺省=首个收件人）", required=False, secret=False),
                    _k("EASEL_NOTIFY_SMTP_PASS", "密码 / 授权码（QQ/163 用授权码）", required=False),
                    _k("EASEL_NOTIFY_FROM", "发件人显示地址（可空）", required=False, secret=False),
                    _k("EASEL_NOTIFY_ON_DONE", "任务完成后自动发（1=开）", required=False, secret=False),
                ],
            },
        ],
    },
    # 论文解读：MinerU 与生图均为可选（缺 MinerU 用 pdfplumber 兜底、缺生图用信息图/图表）。
    # 全 key 可选 → 不误报感叹号；但仍进注册表以便就地填 MINERU_API_TOKEN（无其它叶子 skill 承载它）。
    "paper-explainer": {
        "label": "论文解读（MinerU / 生图 均可选）",
        "providers": [
            {
                "id": "paper",
                "name": "MinerU 解析(可选, 缺则 pdfplumber) + 封面/概念生图(可选)",
                "keys": [
                    _k("MINERU_API_TOKEN", "MinerU API Token（可选，缺则用 pdfplumber 兜底）",
                       required=False),
                    _k("IMG_API_KEY", "生图 API Key（可选，用于封面/概念图）", required=False,
                       aliases=["OPENAI_API_KEY", "API_KEY"]),
                    _k("IMG_BASE_URL", "生图 API 根地址（可选）", required=False, secret=False,
                       aliases=["OPENAI_BASE_URL", "OPENAI_API_BASE", "BASE_URL"]),
                ],
            },
        ],
    },
}

_ENV_ALLOWLIST: set[str] = set()
for _spec in SKILL_API_REQUIREMENTS.values():
    for _key in _spec.get("settings", []):
        _ENV_ALLOWLIST.add(_key["env"])
        _ENV_ALLOWLIST.update(_key.get("aliases", []))
    for _prov in _spec["providers"]:
        for _key in _prov["keys"]:
            _ENV_ALLOWLIST.add(_key["env"])
            _ENV_ALLOWLIST.update(_key.get("aliases", []))

ENV_FILE = DATA_DIR / ".env"
_PLACEHOLDER_RE = re.compile(r"replace_me|your[-_]?api[-_]?key|xxx|^\.{3}$|^<.*>$", re.I)

TEXT_EXTS = {".txt", ".md", ".json", ".csv", ".log", ".py", ".js", ".ts", ".html", ".htm", ".css", ".xml", ".yaml", ".yml", ".srt", ".vtt"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """应用生命周期：关机时回收公众号扫码进程（替代已弃用的 on_event）。"""
    from easel.storage_location import apply_pending
    await asyncio.to_thread(apply_pending, DATA_DIR)
    try:
        await asyncio.to_thread(_publish_receipt_store().recover_interrupted)
    except local_records.RecordError as exc:
        print(str(exc), file=sys.stderr)
    verification = _publish_verification_service()
    verification.start()
    health = _model_health_service()
    health.start()
    try:
        yield
    finally:
        await asyncio.to_thread(health.stop)
        await asyncio.to_thread(verification.stop)
        _stop_mp_login_on_shutdown()


app = FastAPI(title="Easel", docs_url=None, redoc_url=None, lifespan=_lifespan)
def _local_ports(env_port: str) -> set[str]:
    return {'7860', '7870', '5173', (env_port or '').strip() or '7860'}


def _proxy_uri_origin(uri: str) -> tuple[str, str] | None:
    parsed = urllib.parse.urlparse(uri)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return None
    return parsed.hostname, f'{parsed.scheme}://{parsed.netloc}'


def _loopback_peer(request: Request) -> bool:
    if request.client is None:
        return False
    try:
        return ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        return False


_LOCAL_PORTS = _local_ports(os.environ.get('EASEL_PORT', ''))
_LOCAL_ORIGINS = [f'http://{host}:{port}' for host in ('127.0.0.1', 'localhost') for port in _LOCAL_PORTS]
_LOCAL_ORIGINS += [origin.strip() for origin in os.environ.get('EASEL_EXTRA_ORIGINS', '').split(',') if origin.strip()]
_EXTRA_HOSTS = [host.strip() for host in os.environ.get('EASEL_EXTRA_HOSTS', '').split(',') if host.strip()]
_proxy_origin = _proxy_uri_origin(os.environ.get('VSCODE_PROXY_URI', ''))
if _proxy_origin:
    _EXTRA_HOSTS.append(_proxy_origin[0])
    _LOCAL_ORIGINS.append(_proxy_origin[1])

app.add_middleware(CORSMiddleware, allow_origins=_LOCAL_ORIGINS, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1'] + _EXTRA_HOSTS)


@app.middleware('http')
async def local_write_guard(request: Request, call_next):
    origin = request.headers.get('origin')
    if request.url.path == '/api/clipper' and origin and re.fullmatch(r'chrome-extension://[a-p]{32}', origin):
        headers = {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST',
                   'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Vary': 'Origin'}
        if request.method == 'OPTIONS':
            return JSONResponse({}, headers=headers)
        response = await call_next(request)
        response.headers.update(headers)
        return response
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        allowed = origin in _LOCAL_ORIGINS if origin else _loopback_peer(request)
        if not allowed:
            return JSONResponse({'detail': '仅允许从本机工作台操作。'}, status_code=403)
    return await call_next(request)


def list_personas() -> list[dict]:
    if not PROFILES_DIR.is_dir():
        return []
    result = []
    for d in sorted(PROFILES_DIR.iterdir()):
        if d.is_dir() and d.name.startswith('_'):
            continue
        desc = ''
        identity = d / 'identity.md'
        if identity.is_file():
            for line in identity.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith('#') and not line.startswith('<!--'):
                    desc = line[:80]
                    break
        result.append({'name': d.name, 'description': desc})
    return result


def find_skill(name: str) -> str | None:
    """查找 SKILL，返回完整名或 None。与 CLI skill.py 一致。"""
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', name) or name.startswith('.'):
        return None
    cands = [name, f'skill-{name}'] if not name.startswith('skill-') else [name]
    for cand in cands:
        if (SKILLS_DIR / 'openclaw' / cand / 'SKILL.md').is_file():
            return cand
    return None


def _parse_skill_md(path: Path) -> tuple[str, str, str]:
    """解析 SKILL.md → (description, layer, body)。body 为去掉 frontmatter 的正文。
    正确处理 YAML 块标量 description（`>-` / `>` / `|` 后跟缩进多行）。"""
    text = path.read_text(encoding='utf-8')
    desc, layer, body = '', '', text
    lines = text.splitlines()
    if not (lines and lines[0].strip() == '---'):
        return desc, layer, body
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == '---':
            end = i
            break
    if end is None:
        return desc, layer, body
    body = '\n'.join(lines[end + 1:]).strip()
    fm = lines[1:end]
    i = 0
    while i < len(fm):
        st = fm[i].strip()
        if st.startswith('layer:'):
            layer = st.split(':', 1)[1].strip().strip('"').strip("'")
            i += 1
        elif st.startswith('description:'):
            val = st.split(':', 1)[1].strip()
            if val and val[0] in '|>':
                block = []
                j = i + 1
                while j < len(fm):
                    if fm[j].strip() == '':
                        block.append('')
                        j += 1
                        continue
                    indent = len(fm[j]) - len(fm[j].lstrip())
                    if indent == 0:
                        break
                    block.append(fm[j].strip())
                    j += 1
                desc = ' '.join(x for x in block if x).strip()
                i = j
            else:
                desc = val.strip('"').strip("'")
                i += 1
        else:
            i += 1
    return desc, layer, body


# ---- 小白版 SKILL 导读：用 frontmatter + 正文标题做结构化提取 ----
# 原则（见 docs/secondary-development-plan.md 功能 B）：只归纳原文里有的内容；缺哪个字段就留空，
# 由前端显示「原文未说明」，不补造步骤、费用或平台权限。

_GUIDE_H2_INPUT = ("输入", "最小输入", "Inputs", "素材清单")
_GUIDE_H2_OUTPUT = ("输出", "产物", "结果怎么用")
_GUIDE_H2_STEP = ("执行步骤", "执行流程", "执行", "工作流", "Workflow", "步骤", "核心流程")
_GUIDE_H2_PREP = ("前置", "配置", "环境依赖", "Requirements", "工具依赖", "依赖")
_GUIDE_H2_EXAMPLE = ("示例",)

_GUIDE_ACCOUNTS = (
    ("小红书", ("小红书", "xiaohongshu", "redbook")),
    ("抖音", ("抖音", "douyin")),
    ("快手", ("快手", "kuaishou")),
    ("B站", ("bilibili", "B站", "B 站")),
    ("视频号", ("视频号",)),
    ("公众号", ("公众号",)),
    ("知乎", ("知乎", "zhihu")),
)

# 外部生成能力：只认脚本名/环境变量这类硬标记，正文顺口提到（如能力对比表）不算依赖。
_GUIDE_MEDIA = (
    ("AI 生图", "image", ("IMG_BASE_URL", "IMG_API_KEY", "ai_image.py", "generate_image.py")),
)

_GUIDE_TERMS = (
    ("SKILL", "一张技能卡＝一项独立能力：看说明、就地配置、直接运行。"),
    ("Profile", "账号画像（定位/人设/受众）。技能会参考它来贴合你的风格，在「画像」页维护。"),
    ("API Key", "外部服务商发给你的密钥，填进本机设置后技能才能调用对应 AI 能力。"),
    ("生图", "用 AI 生成图片。需要先在「设置 → 生图」里配置好渠道。"),
    ("登录态", "浏览器里保持登录的凭证；发布/抓取类技能首次使用要扫码登录对应平台。"),
    ("ffmpeg", "音视频处理命令行工具，「设置 → 环境安装」可一键安装。"),
)


def _split_h2(body: str) -> list[tuple[str, str]]:
    """正文按二级标题切块 → [(标题, 内容)]；首个标题前的引言块标题为空字符串。"""
    out: list[tuple[str, str]] = []
    head, buf = "", []
    for line in body.splitlines():
        m = re.match(r'^##\s+(.+?)\s*$', line)
        if m:
            out.append((head, "\n".join(buf).strip()))
            head, buf = m.group(1), []
        else:
            buf.append(line)
    out.append((head, "\n".join(buf).strip()))
    return out


def _find_h2(sections: list[tuple[str, str]], keys: tuple[str, ...], default: str = "") -> str:
    """找标题命中 keys 的小节内容：优先完全同名，再前缀，最后包含（容忍标题前 emoji）。
    三轮扫描避免「配置（执行前必读）」被误当成执行步骤这类包含匹配事故。"""
    norm = [(re.sub(r'^[^0-9A-Za-z\u4e00-\u9fff]+', '', h), t) for h, t in sections if h]
    for pick in (lambda h, k: h == k, lambda h, k: h.startswith(k), lambda h, k: k in h):
        for h, text in norm:
            if any(pick(h, k) for k in keys):
                return text
    return default


def _plain(text: str, width: int = 160) -> str:
    """markdown → 单行纯文本（去围栏行/强调/链接/引用符），按 width 截断。
    围栏内的内容保留（CLI 技能的流程图/命令就写在代码块里），只去掉 ``` 标记行。"""
    t = re.sub(r'^\s*```.*$', '', text, flags=re.M)
    t = re.sub(r'`([^`]*)`', r'\1', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'\1', t)
    t = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', t)
    t = re.sub(r'^\s*(?:[-*•>]+|\|)\s*', '', t, flags=re.M)
    t = re.sub(r'\s+', ' ', t).strip()
    return t[:width].strip()


def _table_items(text: str, limit: int = 6, width: int = 60) -> list[str]:
    """markdown 表格 → 「首列：次列」短句（跳过表头/分隔行）。「输入」「参数」节常用字段表。"""
    rows = [l.strip() for l in text.splitlines() if l.strip().startswith('|')]
    if len(rows) < 3:
        return []
    out: list[str] = []
    after_sep = False
    for r in rows:
        if re.fullmatch(r'\|[\s:|-]+\|', r):
            after_sep = True
            continue
        if not after_sep:
            continue
        cells = [_plain(c, width).strip() for c in r.strip('|').split('|')]
        first = cells[0] if cells else ''
        if not first:
            continue
        # 末列取说明文字（两列表＝次列；三列表如「字段|必填|说明」跳过中间的必填列）
        rest = next((c for c in reversed(cells[1:]) if c), '')
        item = f'{first}：{rest}' if rest and rest != first else first
        out.append(item[:width])
        if len(out) >= limit:
            break
    return out


def _items(text: str, limit: int = 6, width: int = 60) -> list[str]:
    """小节里的要点 → 短句列表：列表项优先，其次表格行，最后整段首句。"""
    out: list[str] = []
    for line in text.splitlines():
        m = re.match(r'^\s*(?:\d+[.、)]|[-*•])\s+(.+)$', line)
        if m:
            s = _plain(m.group(1), width).strip('；;，,。')
            if len(s) >= 2:
                out.append(s)
        if len(out) >= limit:
            break
    if not out:
        out = _table_items(text, limit, width)
    if not out:
        first = _plain(text, width)
        if first:
            out = [first]
    return out


def _guide_what(desc: str) -> str:
    """能做什么：description 中触发语/适用场景之前的能力描述。"""
    seg = re.split(r'当用户|适用场景|适用于|使用场景', desc)[0]
    out = ""
    for s in (x.strip() for x in re.split(r'(?<=[。！？])', seg) if x.strip()):
        out += s
        if len(out) >= 12:
            break
    return _plain(out, 140).strip('。；; ')


def _guide_triggers(desc: str) -> list[str]:
    """什么时候用：description 里「当用户说…时使用」「适用场景：…」的原文说法。"""
    found: list[str] = []
    for m in re.finditer(r'当用户(?:说|提到|要求|询问|想要)?\s*[“"「]?(.+?)[”"」]?\s*(?:时)?(?:使用|触发)', desc):
        seg = m.group(1).strip().strip('“”"「」').strip('：: ')
        seg = re.sub(r'[“”"「」]{1,}', '、', seg)   # 相邻引号（说"A""B"）视作分隔
        parts = [p.strip() for p in re.split(r'[、;；]', seg) if p.strip()]
        found.extend(parts if 1 <= len(parts) <= 16 else [seg])
    m2 = re.search(r'适用场景[：:]\s*(.+?)(?:。|$)', desc)
    if m2:
        parts = [p.strip() for p in re.split(r'[、，,]', m2.group(1)) if p.strip()]
        found.extend(parts if 1 <= len(parts) <= 10 else [m2.group(1).strip()])
    seen: set[str] = set()
    out: list[str] = []
    for t in found:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out[:14]


def _guide_accounts(desc: str, body: str) -> list[str]:
    """需要哪个平台账号：正文提到登录态类关键词时，列出同时出现的平台名（原文依据）。"""
    text = f'{desc}\n{body}'
    if not re.search(r'登录态|扫码登录|持久化登录|已登录', text):
        return []
    low = text.lower()
    return [name for name, pats in _GUIDE_ACCOUNTS if any(p.lower() in low for p in pats)][:4]


def _guide_group_ready(group: str, env: dict[str, str]) -> bool:
    """模型分组是否已配好：任一 provider 的必需 key 齐全（含别名），语义与设置页一致。"""
    try:
        spec = _media_ui_spec(group)
    except Exception:  # noqa: BLE001
        return False
    return any(all(_key_configured(k, env) for k in prov['keys'] if k.get('required'))
               for prov in spec['providers'])


def _guide_media(body: str, env: dict[str, str]) -> list[dict]:
    """技能正文硬引用的外部生成能力（脚本/环境变量标记），附当前配置状态。"""
    out = []
    for label, group, markers in _GUIDE_MEDIA:
        if any(marker in body for marker in markers):
            out.append({'label': label, 'configured': _guide_group_ready(group, env)})
    return out


def _guide_runtime(path: Path) -> dict:
    """frontmatter.metadata.openclaw 的运行时要求（额外命令/系统）；读不到给空表。"""
    empty: dict = {'bins': [], 'os': []}
    try:
        parts = path.read_text(encoding='utf-8').replace('\r\n', '\n').split('---', 2)
        if len(parts) < 3 or parts[0].strip():
            return empty
        import yaml
        fm = yaml.safe_load(parts[1]) or {}
        oc = ((fm.get('metadata') or {}).get('openclaw') or {}) if isinstance(fm, dict) else {}
        req = oc.get('requires') or {}
        return {
            'bins': [b for b in (req.get('bins') or []) if isinstance(b, str)],
            'os': [o for o in (oc.get('os') or []) if isinstance(o, str)],
        }
    except Exception:  # noqa: BLE001
        return empty


def _skill_guide(skill: str, desc: str, body: str, path: Path,
                 env: dict[str, str] | None = None) -> dict:
    """小白版技能导读：能做什么/适合谁/需要什么/怎么开始/会得到什么 + 示例与术语。
    纯静态提取（不需要模型配置）；缺字段留空，前端显示「原文未说明」。"""
    env = _read_env() if env is None else env
    sections = _split_h2(body)
    inputs = _items(_find_h2(sections, _GUIDE_H2_INPUT), limit=6, width=50)
    gets_section = _find_h2(sections, _GUIDE_H2_OUTPUT)
    what_you_get = _items(gets_section, limit=4, width=70) if gets_section else []
    examples = _items(_find_h2(sections, _GUIDE_H2_EXAMPLE), limit=3, width=90)
    if examples:
        examples = [e.strip('“”"「」') for e in examples]
    else:
        examples = _guide_triggers(desc)[:3]
    runtime = _guide_runtime(path)
    media = _guide_media(body, env)
    accounts = _guide_accounts(desc, body)
    spec = SKILL_API_REQUIREMENTS.get(skill)
    api = {'label': spec['label'], 'configured': _skill_api_configured(skill, env)} if spec else None

    how_to: list[str] = ['点下方「运行」，用一句话描述你要做的事，再点「执行」。']
    if inputs:
        how_to.append('先把这些说清楚：' + '、'.join(inputs[:4]) + '。')
    if api and not api['configured']:
        how_to.append(f'本技能要调用外部 AI（{api["label"]}），请先在下方「API 配置」填好 Key。')
    for m in media:
        if not m['configured']:
            how_to.append(f'会用到「{m["label"]}」，需要先到「设置 → 生图」配置好渠道。')

    corpus = f'{desc}\n{body}'
    terms = [{'term': t, 'explain': e} for t, e in _GUIDE_TERMS
             if t.lower() in corpus.lower()][:5]

    return {
        'what': _guide_what(desc),
        'whenToUse': _guide_triggers(desc),
        'needs': {
            'inputs': inputs,
            'api': api,
            'media': media,
            'accounts': accounts,
            'tools': runtime['bins'],
            'os': runtime['os'],
            'prep': _items(_find_h2(sections, _GUIDE_H2_PREP), limit=2, width=80),
        },
        'howToStart': how_to,
        'steps': _items(_find_h2(sections, _GUIDE_H2_STEP), limit=4, width=80),
        'whatYouGet': what_you_get,
        'examples': examples,
        'terms': terms,
    }


def get_skills() -> list[dict]:
    env = _read_env()
    result = []
    sd = SKILLS_DIR / 'openclaw'
    if sd.is_dir():
        for d in sorted(sd.iterdir()):
            if d.is_dir() and (d / 'SKILL.md').is_file():
                desc, layer, _ = _parse_skill_md(d / 'SKILL.md')
                needs_api = d.name in SKILL_API_REQUIREMENTS
                result.append({
                    'name': d.name,
                    'description': desc,
                    'layer': layer,
                    'needsApi': needs_api,
                    'apiConfigured': _skill_api_configured(d.name, env) if needs_api else True,
                })
    return result


def clean_agent_output(raw: str) -> str:
    lines = []
    for line in raw.splitlines():
        c = re.sub(r'\x1b\[[0-9;]*m', '', line)
        if c.startswith('[') and any(t in c[:40] for t in ('[provider-', '[agents/', '[agent/', '[plugins]', '[tools]', '[diagnostic]', '[fetch-', '[heartbeat]', '[health-', '[gateway]')):
            continue
        if c.strip():
            lines.append(c)
    return '\n'.join(lines).strip()


def _proxy_env() -> dict[str, str]:
    """返回带外网代理的环境变量（保护内网直连）。"""
    env = child_env(PROJECT_ROOT)
    env.setdefault('http_proxy', os.environ.get('EASEL_PROXY', ''))
    env.setdefault('https_proxy', os.environ.get('EASEL_PROXY', ''))
    env.setdefault('no_proxy', 'localhost,127.0.0.1,10.*,*.xiaohongshu.com,*.devops.xiaohongshu.com,*.douyin.com,*.kuaishou.com,*.zhihu.com,*.bilibili.com,*.weixin.qq.com,*.qq.com')
    return env


def _publish_env() -> dict[str, str]:
    """发布子进程 env：在 _proxy_env 基础上禁用脚本侧日历自动记录——
    发布页由 web 自己回流 _schedule.json，脚本再记一次会重复。对话页 Agent 直跑
    脚本时不经过这里，flag 未设 → 脚本自动记录（见 calendar_ops.record_publish）。"""
    env = _proxy_env()
    env['EASEL_CALENDAR_AUTORECORD'] = '0'
    return env


def _wechat_env() -> dict[str, str]:
    """公众号 API 子进程 env，决定微信 API 从哪个 IP 出网（公众号白名单要求固定出口 IP）。

    两种模式：
    - 设了 WECHAT_EGRESS_PROXY（如反向隧道到你本机/固定 IP 中转）→ 让微信 API **走这个代理**出网，
      微信看到的是该代理的公网 IP，白名单加它即可。其它外网仍走公司代理。
    - 未设 → 微信 API 走**直连**（api.weixin.qq.com 进 no_proxy）。注意本机直连出口也是共享 NAT
      轮询池（见 WECHAT_OA_INTEGRATION.md §4），直连仅在出口 IP 恰好固定的机器上可靠。"""
    env = _publish_env()
    wx_hosts = ("api.weixin.qq.com", "mp.weixin.qq.com")
    egress = os.environ.get("WECHAT_EGRESS_PROXY", "").strip()
    if egress:
        # 微信 API 走指定固定出口代理；从 no_proxy 里去掉微信域名，确保不被旁路成直连。
        env["http_proxy"] = env["https_proxy"] = egress
        env["HTTP_PROXY"] = env["HTTPS_PROXY"] = egress
        kept = [h for h in env.get("no_proxy", "").split(",") if h and not any(w in h for w in wx_hosts)]
        env["no_proxy"] = ",".join(kept)
        env["NO_PROXY"] = env["no_proxy"]
    else:
        existing = env.get("no_proxy", "")
        env["no_proxy"] = (existing + "," + ",".join(wx_hosts)) if existing else ",".join(wx_hosts)
        env["NO_PROXY"] = env["no_proxy"]
    return env


def _persona_prefix(persona: str | None) -> str:
    """把画像作为消息前缀内联（复用 easel.persona，与 CLI/skill 同源）。"""
    return persona_prefix(persona)


def _read_env() -> dict[str, str]:
    """宽松解析项目根 .env → {KEY: value}。跳过注释与非 KEY=value 行（容忍多行值残行）。"""
    result = {}
    if not ENV_FILE.is_file():
        return result
    for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
        s = line.strip()
        if not s or s.startswith('#') or '=' not in s:
            continue
        key, val = s.split('=', 1)
        key = key.strip()
        if key.isidentifier() or key.replace('-', '_').isidentifier():
            result[key] = val.strip()
    return result


def _is_set(val: str | None) -> bool:
    """非空且非占位符才算真正配置了。"""
    if not val or not val.strip():
        return False
    return not _PLACEHOLDER_RE.search(val.strip())


def _mask(val: str) -> str:
    """脱敏：只留尾 4 位（短值全遮）。"""
    v = val.strip()
    if len(v) <= 4:
        return '••••'
    return '••••' + v[-4:]


def _key_configured(key: dict, env: dict[str, str]) -> bool:
    '某个 key（含别名）是否已配置。'
    if _is_set(env.get(key['env'])):
        return True
    return any(_is_set(env.get(a)) for a in key.get('aliases', []))


def _skill_api_configured(skill: str, env: dict[str, str] | None = None) -> bool:
    'SKILL 是否已具备可用配置：任一 provider 的全部 required key 齐全。'
    spec = SKILL_API_REQUIREMENTS.get(skill)
    if not spec:
        return True
    env = _read_env() if env is None else env
    for prov in spec['providers']:
        if all(_key_configured(k, env) for k in prov['keys'] if k['required']):
            return True
    return False


# .env 的值是裸写 `KEY=value` 的，而 setup.sh:310/450 会 `source .env`。bash 在赋值右侧
# 不做分词和通配，但**照做**命令替换，且元字符会截断赋值另起一条命令 —— 所以 `$(…)`、反引号、
# `;`/`&`/`|`/`(`/`)`/`<`/`>`/空白 都等于任意命令执行。加引号写入不行：scripts/gateway.sh:63
# 用 `sed -n 's/^KEY=//p'` 裸取值，引号会跟着漏进端口号。只能在入口把值的字符集收死。
# 这里能写的全是 API Key / Base URL / 模型 id / 端口，没有一个需要空格或上面那些字符。
_ENV_VALUE_OK = re.compile(r'[A-Za-z0-9_.:/@+\-=~,%?#\[\]]*')


def _guard_env_values(updates: dict[str, str]) -> None:
    """集中拦截 .env 值注入：值里带换行能往 .env 追加任意行，带 `$(…)` 能直接执行命令
    —— 两者都等于任何能调到写 .env 接口的人都能拿到命令执行。键名同理。两个写入口都必须先过这道。"""
    for k, v in updates.items():
        if any(c in (k or '') for c in '\r\n=') or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k or ''):
            raise HTTPException(400, f'非法的配置键名：{(k or "")[:40]!r}')
        v = v or ''
        if k == 'IMG_MODEL' and len(v) > 200:
            raise HTTPException(400, '生图模型名称最多 200 个字符')
        if any(c in v for c in '\r\n\x00'):
            raise HTTPException(400, f'配置值不能包含换行符：{k}')
        if not _ENV_VALUE_OK.fullmatch(v):
            bad = ''.join(sorted({c for c in v if not _ENV_VALUE_OK.fullmatch(c)}))
            raise HTTPException(400, f'配置值含不允许的字符（{bad!r}）：{k}')


def _is_local_gateway_base(url: str) -> bool:
    """这个供应商当前是不是挂在本地模型网关上。

    网关模式下 openclaw.json 里存的 baseUrl 是 127.0.0.1:8890，真实上游在 easel-models.yaml，
    面板显示/回传的是上游地址 —— 两边天生不相等。凡是拿「baseUrl 变了」当判据的逻辑都得先问过这里，
    否则网关用户每次保存都被判成「换了地址」。
    """
    return str(url or '').startswith('http://127.0.0.1:8890')


# 设置面板里「改了 Base URL 就必须重填 Key」要比对的 .env 键位（槽位 → (base 键, key 键)）。
_SLOT_ENV_KEYS = {
    'openai': ('OPENAI_BASE_URL', 'OPENAI_API_KEY'),
    'relay': ('EASEL_LLM_BASE_URL', 'EASEL_LLM_API_KEY'),
    'anthropic': ('ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'),
    'siliconflow': ('SILICONFLOW_BASE_URL', 'SILICONFLOW_API_KEY'),
}


def _valid_base_url(u: str) -> bool:
    '整串校验（不是只看开头）：必须是 http(s)://host，且不带控制字符与 URL 内嵌凭据。'
    if any(c in u for c in '\r\n\t\x00') or '@' in u:
        return False
    try:
        p = urllib.parse.urlparse(u)
    except ValueError:
        return False
    return p.scheme in ('http', 'https') and bool(p.hostname)


def _ssrf_safe(u: str) -> bool:
    """自测会带着真 Key 去打这个地址，所以不许指向本机/内网/云元数据——
    这些地址上的服务通常无鉴权，一旦被当成「模型端点」就成了打内网的跳板。"""
    try:
        host = urllib.parse.urlparse(u).hostname or ''
        infos = socket.getaddrinfo(host, None)
    except Exception:  # noqa: BLE001  解析不了就当不安全
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


def _write_env(updates: dict[str, str]) -> None:
    '就地更新命中的 KEY、其余行原样保留，未命中的追加末尾；空串则删除该行。原子写。'
    updates = {k: v for k, v in updates.items() if k in _ENV_ALLOWLIST}
    _guard_env_values(updates)
    if not updates:
        return
    lines = ENV_FILE.read_text(encoding='utf-8').splitlines() if ENV_FILE.is_file() else []
    seen = set()
    out = []
    for line in lines:
        s = line.strip()
        matched = None
        if s and not s.startswith('#') and '=' in s:
            k = s.split('=', 1)[0].strip()
            if k in updates:
                matched = k
        if matched is not None:
            seen.add(matched)
            val = updates[matched]
            if val.strip() == '':
                continue
            out.append(f'{matched}={val}')
            continue
        out.append(line)
    appended = [f'{k}={v}' for k, v in updates.items() if k not in seen and v.strip() != '']
    if appended:
        if out and out[-1].strip() != '':
            out.append('')
        out.append('# ---- Easel API keys (added via Web) ----')
        out.extend(appended)
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    _atomic_model_bytes(ENV_FILE, ('\n'.join(out) + '\n').encode('utf-8'))


def _api_spec_status(skill: str, env: dict[str, str]) -> dict:
    '返回注册表项 + 每个 key 当前配置状态与脱敏值（不回传明文）。'
    spec = SKILL_API_REQUIREMENTS[skill]

    def key_status(k: dict) -> dict:
        raw = env.get(k['env'], '')
        return {
            'env': k['env'],
            'label': k['label'],
            'required': k['required'],
            'secret': k['secret'],
            'choices': list(k.get('choices', [])),
            'configured': _key_configured(k, env),
            'masked': _mask(raw) if k['secret'] and _is_set(raw) else (raw if not k['secret'] else ''),
        }

    providers = []
    for prov in spec['providers']:
        keys = [key_status(k) for k in prov['keys']]
        providers.append({'id': prov['id'], 'name': prov['name'], 'keys': keys})
    return {
        'label': spec['label'],
        'settings': [key_status(k) for k in spec.get('settings', [])],
        'providers': providers,
    }


def run_agent_sync(msg: str, timeout: int = TIMEOUT_DIRECT, session_id: str | None = None,
                   thinking_level: str | None = None) -> str:
    sk = session_id or f'web-{int(time.time() * 1000)}'
    # 跨进程锁：同一会话同时刻只跑一个 openclaw，防并发 takeover 崩溃（rc=1）
    xlock = _CrossProcLock(sk)
    if not xlock.acquire(timeout=min(timeout, 300)):
        return '⏳ 这个会话正在另一个窗口运行，请稍候再试'
    try:
        credentials = gateway_credentials()
        _heal_openclaw_session(sk)
        # Keep CLI setup inside the same safe error boundary as execution.
        cmd = openclaw_base_cmd() + ['--profile', OPENCLAW_PROFILE, 'agent', '--agent', 'main',
               '--session-key', f'agent:main:{sk}', '--session-id', _openclaw_session_id(sk),
               '--thinking', thinking_level or THINKING_LEVEL,
               '--timeout', str(timeout), '--message', msg]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=timeout + 30,
                           env=credentials.environment(_proxy_env()))
        if r.returncode != 0:
            error = gateway_error('\n'.join((r.stdout or '', r.stderr or '')))
            return '❌ ' + error['message']
        return redact_gateway_text(clean_agent_output(r.stdout or ''), credentials) or '（无输出）'
    except subprocess.TimeoutExpired:
        return '⏱️ ' + gateway_error('timeout')['message']
    except Exception as e:
        return '❌ ' + gateway_error(type(e).__name__ + ': ' + str(e))['message']
    finally:
        xlock.release()


def check_gateway() -> bool:
    try:
        with urllib.request.urlopen(healthz_url(), timeout=3) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def _file_kind(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in IMAGE_EXTS:
        return 'image'
    if ext in VIDEO_EXTS:
        return 'video'
    if ext in AUDIO_EXTS:
        return 'audio'
    if ext in TEXT_EXTS:
        return 'text'
    return 'binary'


def _file_meta(f: Path, rel: str) -> dict:
    try:
        st = f.stat()
        mtime, size = int(st.st_mtime), st.st_size
    except OSError:
        mtime, size = 0, 0
    return {'name': f.name, 'path': rel, 'kind': _file_kind(f.name), 'mtime': mtime, 'size': size}


def _build_output_node(path: Path, rel: str) -> dict:
    """递归构建产物树节点：文件→file 节点；目录→dir 节点带 children + 递归 fileCount。"""
    if path.is_dir():
        children = []
        for c in sorted(path.iterdir()):
            if c.name.startswith('.'):   # 嵌套层只跳隐藏文件；_base.mp4 等以 _ 开头的产物要保留
                continue
            children.append(_build_output_node(c, f'{rel}/{c.name}'))
        mtime = max((x['mtime'] for x in children), default=int(path.stat().st_mtime))
        file_count = sum(x.get('fileCount', 1) if x['type'] == 'dir' else 1 for x in children)
        return {'name': path.name, 'type': 'dir', 'path': rel, 'mtime': mtime,
                'children': children, 'fileCount': file_count}
    m = _file_meta(path, rel)
    m['type'] = 'file'
    return m


def _read_project_meta(proj: Path) -> dict:
    """读项目目录的 .easel.json 展示头，附封面/成品的解析路径供前端富展示。

    只取展示相关字段（不含编排 steps）。cover 解析优先级：
    展示头声明的 cover → 首个成品媒体 → 目录内首张图/视频（兜底）。
    """
    mf = proj / ".easel.json"
    if not mf.is_file():
        return {}
    try:
        data = json.loads(mf.read_text(encoding="utf-8"))
    except Exception:
        return {}
    meta = {k: data.get(k) for k in
            ("title", "summary", "platform", "kind", "status", "tags", "deliverables")
            if data.get(k) not in (None, "", [])}
    if not meta:
        return {}

    def _rel_if_exists(name: str) -> str:
        return f"{proj.name}/{name}" if name and (proj / name).is_file() else ""

    # 封面解析
    cover_rel = ""
    declared = data.get("cover")
    if declared and (proj / declared).is_file():
        cover_rel = f"{proj.name}/{declared}"
    if not cover_rel:
        for d in (data.get("deliverables") or []):
            if _file_kind(d) in ("image", "video") and (proj / d).is_file():
                cover_rel = f"{proj.name}/{d}"
                break
    if cover_rel:
        meta["cover"] = cover_rel
    # 成品路径（前端「成品区」高亮用）：解析为 outputs 相对路径，只留真实存在的
    meta["deliverablePaths"] = [f"{proj.name}/{d}" for d in (data.get("deliverables") or [])
                                if (proj / d).is_file()]
    return meta


def get_output_tree() -> list[dict]:
    if not OUTPUTS_DIR.is_dir():
        return []
    items = []
    for e in sorted(OUTPUTS_DIR.iterdir()):
        # 内容库只展示「项目目录」：跳过系统目录(_login/_publish/...)、隐藏项、
        # 以及根目录散文件（按新规约产物必在项目目录内，根散文件=系统状态/残渣）。
        if e.name.startswith('.') or e.name.startswith('_'):
            continue
        if not e.is_dir() or e.name in SYSTEM_TOPLEVEL_DIRS:
            continue
        node = _build_output_node(e, e.name)
        meta = _read_project_meta(e)
        if meta:
            node['meta'] = meta
        items.append(node)
    # 按最后修改时间倒序：最近产物排最前（供工作台「最近产物」与内容库时间排序）
    return sorted(items, key=lambda x: x.get('mtime', 0), reverse=True)


def _safe_output_path(rel: str) -> Path:
    '把相对路径解析到 outputs/ 内，防路径穿越。'
    full = (OUTPUTS_DIR / rel).resolve()
    root = OUTPUTS_DIR.resolve()
    if root != full and root not in full.parents:
        raise HTTPException(403, '非法路径')
    if not full.is_file():
        raise HTTPException(404, '文件不存在')
    return full


@app.get("/")
async def index():
    no_cache = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}
    react_index = REACT_DIR / "index.html"
    if react_index.is_file():
        return FileResponse(react_index, media_type="text/html", headers=no_cache)
    return FileResponse(STATIC_DIR / "index.html", media_type="text/html", headers=no_cache)


@app.get("/onepage")
async def onepage():
    return FileResponse(STATIC_DIR / "onepage.html", media_type="text/html")


@app.get("/assets/{path:path}")
async def react_assets(path: str):
    base = (REACT_DIR / "assets").resolve()
    fp = (REACT_DIR / "assets" / path).resolve()
    if base != fp and base not in fp.parents:
        raise HTTPException(403, "非法路径")
    if not fp.is_file():
        raise HTTPException(404)
    return FileResponse(fp, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/static/{path:path}")
async def static_file(path: str):
    base = STATIC_DIR.resolve()
    fp = (STATIC_DIR / path).resolve()
    if base != fp and base not in fp.parents:
        raise HTTPException(403, "非法路径")
    if not fp.is_file():
        raise HTTPException(404)
    # HTML entrypoints must not be cached: the intro page is edited in-place during local development.
    headers = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"} if fp.suffix.lower() in {".html", ".htm"} else {}
    return FileResponse(fp, headers=headers)


@app.get("/api/status")
async def api_status():
    return {"gateway": check_gateway(), "skills": get_skills(), "personas": list_personas()}


@app.get("/api/personas")
async def api_personas():
    return list_personas()


@app.get("/api/persona/{name}")
async def api_persona(name: str):
    text = load_profile_text(name)
    if not text:
        raise HTTPException(404, "画像不存在")
    return {"name": name, "content": text}


def _valid_persona_name(name: str) -> bool:
    return bool(name) and "/" not in name and "\\" not in name and not name.startswith((".", "_"))


def _persona_file_path(name: str, filename: str) -> Path:
    """校验画像名/文件名，返回 profiles/<name>/<filename> 的安全路径。"""
    if not _valid_persona_name(name):
        raise HTTPException(400, "画像名非法")
    if not filename.endswith(".md") or "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(400, "文件名非法")
    pd = (PROFILES_DIR / name).resolve()
    fp = (pd / filename).resolve()
    if pd != fp.parent or PROFILES_DIR.resolve() not in pd.parents:
        raise HTTPException(403, "非法路径")
    return fp


@app.get("/api/persona/{name}/files")
async def api_persona_files(name: str):
    """返回画像六维文件原文（按固定顺序 + 其余 .md），供在线编辑。"""
    if not profile_exists(name):
        raise HTTPException(404, "画像不存在")
    pd = PROFILES_DIR / name
    ordered = list(_FILE_ORDER) + sorted(f.name for f in pd.glob("*.md") if f.name not in _FILE_ORDER)
    files = []
    for fn in ordered:
        fp = pd / fn
        files.append({"filename": fn, "content": fp.read_text(encoding="utf-8") if fp.is_file() else ""})
    return {"name": name, "files": files}


class PersonaFileRequest(BaseModel):
    filename: str
    content: str


@app.put("/api/persona/{name}/file")
async def api_persona_file_save(name: str, req: PersonaFileRequest):
    """保存画像单个维度文件（原子写）。"""
    if not profile_exists(name):
        raise HTTPException(404, "画像不存在")
    fp = _persona_file_path(name, req.filename)
    tmp = fp.with_suffix(".md.tmp")
    tmp.write_text(req.content, encoding="utf-8")
    tmp.replace(fp)
    return {"ok": True, "filename": req.filename}


@app.delete("/api/persona/{name}")
async def api_persona_delete(name: str):
    """删除整个画像目录。"""
    if not _valid_persona_name(name):
        raise HTTPException(400, "画像名非法")
    pd = (PROFILES_DIR / name).resolve()
    if PROFILES_DIR.resolve() not in pd.parents or not pd.is_dir():
        raise HTTPException(404, "画像不存在")
    import shutil
    shutil.rmtree(pd)
    return {"ok": True, "deleted": name}


@app.get("/api/skills")
async def api_skills():
    return get_skills()


@app.get("/api/skill/{name}")
async def api_skill_detail(name: str):
    """单个 SKILL 详情：描述 + 正文 + API 需求与当前配置状态（脱敏）+ 小白版导读。"""
    full = find_skill(name)
    if full is None:
        raise HTTPException(404, f"SKILL '{name}' 不存在")
    md_path = SKILLS_DIR / "openclaw" / full / "SKILL.md"
    desc, layer, body = _parse_skill_md(md_path)
    needs_api = full in SKILL_API_REQUIREMENTS
    env = _read_env()
    return {
        "name": full,
        "layer": layer,
        "description": desc,
        "body": body,
        "needsApi": needs_api,
        "apiConfigured": _skill_api_configured(full, env) if needs_api else True,
        "apiSpec": _api_spec_status(full, env) if needs_api else None,
        "guide": _skill_guide(full, desc, body, md_path, env),
    }


class EnvUpdateRequest(BaseModel):
    updates: dict[str, str]


@app.post("/api/env")
async def api_env_save(req: EnvUpdateRequest):
    """写 API key 到项目根 .env（仅允许注册表内 env 名）。返回更新后各 skill 的配置状态。"""
    bad = [k for k in (req.updates or {}) if k not in _ENV_ALLOWLIST]
    if bad:
        raise HTTPException(400, f"不允许写入的变量：{', '.join(bad)}")
    _write_env(req.updates or {})
    env = _read_env()
    return {
        "ok": True,
        "skills": {s: _skill_api_configured(s, env) for s in SKILL_API_REQUIREMENTS},
    }


# ═══════════════════════════════════════════════════════════════════════
# 设置面板 · 环境安装（skills/shared/scripts/install_tool.py 引擎桥）
# 体检走引擎 check --json；安装后台跑、前端轮询 /api/env/job/{id}。
# ═══════════════════════════════════════════════════════════════════════

INSTALL_TOOL = SHARED_SCRIPTS / "install_tool.py"
from environment_install import EnvironmentInstalls, safe_output as _safe_env_output

_ENV_TOOLS_CACHE: dict = {"ts": 0.0, "data": None}
_ENV_CHECK_LOCK = threading.Lock()


def _env_install_finished():
    _ENV_TOOLS_CACHE["ts"] = 0.0


_ENV_INSTALLS = EnvironmentInstalls(INSTALL_TOOL, PROJECT_ROOT, sys.executable, DATA_DIR, _env_install_finished)


def _check_env_tools(refresh: bool = False):
    requested_at = time.time()
    with _ENV_CHECK_LOCK:
        # Reuse a check that finished while this caller was waiting, even for
        # refresh. A slow request must not cause several concurrent probes.
        cached = _ENV_TOOLS_CACHE["data"]
        if cached and (_ENV_TOOLS_CACHE["ts"] >= requested_at or
                       (not refresh and time.time() - _ENV_TOOLS_CACHE["ts"] < 15)):
            return cached
        try:
            proc = subprocess.run(
                [sys.executable, str(INSTALL_TOOL), "--python", sys.executable, "--json", "check"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=240, cwd=str(PROJECT_ROOT),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            raise HTTPException(504, "环境检测超过 240 秒；请稍后重新检测，安装任务不会因此中断")
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            detail = _safe_env_output((proc.stderr or "").strip(), PROJECT_ROOT, DATA_DIR)[-600:]
            raise HTTPException(500, f"环境检测失败：{detail or '无输出'}")
        try:
            data = json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise HTTPException(500, "环境检测没有返回有效结果，请重新检测")
        data["cachedAt"] = int(time.time())
        _ENV_TOOLS_CACHE.update({"ts": time.time(), "data": data})
        return data


@app.get("/api/env/tools")
async def api_env_tools(refresh: bool = False):
    """检测当前后端的解释器；单次检测共享，15 秒缓存。"""
    return await asyncio.to_thread(_check_env_tools, refresh)


class EnvInstallRequest(BaseModel):
    model_config = {"extra": "forbid"}
    id: str | None = Field(default=None, max_length=64)
    ids: list[str] | None = Field(default=None, min_length=1, max_length=20)


_INSTALL_IDS_CACHE: dict = {"ts": 0.0, "ids": frozenset()}
_INSTALL_CATALOG_CACHE: dict = {"ts": 0.0, "tools": {}}


def _install_tool_catalog() -> dict[str, dict]:
    if _INSTALL_CATALOG_CACHE["tools"] and time.time() - _INSTALL_CATALOG_CACHE["ts"] < 300:
        return _INSTALL_CATALOG_CACHE["tools"]
    try:
        p = subprocess.run([sys.executable, str(INSTALL_TOOL), "--python", sys.executable, "--json", "list"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=30, cwd=str(PROJECT_ROOT), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        tools = {t["id"]: t for t in (json.loads(p.stdout).get("tools") or []) if isinstance(t, dict) and t.get("id")}
        if p.returncode == 0 and tools:
            _INSTALL_CATALOG_CACHE.update(ts=time.time(), tools=tools)
    except Exception:  # noqa: BLE001
        pass
    return _INSTALL_CATALOG_CACHE["tools"]


def _install_tool_ids() -> frozenset[str]:
    """引擎里真实存在的配方 id（缓存 5 分钟）。安装接口只认这张表里的 id——
    只按正则放行的话，`--help` 这类带横线的串会被 argparse 当选项吃掉。"""
    if _INSTALL_IDS_CACHE["ids"] and time.time() - _INSTALL_IDS_CACHE["ts"] < 300:
        return _INSTALL_IDS_CACHE["ids"]
    ids = frozenset(_install_tool_catalog())
    if ids:
        _INSTALL_IDS_CACHE.update({"ts": time.time(), "ids": ids})
    return ids


@app.post("/api/env/install")
async def api_env_install(req: EnvInstallRequest):
    """服务端串行队列；重复的待装/在装工具复用原任务。"""
    if (req.id is None) == (req.ids is None):
        raise HTTPException(400, "请提供一个工具 id 或一组 ids")
    ids = [(tid or "").strip() for tid in (req.ids or [req.id])]
    catalog = await asyncio.to_thread(_install_tool_catalog)
    try:
        return _ENV_INSTALLS.enqueue(ids, catalog)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


@app.get("/api/env/jobs")
async def api_env_jobs():
    """重新打开页面/恢复网络时找回本服务全部进行中及近期终态任务。"""
    return _ENV_INSTALLS.list()


@app.post("/api/env/job/{job_id}/retry")
async def api_env_retry(job_id: str):
    catalog = await asyncio.to_thread(_install_tool_catalog)
    try:
        return _ENV_INSTALLS.retry(job_id, catalog)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


@app.get("/api/env/job/{job_id}")
async def api_env_job(job_id: str):
    """读取阶段、真实日志、耗时与终态；连接失败本身不是安装失败。"""
    job = _ENV_INSTALLS.get(job_id)
    if not job:
        raise HTTPException(404, "任务不存在（服务可能重启过）")
    return job


# ═══════════════════════════════════════════════════════════════════════
# 设置面板 · 模型配置（v1：按真实 .env / openclaw.json 只读展示 + 真自测）
# ═══════════════════════════════════════════════════════════════════════


def _mask_key(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    return f"{v[:5]}…{v[-4:]}" if len(v) > 14 else "已配置"


_CHAT_PROTOCOLS = {'openai': 'openai', 'anthropic': 'anthropic', 'relay': 'anthropic'}
_CHAT_MODEL_KEYS = {'openai': 'OPENAI_MODEL', 'anthropic': 'ANTHROPIC_MODEL', 'relay': 'EASEL_LLM_MODEL'}
_MODEL_CONFIG_LOCK = threading.RLock()


def _chat_model(slot: str, env: dict, providers: dict | None = None) -> str:
    configured = str(env.get(_CHAT_MODEL_KEYS[slot]) or '').strip()
    if configured:
        return configured
    provider = providers.get(slot) if isinstance(providers, dict) else None
    models = provider.get('models') if isinstance(provider, dict) else []
    models = models if isinstance(models, list) else []
    if models and isinstance(models[0], dict) and models[0].get('id'):
        return str(models[0]['id'])
    legacy = str(env.get('CLAUDE_MODEL') or '').strip()
    if slot != 'openai' and legacy:
        if '/' not in legacy:
            return legacy
        prefix, model = legacy.split('/', 1)
        if prefix == slot or (slot == 'relay' and prefix == 'anthropic'):
            return model
    return 'deepseek-chat' if slot == 'openai' else 'claude-sonnet-4-6'


def _model_channels() -> dict:
    env = _read_env()
    primary = ""
    providers = {}
    try:
        oc = openclaw_state_dir() / "openclaw.json"
        if oc.is_file():
            config = json.loads(oc.read_text(encoding="utf-8"))
            primary = str(config.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", ""))
            configured_providers = config.get('models', {}).get('providers', {})
            providers = configured_providers if isinstance(configured_providers, dict) else {}
    except Exception:  # noqa: BLE001
        pass

    chat_rows = []
    ob = (env.get("OPENAI_BASE_URL") or "").strip()
    ok_key = bool((env.get("OPENAI_API_KEY") or "").strip())
    if ob or ok_key:
        chat_rows.append({
            "slot": "openai", "order": 1, "name": "deepseek",
            "sub": "官方直连",
            "type": "openai", "protocol": "openai", "model": _chat_model('openai', env, providers),
            "baseUrl": ob, "keyMasked": _mask_key(env.get("OPENAI_API_KEY", "")),
            "role": "主" if primary.startswith("openai/") else "备",
            "result": "已配置" if ok_key else "缺 key",
        })
    ab = (env.get("ANTHROPIC_BASE_URL") or "").strip()
    ak = (env.get("ANTHROPIC_API_KEY") or "").strip()
    if ab or ak:
        chat_rows.append({
            "slot": "anthropic", "order": len(chat_rows) + 1, "name": "anthropic", "sub": "官方直连",
            "type": "anthropic", "protocol": "anthropic", "model": _chat_model('anthropic', env, providers),
            "baseUrl": ab or "https://api.anthropic.com", "keyMasked": _mask_key(ak),
            "role": "主" if primary.startswith('anthropic/') else "备", "result": "已配置" if ak else "缺 key",
        })
    lb = (env.get("EASEL_LLM_BASE_URL") or "").strip()
    lk = (env.get("EASEL_LLM_API_KEY") or "").strip()
    if lb or lk:
        chat_rows.append({
            "slot": "relay", "order": len(chat_rows) + 1, "name": "relay", "sub": "中转站",
            "type": "anthropic", "protocol": "anthropic", "model": _chat_model('relay', env, providers),
            "baseUrl": lb or "（未配置）", "keyMasked": _mask_key(lk),
            "role": "主" if primary.startswith('relay/') else "备", "result": "已配置" if lk else "缺 key",
        })

    custom_rows = []
    try:
        oc = openclaw_state_dir() / "openclaw.json"
        if oc.is_file():
            provs = (json.loads(oc.read_text(encoding="utf-8"))
                     .get("models", {}).get("providers", {})) or {}
            for pkey, pv in provs.items():
                if pkey in ("openai", "anthropic", "relay") or not isinstance(pv, dict):
                    continue
                models = pv.get("models") if isinstance(pv.get("models"), list) else []
                mid = models[0].get("id", "") if models and isinstance(models[0], dict) else ""
                custom_rows.append({
                    "slot": "custom", "order": 0, "name": pkey, "sub": "自定义",
                    "type": 'anthropic' if pv.get('api') == 'anthropic-messages' else 'openai',
                    "protocol": 'anthropic' if pv.get('api') == 'anthropic-messages' else 'openai',
                    "model": mid or "", "baseUrl": pv.get("baseUrl") or "",
                    "keyMasked": _mask_key(str(pv.get("apiKey") or "")),
                    "role": "主" if primary == f"{pkey}/{mid}" else "备",
                    "result": "已配置" if str(pv.get("apiKey") or "").strip() else "缺 key",
                    "deletable": True,
                })
    except Exception:  # noqa: BLE001
        pass
    chat_rows.extend(custom_rows)

    sf = bool((env.get("SILICONFLOW_API_KEY") or "").strip())
    trans_rows = [
        {"order": 0, "name": "自带字幕", "sub": "视频自带 SRT/VTT 时直接读", "type": "脚本层",
         "model": "—", "baseUrl": "—", "keyMasked": "—", "role": "免配", "result": "优先"},
        {"slot": "siliconflow", "order": 1, "name": "siliconflow", "sub": "硅基流动", "type": "openai",
         "model": (env.get("SILICONFLOW_ASR_MODEL") or "").strip() or "XingChenAGI/XingChenGSR-V1.0",
         "baseUrl": (env.get("SILICONFLOW_BASE_URL") or "").strip() or "https://api.siliconflow.cn/v1",
         "modelEditable": True, "baseEditable": True,
         "keyMasked": _mask_key(env.get("SILICONFLOW_API_KEY", "")), "role": "主",
         "result": "已配置" if sf else "缺 key"},
    ]
    channels: dict = {"chat": {"rows": chat_rows}, "transcribe": {"rows": trans_rows}}
    try:
        import model_registry as _mr  # skills/shared/scripts 已在 sys.path 上
        _setting_env = {"video": "VIDEO_PROVIDER", "music": "MUSIC_PROVIDER", "voice": "VOICE_PROVIDER"}
        for _gid, _ch in (("image", "image"), ("video", "video"), ("music", "music"), ("voice", "speech")):
            _spec = _media_ui_spec(_gid)
            _chosen = (env.get(_setting_env.get(_gid, ""), "") or "").strip()
            _rows = []
            for _p in _spec["providers"]:
                _req = [k for k in _p["keys"] if k["required"]]
                _bk = next((k for k in _p["keys"] if not k["secret"]
                            and ("BASE" in k["env"] or "URL" in k["env"])), None)
                _mk = next((k for k in _p["keys"] if not k["secret"] and "MODEL" in k["env"]), None)
                _edit_keys = [k for k in _req if k is not _bk and k is not _mk]
                _k1 = _edit_keys[0] if _edit_keys else None
                _k2 = _edit_keys[1] if len(_edit_keys) > 1 else None
                _ok = all(_is_set(env.get(k["env"])) or any(_is_set(env.get(a)) for a in k.get("aliases", []))
                          for k in _req)
                _masked = ""
                if _k1:
                    _raw = env.get(_k1["env"], "")
                    if not _raw:
                        for _a in _k1.get("aliases", []):
                            if env.get(_a):
                                _raw = env[_a]
                                break
                    _masked = _mask_key(_raw)
                _rows.append({
                    "slot": _p["id"], "order": 0, "name": _p["name"], "sub": _gid,
                    "type": _p["id"], "model": (env.get(_mk["env"]) or "").strip() if _mk else "",
                    "baseUrl": (env.get(_bk["env"]) or "").strip() if _bk else "",
                    "keyMasked": _masked, "role": "主" if (_gid == "image" or _chosen == _p["id"]) else "备",
                    "result": "已配置" if _ok else "未配置",
                    "key2Label": _k2["label"] if _k2 else "",
                    "key2Masked": _mask_key(env.get(_k2["env"], "")) if _k2 and _k2["secret"] else "",
                    "modelEditable": _mk is not None,
                    "baseEditable": _bk is not None,
                    "baseOptional": (_bk is None) or (not _bk["required"]),
                })
            channels[_ch] = {"rows": _rows}
    except Exception:  # noqa: BLE001
        pass
    return {"channels": channels, "primary": primary}


@app.get("/api/settings/models")
async def api_settings_models():
    """模型通道：chat / transcribe（含可编辑的原值；key 只回脱敏）。"""
    return _model_channels()


def _write_env_direct(updates: dict[str, str]) -> None:
    """后端受控键位专用：就地更新/追加 .env（不做 allowlist 过滤，仅服务端固定映射调用）。原子写。"""
    updates = {k: v for k, v in updates.items() if k and v.strip() != ''}
    if not updates:
        return
    _guard_env_values(updates)
    lines = ENV_FILE.read_text(encoding='utf-8').splitlines() if ENV_FILE.is_file() else []
    seen = set()
    out = []
    for line in lines:
        s = line.strip()
        matched = None
        if s and not s.startswith('#') and '=' in s:
            k = s.split('=', 1)[0].strip()
            if k in updates:
                matched = k
        if matched is not None:
            seen.add(matched)
            out.append(f'{matched}={updates[matched]}')
            continue
        out.append(line)
    appended = [f'{k}={v}' for k, v in updates.items() if k not in seen]
    if appended:
        if out and out[-1].strip() != '':
            out.append('')
        out.append('# ---- Easel 模型配置（Web 设置面板写入）----')
        out.extend(appended)
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    _atomic_model_bytes(ENV_FILE, ('\n'.join(out) + '\n').encode('utf-8'))


RESERVED_PROVIDER_KEYS = {"openai", "anthropic", "relay"}


def _openclaw_provider_creds() -> dict[str, tuple[str, str]]:
    """读 openclaw.json 里每个 chat 供应商现存的 (baseUrl, apiKey)。读不到就当空表（不阻断保存）。"""
    try:
        oc = openclaw_state_dir() / 'openclaw.json'
        provs = json.loads(oc.read_text(encoding='utf-8')).get('models', {}).get('providers', {})
        return {k: (str(v.get('baseUrl') or ''), str(v.get('apiKey') or ''))
                for k, v in provs.items() if isinstance(v, dict)}
    except Exception:  # noqa: BLE001
        return {}


def _sync_openclaw_chat(provider_updates: dict[str, dict], keep_custom: set[str], primary_ref: str) -> str:
    """同步 chat 供应商到 ~/.openclaw-easel/openclaw.json：更新/新增 + 删除多余自定义 + 主模型。

    provider_updates: {pkey: {"model","base","key"}}；keep_custom: 保留的自定义键；primary_ref: 目标主模型（空=不改）。
    只有确有差异才落盘；由外层配置事务恢复普通写入失败。
    """
    try:
        oc = openclaw_state_dir() / 'openclaw.json'
        data = json.loads(oc.read_text(encoding='utf-8')) if oc.is_file() else {}
        providers = data.setdefault('models', {}).setdefault('providers', {})
        changed = False
        for pkey in [k for k in list(providers.keys())
                     if k not in RESERVED_PROVIDER_KEYS and k not in keep_custom]:
            providers.pop(pkey, None)
            changed = True
        for pkey, vals in provider_updates.items():
            prov = providers.setdefault(pkey, {})
            base, key, model = vals.get('base', ''), vals.get('key', ''), vals.get('model', '')
            local_gateway = _is_local_gateway_base(prov.get('baseUrl'))
            if local_gateway and key and key != prov.get('apiKey'):
                raise ValueError('gateway credentials require separate configuration')
            if vals.get('replaceAuth'):
                for field in ('headers', 'auth', 'authHeader'):
                    if field in prov:
                        prov.pop(field)
                        changed = True
            if pkey in _CHAT_MODEL_KEYS:
                env = _read_env()
                if not base and not prov.get('baseUrl'):
                    base = env.get(_SLOT_ENV_KEYS[pkey][0], '') or (
                        'https://api.anthropic.com' if pkey == 'anthropic' else
                        'https://api.openai.com/v1' if pkey == 'openai' else '')
                if not key and not prov.get('apiKey'):
                    key = env.get(_SLOT_ENV_KEYS[pkey][1], '')
                if not model and not prov.get('models'):
                    model = _chat_model(pkey, env)
            api = 'anthropic-messages' if vals.get('protocol', _CHAT_PROTOCOLS.get(pkey)) == 'anthropic' else 'openai-completions'
            if not local_gateway and prov.get('api') != api:
                prov['api'] = api
                changed = True
            if base and prov.get('baseUrl') != base:
                if _is_local_gateway_base(prov.get('baseUrl')):
                    pass  # 本地模型网关模式：保留网关地址（真实上游在 easel-models.yaml），勿改回直连
                else:
                    prov['baseUrl'] = base
                    changed = True
            if key and prov.get('apiKey') != key:
                previous_key = str(prov.get('apiKey') or '')
                if isinstance(prov.get('headers'), dict):
                    for header, value in prov['headers'].items():
                        if previous_key and isinstance(value, str) and previous_key in value:
                            prov['headers'][header] = value.replace(previous_key, key)
                prov['apiKey'] = key
                changed = True
            if model:
                models = prov.get('models') if isinstance(prov.get('models'), list) and prov.get('models') else [{}]
                if not isinstance(models[0], dict):
                    models = [{}]
                if models[0].get('id') != model:
                    models[0]['id'] = model
                    changed = True
                prov['models'] = models
        if primary_ref:
            ref = data.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})
            if ref.get('primary') != primary_ref:
                ref['primary'] = primary_ref
                changed = True
        if not changed:
            return ''
        _atomic_model_bytes(oc, json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8'))
        return 'openclaw 已同步（下一条消息生效）'
    except Exception as e:  # noqa: BLE001
        raise RuntimeError('OpenClaw 配置同步失败') from e


def _atomic_model_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temp.open('xb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def _model_file_snapshot() -> dict[Path, bytes | None]:
    paths = (ENV_FILE, openclaw_state_dir() / 'openclaw.json', DATA_DIR / 'channel-names.json')
    return {p: p.read_bytes() if p.exists() else None for p in paths}


def _commit_model_configuration(updates: dict[str, str], providers: dict[str, dict] | None = None,
                                keep: set[str] | None = None, primary: str = '', channel_label: tuple[str, str] | None = None) -> str:
    """Rollback ordinary write/sync failures. Each file is atomic; hard process termination is not a transaction."""
    _guard_env_values(updates)
    with _MODEL_CONFIG_LOCK:
        try:
            before = _model_file_snapshot()
        except Exception:
            raise HTTPException(500, '无法读取现有配置，未保存；请检查配置文件和访问权限') from None
        try:
            if updates:
                _write_env_direct(updates)
            note = _sync_openclaw_chat(providers, keep or set(), primary) if providers is not None else ''
            if '失败' in note:
                raise RuntimeError('sync failed')
            if channel_label:
                channel_profiles.save(sys.modules[__name__], channel_label[0], channel_label[1], channel_label[1])
            return note
        except Exception:
            restored = True
            for path, content in before.items():
                try:
                    current = path.read_bytes() if path.exists() else None
                    if current != content:
                        if content is None:
                            path.unlink(missing_ok=True)
                        else:
                            _atomic_model_bytes(path, content)
                except Exception:
                    restored = False
            if not restored:
                raise HTTPException(500, '保存失败且未能完整恢复；请检查文件权限并核对配置后再重试') from None
            raise HTTPException(500, '保存失败，原有配置已恢复；请检查文件权限或 OpenClaw 配置后重试') from None


class ModelSaveRow(BaseModel):
    slot: str = ""
    name: str = ""
    model: str = ""
    baseUrl: str = ""
    key: str = ""
    key2: str = ""
    primary: bool = False
    protocol: str = ""


class ModelSaveRequest(BaseModel):
    channel: str = "chat"
    rows: list[ModelSaveRow] = Field(default_factory=list)
    deletedProviders: list[str] = Field(default_factory=list)


@app.post("/api/settings/models/save")
async def api_settings_models_save(req: ModelSaveRequest):
    """保存模型通道：.env 就地更新（key 留空=不改）；chat 同步 openclaw；媒体通道写 provider 配置。"""
    ch0 = (req.channel or "").strip()
    if ch0 not in ('chat', 'transcribe', 'speech', 'image', 'video', 'music'):
        raise HTTPException(400, '未知模型通道')
    if ch0 in ("speech", "image", "video", "music"):
        import model_registry as _mr2
        _gid0 = {"speech": "voice", "image": "image", "video": "video", "music": "music"}[ch0]
        _spec0 = _media_ui_spec(_gid0)
        _by_id = {p["id"]: p for p in _spec0["providers"]}
        _setting0 = {"video": "VIDEO_PROVIDER", "music": "MUSIC_PROVIDER", "voice": "VOICE_PROVIDER"}.get(_gid0)
        _mupd: dict[str, str] = {}
        _primary0 = ""
        _env0 = _read_env()
        for _row in req.rows:
            _pid = (_row.slot or "").strip()
            _p0 = _by_id.get(_pid)
            if not _p0:
                raise HTTPException(400, f"不认识的服务商：{_pid or '（空）'}")
            _base0 = (_row.baseUrl or "").strip().rstrip("/")
            _key0 = (_row.key or "").strip()
            _key20 = (_row.key2 or "").strip()
            _model0 = (_row.model or "").strip()
            if _base0 and not _valid_base_url(_base0):
                raise HTTPException(400, f'{_p0["name"]} 的根地址需是合法的 http(s):// 地址')
            if (_key0 and any(x.isspace() for x in _key0)) or (_key20 and any(x.isspace() for x in _key20)):
                raise HTTPException(400, f'{_p0["name"]} 的 Key 不能包含空白字符')
            _bk0 = next((k for k in _p0["keys"] if not k["secret"]
                         and ("BASE" in k["env"] or "URL" in k["env"])), None)
            _mk0 = next((k for k in _p0["keys"] if not k["secret"] and "MODEL" in k["env"]), None)
            _req0 = [k for k in _p0["keys"] if k["required"] and k is not _bk0 and k is not _mk0]
            # 与对话通道同一条规矩：只改根地址、Key 留空（留空=沿用旧 Key），等于把已存的真 Key
            # 指到新地址去——SILICONFLOW 这类通道还有「连通性自测」会把它当 Bearer 发过去。
            if _base0 and _bk0 and not _key0 and _base0 != (_env0.get(_bk0["env"], "") or "").strip().rstrip("/") \
                    and _req0 and (_env0.get(_req0[0]["env"], "") or "").strip():
                raise HTTPException(400, f'更换{_p0["name"]}的根地址时必须重新填写 Key')
            if _key0 and _req0:
                _mupd[_req0[0]["env"]] = _key0
            if _key20 and len(_req0) > 1:
                _mupd[_req0[1]["env"]] = _key20
            if _model0 and _mk0:
                _mupd[_mk0["env"]] = _model0
            if _base0 and _bk0:
                _mupd[_bk0["env"]] = _base0
            if getattr(_row, "primary", False):
                _primary0 = _pid
        if _primary0 and _setting0:
            _mupd[_setting0] = _primary0
        if not _mupd:
            raise HTTPException(400, "没有可保存的改动（key 留空表示不改）")
        _commit_model_configuration(_mupd)
        _resp0 = {"ok": True, "note": ""}
        _resp0.update(_model_channels())
        return _resp0

    updates: dict[str, str] = {}
    provider_updates: dict[str, dict] = {}
    keep_custom: set[str] = set()
    primary_ref = ''
    is_chat = (req.channel or '').strip() == 'chat'
    _cur_env = _read_env()
    _cur_prov = _openclaw_provider_creds() if is_chat else {}
    if is_chat:
        if any(name in RESERVED_PROVIDER_KEYS or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,23}', name)
               for name in req.deletedProviders):
            raise HTTPException(400, '只能显式删除自定义服务商')
        keep_custom = set(_cur_prov) - set(req.deletedProviders)
    for row in req.rows:
        slot = (row.slot or '').strip()
        name = (row.name or '').strip().lower()
        model = (row.model or '').strip()
        base = (row.baseUrl or '').strip().rstrip('/')
        key = (row.key or '').strip()
        protocol = (row.protocol or '').strip().lower()
        if is_chat and slot in _CHAT_PROTOCOLS and protocol and protocol != _CHAT_PROTOCOLS[slot]:
            raise HTTPException(400, '服务商协议与目标槽位不匹配，请选择同协议的服务商')
        if is_chat and slot == 'custom' and protocol and protocol not in ('openai', 'anthropic'):
            raise HTTPException(400, '自定义服务商仅支持 OpenAI Chat Completions 或 Anthropic 协议')
        if base and not _valid_base_url(base):
            raise HTTPException(400, 'Base URL 需是合法的 http(s):// 地址')
        if key and any(ch.isspace() for ch in key):
            raise HTTPException(400, 'API Key 不能包含空白字符')
        if len(model) > 120 or len(base) > 300 or len(key) > 400:
            raise HTTPException(400, '字段过长，请检查')
        # 改 Base URL 但把 Key 留空（留空=沿用旧 Key）＝ 把已存的真 Key 指向新地址，
        # 之后一次「连通性自测」就会把它当 Bearer 送到新地址去。换地址必须重填 Key。
        _be, _ke = _SLOT_ENV_KEYS.get(slot, ('', ''))
        saved_base = (_cur_env.get(_be, '') or '').strip().rstrip('/') if _be else ''
        if slot == 'anthropic' and not saved_base:
            saved_base = 'https://api.anthropic.com'
        elif slot == 'siliconflow' and not saved_base:
            saved_base = 'https://api.siliconflow.cn/v1'
        if base and _be and not key and base != saved_base \
                and (_cur_env.get(_ke, '') or '').strip():
            raise HTTPException(400, f'更换 Base URL 时必须重新填写 API Key（{slot}）')
        pkey = ''
        if slot == 'openai':
            if model:
                updates['OPENAI_MODEL'] = model
            if base:
                updates['OPENAI_BASE_URL'] = base
            if key:
                updates['OPENAI_API_KEY'] = key
            if is_chat:
                provider_updates['openai'] = {'model': model, 'base': base, 'key': key}
                pkey = 'openai'
        elif slot == 'relay':
            if base:
                updates['EASEL_LLM_BASE_URL'] = base
            if model:
                updates['EASEL_LLM_MODEL'] = model
            if key:
                updates['EASEL_LLM_API_KEY'] = key
            if is_chat:
                pkey = 'relay'
                provider_updates[pkey] = {'model': model, 'base': base, 'key': key, 'protocol': 'anthropic'}
        elif slot == 'anthropic':
            if model:
                updates['ANTHROPIC_MODEL'] = model
            if base:
                updates['ANTHROPIC_BASE_URL'] = base
            if key:
                updates['ANTHROPIC_API_KEY'] = key
            if is_chat:
                pkey = 'anthropic'
                provider_updates[pkey] = {'model': model, 'base': base, 'key': key, 'protocol': 'anthropic'}
        elif slot == 'siliconflow':
            if base:
                updates['SILICONFLOW_BASE_URL'] = base
            if key:
                updates['SILICONFLOW_API_KEY'] = key
            if model:
                updates['SILICONFLOW_ASR_MODEL'] = model
        elif slot == 'custom' and is_chat:
            if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,23}', name):
                raise HTTPException(400, f'供应商名只能用小写字母/数字/横线（最长24位）：{name[:30] or "（空）"}')
            if name in RESERVED_PROVIDER_KEYS:
                raise HTTPException(400, f'「{name}」是内置槽位名，请换一个')
            if not model or not base:
                raise HTTPException(400, f'自定义供应商「{name}」需要同时填模型和 Base URL')
            provider_updates[name] = {'model': model, 'base': base, 'key': key, 'protocol': protocol or 'openai'}
            keep_custom.add(name)
            pkey = name
        # 同一条规矩也得覆盖 openclaw.json 这一侧：_sync_openclaw_chat 只在 key 非空时改
        # apiKey，却无条件改 baseUrl —— 只换地址、Key 留空，下一轮对话就会拿着原 Key 去打新地址。
        # 自定义供应商压根不写 .env，前面那道 _SLOT_ENV_KEYS 闸拦不到它。
        # 但网关模式要放行：那边存的是 127.0.0.1:8890、面板回传的是真实上游，永远不相等，
        # 这道闸会把网关用户彻底锁死（连只改模型都保存不了）；而且下面 _sync_openclaw_chat
        # 本来就不会改网关的 baseUrl，没有「拿旧 Key 打新地址」这个风险。
        if is_chat and pkey and base and not key:
            _pb, _pk = _cur_prov.get(pkey, ('', ''))
            if _pk and base != _pb.strip().rstrip('/') and not _is_local_gateway_base(_pb):
                raise HTTPException(400, f'更换 Base URL 时必须重新填写 API Key（{pkey}）')
        if is_chat and pkey and getattr(row, 'primary', False) and model:
            primary_ref = f'{pkey}/{model}'
    if not updates and not provider_updates and not primary_ref and not req.deletedProviders:
        raise HTTPException(400, '没有可保存的改动（key 留空表示不改）')
    note = _commit_model_configuration(updates, provider_updates if is_chat else None, keep_custom, primary_ref)
    resp = {"ok": True, "note": note}
    resp.update(_model_channels())
    return resp


class SelftestRequest(BaseModel):
    channel: str = "chat"


@app.post("/api/settings/models/selftest")
async def api_models_selftest(req: SelftestRequest):
    """真自测：对已配置的 OpenAI 兼容通道发 GET {base}/models 并计耗时。"""
    channel = (req.channel or "all").strip()
    env = _read_env()
    targets: list[tuple[str, str]] = []
    if channel in ("chat", "all"):
        for base, key in ((env.get("ANTHROPIC_BASE_URL", ""), env.get("ANTHROPIC_API_KEY", "")),
                          (env.get("OPENAI_BASE_URL", ""), env.get("OPENAI_API_KEY", "")),
                          (env.get("EASEL_LLM_BASE_URL", ""), env.get("EASEL_LLM_API_KEY", ""))):
            if base.strip() and key.strip():
                targets.append((base.strip().rstrip("/"), key.strip()))
    if channel in ("transcribe", "all") and (env.get("SILICONFLOW_API_KEY") or "").strip():
        targets.append(((env.get("SILICONFLOW_BASE_URL") or "https://api.siliconflow.cn/v1").strip().rstrip("/"),
                        env["SILICONFLOW_API_KEY"].strip()))

    # 这里会把真实 API Key 当 Bearer 发出去，所以目标地址必须先过闸：
    # 合法 http(s)、且不指向本机/内网/云元数据；跳转也不跟（跟了等于绕过前面的判断）。
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_a, **_kw):
            return None

    _opener = urllib.request.build_opener(_NoRedirect)

    def _probe(base: str, key: str) -> dict:
        t0 = time.time()
        if not _valid_base_url(base):
            return {"baseUrl": base, "ok": False, "ms": 0, "detail": "Base URL 不合法，未发起请求"}
        if not _ssrf_safe(base):
            return {"baseUrl": base, "ok": False, "ms": 0,
                    "detail": "目标指向本机/内网地址，已拒绝（避免把 API Key 发给内网服务）"}
        try:
            _model_health_service().reserve_legacy()
            rq = urllib.request.Request(base + "/models", headers={"Authorization": f"Bearer {key}"})
            with _opener.open(rq, timeout=15) as resp:
                return {"baseUrl": base, "ok": resp.status == 200, "ms": int((time.time() - t0) * 1000)}
        except HTTPException as exc:
            return {"baseUrl": base, "ok": False, "ms": 0, "detail": "滚动 60 秒测活额度已用完，本目标未发起请求", "rateLimited": exc.status_code == 429}
        except Exception as e:  # noqa: BLE001
            if isinstance(e, urllib.error.HTTPError):
                e.close()
            return {"baseUrl": base, "ok": False, "ms": int((time.time() - t0) * 1000),
                    "detail": _redact(f"{type(e).__name__}: {e}", key)[:140]}

    results = await asyncio.to_thread(lambda: [_probe(b, k) for b, k in targets])
    return {"channel": channel, "results": results, "testedAt": int(time.time())}


def _model_health_target(ref: str):
    """Resolve exact saved model refs, never accept request-supplied credentials."""
    import office_controls
    with _MODEL_CONFIG_LOCK:
        path = openclaw_state_dir() / "openclaw.json"
        if ref not in {row["id"] for row in office_controls.configured_models(path)}:
            return None
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
            provider, model = ref.split("/", 1)
            saved = config["models"]["providers"][provider]
            entry = next(row for row in saved["models"] if row.get("id") == model)
            api = entry.get("api") or saved.get("api") or _CHAT_PROTOCOLS.get(provider, "")
            protocol = {"openai-completions": "openai", "anthropic-messages": "anthropic",
                        "openai": "openai", "anthropic": "anthropic"}.get(api, "")
            base = str(saved.get("baseUrl") or _saved_base_for("chat", provider)).strip().rstrip("/")
            key = saved.get("apiKey") or _saved_key_for("chat", provider)
            if _is_local_gateway_base(base):
                # Built-in gateway routes expose an adapter URL, not the saved
                # upstream. Probe the exact env-backed model without fallback.
                env = _read_env()
                if provider not in _CHAT_MODEL_KEYS or _chat_model(provider, env, {provider: saved}) != model:
                    return None
                base = _saved_base_for("chat", provider).strip().rstrip("/")
                key = _saved_key_for("chat", provider)
                protocol = _CHAT_PROTOCOLS[provider]
            if not isinstance(key, str):
                return None
            match = re.fullmatch(r"\$\{([A-Z][A-Z0-9_]*)\}", key)
            if match:
                key = _read_env().get(match[1], "") or os.environ.get(match[1], "")
            # Header/OAuth authentication is not interchangeable with these protocols.
            if any(row.get("auth") or row.get("headers") or row.get("authHeader") is False for row in (saved, entry)):
                return None
            return model_health.Target(ref, provider, model, protocol, base, key.strip())
        except (OSError, ValueError, KeyError, TypeError, StopIteration, AttributeError):
            return None


_MODEL_HEALTH_SERVICE = None
_MODEL_HEALTH_SERVICE_LOCK = threading.Lock()


def _model_health_service():
    global _MODEL_HEALTH_SERVICE
    root = DATA_DIR / "model-health"
    with _MODEL_HEALTH_SERVICE_LOCK:
        if _MODEL_HEALTH_SERVICE is None or _MODEL_HEALTH_SERVICE.path.parent != root:
            _MODEL_HEALTH_SERVICE = model_health.Service(root, _model_health_target,
                lambda base: _valid_base_url(base) and (_ssrf_safe(base) or
                    (_ssrf_safe_allow_local() and _is_loopback_url(base))))
        return _MODEL_HEALTH_SERVICE


def _conversation_title_runner(prompt, *, timeout=45, session_id=None, thinking_level=None):
    """One saved default-model completion without Agent tools or session mutation."""
    if thinking_level is not None:
        raise ValueError("标题生成当前使用渠道默认思考设置")
    try:
        config = json.loads((openclaw_state_dir() / "openclaw.json").read_text(encoding="utf-8"))
        selected = config["agents"]["defaults"]["model"]
        ref = selected.get("primary") if isinstance(selected, dict) else selected
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError("请先保存缺省模型配置") from None
    target = _model_health_service().target(ref)
    result = model_health.dispatch(target, prompt, "text")
    if not result.get("ok"):
        raise ValueError("标题模型请求失败")
    return result.get("preview", "")


class ModelProbeRequest(BaseModel):
    modelRef: str = Field(min_length=1, max_length=500)
    mode: Literal["text", "vision"] = "text"
    prompt: str = Field(default="", max_length=2000)


class ModelSchedulesRequest(BaseModel):
    schedules: list[dict] = Field(default_factory=list, max_length=32)


@app.get("/api/settings/models/health")
async def api_model_health():
    return await asyncio.to_thread(_model_health_service().status)


def _channel_labels():
    return channel_profiles.labels(sys.modules[__name__])


class ChannelNameRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)


@app.get('/api/settings/models/channel-names')
async def api_channel_names():
    return {'channels': await asyncio.to_thread(_channel_labels)}


@app.post('/api/settings/models/channel-names')
async def api_channel_name_save(req: ChannelNameRequest):
    def save():
        with _MODEL_CONFIG_LOCK:
            try:
                name = channel_profiles.save(sys.modules[__name__], req.provider, req.name)
                return {'ok': True, 'name': name}
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from None
            except OSError:
                raise HTTPException(500, '渠道名称保存失败，原名称已保留。') from None
    return await asyncio.to_thread(save)


_CHANNEL_CONNECTIONS = {}
_CHANNEL_CONNECTION_LOCK = threading.Lock()


@app.get('/api/settings/models/connection')
async def api_channel_connection(modelRef: str):
    def check():
        target = _model_health_service().target(modelRef)
        fingerprint = channel_profiles.fingerprint(target)
        with _CHANNEL_CONNECTION_LOCK:
            cached = _CHANNEL_CONNECTIONS.get(fingerprint)
            if cached and time.monotonic() - cached[0] < 60:
                result = cached[1]
            else:
                result = _discover_models(target.base, target.key, target.protocol)
                _CHANNEL_CONNECTIONS[fingerprint] = (time.monotonic(), result)
                while len(_CHANNEL_CONNECTIONS) > 128:
                    _CHANNEL_CONNECTIONS.pop(next(iter(_CHANNEL_CONNECTIONS)))
        # Reject a late response after the channel configuration changes.
        current = _model_health_service().target(modelRef)
        if channel_profiles.fingerprint(current) != fingerprint:
            raise HTTPException(409, '渠道配置已变化，请重新检测。')
        ok = result.get('ok') is True
        return {'modelRef': modelRef, 'state': 'success' if ok else 'unverified' if result.get('kind') in ('not_found', 'unsupported') else 'failed',
                'channelName': _channel_labels().get(target.provider, {}).get('name', '未命名渠道'),
                'detail': ('渠道模型列表已读取；模型推理尚未验证。' if ok else str(result.get('message') or '渠道模型列表读取失败，推理能力尚未验证。')),
                'modelListed': target.model in result.get('models', []), 'checkedAt': int(time.time()), 'kind': result.get('kind', 'unknown')}
    return await asyncio.to_thread(check)


@app.post("/api/settings/models/probe")
async def api_model_probe(req: ModelProbeRequest):
    return await asyncio.to_thread(_model_health_service().probe, req.modelRef, req.mode, req.prompt)


@app.post("/api/settings/models/health/schedules")
async def api_model_schedules(req: ModelSchedulesRequest):
    return await asyncio.to_thread(_model_health_service().configure, req.schedules)


def _image_reverse_providers() -> list[ImageReverseProvider]:
    """Resolve only saved chat channels; request data can never choose a URL or key."""
    with _MODEL_CONFIG_LOCK:
        channels = _model_channels().get('channels', {}).get('chat', {}).get('rows', [])
        credentials = _openclaw_provider_creds()
        result = []
        for row in channels:
            custom = row.get('slot') == 'custom'
            ident = str(row.get('name') if custom else row.get('slot') or '')
            base, key = credentials.get(ident, ('', '')) if custom else (
                _saved_base_for('chat', ident), _saved_key_for('chat', ident))
            result.append(ImageReverseProvider(
                id=ident, name=str(row.get('name') or ident), model=str(row.get('model') or ''),
                protocol=str(row.get('protocol') or ''), base_url=base.strip(), key=key.strip()))
        return result


@app.get('/api/image-reverse/config')
async def api_image_reverse_config():
    return {'providers': [provider.public() for provider in _image_reverse_providers()],
            'modelRef': _image_reverse_model_ref(),
            'maxBytes': IMAGE_REVERSE_MAX_BYTES, 'maxPixels': IMAGE_REVERSE_MAX_PIXELS,
            'formats': list(IMAGE_REVERSE_FORMATS.values())}


def _image_reverse_model_ref() -> str:
    try:
        value = json.loads((DATA_DIR / 'image-reverse-config.json').read_text(encoding='utf-8'))
        ref = value.get('modelRef', '') if isinstance(value, dict) else ''
        return ref if isinstance(ref, str) else ''
    except (OSError, ValueError):
        return ''


class ImageReverseConfigRequest(BaseModel):
    modelRef: str = Field(max_length=500)


@app.post('/api/image-reverse/config')
async def api_image_reverse_config_save(req: ImageReverseConfigRequest):
    with _MODEL_CONFIG_LOCK:
        if req.modelRef and req.modelRef not in {
            f'{p.id}/{p.model}' for p in _image_reverse_providers() if p.configured
        }:
            raise HTTPException(400, '请选择完整配置且已保存的图片理解模型。')
        path = DATA_DIR / 'image-reverse-config.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps({'modelRef': req.modelRef}), encoding='utf-8')
        temporary.replace(path)
    return {'modelRef': req.modelRef}


@app.post('/api/image-reverse')
async def api_image_reverse(
    image: UploadFile = File(...), provider: str = Form(''), mode: str = Form('auto'),
    language: str = Form('zh'), instruction: str = Form(''), modelRef: str = Form(''),
):
    """Metadata first; when absent, use an explicitly selected saved vision channel."""
    try:
        raw = await image.read(IMAGE_REVERSE_MAX_BYTES + 1)
    finally:
        await image.close()
    providers = _image_reverse_providers()
    if modelRef and not any(p.id == provider and f'{p.id}/{p.model}' == modelRef for p in providers):
        raise HTTPException(409, '所选视觉模型配置已改变，请重新选择；不会替换为其他模型。')
    return await asyncio.to_thread(reverse_image, raw, providers,
                                   provider, mode, language, instruction)


# ---- 服务商预设与模型发现（docs/secondary-development-plan.md 功能 C 第一步）----
# 预设只放公开的端点与协议，不附带任何 Key；模型列表一律现场向服务商查询，不预置猜测。
# 目标地址与跳转沿用自测那套闸（_valid_base_url / _ssrf_safe / 不跟随重定向），
# 报错文案统一脱敏，Key 不落盘、不入日志、不进缓存。

_MODEL_PRESETS: dict[str, list[dict]] = {
    "chat": [
        {"id": "deepseek", "name": "DeepSeek 官方", "protocol": "openai",
         "baseUrl": "https://api.deepseek.com/v1", "note": "官方直连"},
        {"id": "siliconflow", "name": "硅基流动 SiliconFlow", "protocol": "openai",
         "baseUrl": "https://api.siliconflow.cn/v1", "note": "国内聚合"},
        {"id": "dashscope", "name": "阿里云百炼（通义千问）", "protocol": "openai",
         "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "note": "OpenAI 兼容模式"},
        {"id": "ark", "name": "火山引擎方舟", "protocol": "openai",
         "baseUrl": "https://ark.cn-beijing.volces.com/api/v3", "note": "豆包 / Seed 系"},
        {"id": "moonshot", "name": "月之暗面 Kimi", "protocol": "openai",
         "baseUrl": "https://api.moonshot.cn/v1", "note": "官方直连"},
        {"id": "zhipu", "name": "智谱 GLM", "protocol": "openai",
         "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "note": "官方直连"},
        {"id": "openrouter", "name": "OpenRouter", "protocol": "openai",
         "baseUrl": "https://openrouter.ai/api/v1", "note": "海外聚合"},
        {"id": "anthropic", "name": "Anthropic 官方", "protocol": "anthropic",
         "baseUrl": "https://api.anthropic.com", "note": "官方协议（x-api-key）"},
    ],
    "transcribe": [
        {"id": "siliconflow", "name": "硅基流动 SiliconFlow", "protocol": "openai",
         "baseUrl": "https://api.siliconflow.cn/v1", "note": "SenseVoice 等"},
    ],
    "image": [
        {"id": "openai", "name": "OpenAI 官方", "protocol": "openai",
         "baseUrl": "https://api.openai.com/v1", "note": "gpt-image 等"},
        {"id": "apimart", "name": "apimart（异步任务）", "protocol": "openai",
         "baseUrl": "https://api.apimart.ai/v1", "note": "异步轮询出图"},
    ],
}

_PRESET_NOTE = "端点为公开信息；是否支持模型枚举因服务商而异，不支持时请手动填写模型名。"


@app.get("/api/models/presets")
async def api_models_presets(channel: str = ""):
    """服务商预设（公开端点/协议/说明，不含任何密钥）。channel 省略时返回全部通道。"""
    if channel:
        return {"channel": channel, "presets": [dict(p) for p in _MODEL_PRESETS.get(channel, [])],
                "note": _PRESET_NOTE}
    return {"presets": {ch: [dict(p) for p in ps] for ch, ps in _MODEL_PRESETS.items()},
            "note": _PRESET_NOTE}


class ModelDiscoverRequest(BaseModel):
    channel: str = "chat"
    slot: str = ""
    baseUrl: str = ""
    apiKey: str = ""
    protocol: str = ""   # openai | anthropic；留空按 slot 推断


_ANTHROPIC_VERSION = "2023-06-01"


def _is_loopback_url(u: str) -> bool:
    """地址主机是否就是回环（配合仅冒烟用的本地放行开关）。"""
    try:
        host = urllib.parse.urlparse(u).hostname or ""
        return host in ("127.0.0.1", "localhost", "::1")
    except Exception:  # noqa: BLE001
        return False


def _saved_key_for(channel: str, slot: str) -> str:
    """该通道/槽位已保存的 Key（供「不重填也能获取模型」）；没有给空串。"""
    env = _read_env()
    if channel == "chat":
        return {"openai": env.get("OPENAI_API_KEY", ""),
                "relay": env.get("EASEL_LLM_API_KEY", ""),
                "anthropic": env.get("ANTHROPIC_API_KEY", "")}.get(slot, "") or ""
    if channel == "transcribe":
        return env.get("SILICONFLOW_API_KEY", "") or ""
    if channel == "image":
        for name in ("IMG_API_KEY", "OPENAI_API_KEY", "API_KEY"):
            if (env.get(name) or "").strip():
                return env[name]
    return ""


def _saved_base_for(channel: str, slot: str) -> str:
    env = _read_env()
    if channel == 'chat':
        field = _SLOT_ENV_KEYS.get(slot, ('', ''))[0]
        return env.get(field, '') or ('https://api.anthropic.com' if slot == 'anthropic' else '')
    if channel == 'transcribe' and slot == 'siliconflow':
        return env.get('SILICONFLOW_BASE_URL') or 'https://api.siliconflow.cn/v1'
    if channel == 'image':
        return env.get('IMG_BASE_URL') or env.get('OPENAI_BASE_URL') or ''
    return ''


def _redact(text: object, secret: str) -> str:
    """异常/响应体里可能回显 Key，统一抹掉再回给前端（也避免写进日志）。"""
    t = str(text or "")
    if secret and secret in t:
        t = t.replace(secret, "••••")
    return t[:180]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """发现请求不跟随跳转：跟了等于绕过前面的地址闸。"""

    def redirect_request(self, *_a, **_kw):  # noqa: D102
        return None


def _ssrf_safe_allow_local() -> bool:
    """仅本机冒烟（EASEL_ALLOW_DISCOVER_LOCAL=1）：127.0.0.1 假服务验证成功态用。
    绝不能默认开启——开着等于把「拿真 Key 打内网」的闸拆了。"""
    return os.environ.get("EASEL_ALLOW_DISCOVER_LOCAL", "").strip() == "1"


def _discover_models(base: str, key: str, protocol: str = "openai",
                     timeout: float = 10.0) -> dict:
    """向服务商查询可用模型列表 → {ok, kind, message, models, elapsedMs}。
    OpenAI 兼容：GET {base}/models（Bearer）；Anthropic：GET {base}/v1/models（x-api-key）。"""
    base = (base or "").strip().rstrip("/")
    if not _valid_base_url(base):
        return {"ok": False, "kind": "invalid_url", "models": [],
                "message": "地址需是合法的 http(s):// 根地址"}
    local_ok = _ssrf_safe_allow_local()
    if not _ssrf_safe(base) and not (local_ok and _is_loopback_url(base)):
        return {"ok": False, "kind": "blocked_target", "models": [],
                "message": "目标指向本机/内网地址，已拒绝（避免服务端被当作内网跳板）"}
    suffix = '/v1/models' if protocol == 'anthropic' and not base.endswith('/v1') else '/models'
    url = base + suffix
    headers = {"Accept": "application/json"}
    if key:
        if protocol == "anthropic":
            headers["x-api-key"] = key
            headers["anthropic-version"] = _ANTHROPIC_VERSION
        else:
            headers["Authorization"] = f"Bearer {key}"
    opener = urllib.request.build_opener(_NoRedirect)
    t0 = time.time()
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
            raw = resp.read(512 * 1024)
    except urllib.error.HTTPError as e:
        kinds = {401: "unauthorized", 403: "unauthorized", 404: "not_found", 429: "rate_limited"}
        kind = kinds.get(e.code, "server_error" if e.code >= 500 else "http_error")
        if 300 <= e.code < 400:
            kind, msg = "redirect_blocked", "接口发生了跳转，已按安全策略拒绝跟随"
        elif kind == "unauthorized":
            msg = "Key 无效或没有权限（401/403）"
        elif kind == "not_found":
            msg = "该地址没有模型列表接口（404），请手动填写模型名"
        elif kind == "rate_limited":
            msg = "请求过于频繁（429），稍后再试"
        else:
            msg = f"服务商返回 HTTP {e.code}"
        return {"ok": False, "kind": kind, "message": msg, "models": [],
                "elapsedMs": int((time.time() - t0) * 1000)}
    except (urllib.error.URLError, TimeoutError, socket.timeout) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return {"ok": False, "kind": "timeout", "models": [],
                    "message": f"请求超时（{int(timeout)} 秒），请检查网络或代理",
                    "elapsedMs": int((time.time() - t0) * 1000)}
        return {"ok": False, "kind": "network", "models": [],
                "message": f"网络错误：{_redact(reason, key)}",
                "elapsedMs": int((time.time() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "kind": "network", "models": [],
                "message": f"请求失败：{_redact(e, key)}",
                "elapsedMs": int((time.time() - t0) * 1000)}
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {"ok": False, "kind": "unsupported", "models": [],
                "message": "响应不是模型列表（该服务商可能不支持枚举），请手动填写模型名",
                "elapsedMs": int((time.time() - t0) * 1000)}
    items = payload.get("data") if isinstance(payload, dict) else payload
    if not items and isinstance(payload, dict):
        items = payload.get("models")
    if items is not None and not isinstance(items, list):
        return {'ok': False, 'kind': 'unsupported', 'models': [],
                'message': '响应不是模型列表，请手动填写模型名',
                'elapsedMs': int((time.time() - t0) * 1000)}
    models: list[str] = []
    for it in (items or []):
        mid = it.get("id") if isinstance(it, dict) else (it if isinstance(it, str) else "")
        if (not isinstance(mid, str) or not mid or len(mid) > 120 or mid != mid.strip()
                or any(ord(ch) < 32 or ord(ch) == 127 for ch in mid) or (key and key in mid)):
            continue
        if mid not in models:
            models.append(mid)
        if len(models) >= 500:
            break
    if not models:
        return {"ok": False, "kind": "empty", "models": [],
                "message": "接口可用但没返回任何模型，请手动填写",
                "elapsedMs": int((time.time() - t0) * 1000)}
    return {"ok": True, "kind": "ok", "models": models,
            "message": f"获取到 {len(models)} 个模型",
            "elapsedMs": int((time.time() - t0) * 1000)}


@app.post("/api/models/discover")
async def api_models_discover(req: ModelDiscoverRequest):
    """按已填或已保存的地址与 Key 拉取可用模型列表；远端结果原样返回，不落盘、不缓存 Key。"""
    channel = (req.channel or "chat").strip()
    if channel not in ("chat", "transcribe", "image", "video", "music", "speech"):
        raise HTTPException(400, "未知通道")
    base = (req.baseUrl or "").strip().rstrip("/")
    if not base:
        raise HTTPException(400, "请先填写或选择 Base URL")
    slot = (req.slot or "").strip()
    typed = (req.apiKey or "").strip()
    if typed and any(c.isspace() for c in typed):
        raise HTTPException(400, 'API Key 不能包含空白字符')
    key = typed or _saved_key_for(channel, slot)
    proto = (req.protocol or "").strip().lower()
    expected = _CHAT_PROTOCOLS.get(slot) if channel == 'chat' else 'openai'
    if proto and proto not in ('openai', 'anthropic'):
        raise HTTPException(400, '不支持的模型协议')
    if expected and proto and expected != proto:
        raise HTTPException(400, '协议与目标槽位不匹配')
    proto = proto or expected or 'openai'
    if key and not typed and base != _saved_base_for(channel, slot).strip().rstrip('/'):
        raise HTTPException(400, '更换 Base URL 时必须重新填写 API Key，未向新地址发送已保存的密钥')
    result = await asyncio.to_thread(_discover_models, base, key, proto)
    result.update({
        "channel": channel,
        "slot": slot,
        "protocol": proto,
        "source": base,
        "fetchedAt": int(time.time()),
        "keySource": "input" if typed else ("saved" if key else "none"),
    })
    return result


# ---- 从本机配置导入（方案功能 C 第二步）----
# 只读用户主动选择的来源；预览不回明文密钥；导入时重新读取源文件、只写所选槽位的几项，
# 其余配置（其它槽位、其它通道、openclaw 自定义供应商）保持不动。

import local_config_import  # noqa: E402  （web/ 在 sys.path 上）

_IMPORT_SLOT_ENV: dict[str, tuple[str, str, str]] = {
    "openai": ("OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"),
    "anthropic": ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"),
    "relay": ("EASEL_LLM_BASE_URL", "EASEL_LLM_API_KEY", "EASEL_LLM_MODEL"),
}
_IMPORT_PREVIEWS: dict[str, dict] = {}


def _import_digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()


def _import_target_digest() -> str:
    return _import_digest({str(p): hashlib.sha256(b).hexdigest() if b is not None else None
                           for p, b in _model_file_snapshot().items()})


def _import_compatible(slot: str, candidate: dict) -> str:
    if not candidate['compatible']:
        return candidate['skipReason']
    if candidate['protocol'] != _CHAT_PROTOCOLS[slot]:
        return f'协议不匹配：{slot} 槽位需要 {_CHAT_PROTOCOLS[slot]}'
    base, _ = _openclaw_provider_creds().get(slot, ('', ''))
    if _is_local_gateway_base(base):
        return '此槽位由本地模型网关管理，请在网关配置中修改上游'
    return ''


def _import_target_slot(requested: str, candidate: dict, env: dict, providers: dict) -> str:
    """Auto matches transport and prefers an empty slot; preview still confirms writes."""
    if requested != 'auto':
        return requested
    preferred = {'openai': ('openai',), 'anthropic': ('relay', 'anthropic')}.get(candidate['protocol'], ())
    usable = [slot for slot in preferred if not _import_compatible(slot, candidate)]
    if not usable:
        return preferred[0] if preferred else 'openai'
    for slot in usable:
        if not providers.get(slot) and not any(str(env.get(field) or '').strip() for field in _IMPORT_SLOT_ENV[slot]):
            return slot
    return usable[0]


def _import_source_path(source: str, supplied_path: str) -> Path:
    if source not in local_config_import.SOURCES:
        raise HTTPException(400, '不认识的配置来源')
    path, _ = local_config_import.resolve_source(source, supplied_path)
    if path is None:
        raise HTTPException(404, '来源配置不可用，请检查来源和路径')
    return path.resolve()


@app.get("/api/models/import/sources")
async def api_import_sources():
    """可导入的本机配置来源与可用性（只报路径是否存在，不读内容）。"""
    out = []
    for sid, meta in local_config_import.SOURCES.items():
        path, err = local_config_import.resolve_source(sid)
        out.append({
            "id": sid,
            "label": meta["label"],
            "note": meta["note"],
            "available": path is not None,
            "path": str(path) if path else "",
            "detail": err,
        })
    return {"sources": out,
            "slots": [{"id": k, "env": list(v)} for k, v in _IMPORT_SLOT_ENV.items()]}


class ImportPreviewRequest(BaseModel):
    source: str = "cc-switch"
    path: str = ""
    slot: str = "openai"


def _import_overwrites(slot: str, cand: dict, env: dict[str, str]) -> list[dict]:
    """覆盖预览：目标槽位各 env 的现值 vs 拟写入值（密钥只给脱敏）。"""
    base_env, key_env, model_env = _IMPORT_SLOT_ENV[slot]
    out: list[dict] = []
    cur_base = (env.get(base_env) or "").strip()
    if cand.get("baseUrl") and cand["baseUrl"] != cur_base:
        out.append({"field": base_env, "current": local_config_import.public_base_url(cur_base) or "（空）",
                    "incoming": local_config_import.public_base_url(cand["baseUrl"])})
    cur_key = (env.get(key_env) or "").strip()
    if cand.get("keyPresent"):
        out.append({"field": key_env,
                    "current": _mask_key(cur_key) if cur_key else "（空）",
                    "incoming": cand["keyMasked"]})
    cur_model = (env.get(model_env) or "").strip()
    if cand.get("model") and cand["model"] != cur_model:
        out.append({"field": model_env, "current": cur_model or "（空）", "incoming": cand["model"]})
    return out


@app.post("/api/models/import/preview")
async def api_import_preview(req: ImportPreviewRequest):
    """读取来源 → 候选列表（脱敏）+ 覆盖预览。只读，不改任何配置。"""
    slot = req.slot
    if slot not in _IMPORT_SLOT_ENV and slot != 'auto':
        raise HTTPException(400, '目标槽位不认识')
    path = _import_source_path(req.source, req.path)
    cands, errors = await asyncio.to_thread(local_config_import.read_source, req.source, path)
    with _MODEL_CONFIG_LOCK:
        try:
            target = _import_target_digest()
        except Exception:
            raise HTTPException(500, '无法读取当前配置，请检查访问权限') from None
        env = _read_env()
        target_oc = openclaw_state_dir() / 'openclaw.json'
        try:
            target_data = json.loads(target_oc.read_text(encoding='utf-8')) if target_oc.is_file() else {}
            target_providers = target_data.get('models', {}).get('providers', {})
            if not isinstance(target_providers, dict):
                raise ValueError('Invalid provider collection')
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(500, 'OpenClaw 配置格式不正确，请修复后重新预览') from None
        now = time.monotonic()
        for token, record in list(_IMPORT_PREVIEWS.items()):
            if record['expires'] <= now:
                _IMPORT_PREVIEWS.pop(token, None)
        for c in cands:
            target_slot = _import_target_slot(slot, c, env, target_providers)
            reason = _import_compatible(target_slot, c)
            fingerprint = _import_digest(c)
            c['compatible'], c['skipReason'] = not reason, reason
            c['targetSlot'] = target_slot
            c["overwrites"] = _import_overwrites(target_slot, c, env) if not reason else []
            if not reason:
                token = uuid.uuid4().hex
                _IMPORT_PREVIEWS[token] = {'source': req.source, 'path': str(path), 'slot': target_slot,
                    'id': c['id'], 'candidate': fingerprint, 'target': target, 'expires': now + 600,
                    'model': c.get('model') or _chat_model(target_slot, env, target_providers)}
                if not c.get('model'):
                    c['note'] = f'未提供模型名，保留目标模型 {_IMPORT_PREVIEWS[token]["model"]}；导入后可手动修改'
                c['previewToken'] = token
            c.pop("key", None)
            c['baseUrl'] = local_config_import.public_base_url(c['baseUrl'])
        # A provider may expose more than 128 explicitly configured models;
        # keep every token from this preview valid while evicting older previews.
        while len(_IMPORT_PREVIEWS) > max(128, len(cands)):
            _IMPORT_PREVIEWS.pop(next(iter(_IMPORT_PREVIEWS)))
    return {
        "source": req.source, "path": str(path), "slot": slot,
        "candidates": cands, "errors": errors, "readAt": int(time.time()),
        "note": "预览不写入；确认后仅更新候选标明的通道并立即保存。预览十分钟内有效，源或现有配置变化须重新预览。",
    }


class ImportApplyRequest(BaseModel):
    source: str = "cc-switch"
    path: str = ""
    id: str = ""
    slot: str = "openai"
    previewToken: str = ""


def _validated_import_preview(req: ImportApplyRequest):
    """Call under the model lock; credentials are reread only for a valid unchanged preview."""
    slot = (req.slot or 'openai').strip()
    if slot not in _IMPORT_SLOT_ENV:
        raise HTTPException(400, '目标槽位不认识')
    if not (req.id or '').strip():
        raise HTTPException(400, '没有选择要导入的配置')
    path = _import_source_path(req.source, req.path)
    preview = _IMPORT_PREVIEWS.get(req.previewToken)
    if not preview or preview['expires'] <= time.monotonic():
        raise HTTPException(409, '请先读取并确认预览；预览已过期或不存在')
    if any(preview[k] != value for k, value in
           (('source', req.source), ('path', str(path)), ('slot', slot), ('id', req.id))):
        raise HTTPException(409, '来源、候选或目标槽位已变化，请重新预览')
    cands, _errors = local_config_import.read_source(req.source, path)
    hits = [c for c in cands if c['id'] == req.id]
    if len(hits) != 1 or _import_digest(hits[0]) != preview['candidate']:
        raise HTTPException(409, '来源内容已变化，请重新预览')
    hit = hits[0]
    reason = _import_compatible(slot, hit)
    if reason:
        raise HTTPException(400, f'该来源配置不可用：{reason}')
    try:
        if _import_target_digest() != preview['target']:
            raise HTTPException(409, '当前配置已变化，请重新预览覆盖内容')
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(500, '无法读取当前配置，请检查访问权限') from None
    return preview, hit, path, slot


def _public_import_candidate(candidate, slot, token, env):
    """Project source credentials into a masked, explicit model-selection preview."""
    key = candidate.get('key') or ''
    value = {k: v for k, v in candidate.items() if k != 'key'}
    value.update(targetSlot=slot, compatible=True, skipReason='', previewToken=token,
                 overwrites=_import_overwrites(slot, candidate, env))
    value['baseUrl'] = local_config_import.public_base_url(candidate['baseUrl'])
    def redact(item):
        if isinstance(item, str):
            return item.replace(key, '••••') if key else item
        if isinstance(item, list):
            return [redact(v) for v in item]
        if isinstance(item, dict):
            return {k: redact(v) for k, v in item.items()}
        return item
    return redact(value)


@app.post('/api/models/import/discover')
async def api_import_discover(req: ImportApplyRequest):
    """Enumerate the exact previewed source with its server-only credentials; no inference or writes."""
    with _MODEL_CONFIG_LOCK:
        preview, hit, _path, slot = _validated_import_preview(req)
        base, key, protocol = hit.get('baseUrl') or '', hit.get('key') or '', hit.get('protocol') or ''
        if not base:
            raise HTTPException(400, '来源缺少 Base URL；仅有 Key 无法确定模型列表地址')
        if not key:
            raise HTTPException(400, '来源没有可用 API Key，请先补全来源配置并重新预览')
        if protocol not in ('openai', 'anthropic'):
            raise HTTPException(400, '来源协议不支持模型列表枚举')
    # Reuse the existing SSRF, no-redirect, authentication and protocol restrictions.
    discovered = await asyncio.to_thread(_discover_models, base, key, protocol)
    with _MODEL_CONFIG_LOCK:
        # A slow provider response must not extend expiry or revive changed source/target files.
        current, _hit, _path, _slot = _validated_import_preview(req)
        models = [m for m in discovered.get('models', []) if isinstance(m, str) and m.strip()
                  and len(m) <= 120 and not any(c in m for c in ('\n', '\r', '\x00')) and key not in m]
        models = list(dict.fromkeys(models))[:500]
        result = {k: discovered[k] for k in ('ok', 'kind', 'message', 'elapsedMs') if k in discovered}
        result['message'] = _redact(result.get('message'), key)
        result['models'] = models
        if result.get('ok') and not models:
            result.update(ok=False, kind='empty', message='接口没有返回可使用的模型 ID，请检查来源配置或手动填写')
        if result.get('ok'):
            current['discoveredModels'] = models
        result.update(channel='chat', slot=slot, protocol=protocol,
                      source=local_config_import.public_base_url(base).replace(key, '••••'),
                      fetchedAt=int(time.time()), keySource='source', previewToken=req.previewToken)
    return result


class ImportModelRequest(ImportApplyRequest):
    model: Annotated[str, Field(strict=True, min_length=1, max_length=120)]


@app.post('/api/models/import/model')
async def api_import_model(req: ImportModelRequest):
    """Bind a discovered ID to a new confirmation token, preserving the original deadline."""
    model = req.model.strip()
    with _MODEL_CONFIG_LOCK:
        preview, hit, _path, slot = _validated_import_preview(req)
        if not model or model not in preview.get('discoveredModels', []):
            raise HTTPException(400, '请先获取此来源的模型列表，并选择返回的真实模型 ID')
        token = uuid.uuid4().hex
        _IMPORT_PREVIEWS[token] = {**preview, 'model': model, 'selectedModel': model,
                                  'discoveredModels': list(preview['discoveredModels'])}
        candidate = {**hit, 'model': model,
                     'note': '已选择该来源返回的模型 ID；确认导入后才保存，仍沿用原预览十分钟期限。'}
        return _public_import_candidate(candidate, slot, token, _read_env())


@app.post("/api/models/import/apply")
async def api_import_apply(req: ImportApplyRequest):
    """把选中候选写入指定槽位：先全部校验，再 .env 原子写 + chat 同步 openclaw。"""
    with _MODEL_CONFIG_LOCK:
        preview, hit, path, slot = _validated_import_preview(req)
        try:
            oc = openclaw_state_dir() / 'openclaw.json'
            data = json.loads(oc.read_text(encoding='utf-8')) if oc.is_file() else {}
            keep = set(data.get('models', {}).get('providers', {}))
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(500, '无法读取 OpenClaw 配置，未导入；请检查配置后重试') from None
        base, key = hit['baseUrl'], hit['key']
        if not _valid_base_url(base):
            raise HTTPException(400, 'Base URL 不合法')
        base_env, key_env, model_env = _IMPORT_SLOT_ENV[slot]
        updates = {base_env: base, key_env: key}
        selected_model = preview.get('selectedModel')
        if selected_model and selected_model not in preview.get('discoveredModels', []):
            raise HTTPException(409, '选择的模型已不在最新来源列表中，请重新选择')
        if selected_model or hit.get('model'):
            updates[model_env] = selected_model or hit['model']
        note = _commit_model_configuration(updates, {slot: {
            'model': preview['model'], 'base': base, 'key': key, 'protocol': hit['protocol'], 'replaceAuth': True}}, keep, channel_label=(slot, hit['name']))
        _IMPORT_PREVIEWS.pop(req.previewToken, None)
    resp = {"ok": True, "note": note,
            "applied": {"name": hit["name"], "slot": slot, "source": req.source,
                        "fields": sorted(updates.keys())}}
    resp.update(_model_channels())
    return resp


class AttachmentRef(BaseModel):
    id: str
    name: str
    path: str


class ChatRequest(BaseModel):
    message: str
    persona: str | None = None
    sessionId: str | None = None
    turnId: str | None = None
    modelRef: Annotated[str, Field(strict=True, min_length=1, max_length=300)] | None = None
    thinkingLevel: Literal['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra'] | None = None
    attachments: list[AttachmentRef] = Field(default_factory=list)
    selectedSkills: list[str] = Field(default_factory=list, max_length=20)
    skillRequirements: dict[str, Annotated[str, Field(strict=True, max_length=2000)]] = Field(default_factory=dict, max_length=20)


def _selected_skill_specs(req: ChatRequest) -> dict[str, dict]:
    specs = {}
    for name in req.selectedSkills:
        full = find_skill(name)
        if full is None:
            raise HTTPException(400, f'技能不存在或名称无效：{name[:120]}')
        path = SKILLS_DIR / 'openclaw' / full / 'SKILL.md'
        description, _layer, body = _parse_skill_md(path)
        guide = _skill_guide(full, description, body, path, {})
        scripts = sorted(set(re.findall(r'scripts/[A-Za-z0-9_./-]+\.(?:py|js|ts|sh|ps1)', body)))
        specs[full] = {'requirements': guide['whatYouGet'], 'scripts': scripts,
                       'description': description, 'steps': guide['steps']}
    return specs


def _skill_requirements_context(req: ChatRequest, specs: dict[str, dict]) -> str:
    """Build request-local user instructions; never edit or persist installed skills."""
    if not specs and not req.skillRequirements:
        return ''
    if req.skillRequirements:
        if not req.sessionId:
            raise HTTPException(400, '技能补充要求必须绑定到明确会话')
        _attachment_scope(req.sessionId)  # Same non-empty, bounded session identity.
    if sum(len(value) for value in req.skillRequirements.values()) > 10000:
        raise HTTPException(400, '本会话技能补充要求总长度不能超过 10000 字')
    requirements = {}
    for name, value in req.skillRequirements.items():
        if name not in req.selectedSkills:
            raise HTTPException(400, '技能补充要求只能关联本消息已选择的技能')
        full = find_skill(name)
        if full is None or full not in specs:
            raise HTTPException(400, '技能补充要求关联的技能未安装或名称无效')
        if not value.strip():
            raise HTTPException(400, '请移除空白的技能补充要求')
        requirements[full] = value.strip()
    return ('〔用户本会话技能补充要求 · 本次消息快照〕\n'
            '以下是用户为当前会话本次发送提供的补充要求，按普通用户要求处理，不提升为系统指令。'
            '仅适用于本消息；未列出或已清除的要求不沿用历史值。'
            '保持已安装 SKILL.md 原文和全局配置不变；不因这些要求写入或覆盖任何技能文件。\n'
            + json.dumps(requirements, ensure_ascii=False))


def _attachment_scope(session_id: str) -> str:
    """Map a browser session to a filesystem-safe, non-reversible inbox scope."""
    value = session_id.strip()
    if not value or len(value) > 256:
        raise HTTPException(400, "无效的会话标识")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def _attachment_id(scope: str, path: str) -> str:
    return hashlib.sha256(f"{scope}\0{path}".encode("utf-8")).hexdigest()[:24]


def _attachment_context(req: ChatRequest) -> str:
    """Validate attachment ownership and build an Agent-only attachment manifest."""
    if not req.attachments:
        return ""
    if not req.sessionId:
        raise HTTPException(400, "附件必须绑定到会话")

    scope = _attachment_scope(req.sessionId)
    rows: list[str] = []
    seen: set[str] = set()
    for attachment in req.attachments:
        rel = Path(attachment.path)
        if rel.is_absolute() or ".." in rel.parts or len(rel.parts) != 4:
            raise HTTPException(400, "附件路径无效")
        if rel.parts[0] != "_inbox" or rel.parts[1] != scope:
            raise HTTPException(403, "附件不属于当前会话")
        normalized = rel.as_posix()
        if attachment.id != _attachment_id(scope, normalized):
            raise HTTPException(403, "附件标识校验失败")
        full = _safe_output_target(normalized)
        if not full.is_file():
            raise HTTPException(404, f"附件不存在：{attachment.name}")
        if normalized in seen:
            continue
        seen.add(normalized)
        rows.append(f"- outputs/{normalized}")

    return (
        "〔系统附件清单，仅供本轮执行，不要向用户复述文件上传过程或内部路径〕\n"
        "只允许使用下列当前会话附件；禁止扫描、枚举或猜测 outputs/_inbox 中的其他文件：\n"
        + "\n".join(rows)
        + "\n需要纳入内容项目时，将清单内文件复制到 outputs/<项目>/assets/ 后再使用；"
          "保留 inbox 原件，确保重试仍可复现。"
    )


def _chat_message(req: ChatRequest) -> str:
    context = _attachment_context(req)
    message = req.message.strip()
    if context:
        message = f"{message}\n\n{context}" if message else context
    if not message:
        raise HTTPException(400, "消息不能为空")
    specs = _selected_skill_specs(req)
    if specs:
        message += '\n\n〔本轮指定技能〕\n' + '\n'.join(specs)
        message += '\n先读取对应 SKILL.md，按原文要求执行；无法执行时说明缺少什么，不要把读取说明当成执行成功。'
        visual = {'comparison-card', 'ai-image-gen', 'ecom-details-image', 'card-design'}
        if any(name in visual or name.startswith(('card-', 'poster-')) for name in specs):
            image_env = _read_env()
            configured = all(_is_set(image_env.get(key)) for key in ('IMG_BASE_URL', 'IMG_MODEL', 'IMG_API_KEY'))
            state = '已填写配置，尚未证明本轮可调用' if configured else '配置不完整，需要在设置 → 生图通道补充地址、模型和 API Key'
            message += ('\n\n〔本轮视觉创作协作〕\n'
                '主动根据任务说明出图方式，不只询问素材：文字、参数和对比表优先确定性排版；'
                '需要插画、场景或商品背景时，主动建议 ai-image-gen 配合排版。用户已明确要求生成配图时，'
                '按生图技能执行，不重复询问是否要生图；未选择 AI 配图时说明可选方案，不擅自调用付费工具。'
                'ai-image-gen 调用联网供应商，可能计费，绝不是本地免费生成；本地 SVG 手绘是另一种确定性方案，不能混称 AI 生图。'
                f'本轮必须使用准确源码脚本离线核验："{sys.executable}" "{PROJECT_ROOT / "skills/shared/scripts/ai_image.py"}" check --dedicated-channel --env-file "{DATA_DIR / ".env"}"；'
                '不得改用workspace/shared的旧脚本，也不得删除--dedicated-channel。这是离线核验，不是出图，也不证明联网可用；不读取或打印.env原文。'
                '先检查通道，再准备主体、构图、风格和尺寸；只追问缺失的对比对象或必要事实，其他采用合理默认并说明。'
                f'当前生图通道：{state}。核验只认IMG_*，不要把聊天Key别名结果当作生图工坊可用。'
                '不要向用户索取 Key 文本；引导在设置中填写。没有工具成功回执和真实产物时不能声称已经生成。')
    requirements = _skill_requirements_context(req, specs)
    if requirements:
        message += '\n\n' + requirements
    return chat_turn_message(message, req.persona)


# 每个会话（session-key）一把锁：防止同一会话被两个并发的 openclaw agent 进程同时处理。
# 并发跑同一 session 文件会触发 openclaw 的 EmbeddedAttemptSessionTakeoverError（进程 rc=1、
# 表现为「答一半停在冒号」），以及会话串味（一个会话读到另一个的 session 文件内容）。
# 不同会话 key 不同锁 → 不同对话仍可并行；只序列化「同一会话」的重叠请求。
_session_locks: dict[str, asyncio.Lock] = {}


def _session_lock(sk: str) -> asyncio.Lock:
    lk = _session_locks.get(sk)
    if lk is None:
        lk = asyncio.Lock()
        _session_locks[sk] = lk
    return lk


# 会话续接：把 web 的 sessionId 确定性映射成一个稳定的 OpenClaw --session-id（transcript 文件名）。
# 背景（实测根因）：OpenClaw 靠 --session-key 解析 transcript，但空闲超过约 24h（threadBindings
# 默认 idleHours:24）后该绑定过期，下一条消息会新起一个空 transcript → 历史全丢（用户「关页两天
# 后再问就忘了」）。同一天内没事，隔天就断。解法：我们自己钉死 --session-id（对同一 web 会话恒定），
# 让 OpenClaw 每轮都续同一个 transcript 文件，绕开 key→绑定的过期/轮换逻辑。
_EASEL_SESSION_NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")  # 固定命名空间（uuid5 确定性）


def _openclaw_session_id(sk: str) -> str:
    """web sessionId → 稳定的 OpenClaw session-id（transcript）。同 sk 永远同 id，无需落盘映射。"""
    return str(uuid.uuid5(_EASEL_SESSION_NS, sk))


def _session_flock_path(sk: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", sk)[:120]
    return SESSIONS_DIR / f"{safe}.lock"


def _transport_pin_file(sk: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", sk)[:120]
    return SESSIONS_DIR / f"{safe}.transport"


def _resolve_transport(sk: str) -> str:
    """决定这一轮走哪条传输层，并保证同一会话**永不中途换边**。

    换边的代价是静默丢光上下文，不是慢一点：CLI 路径用 `--session-id`（uuid5(sk)）把 transcript
    钉死，而 /v1/chat/completions **压根不读 x-openclaw-session-id** —— openclaw 2026.6.11 全量
    实测：该 header 只有 MCP 端点和对上游供应商的出站请求会用，OpenAI 兼容端点只认
    x-openclaw-session-key，transcript 文件名由网关自己挑。于是同一个 web 会话在两条路径下落在
    两份不同的 jsonl 上。实测拿 CLI 去续一个已有两轮 HTTP 历史的会话，agent 回答"无历史"。

    所以判定顺序（都不依赖内存态，web 重启后依然成立）：
      1) uuid5 那份 transcript 已落盘 → 这会话是 CLI 起的，继续 cli；
      2) 有 http 钉子文件 → 继续 http；
      3) 两者都没有 → 新会话，按总开关 + 真探针决定。
    """
    if (OPENCLAW_SESSIONS_DIR / f"{_openclaw_session_id(sk)}.jsonl").is_file():
        return "cli"
    from easel.session_trace import has_session
    if has_session(OPENCLAW_SESSIONS_DIR, sk):
        return 'cli'
    try:
        if _transport_pin_file(sk).read_text(encoding="utf-8").strip() == "http":
            return "http"
    except OSError:
        pass
    return "http" if (CHAT_TRANSPORT == "http" and _gateway_http_ready()) else "cli"


def _pin_transport(sk: str, kind: str) -> None:
    """把会话钉在某条传输层上。只需钉 http —— cli 侧由 uuid5 transcript 文件自证。"""
    if kind != "http":
        return
    try:
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        _transport_pin_file(sk).write_text("http", encoding="utf-8")
    except OSError:
        pass


class _CrossProcLock:
    """跨进程会话锁（fcntl.flock）：同一会话同一时刻只允许一个 openclaw 进程在跑。

    现有 _session_lock（asyncio）只在单个 web 进程内串行；挡不住两个浏览器标签/常驻 gateway/
    cron 并发碰同一会话 → openclaw 抛 EmbeddedAttemptSessionTakeoverError（rc=1，答一半就停）。
    flock 在持有进程退出时自动释放，无 stale 死锁。返回 True=拿到锁，False=超时未拿到。
    """

    def __init__(self, sk: str):
        self._path = _session_flock_path(sk)
        self._fh = None
        self.acquired = False

    def acquire(self, timeout: float = 300.0, poll: float = 0.5) -> bool:
        try:
            SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
            self._fh = open(self._path, "a+b")
            if os.name == "nt":
                self._fh.seek(0, os.SEEK_END)
                if self._fh.tell() == 0:
                    self._fh.write(b"0")
                    self._fh.flush()
        except OSError:
            return False  # 拿不到文件句柄就不强求（退化为仅 asyncio 锁）
        deadline = time.time() + timeout
        while True:
            try:
                if os.name == "nt":
                    self._fh.seek(0)
                    msvcrt.locking(self._fh.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.acquired = True
                return True
            except OSError:
                if time.time() >= deadline:
                    return False
                time.sleep(poll)

    def release(self) -> None:
        if self._fh is not None:
            try:
                if self.acquired:
                    if os.name == "nt":
                        self._fh.seek(0)
                        msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None
            self.acquired = False


def _turn_file(sk: str) -> Path:
    """每会话最近一轮结果的落盘路径（sk 做文件名安全化）。"""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", sk)[:120]
    return SESSIONS_DIR / f"{safe}.json"


def _job_event_file(turn_id: str) -> Path:
    """Per-turn append-only event log used to resume SSE without restarting the agent."""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", turn_id)[:160]
    return SESSIONS_DIR / "jobs" / f"{safe}.jsonl"


def _read_job_events(turn_id: str, after: int = 0) -> list[dict]:
    path = _job_event_file(turn_id)
    if not path.is_file():
        return []
    events = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            event = json.loads(line)
            if int(event.get("id", 0)) > after:
                events.append(event)
    except (OSError, ValueError, json.JSONDecodeError):
        return []
    return events


def _raw_event_for_run(line: str, expected_run_id: str | None,
                       expected_session_id: str | None = None) -> dict | None:
    """Parse one OpenClaw raw event and reject events from other runs.

    Modern OpenClaw events carry both runId and runtime sessionId. The live
    supervisor always supplies its sessionId; an unbound turn accepts only that
    exact session, then pins the run. A trusted HTTP completion id can also pin
    the run before raw events arrive. The two-argument form remains for legacy
    parser callers; it must not be used to bind a live shared stream.
    """
    line = line.strip()
    if not line:
        return None
    try:
        event = json.loads(line)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(event, dict):
        return None
    if expected_session_id is not None:
        session_id = event.get('sessionId')
        if session_id is not None and session_id != expected_session_id:
            return None
        # Before a trusted HTTP run id is known, only the exact runtime session
        # can establish ownership. Never latch the first unrelated shared event.
        if expected_run_id is None and session_id != expected_session_id:
            return None
    if expected_run_id is not None:
        rid = event.get("runId")
        if rid != expected_run_id:
            return None
    return event


def _save_turn(sk: str, status: str, text: str, extra: dict | None = None) -> None:
    """持久化本轮结果（running/done），供 SSE 连接中断后前端用 /api/chat/last 取回。

    后端跑完整轮不依赖客户端连接——长任务时 webide 代理会掐断 SSE，但 openclaw 仍跑到底，
    结果写这里，前端断线后轮询即可拿到完整回答（否则"运行完也不说一声"）。
    """
    try:
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"status": status, "text": text, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        if extra:
            payload.update(extra)
        tmp = _turn_file(sk).with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, _turn_file(sk))
    except Exception:
        pass


# 后台 supervisor 任务集合：持有强引用防被 GC；每个对话流的 openclaw run 跑在这里，
# 与客户端 SSE 连接解耦（断线不杀 run）。
_BG_TASKS: set = set()

# 正在跑的对话 openclaw 进程（sk→proc），供用户**显式「停止」**终止；断线**不**经此路径（断线不杀）。
_RUNNING_CHAT: dict = {}
_ACTIVE_SKILL_TURNS: dict[str, str] = {}
# 被用户显式停止的会话 key：supervisor 据此把本轮当作正常「已停止」收尾（不报「被中断」、释放会话锁）。
_STOPPED_CHAT: set = set()


@app.get("/api/chat/last/{session_id}")
async def api_chat_last(session_id: str, turn_id: str | None = None):
    """取某会话最近一轮的完整结果（SSE 断线后前端据此取回，避免丢结果）。"""
    f = _turn_file(f"web:{session_id}")
    if not f.is_file():
        return {"status": "none", "text": ""}
    try:
        payload = json.loads(f.read_text(encoding="utf-8"))
        if turn_id and payload.get("turn_id") != turn_id:
            return {"status": "stale", "text": "", "turn_id": payload.get("turn_id")}
        old_error = payload.get('error') or {}
        if (payload.get('status') == 'done' and isinstance(old_error, dict)
                and old_error.get('code') in ('agent_execution_failed', 'agent_request_aborted')
                and (old_error.get('detail') == 'aborted' or str(old_error.get('message', '')).endswith('aborted'))):
            import skill_audit
            from chat_failure import recover_failure
            audit_file = skill_audit.audit_path(OUTPUTS_DIR / '_skill_audits', session_id, payload['turn_id'])
            if audit_file.is_file():
                try:
                    audit = json.loads(audit_file.read_text(encoding='utf-8'))
                    if audit.get('sessionId') == session_id and audit.get('turnId') == payload['turn_id']:
                        recovered = await asyncio.to_thread(recover_failure, OPENCLAW_SESSIONS_DIR, audit)
                        if recovered:
                            payload['error'] = recovered
                except (OSError, ValueError, KeyError, TypeError):
                    # Optional diagnostics must never erase the saved reply.
                    pass
        return payload
    except Exception:
        return {"status": "none", "text": ""}


@app.get("/api/chat/jobs/{turn_id}/stream")
async def api_chat_job_stream(turn_id: str, after: int = 0):
    """Replay missed events, then tail this turn until its terminal event arrives."""
    # A stale browser-side pendingTurnId must fail promptly instead of receiving
    # heartbeats forever. The frontend can then recover from the final snapshot.
    if not _job_event_file(turn_id).is_file():
        raise HTTPException(404, "对话任务记录不存在或已失效")

    async def events():
        cursor = max(0, after)
        idle_since = time.monotonic()
        while True:
            batch = _read_job_events(turn_id, cursor)
            if batch:
                idle_since = time.monotonic()
                for event in batch:
                    cursor = int(event["id"])
                    yield {
                        "id": str(cursor),
                        "event": event["event"],
                        "data": json.dumps(event.get("data"), ensure_ascii=False),
                    }
                    if event["event"] in ("done", "error"):
                        return
            else:
                # Keep proxy connections active; reconnecting remains safe if it still drops.
                if time.monotonic() - idle_since >= 15:
                    yield {"event": "ping", "data": "{}"}
                    idle_since = time.monotonic()
                await asyncio.sleep(0.25)

    return EventSourceResponse(events(), headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Content-Encoding": "identity",
    })


@app.post("/api/chat/stream")
async def api_chat_stream(req: ChatRequest):
    """SSE 真流式对话。

    `openclaw agent` CLI 会把整段模型输出缓冲到结束才打印（stdout 无增量）。真正跑模型的是
    常驻 gateway，它按自己的 OPENCLAW_RAW_STREAM/OPENCLAW_RAW_STREAM_PATH 把「模型原始流」逐
    token 写到**单个共享 jsonl**（SHARED_RAW_STREAM，见 scripts/gateway.sh）。后端在本轮开始时
    记下该文件尾偏移、实时 tail 之后追加的行，用 runId 闩锁隔离本轮，把 assistant_text_stream 的
    token delta 转成 SSE `token`、thinking delta 转成 `thinking`。stdout 仅留作错误/兜底。
    """
    # 每轮末尾追加「先查技能库」提醒，抗长对话指令衰减（对用户不可见）
    message = _chat_message(req)
    requested_model_ref = req.modelRef
    requested_thinking_level = req.thinkingLevel
    import office_controls
    if requested_model_ref is not None:
        await asyncio.to_thread(office_controls.require_model_override, sys.modules[__name__],
                                req.sessionId, requested_model_ref,
                                transport='cli' if requested_thinking_level is not None else None,
                                thinking_level=requested_thinking_level)
    elif requested_thinking_level is not None:
        capability = await asyncio.to_thread(office_controls.turn_model_capability, sys.modules[__name__], req.sessionId, transport='cli')
        office_controls.validate_thinking_level(capability, None, requested_thinking_level)
    import skill_audit
    specs = _selected_skill_specs(req)
    if req.sessionId:
        skill_audit.audit_path(OUTPUTS_DIR / '_skill_audits', req.sessionId, req.turnId or 'pending')

    # supervisor（跑 openclaw run）与 forward（转发 SSE 给浏览器）之间的事件通道。
    # 关键：run 跑在独立后台任务里，客户端断开只结束 forward，不取消 supervisor →
    # openclaw 照常跑到底、结果落盘，前端断线后 /api/chat/last 取回。
    loop = asyncio.get_event_loop()
    client_q: asyncio.Queue = asyncio.Queue()
    CLIENT_DONE = object()

    async def supervisor():
        sk = req.sessionId or f"web-{int(time.time() * 1000)}"
        pk = f"web:{sk}"                 # 落盘 key（与 /api/chat/last 一致）
        turn_id = req.turnId or uuid.uuid4().hex
        event_seq = 0
        full_text: list[str] = []        # 累积完整回答，供断线取回
        full_thinking: list[str] = []
        reasoning_stream = ReasoningStream()
        http_text_stream = ThinkingTextStream()
        raw_text_stream = ThinkingTextStream()
        turn_error = None
        timed_out = False                # 只有真·超时才 terminate 进程；断线绝不杀

        # Claim this turn before waiting for locks, so recovery cannot return the previous turn.
        _save_turn(pk, "running", "", {"turn_id": turn_id, "requestedModelRef": requested_model_ref,
                                         "requestedThinkingLevel": requested_thinking_level})

        event_path = _job_event_file(turn_id)
        try:
            event_path.parent.mkdir(parents=True, exist_ok=True)
            event_path.write_text("", encoding="utf-8")
        except OSError:
            pass

        def to_client(kind, text=None, **extra):
            nonlocal event_seq, turn_error
            if kind == 'error' and isinstance(text, dict):
                turn_error = text
            event_seq += 1
            data = ({"sessionKey": extra.get("sessionKey")} if kind == "done" else text)
            event = {"id": event_seq, "event": kind, "data": data}
            try:
                with event_path.open("a", encoding="utf-8") as ef:
                    ef.write(json.dumps(event, ensure_ascii=False) + "\n")
                    ef.flush()
            except OSError:
                pass
            client_q.put_nowait({"t": kind, "text": text, "id": event_seq, **extra})

        # 秒级反馈：发出即亮「已收到」，不等 agent 冷启动（首个 SSE 事件，随流回放必达）
        to_client("activity", "⏳ 已收到，正在唤醒 agent…")
        if requested_model_ref is not None:
            to_client('model_selection', {'requestedModelRef': requested_model_ref})

        async def _run_gateway_turn(hproc):
            """HTTP 直连常驻网关跑一轮（OpenAI 兼容端点 /v1/chat/completions，原生 SSE）。

            与 CLI 路径的差异：agent 在常驻 gateway 进程里直接跑，无每轮进程冷启动；
            正文 token 经 SSE 直接进 q（与 CLI 路径共享同一消费出口）；
            收尾由主循环统一负责（proc.poll() 兼容面）。
            """
            body = {
                "model": "openclaw/default",
                "stream": True,
                "messages": [{"role": "user", "content": message}],
            }
            # session-id 必须跟 CLI 路径钉死同一个（见 _openclaw_session_id）：只带 session-key
            # 的话网关会自己另起一个 transcript —— 跨天空闲后丢历史，且万一本轮回退 CLI，
            # 两条路径会写进不同的会话文件，对话历史直接劈叉。
            headers = {"x-openclaw-session-key": f"agent:main:{sk}",
                       "x-openclaw-session-id": _openclaw_session_id(sk)}
            headers.update(credentials.headers())
            if requested_model_ref is not None:
                headers['x-openclaw-model'] = requested_model_ref
            tool_noted = False
            saw_done = False
            try:
                import httpx as _httpx
                timeout = _httpx.Timeout(TIMEOUT_CHAT + 60, connect=10)
                async with _httpx.AsyncClient(timeout=timeout) as client:
                    async with client.stream(
                            "POST", chat_completions_url(),
                            json=body, headers=headers) as resp:
                        if resp.status_code != 200:
                            raw = (await resp.aread())[:200].decode("utf-8", "replace")
                            _emit('error', gateway_error(raw, status=resp.status_code, fallback='gateway_request_failed'))
                            return
                        async for line in resp.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            payload = line[5:].lstrip()   # SSE 允许 `data:{…}`（冒号后无空格）
                            if payload == "[DONE]":
                                saw_done = True
                                break
                            try:
                                d = json.loads(payload)
                            except ValueError:
                                continue
                            if not isinstance(d, dict):
                                continue
                            if d.get("error"):   # 200 里夹错误对象/字符串：不能当正常流吞掉
                                _emit('error', gateway_error(str(d['error'])))
                                return
                            # OpenClaw 2026.9.x emits the actual runId as the
                            # chat completion id, allowing exact raw correlation.
                            response_id = d.get('id')
                            if isinstance(response_id, str) and response_id.startswith('chatcmpl_'):
                                run_info['run_id'] = response_id
                                hproc._office_run_id = response_id
                            for reasoning, snapshot, block, event_id in provider_reasoning(d):
                                rc = reasoning_stream.push('http', reasoning, snapshot=snapshot, block=block, event_id=event_id)
                                if rc:
                                    run_info['thinking_chars'] += len(rc)
                                    _emit('thinking', rc)
                            choices = d.get('choices')
                            choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
                            finish_reason = choice.get('finish_reason')
                            if finish_reason in ('length', 'max_tokens', 'content_filter', 'error', 'tool_calls', 'tool_use'):
                                run_info['stop_reason'] = 'tool_use' if finish_reason == 'tool_calls' else finish_reason
                            delta = choice.get('delta')
                            if not isinstance(delta, dict):
                                delta = {}
                            # 正文来自当前 HTTP 响应。公开 reasoning/summary 字段
                            # 已在上方独立映射，单轮只选一个来源以防 raw/HTTP 重叠。
                            wrapped, c = http_text_stream.push(visible_text(delta.get("content")))
                            rc = reasoning_stream.push('http-tag', wrapped)
                            if rc:
                                run_info['thinking_chars'] += len(rc)
                                _emit('thinking', rc)
                            if c:
                                _emit("token", c)
                            if delta.get("tool_calls") and not tool_noted:
                                tool_noted = True
                                to_client("activity", "🔧 正在执行操作…")
                # EOF alone is not successful SSE completion, even after text.
                wrapped, tail = http_text_stream.push('', final=True)
                rc = reasoning_stream.push('http-tag', wrapped)
                if rc:
                    run_info['thinking_chars'] += len(rc)
                    _emit('thinking', rc)
                if tail:
                    _emit('token', tail)
                # Persist the same structured error for live and recovery paths.
                if not saw_done:
                    _emit('error', gateway_error(fallback='gateway_stream_interrupted'))
                else:
                    run_info['http_done'] = True
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                _emit('error', gateway_error(type(e).__name__ + ': ' + str(e), fallback='gateway_connection_failed'))
            finally:
                # 先把 SENTINEL 排进 q（FIFO 保证它排在本轮所有 token 之后），再标记完成：
                # 主循环读到它时，前面的 token 必然已全部消费过。
                q.put_nowait(SENTINEL)
                hproc.finish()

        # 会话级串行：同一会话若已有请求在跑，先提示排队，等它结束再开
        # （否则两个 openclaw 进程并发写同一 session 文件 → 崩溃 rc=1 / 会话串味）。
        # 双层锁：asyncio 锁管同 web 进程内并发；flock 跨进程锁管两个标签/gateway/cron 撞同一会话。
        lock = _session_lock(sk)
        xlock = _CrossProcLock(sk)
        if lock.locked():
            to_client("activity", "⏳ 这个会话上一条还在跑，排队等它结束再开始…")
        await lock.acquire()
        try:
            # flock 可能阻塞（等另一进程/标签跑完），放线程池避免卡住事件循环
            got = await loop.run_in_executor(None, xlock.acquire, min(TIMEOUT_CHAT, 300))
            if not got:
                _save_turn(pk, "done", "这个会话正在另一个窗口运行，请稍候再试。", {
                    "turn_id": turn_id, "clean_end": False, "stop_reason": "session_lock_timeout",
                    "requestedModelRef": requested_model_ref,
                    "requestedThinkingLevel": requested_thinking_level,
                })
                to_client("activity", "⏳ 这个会话正在另一个窗口运行，请稍候再试")
                return

            # Resolve credentials after queueing, so a rotation while the prior
            # turn runs is used by both transports on this turn.
            credentials = gateway_credentials()
            selected_transport = None
            if requested_model_ref is not None:
                selected_transport = ('cli' if requested_thinking_level is not None
                                      else await asyncio.to_thread(_resolve_transport, sk))
                # Recheck the exact choice, running gateway and approved identity
                # after queueing. Never remove the override or switch transports.
                await asyncio.to_thread(office_controls.require_model_override, sys.modules[__name__],
                                        sk, requested_model_ref, transport=selected_transport, credentials=credentials,
                                        thinking_level=requested_thinking_level)
            _heal_openclaw_session(sk)

            # _resolve_transport 里既有 stat 又有阻塞 urllib 探针（最多 3s），必须丢线程：
            # 直接在协程里调会把整个事件循环——连同其它会话正在推的 SSE——一起卡住。
            audit_context = None
            try:
                audit_context = await asyncio.to_thread(skill_audit.begin, OUTPUTS_DIR, OPENCLAW_SESSIONS_DIR,
                                                         sk, turn_id, specs, req.message, await asyncio.to_thread(_channel_labels))
                _ACTIVE_SKILL_TURNS[sk] = turn_id
            except Exception:
                to_client('activity', '执行核验暂不可用；创作任务继续运行。')
            # The OpenAI-compatible gateway endpoint does not expose a documented
            # per-turn thinking field. Use the CLI when the user explicitly chose
            # a level so the value reaches OpenClaw's native --thinking option.
            is_http = (selected_transport or await asyncio.to_thread(_resolve_transport, sk)) == "http" and requested_thinking_level is None
            # A queued turn must begin after the preceding turn's raw output.
            # The earlier pre-lock offset may belong to an entirely older run.
            try:
                raw_start_offset = SHARED_RAW_STREAM.stat().st_size
            except OSError:
                raw_start_offset = 0
            if is_http:
                # HTTP 直连常驻网关：无进程冷启动（agent 在 gateway 进程里跑）
                proc = _GatewayHttpProc()
            else:
                try:
                    native_client = await asyncio.to_thread(_native_agent_client, credentials)
                    if native_client is not None:
                        from easel.gateway_agent import GatewayAgentProc
                        params = {'agentId': 'main', 'sessionKey': f'agent:main:{sk}',
                                  'sessionId': _openclaw_session_id(sk), 'message': message,
                                  'thinking': requested_thinking_level or THINKING_LEVEL,
                                  'deliver': False, 'timeout': TIMEOUT_CHAT,
                                  'idempotencyKey': turn_id}
                        if requested_model_ref is not None:
                            params['model'] = requested_model_ref
                        proc = GatewayAgentProc(native_client,
                            lambda: office_controls._model_probe_client('cli', credentials), params, TIMEOUT_CHAT,
                            on_compaction=lambda event: loop.call_soon_threadsafe(to_client, 'compaction', event))
                    else:
                        proc = None
                    if proc is None:
                        cmd = openclaw_base_cmd() + [
                            "--profile", OPENCLAW_PROFILE, "agent", "--agent", "main",
                            "--session-key", f"agent:main:{sk}", "--session-id", _openclaw_session_id(sk),
                            "--thinking", requested_thinking_level or THINKING_LEVEL,
                            "--timeout", str(TIMEOUT_CHAT), "--message", message,
                        ]
                        if requested_model_ref is not None:
                            cmd.extend(['--model', requested_model_ref])
                        env = credentials.environment(_proxy_env())
                        # Raw streaming belongs to the gateway process. Only pass
                        # whether the local question bridge can display ask_user.
                        _cards_ok = question_bridge_supported is not None and question_bridge_supported()
                        env["EASEL_ASKUSER_CARDS"] = "1" if _cards_ok else "0"
                        proc = subprocess.Popen(
                            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            cwd=str(PROJECT_ROOT), text=True, bufsize=1, env=env,
                        )
                except Exception as e:
                    error = gateway_error(type(e).__name__ + ': ' + str(e))
                    _save_turn(pk, "done", "", {
                        "turn_id": turn_id, "clean_end": False, "stop_reason": "spawn_failed", "error": error,
                        "requestedModelRef": requested_model_ref,
                        "requestedThinkingLevel": requested_thinking_level,
                    })
                    to_client("error", error)
                    return
            _RUNNING_CHAT[sk] = proc         # 注册运行中进程（HTTP 模式为伪进程），供 /api/chat/stop
            # 经 gateway 后客户端 stdout 没有 model-fetch 标记（那是独立跑 agent 才有），先立刻
            # 给一个「正在思考」活动指示，随后 token 从共享 raw stream 流进来接管显示。
            to_client("activity", "🧠 正在思考…")

            q = asyncio.Queue()
            SENTINEL = object()
            stdout_lines = []
            run_info: dict = {"stop_reason": None, "last_ev": None, "saw_message_end": False,
                              "run_id": getattr(proc, '_office_run_id', None),
                              "fetch_count": 0, "token_chars": 0, "thinking_chars": 0,
                              "delegated": False, "ignored_foreign_events": 0}
            usage_observations = []

            def _drain_stdout():
                try:
                    for line in proc.stdout:
                        stdout_lines.append(line)
                        c = re.sub(r"\x1b\[[0-9;]*m", "", line)
                        if "model-fetch] start" in c:
                            run_info["fetch_count"] += 1
                            fc = run_info["fetch_count"]
                            _emit("activity", "🧠 正在思考…" if fc == 1 else f"🔧 调用工具后继续推理（第 {fc} 步）…")
                        elif "[agent]" in c and "delegat" in c.lower():
                            run_info["delegated"] = True
                            _emit("activity", "🛠️ 制作中…")
                        m = re.search(r"ended with stopReason=(\S+)", c)
                        if m:
                            run_info["stop_reason"] = m.group(1)
                except Exception:
                    pass

            def _emit(kind: str, text: str):
                loop.call_soon_threadsafe(q.put_nowait, {"t": kind, "text": text})

            # 必须等 q / run_info / _emit 都就位后再起这一轮：_run_gateway_turn 闭包引用它们，
            # 早一步 create_task 就只能靠「中间没有 await」来侥幸，改一行同步代码就会崩。
            if is_http:
                proc._task = loop.create_task(_run_gateway_turn(proc))

            # ---- ask_user 问答题桥接：轮询 gateway 的 pending question，推给前端渲染 ----
            # 背景：OpenClaw 的 ask_user 注册到 gateway 进程内，Easel 前端不消费 question RPC → 选项不可见。
            # 这里在 agent 运行期间每 2s 轮询一次，把新出现的 pending question 以 SSE `question` 事件推送，
            # 前端渲染选项卡片；用户点击后经 /api/chat/question/answer 调 question.resolve 完成回答。
            if GatewayClient is not None and not _QBRIDGE_DISABLED:
                def _question_poll():
                    global _QBRIDGE_DISABLED
                    if _QBRIDGE_DISABLED:
                        return
                    # 版本能力门：旧版本 OpenClaw（<2026.9.x）没有 question.* RPC，连都不连——
                    # 否则每轮 connect 都在网关上触发新的 scope-upgrade 配对申请。只提示一次，走文字问答。
                    if question_bridge_supported is not None and not question_bridge_supported():
                        _QBRIDGE_DISABLED = True
                        _qbridge_warn_once(
                            "unsupported",
                            "[question-bridge] 当前 OpenClaw 版本无 question RPC（需 2026.9.x+），"
                            "已跳过 ask_user 选项卡片桥接，改用文字问答。")
                        return
                    client = None
                    pushed: set[str] = set()
                    try:
                        client = GatewayClient()
                        client.connect()
                    except Exception as e:
                        # connect 失败（如 NOT_PAIRED/scope-upgrade，或网关不可达）：熔断整个桥接，
                        # 不再每轮重试——否则每轮都会在网关上堆一个新的配对/权限申请。每进程只告警一次。
                        _QBRIDGE_DISABLED = True
                        _qbridge_warn_once(
                            "connect",
                            f"[question-bridge] connect gateway failed，已停用桥接（本进程），"
                            f"ask_user 改用文字问答: {e}")
                        return
                    try:
                        while proc.poll() is None:
                            try:
                                items = client.list_questions(
                                    session_key=f"agent:main:{sk}", status="pending")
                            except GatewayUnsupportedError as e:
                                # 连上了但没有 question RPC（版本判断漏网时的兜底）：熔断，安静退出。
                                _QBRIDGE_DISABLED = True
                                _qbridge_warn_once(
                                    "unsupported",
                                    f"[question-bridge] 当前 OpenClaw 版本无 question RPC，"
                                    f"已停用 ask_user 选项卡片桥接（需 2026.9.x+）: {e}")
                                return
                            except Exception:
                                time.sleep(2)
                                continue
                            for it in items:
                                qid = it.get("id")
                                if qid and qid not in pushed:
                                    pushed.add(qid)
                                    _emit("question", json.dumps({
                                        "id": qid,
                                        "questions": it.get("questions", []),
                                        "expiresAtMs": it.get("expiresAtMs"),
                                    }, ensure_ascii=False))
                            time.sleep(2)
                    finally:
                        try:
                            if client is not None:
                                client.close()
                        except Exception:
                            pass
                loop.run_in_executor(None, _question_poll)

            def _handle(line: str):
                nonlocal raw_text_stream
                if hasattr(proc, 'clean_end'):
                    run_info['run_id'] = proc._office_run_id
                o = _raw_event_for_run(line, run_info["run_id"], _openclaw_session_id(sk))
                if o is None:
                    # 属其它并发 run 的事件（或无法解析）：绝不混入本轮可见流/收尾诊断，仅计数。
                    try:
                        parsed = json.loads(line)
                        rid = parsed.get("runId") if isinstance(parsed, dict) else None
                        if rid is not None and run_info["run_id"] is not None and rid != run_info["run_id"]:
                            run_info["ignored_foreign_events"] += 1
                    except Exception:
                        pass
                    return
                # 仅当前 runtime session 的事件能建立本轮 run 归属。
                if run_info["run_id"] is None:
                    rid = o.get("runId")
                    if rid is None:
                        return          # 还没拿到 runId，等下一条带 runId 的事件再闩锁
                    run_info["run_id"] = rid
                    proc._office_run_id = rid
                ev, et, delta = o.get("event"), o.get("evtType"), visible_text(o.get("delta"))
                stamp = o.get('ts')
                if (isinstance(stamp, (int, float)) and not isinstance(stamp, bool)
                        and math.isfinite(stamp) and len(usage_observations) < 20000
                        and (ev == 'assistant_message_end' or
                             (ev in ('assistant_text_stream', 'assistant_thinking_stream')
                              and et in ('text_delta', 'thinking_delta') and delta))):
                    usage_observations.append({'ts': stamp, 'kind': 'end' if ev == 'assistant_message_end' else 'output'})
                # 记录最后一个 raw 事件：正常收尾 last_ev == assistant_message_end；
                # 若停在 text_delta/thinking_delta 说明输出或思考流被中断、没正常收尾（本次排查关键信号）。
                if ev:
                    run_info["last_ev"] = ev
                if ev == "assistant_message_end":
                    run_info["saw_message_end"] = True
                    if not is_http:
                        wrapped, tail = raw_text_stream.push('', final=True)
                        chunk = reasoning_stream.push('raw-tag', wrapped)
                        if chunk:
                            run_info['thinking_chars'] += len(chunk)
                            _emit('thinking', chunk)
                        if tail:
                            run_info['token_chars'] += len(tail)
                            _emit('token', tail)
                if ev == 'assistant_thinking_stream':
                    if et == 'thinking_start':
                        reasoning_stream.reset('raw')
                    chunk = reasoning_stream.push('raw', delta) if delta else ''
                    if et == 'thinking_end':
                        chunk += reasoning_stream.push('raw', visible_text(o.get('content')), snapshot=True)
                    if chunk:
                        run_info['thinking_chars'] += len(chunk)
                        _emit('thinking', chunk)
                    return
                if ev == 'assistant_text_stream' and et == 'text_start' and not is_http:
                    raw_text_stream = ThinkingTextStream()
                if not delta:
                    return
                if ev == "assistant_text_stream" and et == "text_delta":
                    if is_http:
                        # HTTP 模式正文以 SSE 为准（那条才是本请求自己的响应流）。这里再发一遍
                        # 就是同一段内容进两次队列 —— 前端会看到每个字重复。
                        return
                    wrapped, delta = raw_text_stream.push(delta)
                    chunk = reasoning_stream.push('raw-tag', wrapped)
                    if chunk:
                        run_info['thinking_chars'] += len(chunk)
                        _emit('thinking', chunk)
                    if not delta:
                        return
                    run_info["token_chars"] += len(delta)
                    run_info["text_tail"] = (run_info.get("text_tail", "") + delta)[-160:]
                    _emit("token", delta)
                    return

            def _tail():
                try:
                    f = None
                    # gateway 刚起或本轮还没产生事件时文件可能暂不存在：轮询等它出现（进程先退出则收尾）。
                    while f is None:
                        try:
                            f = open(SHARED_RAW_STREAM, "r", encoding="utf-8")
                        except OSError:
                            if proc.poll() is not None:
                                return
                            time.sleep(0.04)
                    with f:
                        f.seek(raw_start_offset)   # 只读本轮开始后追加的行，跳过历史轮次
                        buf = ""
                        while True:
                            chunk = f.readline()
                            if chunk == "":
                                if proc.poll() is not None:
                                    buf += f.read()
                                    for ln in buf.split("\n"):
                                        _handle(ln)
                                    break
                                time.sleep(0.04)
                                continue
                            buf += chunk
                            while "\n" in buf:
                                ln, buf = buf.split("\n", 1)
                                _handle(ln)
                except Exception:
                    pass
                finally:
                    loop.call_soon_threadsafe(q.put_nowait, SENTINEL)

            stdout_fut = None
            if is_http:
                # 正文走 SSE，但思考流**不走**：openclaw 2026.6.11 的 chat/completions 实现里
                # reasoning/thinking 一次都没出现，不回传任何思考增量。思考只存在于常驻 gateway
                # 写的那份共享 raw 流里（它按 gateway 自己的 env 写，与谁触发无关）。所以这条路径
                # 照样 tail 它——_handle 里 text_delta 在 is_http 下直接丢弃，只取 thinking_delta，
                # 正文不会进两次。不 tail 的话「💭 思考过程」在 HTTP 模式下永远是空的。
                loop.run_in_executor(None, _tail)
            else:
                stdout_fut = loop.run_in_executor(None, _drain_stdout)
                loop.run_in_executor(None, _tail)

            deadline = time.monotonic() + TIMEOUT_CHAT + 30
            emitted = False
            # 两条路径都靠「队列里读到 SENTINEL」收尾。HTTP 模式若改用带外标志（一开始就置 True），
            # 最后一批还排在 q 里没被消费的 token 会随 poll() 转为已完成而被直接丢掉——答案尾巴被截。
            finished_producers = 0
            expected_producers = 2 if is_http else 1
            try:
                while True:
                    # A raw-stream reader failure must not be mistaken for model
                    # completion. Keep the session lock until the process exits.
                    if finished_producers >= expected_producers and proc.poll() is not None and q.empty():
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        timed_out = True
                        to_client('error', gateway_error('timeout'))
                        break
                    try:
                        item = await asyncio.wait_for(q.get(), timeout=min(10, remaining))
                    except asyncio.TimeoutError:
                        continue
                    if item is SENTINEL:
                        finished_producers += 1
                        continue
                    if item["t"] == "token":
                        emitted = True
                        full_text.append(item["text"])
                        to_client("token", item["text"])
                    elif item["t"] == "thinking":
                        full_thinking.append(item['text'])
                        to_client("thinking", item["text"])
                    elif item["t"] == "activity":
                        to_client("activity", item["text"])
                    elif item["t"] == "question":
                        to_client("question", item["text"])
                    elif item["t"] == "error":
                        to_client("error", item["text"])
                rc = proc.poll()
                # 等 stdout 读完（stopReason 行在进程收尾时才打印，避免 _tail 先发 SENTINEL 时漏读）
                if stdout_fut is not None:
                    try:
                        await asyncio.wait_for(stdout_fut, timeout=2)
                    except Exception:
                        pass
                sr = run_info.get("stop_reason")
                native_result = getattr(proc, 'result', None)
                if hasattr(proc, 'clean_end'):
                    run_info['run_id'] = proc._office_run_id
                if rc == 0 and isinstance(native_result, dict) and native_result.get('status') == 'ok':
                    result = native_result.get('result')
                    payloads = result.get('payloads', []) if isinstance(result, dict) else []
                    canonical = '\n'.join(row['text'] for row in payloads
                                          if isinstance(row, dict) and isinstance(row.get('text'), str) and not row.get('isError'))
                    if canonical:
                        run_info['text_tail'] = canonical[-160:]
                    if canonical and canonical != ''.join(full_text):
                        # Provider adapters may revise or reorder their deltas.
                        # The native final payload is authoritative, not append-only.
                        full_text[:] = [canonical]
                        emitted = True
                        to_client('text_snapshot', canonical)
                if rc not in (0, None) and sk not in _STOPPED_CHAT and turn_error is None:
                    native_error = getattr(proc, 'error_text', None)
                    from chat_failure import turn_failure
                    failure = await asyncio.to_thread(turn_failure, OPENCLAW_SESSIONS_DIR, audit_context, native_error or ''.join(stdout_lines))
                    to_client('error', failure)
                if not emitted and turn_error is None:
                    clean = redact_gateway_text(clean_agent_output("".join(stdout_lines)), credentials)
                    if clean:
                        emitted = True
                        full_text.append(clean)
                        to_client("token", clean)
                # 收尾检测：即使已吐了内容，只要不是「正常收尾」就显式告知——
                # 否则被截断（触顶）/被杀（负载）/流被中断，都会被当成「清晰地答完了」，
                # 用户看到的就是「答一半突然停、也不说做完」（本 bug 根因）。
                # 正常收尾的唯一标志：raw 流最后一个事件是 assistant_message_end。
                # 用户显式「停止」不是异常中断 → 不报「被中断」告警（前端已就地标注「已停止」）。
                if (emitted or run_info["thinking_chars"]) and sk not in _STOPPED_CHAT and turn_error is None:
                    note = None
                    if sr and sr in ("max_tokens", "length", "model_length"):
                        note = (f"\n\n---\n⚠️ 上面这条**被截断**了（stopReason={sr}，单条回复触顶）。"
                                f"回我「继续」我接着写完，或让我把任务拆小一点。")
                    elif rc not in (0, None):
                        note = f"\n\n---\n⚠️ 生成被中断（退出码 {rc}）；退出码本身不能确定原因，请查看运行记录。"
                    elif sr == "tool_use":
                        note = ("\n\n---\n⚠️ 我刚做完这一步、**正要执行下一步操作时中断了**"
                                "（本轮以工具调用结尾却没能继续，前端把它当成答完了）。回我「继续」我接着做。")
                    elif not (is_http and run_info.get('http_done')) and not getattr(proc, 'clean_end', False) and run_info.get("last_ev") not in (None, "assistant_message_end"):
                        note = ("\n\n---\n⚠️ 这条**可能没写完**——模型的输出/思考流被中断、没有正常收尾"
                                "（多为网络或模型代理把长回复的流掐断了）。回我「继续」，或重试。")
                    elif run_info.get("text_tail", "").rstrip()[-1:] in ("：", ":"):
                        # 正常收尾但正文停在冒号 = 模型"我要做X："后没接着做（多为要接工具/下一步却断了）。
                        # 用户实测「所有莫名停止都停在冒号」——这一条兜住这个模式。
                        note = ("\n\n---\n⚠️ 我似乎停在了冒号处、没接着把后面的内容/操作做出来。"
                                "回我「继续」我补上。")
                    if note:
                        full_text.append(note)
                        to_client("token", note)
            finally:
                # 只有真的在 HTTP 上跑出了内容，才把这个会话钉到 http 上。钉早了（比如选路时就钉）
                # 会把一个其实没跑成的会话锁死在 http，之后每轮都往一条不通的路上撞；而钉住之后
                # 就绝不能再换回 cli —— 网关那份 transcript 我们按名字找不回来，换边即丢历史。
                if is_http and emitted:
                    _pin_transport(sk, "http")
                user_stopped = sk in _STOPPED_CHAT
                _STOPPED_CHAT.discard(sk)
                clean_end = (not user_stopped and turn_error is None
                             and run_info.get('stop_reason') not in ('length', 'max_tokens', 'model_length', 'tool_use', 'content_filter', 'error')
                             and (bool(run_info.get('http_done')) if is_http
                                  else (getattr(proc, 'clean_end', False) or run_info.get('last_ev') == 'assistant_message_end')))
                # Reaching finally while the child is alive means timeout, explicit
                # stop, cancellation, or an internal stream failure. Never release
                # the session locks while such a process can still write history.
                if proc.poll() is None:
                    try:
                        await asyncio.to_thread(proc.terminate)
                    except OSError:
                        pass
                    try:
                        await asyncio.to_thread(proc.wait, timeout=5)
                    except subprocess.TimeoutExpired:
                        try:
                            proc.kill()
                            await asyncio.to_thread(proc.wait, timeout=2)
                        except (OSError, subprocess.TimeoutExpired):
                            pass
                    if hasattr(proc, 'clean_end') and proc.poll() is None:
                        # Native RPC disconnection does not end the gateway run.
                        # Keep both locks until its worker confirms abort/final.
                        await asyncio.to_thread(proc.wait)
                # 诊断日志：每次对话流收尾都记一行，供事后定位「莫名停下」到底是哪种情况。
                try:
                    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
                    tail = redact_gateway_text(clean_agent_output("".join(stdout_lines)), credentials)[-800:]
                    with (DEBUG_DIR / "chat-stream.jsonl").open("a", encoding="utf-8") as lf:
                        lf.write(json.dumps({
                            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                            "session": sk,
                            "requestedModelRef": requested_model_ref,
                            "rc": proc.poll(),
                            "stop_reason": run_info["stop_reason"],
                            "last_ev": run_info["last_ev"],
                            "clean_end": clean_end,
                            "error": turn_error,
                            "saw_message_end": run_info["saw_message_end"],
                            "fetch_count": run_info["fetch_count"],
                            "token_chars": run_info["token_chars"],
                            "thinking_chars": run_info["thinking_chars"],
                            "delegated": run_info["delegated"],
                            "ignored_foreign_events": run_info["ignored_foreign_events"],
                            "text_tail": run_info.get("text_tail", ""),
                            "stdout_tail": tail,
                        }, ensure_ascii=False) + "\n")
                except Exception:
                    pass
                # 落盘完整结果：后端跑完整轮不依赖客户端连接，断线后前端用 /api/chat/last 取回
                _save_turn(pk, "done", "".join(full_text), {
                    "turn_id": turn_id,
                    "requestedModelRef": requested_model_ref,
                    "requestedThinkingLevel": requested_thinking_level,
                    "gateway_run_id": run_info.get('run_id'),
                    "thinking": ''.join(full_thinking),
                    "thinkingStatus": 'available' if full_thinking else 'unavailable',
                    "thinkingSource": reasoning_stream.source,
                    "error": turn_error,
                    "clean_end": clean_end,
                    "stop_reason": "user_stopped" if user_stopped else run_info.get("stop_reason"),
                })
                if audit_context is not None:
                    try:
                        audit_context['record']['_usageObservations'] = usage_observations
                        await asyncio.to_thread(skill_audit.finish, OUTPUTS_DIR, OPENCLAW_SESSIONS_DIR,
                                                audit_context, ''.join(full_text),
                                                'stopped' if user_stopped else 'interrupted' if timed_out or turn_error is not None or proc.poll() not in (0, None) else 'completed')
                    except Exception:
                        to_client('activity', '执行核验未能保存；本轮回复已保留，不能据此确认技能执行。')
                # 邮箱通知钩子：正常跑完且真有产出的一轮发一封摘要邮件（图文/视频/文案等
                # 所有经 chat 入口生成的内容）。失败/超时/用户停止/被截断都不发；未配置零开销。
                if _notify_email_web_turn is not None:
                    try:
                        _notify_email_web_turn(
                            "done", "".join(full_text),
                            stop_reason="user_stopped" if user_stopped else run_info.get("stop_reason"),
                            user_stopped=user_stopped,
                            clean_end=(clean_end and not run_info.get("stop_reason")),
                        )
                    except Exception:
                        pass
        except Exception as e:
            error = (e.detail if isinstance(e, HTTPException) and isinstance(e.detail, dict)
                     and str(e.detail.get('code', '')).startswith('chat_model_')
                     else gateway_error(type(e).__name__ + ': ' + str(e)))
            to_client('error', error)
            _save_turn(pk, 'done', ''.join(full_text), {
                'turn_id': turn_id, 'thinking': ''.join(full_thinking),
                'requestedModelRef': requested_model_ref,
                'requestedThinkingLevel': requested_thinking_level,
                'error': error, 'clean_end': False, 'stop_reason': 'supervisor_failed',
            })
        finally:
            xlock.release()
            lock.release()
            _RUNNING_CHAT.pop(sk, None)
            _ACTIVE_SKILL_TURNS.pop(sk, None)
            to_client("done", sessionKey=sk)
            client_q.put_nowait(CLIENT_DONE)

    # 把 run 跑在独立后台任务里（持强引用防 GC）——客户端断开不取消它。
    task = asyncio.create_task(supervisor())
    _BG_TASKS.add(task)

    def _bg_done(t):
        _BG_TASKS.discard(t)
        try:
            exc = t.exception()   # 取出异常避免「never retrieved」告警
        except Exception:
            exc = None
        if exc is not None:
            # supervisor 意外崩溃：解锁 forward，别让它空等
            try:
                client_q.put_nowait(CLIENT_DONE)
            except Exception:
                pass
    task.add_done_callback(_bg_done)

    async def forward():
        """纯转发：从 client_q 取事件 yield 给浏览器。

        客户端断开（关标签/代理掐断）只会结束本生成器，supervisor 任务不受影响，
        继续把 openclaw run 跑完并落盘 → 前端断线后 /api/chat/last 取回完整结果。
        """
        idle_since = time.monotonic()
        while True:
            try:
                item = await asyncio.wait_for(client_q.get(), timeout=10)
            except asyncio.TimeoutError:
                # 长时间无输出（等模型长回复 / 制作类长任务）→ 发心跳，让用户知道没卡死。
                # 用独立的 `heartbeat` 事件，不走 `activity`：否则会覆盖掉真实的
                # 「🧠 正在思考…/🛠️ 制作中…」状态与思考流（防呆消息把思考设计顶掉的根因）。
                # 发出后重置 idle_since → 心跳按 30s 一次的节奏，不再每 10s 重复刷屏。
                if time.monotonic() - idle_since >= 30:
                    idle_since = time.monotonic()
                    yield {"event": "heartbeat", "data": json.dumps(
                        "仍在处理中，未卡住…（复杂或制作类任务会花点时间）", ensure_ascii=False)}
                continue
            if item is CLIENT_DONE:
                break
            idle_since = time.monotonic()
            t = item["t"]
            if t in ("token", "text_snapshot"):
                yield {"id": str(item["id"]), "event": t, "data": json.dumps(item["text"], ensure_ascii=False)}
            elif t == "thinking":
                yield {"id": str(item["id"]), "event": "thinking", "data": json.dumps(item["text"], ensure_ascii=False)}
            elif t == "activity":
                yield {"id": str(item["id"]), "event": "activity", "data": json.dumps(item["text"], ensure_ascii=False)}
            elif t == "question":
                yield {"id": str(item["id"]), "event": "question", "data": item["text"]}
            elif t == "error":
                yield {"id": str(item["id"]), "event": "error", "data": json.dumps(item["text"], ensure_ascii=False)}
            elif t == 'model_selection':
                yield {"id": str(item["id"]), "event": t, "data": json.dumps(item["text"], ensure_ascii=False)}
            elif t == "done":
                yield {"id": str(item["id"]), "event": "done", "data": json.dumps({"sessionKey": item.get("sessionKey")}, ensure_ascii=False)}

    return EventSourceResponse(forward(), headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Content-Encoding": "identity"})


class QuestionAnswerRequest(BaseModel):
    sessionId: str | None = None
    questionId: str
    answers: dict  # {questionId: [optionValues]}
    resolvedBy: str | None = None


@app.post("/api/chat/question/answer")
async def api_question_answer(req: QuestionAnswerRequest):
    """前端点击 ask_user 选项后调用：转发 gateway question.resolve，让等待的 agent 拿到答案。"""
    if GatewayClient is None:
        return {"ok": False, "error": "gateway question bridge unavailable"}
    client = GatewayClient()
    try:
        client.connect()
        result = client.resolve(req.questionId, req.answers or {}, req.resolvedBy)
        return {"ok": True, "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        client.close()


class QuestionStatusRequest(BaseModel):
    questionIds: list[str]


@app.post("/api/chat/question/status")
async def api_question_status(req: QuestionStatusRequest):
    """批量查 question 状态（重放旧事件时过滤已解决的题）。"""
    if GatewayClient is None:
        return {"ok": False, "questions": {}}
    client = GatewayClient()
    try:
        client.connect()
        out = {}
        for qid in req.questionIds:
            try:
                q = client.get_question(qid)
                # QUESTION_NOT_FOUND 抛异常捕获后报 not_found；正常返回则按 status
                out[qid] = {"status": q.get("status") if q else "not_found"}
            except GatewayQuestionError as e:
                # gateway 明确错：问题已清理/不存在 = 已答或已过期，一律 not_found
                out[qid] = {"status": "not_found"}
            except Exception:
                out[qid] = {"status": "unknown"}   # 网络/连接异常：保持 unknown（前端保留显示，宁不缺题）
        return {"ok": True, "questions": out}
    except Exception as e:
        return {"ok": False, "error": str(e), "questions": {}}
    finally:
        client.close()


class StopRequest(BaseModel):
    sessionId: str | None = None
    turnId: str | None = None


@app.post("/api/chat/stop")
async def api_chat_stop(req: StopRequest):
    """用户显式停止当前会话正在跑的对话 agent：终止进程 → supervisor 收尾释放会话锁 →
    下一句立刻能发（不再卡「上一条还在跑」）。仅此显式入口会杀进程；客户端断线不经此路径。"""
    sk = (req.sessionId or "").strip()
    proc = _RUNNING_CHAT.get(sk) if sk else None
    if req.turnId and _ACTIVE_SKILL_TURNS.get(sk) != req.turnId:
        return {"stopped": False}
    if proc is not None and proc.poll() is None:
        _STOPPED_CHAT.add(sk)          # 标记为用户停止，供 supervisor 正常收尾（不报「被中断」）
        try:
            await asyncio.to_thread(proc.terminate)
        except OSError:
            pass
        try:
            await asyncio.to_thread(proc.wait, timeout=3)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
        # supervisor removes the running marker only after persisting the final
        # snapshot and releasing both session locks.
        deadline = time.monotonic() + 5
        while _RUNNING_CHAT.get(sk) is proc and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        return {"stopped": _RUNNING_CHAT.get(sk) is not proc}
    return {"stopped": False}          # 没有在跑（可能已结束）→ 前端照常清理即可


@app.post("/api/chat")
async def api_chat(req: ChatRequest):
    """非流式对话（备选）。"""
    if req.modelRef is not None:
        raise HTTPException(400, {'code': 'chat_model_requires_stream', 'category': 'configuration',
                                 'retryable': False, 'message': '指定渠道模型请使用流式任务入口。'})
    # 每轮末尾追加「先查技能库」提醒，抗长对话指令衰减（对用户不可见）
    message = _chat_message(req)
    loop = asyncio.get_event_loop()
    # chat 可能中途触发制作层长任务 → 用 TIMEOUT_CHAT，与流式 /api/chat/stream 一致（勿用 300s）
    result = await loop.run_in_executor(None, run_agent_sync, message, TIMEOUT_CHAT,
                                        req.sessionId, req.thinkingLevel)
    return {"response": result}


class SkillRequest(BaseModel):
    skill: str
    input: str
    persona: str | None = None


@app.post("/api/skill")
async def api_skill(req: SkillRequest):
    skill_full = find_skill(req.skill)
    if skill_full is None:
        raise HTTPException(404, f"SKILL '{req.skill}' 不存在")
    message = f"{_persona_prefix(req.persona)}请执行 /{skill_full}，内容如下：\n\n{req.input}"
    # 统一给足超时：制作类 SKILL（生视频/多镜合成）可能跑很久，取安全上界
    timeout = TIMEOUT_PRODUCE
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, run_agent_sync, message, timeout)
    return {"response": result}


@app.get("/api/outputs")
def api_outputs():
    # 产物树是全量递归扫描（文件量大时单次可达数十秒）。必须是同步 handler：
    # FastAPI 会自动放入线程池执行；若写成 async def 直调，扫描期间会阻塞事件循环，
    # 全站所有请求（含 /api/status）一起挂起等它。
    nodes = get_output_tree()
    for node in nodes:
        if node['name'] not in {IMAGEGEN_DIR.name, 'images'}:
            continue
        node['source'] = 'imagegen'
        node['meta'] = {**node.get('meta', {}),
                        'title': node.get('meta', {}).get('title') or ('AI 生图 · 早期图片' if node['name'] == 'images' else 'AI 生图'),
                        'kind': 'image'}

        def enrich(children: list[dict]) -> None:
            for child in children:
                if child['type'] == 'dir':
                    enrich(child.get('children', []))
                elif child.get('kind') == 'image':
                    path = OUTPUTS_DIR / child['path']
                    child.update({'source': 'imagegen', **_imagegen_dimensions(path)})
                    generation = _read_imagegen_metadata(path)
                    if generation:
                        child['generation'] = generation

        enrich(node.get('children', []))
    return nodes


@app.get('/api/workspace-outputs')
def api_workspace_outputs():
    """Recent public output metadata; sync handler runs in FastAPI's worker pool."""
    import office_outputs
    return office_outputs.snapshot(OUTPUTS_DIR)


@app.get("/api/output/{path:path}")
async def api_output(path: str):
    """文本产物内容。二进制/媒体返回 isBinary=true，前端改用 /api/media。"""
    full = _safe_output_path(path)
    kind = _file_kind(full.name)
    if kind not in ("text",):
        return {"path": path, "content": "", "kind": kind, "isBinary": True}
    try:
        return {"path": path, "content": full.read_text(encoding="utf-8"), "kind": "text", "isBinary": False}
    except UnicodeDecodeError:
        return {"path": path, "content": "", "kind": "binary", "isBinary": True}


@app.get("/api/media/{path:path}")
async def api_media(path: str):
    """原样输出媒体文件（图片/视频/音频/HTML/PDF），供 <img>/<video>/iframe/下载。"""
    full = _safe_output_path(path)
    # HTML 预览会在本地被就地重新生成（如 gzh-design 重排/内联图片），必须禁缓存，
    # 否则浏览器/代理按启发式缓存旧版 → 内容库 iframe 打开的是过期预览（复制粘贴带旧图 URL）。
    headers = ({"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}
               if full.suffix.lower() in {".html", ".htm"} else {})
    return FileResponse(full, headers=headers)


# 系统数据目录/文件——不允许从内容库删除（删了会丢登录态/日历/发布记录）
PROTECTED_OUTPUTS = {"_login", "_analytics", "_schedule.json", "_ideas.json",
                     "_publish", "_publish.log", "analytics"}
UPLOAD_EXTS = IMAGE_EXTS | VIDEO_EXTS | {
    ".pdf", ".txt", ".md", ".markdown", ".csv", ".json", ".srt", ".vtt",
    ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".mp3", ".wav", ".m4a"}
MAX_UPLOAD_MB = 50


def _unique_upload_path(dest: Path, filename: str) -> Path:
    """同一上传批次内保留所有同名文件，不让后一个静默覆盖前一个。"""
    target = dest / filename
    if not target.exists():
        return target
    source = Path(filename)
    index = 2
    while True:
        target = dest / f"{source.stem} ({index}){source.suffix}"
        if not target.exists():
            return target
        index += 1


def _safe_output_target(rel: str, *, must_exist: bool = True) -> Path:
    """解析到 outputs/ 内的文件或目录（防穿越）。与 _safe_output_path 不同：允许目录、
    可要求不必已存在（上传新文件时）。永远拒绝 outputs/ 根本身。"""
    full = (OUTPUTS_DIR / rel).resolve()
    root = OUTPUTS_DIR.resolve()
    if full == root or root not in full.parents:
        raise HTTPException(403, '非法路径')
    if must_exist and not full.exists():
        raise HTTPException(404, '不存在')
    return full


def _is_protected(full: Path) -> bool:
    """路径的顶层段是否属于受保护的系统项。"""
    try:
        rel = full.relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        return True
    return bool(rel.parts) and (rel.parts[0].startswith('_') or rel.parts[0] in PROTECTED_OUTPUTS)


@app.delete("/api/output/{path:path}")
async def api_output_delete(path: str):
    """删除内容库里的单个文件或整个项目目录。系统数据（_login/_analytics/日历/发布记录）受保护。"""
    full = _safe_output_target(path)
    if _is_protected(full):
        raise HTTPException(403, '系统数据受保护，不可从内容库删除')
    is_dir = full.is_dir()
    try:
        if is_dir:
            shutil.rmtree(full)
        else:
            full.unlink()
            # 生图提示词属于图片的元数据，删除图片时一并清理隐藏旁车。
            if full.parent.name in {IMAGEGEN_DIR.name, 'images'}:
                try:
                    _imagegen_metadata_path(full).unlink(missing_ok=True)
                except OSError:
                    pass
    except OSError as e:
        raise HTTPException(500, f'删除失败：{e}')
    return {"ok": True, "deleted": path, "kind": "dir" if is_dir else "file"}


@app.post("/api/upload")
async def api_upload(
    files: list[UploadFile] = File(...),
    sessionId: str = Form(...),
):
    """Store chat attachments in a session-scoped inbox and return opaque refs."""
    scope = _attachment_scope(sessionId)
    batch = time.strftime('%Y%m%d-') + uuid.uuid4().hex[:6]
    dest = OUTPUTS_DIR / "_inbox" / scope / batch
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        name = Path(f.filename or "file").name
        ext = Path(name).suffix.lower()
        if ext not in UPLOAD_EXTS:
            raise HTTPException(400, f'不支持的文件类型：{ext or name}')
        data = await f.read()
        if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f'{name} 超过 {MAX_UPLOAD_MB}MB 上限')
        target = _unique_upload_path(dest, name)
        target.write_bytes(data)
        rel = f"_inbox/{scope}/{batch}/{target.name}"
        saved.append({"id": _attachment_id(scope, rel), "name": target.name, "path": rel})
    if not saved:
        raise HTTPException(400, '没有文件')
    return {"ok": True, "files": saved}


@app.get("/api/upload/limits")
async def api_upload_limits():
    """当前上传上限（MB）——前端在文件超限时据此切换到本地复制通道。"""
    return {"ok": True, "max_mb": MAX_UPLOAD_MB}


@app.post("/api/upload/local")
async def api_upload_local(
    files: list[UploadFile] = File(...),
    sessionId: str = Form(...),
):
    """超过上传上限的文件复制通道：1MB 分块流式落盘（不整读进内存）、无大小上限；
    产出与 /api/upload 同构的附件引用（id/name/path），附件校验与清单链路零改动。"""
    scope = _attachment_scope(sessionId)
    batch = time.strftime('%Y%m%d-') + uuid.uuid4().hex[:6]
    dest = OUTPUTS_DIR / "_inbox" / scope / batch
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        name = Path(f.filename or "file").name
        ext = Path(name).suffix.lower()
        if ext not in UPLOAD_EXTS:
            raise HTTPException(400, f'不支持的文件类型：{ext or name}')
        target = _unique_upload_path(dest, name)
        with open(target, 'wb') as out:
            while True:
                chunk = await f.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        rel = f"_inbox/{scope}/{batch}/{target.name}"
        saved.append({"id": _attachment_id(scope, rel), "name": target.name, "path": rel})
    if not saved:
        raise HTTPException(400, '没有文件')
    return {"ok": True, "files": saved}


def _write_login_marker(platform: str, state: str, message: str = '') -> None:
    """回写登录标记 outputs/_login/<平台>.json（与 login_state.write_status 同格式，原子写）。
    whoami 真校验确认已登录后调用 → _account_logged_in 的快速路径此后自愈并持久。"""
    LOGIN_DIR.mkdir(parents=True, exist_ok=True)
    data = {"state": state, "message": message, "qr": "", "ts": int(time.time())}
    st = LOGIN_DIR / f'{platform}.json'
    tmp = st.with_suffix('.json.tmp')
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        os.replace(tmp, st)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


def _account_logged_in(platform: str, cfg: dict) -> bool:
    """尽力判断某平台是否已登录。
    浏览器平台的登录态只有启动浏览器才真能知道（profile 里总有 Cookies 文件，存在≠已登录，
    会误报），故这里只信「本流程最近一次登录成功」——即 status.json == success。
    biliup 的 cookies.json 只有登录成功才生成，可直接判。"""
    backend = cfg['backend']
    if backend == 'unsupported':
        return False
    if backend == 'biliup':
        return (DATA_DIR / 'cookies.json').is_file()
    if backend == 'wechat-oa':
        # 发布+数据都走「后台会话」→ 以 mp 后台登录成功为准；AppID 凭证作为兜底（旧配置）
        try:
            if _mp_login_status().get('state') == 'success':
                return True
        except Exception:
            pass
        return _wechat_has_credentials()
    st = LOGIN_DIR / f'{platform}.json'
    if st.is_file():
        try:
            return json.loads(st.read_text(encoding="utf-8")).get('state') == 'success'
        except Exception:
            return False
    return False


def _login_status(platform: str) -> dict:
    """读登录状态文件 + 二维码是否就绪。"""
    st = LOGIN_DIR / f'{platform}.json'
    data = {'state': 'unknown', 'message': ''}
    marker = {}
    if st.is_file():
        try:
            d = json.loads(st.read_text(encoding="utf-8"))
            marker = d
            data = {'state': d.get('state', 'unknown'), 'message': d.get('message', '')}
        except Exception:
            pass
    # A runner can exit at any point (including QR/SMS verification). A stale
    # nonterminal marker must not keep the UI polling a dead child indefinitely.
    proc = LOGIN_PROCESSES.get(platform)
    if data['state'] not in ('success', 'expired', 'error') and proc is not None:
        code = proc.poll()
        if code is not None:
            data = {'state': 'error', 'message': f'登录流程已结束，但未返回成功结果。请重新连接（退出码 {code}）。'}
    qr = LOGIN_DIR / f'{platform}.png'
    # New runners explicitly bind the image to this phase. A verification
    # marker with qr="" must never resurrect a previously saved code.
    show_image = (data['state'] in ('qr_ready', 'scanned', 'sms_required')
                  or (data['state'] == 'verifying' and bool(marker.get('qr'))))
    if show_image and qr.is_file():
        data['qr'] = f'_login/{platform}.png'
        try:
            data['qrTs'] = int(qr.stat().st_mtime * 1000)   # 毫秒缓存键，保留短时间内二维码刷新的区分
        except OSError:
            data['qrTs'] = 0
        if marker.get('qrKind') in ('qr', 'page'):
            data['qrKind'] = marker['qrKind']
        for field in ('qrWidth', 'qrHeight'):
            value = marker.get(field)
            if type(value) is int and 0 < value <= 16384:
                data[field] = value
    else:
        data['qr'] = ''
        data['qrTs'] = 0
    data['visibleBrowser'] = bool(proc is not None and '--headed' in (getattr(proc, 'args', ()) or ()))
    return data


@app.get("/api/accounts")
async def api_accounts():
    return [
        {'platform': pf, 'name': cfg['name'], 'backend': cfg['backend'],
         'supported': cfg['backend'] != 'unsupported',
         'loggedIn': _account_logged_in(pf, cfg),
         'note': cfg.get('note', ''), **_account_local_metadata(pf, cfg)}
        for pf, cfg in LOGIN_RUNNERS.items()
    ]


def _account_local_metadata(platform: str, cfg: dict) -> dict:
    markers = [LOGIN_DIR / f'{platform}.json']
    backend = cfg['backend']
    if backend == 'biliup':
        paths, storage = [DATA_DIR / 'cookies.json'], 'cookie_file'
    elif backend == 'wechat-oa':
        paths = [BROWSER_PROFILES / 'WeixinMpProfile']
        markers.append(LOGIN_DIR / 'wechat-oa-mp.json')
        storage = 'browser_profile' if paths[0].exists() else 'app_credentials'
    else:
        paths = [BROWSER_PROFILES / cfg['profile']] if cfg.get('profile') else []
        storage = 'browser_profile'
    has_local = any(p.exists() for p in paths) or any(p.exists() for p in markers)
    login_names = [platform] + (['wechat-oa-mp'] if backend == 'wechat-oa' else [])
    has_local = has_local or any((LOGIN_DIR / (name + suffix)).exists()
                                 for name in login_names for suffix in ('.code', '.png', '-me.png'))
    if backend == 'wechat-oa':
        has_local = has_local or _wechat_has_credentials()
    timestamps = []
    for marker in markers:
        try:
            value = json.loads(marker.read_text(encoding='utf-8')).get('ts')
            if type(value) in (int, float) and 0 < value <= time.time() + 60:
                timestamps.append(value)
        except (OSError, ValueError, AttributeError):
            pass
    return {'hasLocalSession': has_local, 'lastStateAt': max(timestamps) if timestamps else None,
            'credentialStorage': storage}


def _account_check_generation(platform: str) -> str:
    with _WHOAMI_LOCK:
        generation = _ACCOUNT_GENERATIONS.get(platform, '')
    return generation + ':' + (account_context_generation(platform) if platform == 'xiaohongshu' else '')


def _invalidate_account_check(platform: str) -> None:
    with _WHOAMI_LOCK:
        _ACCOUNT_GENERATIONS[platform] = uuid.uuid4().hex
        _WHOAMI_CACHE.pop(platform, None)


def _require_account_available(platform: str) -> None:
    with _PUBLISH_LOCK:
        if platform in _ACCOUNT_CLEARING:
            raise HTTPException(409, '该账号正在退出或重新连接，请完成后重试')
        if platform in _PUBLISH_ACTIVE:
            raise HTTPException(409, '该平台正在发布或核实作品，请等待结束后再操作账号')


def _account_browser_busy(platform: str) -> bool:
    """Called with _PUBLISH_LOCK held; account locks are always acquired after it."""
    key = 'wechat-oa-mp' if platform == 'wechat-oa' else platform
    login = LOGIN_PROCESSES.get(key)
    if login is not None and login.poll() is None:
        return True
    with _WHOAMI_LOCK:
        return any(process.poll() is None for process in _WHOAMI_PROCESSES.get(platform, []))


def _stop_owned_login(platform: str) -> None:
    key = 'wechat-oa-mp' if platform == 'wechat-oa' else platform
    with _PUBLISH_LOCK:
        with _WHOAMI_LOCK:
            processes = list(_WHOAMI_PROCESSES.get(platform, []))
        login = LOGIN_PROCESSES.get(key)
        if login is not None:
            processes.append(login)
    for process in processes:
        if process.poll() is None:
            from easel.install_runner import terminate_phase_tree
            try:
                terminate_phase_tree(process)
                process.wait(timeout=5)
            except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                raise HTTPException(500, '登录或账号核验进程未能停止，退出未完成；请关闭该平台窗口后重试') from exc
    with _PUBLISH_LOCK:
        LOGIN_PROCESSES.pop(key, None)


def _run_owned_whoami(platform: str, command: list[str], expected_generation: str):
    """Register the browser owner before launch so logout can stop every writer."""
    import tempfile
    from easel.install_runner import terminate_phase_tree
    with tempfile.TemporaryFile(mode='w+b') as output:
        with _PUBLISH_LOCK:
            _require_account_available(platform)
            if _account_browser_busy(platform):
                raise HTTPException(409, '该平台正在登录或核验账号，请等待结束后重试')
            with _WHOAMI_LOCK:
                if _ACCOUNT_GENERATIONS.get(platform, '') != expected_generation.partition(':')[0]:
                    raise HTTPException(409, '账号状态已变化，已取消旧核验请求')
                process = subprocess.Popen(command, cwd=str(PROJECT_ROOT), env=_proxy_env(),
                                           stdout=output, stderr=subprocess.STDOUT,
                                           start_new_session=os.name != 'nt',
                                           creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                _WHOAMI_PROCESSES.setdefault(platform, []).append(process)
        try:
            try:
                process.wait(timeout=150)
            except subprocess.TimeoutExpired:
                terminate_phase_tree(process)
                process.wait(timeout=5)
                raise
            output.seek(0)
            return subprocess.CompletedProcess(command, process.returncode,
                                               output.read(2 * 1024 * 1024).decode('utf-8', errors='replace'), '')
        finally:
            with _WHOAMI_LOCK:
                remaining = [p for p in _WHOAMI_PROCESSES.get(platform, []) if p is not process]
                if remaining:
                    _WHOAMI_PROCESSES[platform] = remaining
                else:
                    _WHOAMI_PROCESSES.pop(platform, None)


async def _restart_owned_login(platform: str, key: str) -> None:
    """Reserve one account while stopping its registered login off the loop."""
    with _PUBLISH_LOCK:
        _require_account_available(platform)
        existing = LOGIN_PROCESSES.get(key)
        if existing is None or existing.poll() is not None:
            return
        with _WHOAMI_LOCK:
            if any(process.poll() is None for process in _WHOAMI_PROCESSES.get(platform, [])):
                raise HTTPException(409, '该平台正在核验账号，请等待结束后再重新连接')
        _ACCOUNT_CLEARING.add(platform)

    def stop():
        from easel.install_runner import terminate_phase_tree
        try:
            terminate_phase_tree(existing)
            existing.wait(timeout=5)
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            raise HTTPException(500, '旧登录流程未能停止，请关闭该平台登录窗口后重试') from exc
        if existing.poll() is None:
            raise HTTPException(500, '旧登录流程仍在运行，请关闭该平台登录窗口后重试')

    try:
        await asyncio.to_thread(stop)
        with _PUBLISH_LOCK:
            if LOGIN_PROCESSES.get(key) is not existing:
                raise HTTPException(409, '登录流程已变化，请重新连接')
            LOGIN_PROCESSES.pop(key, None)
    finally:
        with _PUBLISH_LOCK:
            _ACCOUNT_CLEARING.discard(platform)


@app.post("/api/login/{platform}")
async def api_login_start(platform: str, visibleBrowser: bool = False, restart: bool = False):
    """启动某平台登录：浏览器平台后台跑 QR runner，轮询到二维码就绪即返回。"""
    cfg = LOGIN_RUNNERS.get(platform)
    if not cfg:
        raise HTTPException(404, '未知平台')
    if visibleBrowser and cfg.get('backend') != 'xhs':
        raise HTTPException(400, '此平台暂不支持在浏览器窗口中登录')
    if restart and cfg.get('backend') not in ('unsupported', 'wechat-oa'):
        await _restart_owned_login(platform, platform)
    # Reserve the profile until the child is registered. No browser wait or
    # await belongs inside this lock; logout can then stop the owned child.
    with _PUBLISH_LOCK:
        _require_account_available(platform)
        backend = cfg['backend']
        if backend == 'unsupported':
            raise HTTPException(400, f"{cfg['name']} 暂不可用：{cfg.get('note', '')}")
        if backend == 'wechat-oa':
            # 公众号不走扫码：前端应改用凭证表单提交到 /api/accounts/{platform}/credentials。
            return {'mode': 'credentials', 'configured': _wechat_has_credentials(),
                    'message': '微信公众号请填写 AppID / AppSecret'}
        existing = LOGIN_PROCESSES.get(platform)
        if existing is not None and existing.poll() is None:
            return {'mode': 'qr', **_login_status(platform)}
        if _account_browser_busy(platform):
            raise HTTPException(409, '该平台正在核验账号，请等待结束后再登录')
        _invalidate_account_check(platform)
        login_generation = _account_check_generation(platform)
        if platform == 'xiaohongshu':
            invalidate_account_context(platform)
            login_generation = _account_check_generation(platform)
        LOGIN_DIR.mkdir(parents=True, exist_ok=True)
        qr = LOGIN_DIR / f'{platform}.png'
        status = LOGIN_DIR / f'{platform}.json'
        for f in (qr, status):
            try:
                f.unlink()
            except OSError:
                pass
        if backend == 'xhs':
            cmd = [sys.executable, str(SHARED_SCRIPTS / 'xhs_publish.py'), 'login', '--no-proxy',
                   '--qr-out', str(qr), '--status-file', str(status), '--timeout', str(LOGIN_TIMEOUT)]
            if visibleBrowser:
                cmd.append('--headed')
        elif backend == 'biliup':
            # B站：TV 端扫码登录 API 生成二维码 + 写 biliup cookie（biliup login 需真终端，前端用不了）
            cmd = [sys.executable, str(SHARED_SCRIPTS / 'bili_login.py'), 'login',
                   '--qr-out', str(qr), '--status-file', str(status),
                   '--cookie', str(DATA_DIR / 'cookies.json'), '--timeout', str(LOGIN_TIMEOUT)]
        elif backend == 'douyin':
            code_file = LOGIN_DIR / f'{platform}.code'
            try:
                code_file.unlink()
            except OSError:
                pass
            cmd = [sys.executable, str(SHARED_SCRIPTS / 'douyin_publish.py'), 'login',
                   '--qr-out', str(qr), '--status-file', str(status),
                   '--sms-code-file', str(code_file), '--timeout', str(LOGIN_TIMEOUT)]
        else:
            cmd = [sys.executable, str(SHARED_SCRIPTS / 'web_publisher.py'), 'login-qr',
                   '--platform', cfg['wp'], '--qr-out', str(qr), '--status-file', str(status),
                   '--timeout', str(LOGIN_TIMEOUT)]
        # 新登录开始 → 清掉旧的 whoami 缓存（登录前可能缓存了「未登录」），避免登录成功后仍读到旧结果
        with _WHOAMI_LOCK:
            _WHOAMI_CACHE.pop(platform, None)
        log_path = LOGIN_DIR / f'{platform}.log'
        with log_path.open('a', encoding='utf-8') as log_file:
            proc = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), env=_proxy_env(),
                                    stdout=log_file, stderr=subprocess.STDOUT,
                                    start_new_session=os.name != 'nt',
                                    creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        LOGIN_PROCESSES[platform] = proc
    for _ in range(50):
        await asyncio.sleep(0.5)
        if _account_check_generation(platform) != login_generation:
            raise HTTPException(409, '账号状态已变化，已结束旧登录请求')
        s = _login_status(platform)
        if s['qr'] or s['state'] in ('qr_ready', 'success', 'error', 'expired'):
            return {'mode': 'qr', **s}
    s = _login_status(platform)
    return {'mode': 'qr', **s}


@app.get("/api/login/{platform}/status")
async def api_login_status(platform: str):
    if platform not in LOGIN_RUNNERS:
        raise HTTPException(404, '未知平台')
    s = _login_status(platform)
    if s.get('state') == 'success':
        # 登录刚成功 → 清掉登录前缓存的「未登录」whoami 结果，令下次 whoami 重新真校验；
        # 否则卡片会因 WHOAMI_TTL(600s) 内的旧 false 持续显示「未登录」（本次视频号问题的根因）。
        # 只清缓存、不改任何登录/检测逻辑。
        with _WHOAMI_LOCK:
            _WHOAMI_CACHE.pop(platform, None)
    return {'mode': 'qr', **s}


class SmsCodeRequest(BaseModel):
    code: str


@app.post("/api/login/{platform}/sms")
async def api_login_sms(platform: str, req: SmsCodeRequest):
    """回填短信验证码：写入 runner 轮询的一次性验证码文件（见 login_state.read_sms_code）。

    登录 runner 检测到风控短信墙时把状态置 sms_required，前端弹输入框，用户把手机
    收到的验证码提交到这里，runner 读走后填码提交，继续完成登录。
    """
    if platform not in LOGIN_RUNNERS:
        raise HTTPException(404, '未知平台')
    code = ''.join(ch for ch in (req.code or '') if ch.isdigit())
    if not (4 <= len(code) <= 8):
        raise HTTPException(400, '验证码应为 4-8 位数字')
    LOGIN_DIR.mkdir(parents=True, exist_ok=True)
    (LOGIN_DIR / f'{platform}.code').write_text(code, encoding='utf-8')
    return {'ok': True}


class WechatCredentials(BaseModel):
    appId: str = ''
    appSecret: str = ''
    name: str = ''
    author: str = ''


@app.get("/api/accounts/{platform}/credentials")
async def api_get_credentials(platform: str):
    """读取凭证式平台（目前仅公众号）的已配置状态（AppID 脱敏，AppSecret 不回传）。"""
    cfg = LOGIN_RUNNERS.get(platform)
    if not cfg or cfg.get('backend') != 'wechat-oa':
        raise HTTPException(404, '该平台不使用凭证登录')
    acc = _wechat_web_account()
    app_id = acc.get('app_id', '') or ''
    return {
        'configured': bool(app_id and acc.get('app_secret')),
        'appIdMasked': (app_id[:6] + '***' + app_id[-4:]) if len(app_id) > 10 else ('***' if app_id else ''),
        'name': acc.get('name', '') or '',
        'author': acc.get('author', '') or '',
    }


@app.post("/api/accounts/{platform}/credentials")
async def api_save_credentials(platform: str, req: WechatCredentials):
    """保存凭证式平台（公众号）的 AppID/AppSecret，写入 skill 配置并调官方接口验证。"""
    cfg = LOGIN_RUNNERS.get(platform)
    if not cfg or cfg.get('backend') != 'wechat-oa':
        raise HTTPException(404, '该平台不使用凭证登录')
    _require_account_available(platform)
    app_id = (req.appId or '').strip()
    app_secret = (req.appSecret or '').strip()
    if not app_id or not app_secret:
        raise HTTPException(400, 'AppID 和 AppSecret 都不能为空')
    _invalidate_account_check(platform)
    _wechat_save_credentials(app_id, app_secret, name=req.name.strip(), author=req.author.strip())
    ok, msg = _wechat_verify_token()
    with _WHOAMI_LOCK:
        _WHOAMI_CACHE.pop(platform, None)
    if ok:
        _write_login_marker(platform, 'success', req.name.strip() or '微信公众号')
        return {'ok': True, 'message': '公众号凭证已保存并验证通过'}
    # 校验失败：凭证已存（下次改正后可直接重试），但明确告知失败原因（常见 40164 IP 白名单 / 40125 密钥错误）
    return {'ok': False, 'message': f'凭证已保存但验证未通过：{msg}。若是 40164 请把服务器出口 IP 加入公众号 IP 白名单。'}


def _mp_login_status() -> dict:
    """读公众号后台(mp)登录状态 + 二维码（文件由 weixin_mp_stats.py login 写）。"""
    return _login_status('wechat-oa-mp')


def _stop_mp_login_on_shutdown() -> None:
    """正常重启 Web 时回收扫码进程，避免它继续写入下一次登录的状态。"""
    proc = LOGIN_PROCESSES.pop("wechat-oa-mp", None)
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        _write_login_marker("wechat-oa-mp", "expired", "服务已重启，请重新扫码登录")


@app.post("/api/accounts/{platform}/mp-login")
async def api_mp_login_start(platform: str, restart: bool = False):
    """启动「公众号后台」扫码登录（数据中心取数用，管理员级会话，独立于 AppID 凭证）。
    默认直连起 Playwright 出二维码；受限网络可设 EASEL_PROXY / https_proxy 走正向代理。"""
    cfg = LOGIN_RUNNERS.get(platform)
    if not cfg or cfg.get("backend") != "wechat-oa":
        raise HTTPException(404, "该平台不使用公众号后台登录")
    if restart:
        await _restart_owned_login(platform, 'wechat-oa-mp')
    with _PUBLISH_LOCK:
        _require_account_available(platform)
        # 重复点击复用正在进行的登录，不能删除其二维码或启动第二个 Chromium。
        proc = LOGIN_PROCESSES.get("wechat-oa-mp")
        if proc is not None and proc.poll() is None:
            return {"mode": "qr", **_mp_login_status()}
        if _account_browser_busy(platform):
            raise HTTPException(409, '该平台正在核验账号，请等待结束后再登录')
        _invalidate_account_check(platform)
        login_generation = _account_check_generation(platform)
        LOGIN_DIR.mkdir(parents=True, exist_ok=True)
        for f in (LOGIN_DIR / "wechat-oa-mp.png", LOGIN_DIR / "wechat-oa-mp.json"):
            try:
                f.unlink()
            except OSError:
                pass
        wx_proxy = os.environ.get("EASEL_PROXY") or os.environ.get("https_proxy") or ""
        cmd = [sys.executable, str(SHARED_SCRIPTS / "weixin_mp_stats.py"), "login",
               "--proxy", wx_proxy, "--qr-out", str(LOGIN_DIR / "wechat-oa-mp.png"),
               "--status-file", str(LOGIN_DIR / "wechat-oa-mp.json"), "--timeout", "240"]
        with (LOGIN_DIR / "wechat-oa-mp.log").open("a", encoding="utf-8") as log_file:
            proc = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), env=_proxy_env(),
                                    stdout=log_file, stderr=subprocess.STDOUT,
                                    start_new_session=os.name != 'nt',
                                    creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        LOGIN_PROCESSES["wechat-oa-mp"] = proc
    for _ in range(60):
        await asyncio.sleep(0.5)
        if _account_check_generation(platform) != login_generation:
            raise HTTPException(409, '账号状态已变化，已结束旧登录请求')
        s = _mp_login_status()
        if s["qr"] or s["state"] in ("qr_ready", "success", "error", "expired"):
            return {"mode": "qr", **s}
    return {"mode": "qr", **_mp_login_status()}


@app.get("/api/accounts/{platform}/mp-login/status")
async def api_mp_login_status(platform: str):
    cfg = LOGIN_RUNNERS.get(platform)
    if not cfg or cfg.get("backend") != "wechat-oa":
        raise HTTPException(404, "该平台不使用公众号后台登录")
    return {"mode": "qr", **_mp_login_status()}


@app.get("/api/accounts/{platform}/whoami")
async def api_account_whoami(platform: str):
    """真校验登录态 + 读昵称/头像（起 headless 浏览器，数秒）。前端开页后台调用以自愈假阳性。
    带 TTL 进程内缓存（避免账号页+工作台重复起浏览器）；确认已登录则回写标记，令快速路径自愈。"""
    cfg = LOGIN_RUNNERS.get(platform)
    if not cfg:
        raise HTTPException(404, '未知平台')
    _require_account_available(platform)
    backend = cfg['backend']
    if backend == 'unsupported':
        return {'loggedIn': False, 'name': '', 'avatar': ''}
    if backend == 'wechat-oa':
        # 不起浏览器：以 mp 后台会话/AppID 配置判断（见 _account_logged_in），名字取配置账号名
        acc = _wechat_web_account()
        return {'loggedIn': _account_logged_in(platform, cfg),
                'name': acc.get('name', '') or '微信公众号', 'avatar': ''}
    # 小红书账号数据切换后，旧缓存的昵称和登录结论不再属于当前上下文。
    account_generation = _account_check_generation(platform)
    with _WHOAMI_LOCK:
        hit = _WHOAMI_CACHE.get(platform)
    if hit and hit[2] == account_generation and (time.time() - hit[0]) < WHOAMI_TTL:
        return hit[1]
    if backend == 'biliup':
        cmd = [sys.executable, str(SHARED_SCRIPTS / 'bili_login.py'), 'whoami',
               '--cookie', str(DATA_DIR / 'cookies.json')]
    elif backend == 'xhs':
        cmd = [sys.executable, str(SHARED_SCRIPTS / 'xhs_publish.py'), 'whoami', '--no-proxy']
    elif backend == 'douyin':
        cmd = [sys.executable, str(SHARED_SCRIPTS / 'douyin_publish.py'), 'whoami']
    else:
        cmd = [sys.executable, str(SHARED_SCRIPTS / 'web_publisher.py'), 'whoami',
               '--platform', cfg['wp']]
    try:
        proc = await asyncio.to_thread(_run_owned_whoami, platform, cmd, account_generation)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, '校验超时（浏览器起不来或网络慢）')
    if account_generation != _account_check_generation(platform) or platform in _ACCOUNT_CLEARING:
        raise HTTPException(409, '账号状态已变化，已丢弃旧校验结果，请重新校验')
    data = {'loggedIn': False, 'name': '', 'avatar': ''}
    confident = False   # 是否拿到「可信」校验结论（子进程正常跑出 JSON 且无 error 字段）
    for line in reversed((proc.stdout or '').strip().splitlines()):
        line = line.strip()
        if line.startswith('{'):
            try:
                d = json.loads(line)
                data = {'loggedIn': bool(d.get('loggedIn')), 'name': d.get('name') or '', 'avatar': d.get('avatar') or ''}
                # 有 error 字段 = 校验本身失败（浏览器起不来/网络抖动/崩溃），不是可信的「未登录」结论
                confident = isinstance(d.get('loggedIn'), bool) and not d.get('error') and not getattr(proc, 'returncode', 0)
                break
            except Exception:
                continue
    if not confident:
        # 校验失败/无有效输出 → **不缓存、不删标记**，返回「上次已知」登录态（读标记）。
        # 避免一次校验抖动就把已登录卡片翻成「未登录」并缓存 10 分钟；下次校验(缓存未写)会自动重试恢复。
        return {'loggedIn': _account_logged_in(platform, cfg), 'name': '', 'avatar': '',
                'verified': False, 'verificationMessage': '本次在线检查未取得可信结果，保留上次登录状态；请稍后重试。'}
    if platform == 'xiaohongshu' and not data['loggedIn']:
        invalidate_account_context(platform, live_only=True)
    current_generation = _account_check_generation(platform)
    with _WHOAMI_LOCK:
        _WHOAMI_CACHE[platform] = (time.time(), data, current_generation)
    # 回写标记：确认已登录 → 快速路径（/api/accounts、/api/analytics/platforms）此后也正确；
    # biliup 走 cookies.json 判定，不用标记文件。
    if backend != 'biliup':
        if data['loggedIn']:
            _write_login_marker(platform, 'success', data.get('name') or '')
        else:
            try:
                (LOGIN_DIR / f'{platform}.json').unlink()
            except OSError:
                pass
    return {**data, 'verified': True}


@app.post("/api/logout/{platform}")
async def api_logout(platform: str):
    """Stop the selected login writer before removing only its local credentials."""
    cfg = LOGIN_RUNNERS.get(platform)
    if not cfg:
        raise HTTPException(404, '未知平台')
    # Claim cleanup before leaving the event loop. A verification worker must
    # see either the complete old profile or the completed logout, never both.
    with _PUBLISH_LOCK:
        _require_account_available(platform)
        _ACCOUNT_CLEARING.add(platform)
        _invalidate_account_check(platform)
    try:
        await asyncio.to_thread(_stop_owned_login, platform)
        if platform == 'xiaohongshu':
            invalidate_account_context(platform)
        return await asyncio.to_thread(_clear_account_files, platform, cfg)
    finally:
        with _PUBLISH_LOCK:
            _ACCOUNT_CLEARING.discard(platform)


def _clear_account_files(platform: str, cfg: dict) -> dict:
    deleted = []
    try:
        prof_name = 'WeixinMpProfile' if cfg['backend'] == 'wechat-oa' else cfg.get('profile')
        if prof_name:
            parent = BROWSER_PROFILES.resolve()
            profile = BROWSER_PROFILES / prof_name
            resolved = profile.resolve()
            # A profile symlink/junction must not redirect this deletion into a
            # different account or outside the explicitly configured root.
            if resolved != parent / prof_name or resolved.parent != parent:
                raise HTTPException(409, '账号会话目录指向其他位置，未执行删除；请检查本地目录链接')
            if profile.exists():
                shutil.rmtree(profile)
                if profile.exists():
                    raise OSError('profile still exists')
                deleted.append(prof_name)
        if cfg['backend'] == 'wechat-oa':
            _wechat_clear_credentials()
            deleted.append('wechat-publisher.yaml:accounts.web')
        if cfg['backend'] == 'biliup':
            cookie = DATA_DIR / 'cookies.json'
            if cookie.is_file():
                cookie.unlink()
                deleted.append('cookies.json')
        names = [f'{platform}{suffix}' for suffix in ('.json', '.png', '-me.png', '.code', '.log')]
        if cfg['backend'] == 'wechat-oa':
            names.extend('wechat-oa-mp' + suffix for suffix in ('.json', '.png', '.code', '.log'))
        for name in names:
            path = LOGIN_DIR / name
            if path.is_file() or path.is_symlink():
                path.unlink()
                deleted.append(name)
    except OSError as exc:
        raise HTTPException(500, '退出未完成：部分本地登录资料仍被占用或无删除权限；请关闭该平台浏览器后重试。其他平台资料未清理。') from exc
    return {'ok': True, 'deleted': deleted, 'scope': platform}


# 归因层：可抓创作数据的平台（多数走 Playwright 登录态；bilibili 用 biliup cookies 不起浏览器、
# wechat-oa 走 mp 后台会话 Playwright 拦截数据 XHR）
ANALYTICS_PLATFORMS = {"xiaohongshu", "douyin", "kuaishou", "zhihu", "weixin-channels", "bilibili", "wechat-oa"}


def _notes_snapshot_file(platform: str) -> Path:
    if platform == "xiaohongshu":
        import account_evidence as ae
        account = ae.active_account(OUTPUTS_DIR / "_analytics")
        if account:
            return ae.account_dir(OUTPUTS_DIR / "_analytics", account["id"]) / "notes.jsonl"
    return OUTPUTS_DIR / "_analytics" / f"{platform}-notes.jsonl"


def invalidate_account_context(platform: str, *, live_only: bool = False) -> None:
    """Invalidate ownership immediately on login/logout without deleting retained evidence."""
    if platform == "xiaohongshu":
        import account_evidence as ae
        if live_only and (ae.active_account(OUTPUTS_DIR / "_analytics") or {}).get("source") != "live":
            return
        ae.invalidate(OUTPUTS_DIR / "_analytics")


def account_context_generation(platform: str) -> str:
    if platform == "xiaohongshu":
        import account_evidence as ae
        return ae.generation(OUTPUTS_DIR / "_analytics")
    return ""


def _last_note_snapshot_at(platform: str) -> int | None:
    """逐篇快照流里最近一次采集时间（文件不存在 → None）。"""
    if platform == "xiaohongshu":
        import account_evidence as ae
        return ae.context(OUTPUTS_DIR / "_analytics")["lastFetchedAt"]
    p = _notes_snapshot_file(platform)
    if not p.is_file():
        return None
    last = None
    for line in p.read_text(encoding="utf-8").splitlines():
        try:
            d = json.loads(line)
            ts = d.get("fetched_at")
            if isinstance(ts, int) and (last is None or ts > last):
                last = ts
        except Exception:  # noqa: BLE001
            continue
    return last


@app.get("/api/analytics/platforms")
async def api_analytics_platforms():
    """列出支持抓数据的平台 + 各自登录态（前端据此渲染平台选择器）。"""
    return [
        {"platform": pf, "name": LOGIN_RUNNERS.get(pf, {}).get("name", pf),
         "loggedIn": _account_logged_in(pf, LOGIN_RUNNERS.get(pf, {}))}
        for pf in LOGIN_RUNNERS if pf in ANALYTICS_PLATFORMS
    ]


@app.get("/api/analytics/notes/{platform}")
async def api_analytics_notes(platform: str):
    """读逐篇笔记快照流（本机 outputs/_analytics/<platform>-notes.jsonl），只读不抓取。
    返回规范化记录 + 数据覆盖窗口（首末采集时间、条数），供「选题建议」追溯证据用。"""
    if platform not in ANALYTICS_PLATFORMS:
        raise HTTPException(404, "该平台暂不支持数据抓取")
    if platform == "xiaohongshu":
        import account_evidence as ae
        context = ae.context(OUTPUTS_DIR / "_analytics")
        records = ae.load(OUTPUTS_DIR / "_analytics")
        first, last = context["firstFetchedAt"], context["lastFetchedAt"]
        return {"platform": platform, "records": records, "count": len(records), **context,
                "window": {"from": first, "to": last} if first else None,
                "note": "逐篇快照保留 365 天、每篇最近两次；无账号旧数据隔离。已入库选题及其引用需在选题库单独删除。"}
    p = _notes_snapshot_file(platform)
    recs: list[dict] = []
    if p.is_file():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(d, dict) and d.get("version"):
                recs.append(d)
    recs.sort(key=lambda x: (x.get("fetched_at", 0), x.get("note_id") or ""))
    first = min((r.get("fetched_at") for r in recs), default=None)
    last = max((r.get("fetched_at") for r in recs), default=None)
    return {
        "platform": platform,
        "records": recs,
        "count": len(recs),
        "firstFetchedAt": first,
        "lastFetchedAt": last,
        "window": {"from": first, "to": last} if first else None,
        "note": "快照仅保最近两次采集且按 12 个月保留期裁剪；清除入口为 POST /api/analytics/clear",
    }


class AnalyticsClearRequest(BaseModel):
    platform: str = "xiaohongshu"
    accountId: str = ""
    scope: str = "account"


@app.post("/api/analytics/clear")
async def api_analytics_clear(req: AnalyticsClearRequest):
    """清除分析历史（概览快照 + 逐篇快照）。用户明确触发才执行；不动登录态。"""
    pf = (req.platform or "").strip()
    if pf and pf not in ANALYTICS_PLATFORMS:
        raise HTTPException(400, "未知平台")
    if req.scope not in {"account", "platform"}:
        raise HTTPException(400, "未知清除范围")
    if pf == "xiaohongshu":
        import account_evidence as ae
        key = None
        if req.scope == "account":
            if not req.accountId:
                raise HTTPException(400, "请提供要清除的账号 ID")
            current = ae.active_account(OUTPUTS_DIR / "_analytics")
            if not current or current["id"] != req.accountId:
                raise HTTPException(409, "账号已切换，请刷新后再清除")
            key = req.accountId
        count = ae.clear(OUTPUTS_DIR / "_analytics", key)
        return {"ok": True, "cleared": pf, "accountId": key, "deletedCount": count,
                "note": "已清除分析快照；登录态及已入库选题保留。"}
    if req.scope != "platform":
        raise HTTPException(400, "该平台仅支持显式指定 scope=platform 清除")
    import account_stats as _as  # skills/shared/scripts 已在 sys.path 上
    _as.clear_analytics(pf or None)
    return {"ok": True, "cleared": pf or "all"}


def _load_note_snapshot_records(platform: str) -> list[dict]:
    """读逐篇快照流里的规范化记录（坏行跳过），供 insights 与选题写入共用。"""
    if platform == "xiaohongshu":
        import account_evidence as ae
        return ae.load(OUTPUTS_DIR / "_analytics")
    p = _notes_snapshot_file(platform)
    recs: list[dict] = []
    if not p.is_file():
        return recs
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(d, dict) and d.get("version"):
            recs.append(d)
    return recs


@app.get("/api/analytics/insights/{platform}")
async def api_analytics_insights(platform: str):
    """基于本人账号逐篇快照的热词建议（只读快照，不联网）。
    每条建议可追溯到原笔记（refs）+ 样本量 + 指标 + 可信度分级。"""
    if platform == "bilibili":
        import bili_insights as bi   # web/ 在 sys.path 上
        return bi.keyword_insights(_load_note_snapshot_records(platform))
    if platform != "xiaohongshu":
        raise HTTPException(404, "探索建议目前仅支持小红书与B站")
    import xhs_insights as xi   # web/ 在 sys.path 上
    import account_evidence as ae
    result = xi.keyword_insights(_load_note_snapshot_records(platform))
    return {**result, **ae.context(OUTPUTS_DIR / "_analytics")}


class AnalyticsImportRequest(BaseModel):
    platform: str = "xiaohongshu"
    accountId: str
    accountName: str = ""
    records: list[dict]


@app.post("/api/analytics/import")
async def api_analytics_import(req: AnalyticsImportRequest):
    """Import user-supplied evidence; it never establishes a platform login identity."""
    if req.platform != "xiaohongshu":
        raise HTTPException(400, "离线导入目前仅支持小红书")
    if not req.records or len(req.records) > 2000:
        raise HTTPException(400, "每次请导入 1–2000 条笔记")
    if len(req.model_dump_json().encode("utf-8")) > 5 * 1024 * 1024:
        raise HTTPException(413, "导入文件不能超过 5 MB")
    import account_evidence as ae
    try:
        rows = ae.ingest(OUTPUTS_DIR / "_analytics", req.records, req.accountId.strip(), int(time.time()),
                         source="import", name=req.accountName)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**await api_analytics_notes("xiaohongshu"), "importedCount": len(rows)}


class InsightIdeaRequest(BaseModel):
    platform: str = "xiaohongshu"
    word: str = ""
    accountId: str = ""


@app.post("/api/analytics/insights/idea")
async def api_insights_idea(req: InsightIdeaRequest):
    """把一条热词建议写入选题库（复用选题创建格式；按来源+标题查重）。"""
    pf = (req.platform or "xiaohongshu").strip()
    if pf == "bilibili":
        # B站快照按平台保存（无账号目录），没有小红书式的账号核验链路：
        # 只做候选词在当前建议列表内的原子校验，归属以快照窗口写进证据。
        import bili_insights as bi
        word = (req.word or "").strip()
        if not word:
            raise HTTPException(400, "没有要加入的候选词")
        records = _load_note_snapshot_records(pf)
        if not records:
            raise HTTPException(409, "B站逐篇快照已更新或被清除，请刷新后重新采集")
        try:
            insights = bi.keyword_insights(records)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        hit = next((s for s in insights["suggestions"] if s["word"] == word), None)
        if hit is None:
            raise HTTPException(404, f"候选词「{word}」不在当前建议列表（可能快照已更新），请刷新后重试")
        idea = bi.idea_from_suggestion(hit, insights.get("window"))
        existing = _read_ideas()
        if any((it.get("analysisEvidence") or {}).get("word") == word
               and (it.get("analysisEvidence") or {}).get("platform") == pf
               and (it.get("analysisEvidence") or {}).get("window") == insights.get("window")
               for it in existing):
            raise HTTPException(409, f"选题「{idea['title']}」已在选题库，不重复添加")
        item = {
            "id": uuid.uuid4().hex[:12],
            "title": idea["title"],
            "note": idea["note"],
            "source": idea["source"],
            "status": "pending",
            "created": int(time.time()),
            "analysisEvidence": {"platform": pf, "word": word,
                                 "window": insights.get("window"),
                                 "confidence": hit["confidence"], "refs": hit["refs"],
                                 "sampleSize": hit["sampleSize"], "evidence": hit["evidence"]},
        }
        existing.insert(0, item)
        _write_ideas(existing)
        return {"ok": True, "idea": item}
    if pf != "xiaohongshu":
        raise HTTPException(400, "探索建议目前仅支持小红书与B站")
    import account_evidence as ae
    if not req.accountId:
        raise HTTPException(400, "缺少分析账号 ID，请刷新后重试")
    context = ae.context(OUTPUTS_DIR / "_analytics")
    if not context["account"] or context["account"]["id"] != req.accountId:
        raise HTTPException(409, "账号已切换，请刷新后再加入选题库")
    word = (req.word or "").strip()
    if not word:
        raise HTTPException(400, "没有要加入的候选词")
    import xhs_insights as xi
    insights = xi.keyword_insights(_load_note_snapshot_records(pf))
    hit = next((s for s in insights["suggestions"] if s["word"] == word), None)
    if hit is None:
        raise HTTPException(404, f"候选词「{word}」不在当前建议列表（可能快照已更新），请刷新后重试")
    idea = xi.idea_from_suggestion(hit, insights.get("window"))
    if context["account"]["source"] == "import":
        idea["source"] = "小红书导入数据分析"
        idea["note"] = "用户提供的账号 ID 与导出文件，账号归属未经平台验证。\n" + idea["note"]
    existing = _read_ideas()
    title = idea["title"]
    if any((it.get("analysisEvidence") or {}).get("word") == word
           and (it.get("analysisEvidence") or {}).get("account", {}).get("id") == req.accountId
           for it in existing):
        raise HTTPException(409, f"选题「{title}」已在选题库，不重复添加")
    item = {
        "id": uuid.uuid4().hex[:12],
        "title": title,
        "note": idea["note"],
        "source": idea["source"],
        "status": "pending",
        "created": int(time.time()),
        "analysisEvidence": {"account": context["account"], "word": word,
                             "coverage": context["coverage"], "window": insights.get("window"),
                             "confidence": hit["confidence"], "refs": hit["refs"],
                             "sampleSize": hit["sampleSize"], "evidence": hit["evidence"]},
    }
    existing.insert(0, item)
    _write_ideas(existing)
    return {"ok": True, "idea": item}


@app.get("/api/analytics/{platform}")
async def api_analytics(platform: str):
    """抓取某平台已登录账号的创作数据（粉丝/获赞/作品 + 与上次快照的增长）。起 headless 浏览器，数秒。"""
    if platform not in ANALYTICS_PLATFORMS:
        raise HTTPException(404, "该平台暂不支持数据抓取")
    import account_evidence as ae
    evidence_root = OUTPUTS_DIR / "_analytics"
    expected_generation = ae.generation(evidence_root) if platform == "xiaohongshu" else None
    # B站用 cookie 调 API（无浏览器 profile）、公众号走 mp 后台会话（Playwright 拦截数据 XHR，见下），单独分支；其余走 account_stats（Playwright）
    if platform == "bilibili":
        cmd = [sys.executable, str(SHARED_SCRIPTS / "bili_login.py"), "stats",
               "--cookie", str(DATA_DIR / "cookies.json")]
        # 逐篇快照复用 account_stats 的规范化流（bilibili-notes.jsonl），
        # bvid 已作为 note_id 落进 notes；与其它非小红书平台同一契约。
    elif platform == "wechat-oa":
        # 公众号数据走「后台网页端」(mp.weixin.qq.com 管理员会话 + Playwright 拦截数据 XHR)：
        # 开发者 datacube 接口需认证+群发+接口权限，多数号取不到；后台端有登录态即可看到发表记录/数据。
        # 需先扫码登录 mp 后台（weixin_mp_stats.py login）；默认直连，受限网络才需 EASEL_PROXY/https_proxy。
        wx_proxy = os.environ.get("EASEL_PROXY") or os.environ.get("https_proxy") or ""
        cmd = [sys.executable, str(SHARED_SCRIPTS / "weixin_mp_stats.py"), "stats",
               "--proxy", wx_proxy, "--count", "20"]
    else:
        # 代理策略由 account_stats.py 按平台自定（xhs 直连、其它走 env），后端照常传 _proxy_env
        cmd = [sys.executable, str(SHARED_SCRIPTS / "account_stats.py"), "fetch", "--platform", platform]
    ana_env = _proxy_env()
    if platform == "xiaohongshu":
        # Keep persistence in this process so a pending scrape cannot restore cleared/switched data.
        ana_env["EASEL_ANALYTICS_MANAGED"] = "1"
    try:
        proc = await asyncio.to_thread(subprocess.run, cmd, cwd=str(PROJECT_ROOT), env=ana_env,
                                       capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "抓取超时（浏览器起不来或网络慢）")
    data = None
    for line in reversed((proc.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
                break
            except Exception:
                continue
    if isinstance(data, dict):
        if platform != "xiaohongshu":
            if data.get('error') or getattr(proc, 'returncode', 0):
                raise HTTPException(502, '平台数据采集未完成，请检查登录状态、网络或平台页面后重试')
            if not isinstance(data.get('loggedIn'), bool) or not isinstance(data.get('notes', []), list) \
                    or any(not isinstance(note, dict) for note in data.get('notes', [])):
                raise HTTPException(502, '平台返回的数据格式无效，请重新采集')
        if platform == "bilibili":
            if data.get("loggedIn") and not data.get("error"):
                # 与 account_stats fetch 相同的规范化落盘：bvid 作为 note_id 进
                # bilibili-notes.jsonl（缺指标保持 None，不造零），insights 只读这个流。
                import account_stats as stats
                rows = stats.record_note_snapshot(platform, data.get("notes") or [], int(time.time()))
                data["noteSnapshotCount"] = len(rows)
                snapshot = {"ts": int(time.time()), **{key: data.get(key) for key in ("followers", "likes", "posts")}}
                if any(snapshot[key] is not None for key in ("followers", "likes", "posts")):
                    stats.record_snapshot(platform, snapshot)
        if platform == "xiaohongshu":
            if expected_generation != ae.generation(evidence_root):
                raise HTTPException(409, "账号或分析数据已切换，请刷新后重新采集")
            # 抓取失败不是退出登录，也不能把半成品写成一次成功采集。
            if data.get("error") or getattr(proc, "returncode", 0):
                raise HTTPException(502, "采集未完成，已保留原有分析数据；请检查登录状态或网络后重试")
            if not isinstance(data.get("loggedIn"), bool) or not isinstance(data.get("notes"), list) \
                    or any(not isinstance(note, dict) for note in data["notes"]):
                raise HTTPException(502, "采集结果格式无效，已保留原有分析数据，请重试")
            external_id = str(data.get("accountId") or "")
            if data.get("loggedIn") and external_id:
                try:
                    rows = ae.ingest(evidence_root, data.get("notes") or [], external_id, int(time.time()),
                                     source="live", name=data.get("nickname") or "")
                except ValueError as exc:
                    invalidate_account_context(platform)
                    raise HTTPException(502, f"采集数据无法确认归属：{exc}") from exc
                data["noteSnapshotCount"] = len(rows)
                import account_stats as stats
                snapshot = {"ts": int(time.time()), **{key: data.get(key) for key in ("followers", "likes", "posts")}}
                if any(snapshot[key] is not None for key in ("followers", "likes", "posts")):
                    # The standalone script and web share EASEL_DATA_DIR in production.
                    stats.record_snapshot(platform, snapshot)
            else:
                prior_context = ae.context(evidence_root)
                keep_import = not data.get("loggedIn") and (prior_context["account"] or {}).get("source") == "import"
                previous = _last_note_snapshot_at(platform)
                invalidate_account_context(platform, live_only=not data.get("loggedIn"))
                data["lastGoodAt"] = None if keep_import else previous
                data["stale"] = prior_context["stale"] if keep_import else bool(previous)
                data["analysisNote"] = ("平台登录未通过核验，当前展示的手动导入记录已保留；导入账号归属未经平台验证"
                                        if keep_import else "未确认当前账号 ID，历史数据已隔离；重新采集或导入数据后再分析")
            context = ae.context(evidence_root)
            data.update({key: value for key, value in context.items() if key != "stale"})
        # 登录失效时附上次成功时间与过期标记：不拿空列表冒充「没有笔记」
        if data.get("loggedIn") is False and platform != "xiaohongshu":
            prev = _last_note_snapshot_at(platform)
            data["stale"] = bool(prev)
            data["lastGoodAt"] = prev
        data.setdefault("notes", [])
        for n in data.get("notes") or []:
            # 逐篇字段归一（旧字段兼容）：缺指标保持 None，缺 tags/publish 保持空值
            m = n.setdefault("metrics", {})
            if not isinstance(m, dict):
                n["metrics"] = m = {}
            m.setdefault("likes", None)
            m.setdefault("collects", None)
            m.setdefault("comments", None)
            n.setdefault("tags", [])
            n.setdefault("publish", "")
        if platform != 'xiaohongshu':
            from account_analysis import build_analysis
            data['analysis'] = build_analysis(platform, data)
            # 这些旧快照仅按平台存储，无法核验是否同一账号；不能输出本人增长结论。
            data['growth'] = {window: None for window in ('last', 'day', 'week', 'month', 'year')}
        return data
    detail = (proc.stderr or "").strip().splitlines()[-1:] or ["未取到数据"]
    raise HTTPException(502, f"未取到数据（可能未登录或平台改版）：{detail[0][:120]}")


from content_analysis_routes import create_router as _content_analysis_router
from conversation_titles import create_router as _conversation_titles_router

def _content_analysis_session_generation(platform):
    # Collection itself changes the evidence generation; login-session invalidation does not.
    # A successful whoami atomically rewrites ts/message. That is not a new session.
    with _WHOAMI_LOCK:
        generation = _ACCOUNT_GENERATIONS.get(platform, '')
    if platform == 'bilibili':
        # Bilibili's checker never rewrites this credential file; replacing it invalidates cache.
        marker = DATA_DIR / 'cookies.json'
        try:
            info = marker.stat()
            signature = f'{marker.resolve()}:{info.st_ino}:{info.st_mtime_ns}:{info.st_size}'
        except OSError:
            signature = 'missing'
    else:
        marker = LOGIN_DIR / f'{platform}.json'
        try:
            value = json.loads(marker.read_text(encoding='utf-8'))
            if not isinstance(value, dict):
                value = {}
            # No nickname, QR, timestamps, or mtime: none proves a different account.
            identity = {key: value.get(key) for key in
                        ('state', 'accountId', 'externalId', 'sessionId', 'loginGeneration')}
            identity['markerPath'] = str(marker.resolve())
        except (OSError, ValueError):
            identity = {'state': 'missing'}
        profile_name = LOGIN_RUNNERS.get(platform, {}).get('profile')
        profile = BROWSER_PROFILES / profile_name if profile_name else None
        try:
            info = profile.stat() if profile else None
            # Browser reads update the profile's files, but retain the directory identity.
            identity['profile'] = [str(profile.resolve()), info.st_dev, info.st_ino] if info else None
        except OSError:
            identity['profile'] = None
        signature = hashlib.sha256(json.dumps(identity, sort_keys=True).encode('utf-8')).hexdigest()
    return generation + ':' + signature


app.include_router(_content_analysis_router(
    lambda: OUTPUTS_DIR / "_analytics" / "workbench", api_analytics, _image_reverse_providers,
    session_getter=lambda platform: _account_logged_in(platform, LOGIN_RUNNERS[platform])
    and platform not in _ACCOUNT_CLEARING,
    generation_getter=_content_analysis_session_generation))
app.include_router(_conversation_titles_router(_conversation_title_runner))

from storage_location_routes import create_router as _storage_location_router
app.include_router(_storage_location_router(lambda: DATA_DIR))


MEDIA_REQUIRED = {"xiaohongshu", "douyin", "kuaishou", "weixin-channels", "bilibili"}
VIDEO_ONLY_PUBLISH = {"douyin", "weixin-channels", "bilibili"}   # 只能发视频的平台


class PublishRequest(BaseModel):
    title: str = ''
    body: str = ''
    media: list[str] = []
    tags: str = ''


_PUBLISH_LOCK = threading.RLock()
_PUBLISH_ACTIVE: dict[str, str] = {}
# Preserve a known result in the running process if a disk fails after the
# platform has accepted it. Starting a new operation still requires durable IO.
_PUBLISH_VOLATILE: dict[str, dict] = {}
_PUBLISH_VERIFIER: publish_followup.VerificationService | None = None


def _publish_receipt_store() -> publish_receipts.ReceiptStore:
    return publish_receipts.ReceiptStore(PUBLISH_DIR / 'receipts.json')


def _save_publish_receipt(receipt_id: str, changes: dict) -> dict:
    with _PUBLISH_LOCK:
        base = _PUBLISH_VOLATILE.get(receipt_id, {})
        if not base:
            try:
                base = _publish_receipt_store().get(receipt_id) or {}
            except local_records.RecordError:
                pass
        try:
            pending = {**base, **changes} if base.get('storageWarning') else dict(changes)
            pending.pop('storageWarning', None)
            result = _publish_receipt_store().update(receipt_id, pending)
        except (local_records.RecordError, KeyError):
            result = {**base, **changes, 'receiptId': receipt_id,
                      'updatedAt': publish_receipts._now(base.get('updatedAt')),
                      'storageWarning': '发布回执未能保存；请先核对平台结果，避免重复发布。'}
        _PUBLISH_VOLATILE[receipt_id] = result
        return dict(result)


def _begin_publish(platform: str, title: str) -> dict:
    with _PUBLISH_LOCK:
        if platform in _PUBLISH_ACTIVE:
            raise HTTPException(409, '该平台已有发布任务，请先查看现有任务。')
        if platform in _ACCOUNT_CLEARING:
            raise HTTPException(409, '该账号正在退出，请完成后再发布。')
        if _account_browser_busy(platform):
            raise HTTPException(409, '该平台正在登录或核验账号，请等待结束后再发布。')
        try:
            receipt = _publish_receipt_store().create(uuid.uuid4().hex, platform, title)
        except publish_receipts.ActivePublishError as exc:
            raise HTTPException(409, str(exc)) from None
        except local_records.RecordError as exc:
            raise HTTPException(exc.status_code, str(exc)) from None
        _PUBLISH_ACTIVE[platform] = receipt['receiptId']
        _PUBLISH_VOLATILE[receipt['receiptId']] = receipt
        return receipt


def _release_publish(platform: str, receipt_id: str) -> None:
    with _PUBLISH_LOCK:
        if _PUBLISH_ACTIVE.get(platform) == receipt_id:
            _PUBLISH_ACTIVE.pop(platform, None)


def _write_publish_status(status_file: Path, state: str, message: str = '') -> None:
    """Progress only. Platform scripts may replace this with their next state."""
    import tempfile
    temporary = None
    try:
        status_file.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=status_file.parent, suffix='.tmp')
        temporary = Path(name)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump({'state': state, 'message': message, 'ts': int(time.time())},
                      handle, ensure_ascii=False)
        os.replace(temporary, status_file)
        temporary = None
    except OSError:
        pass
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _refresh_publish_receipt(receipt: dict) -> dict:
    if receipt.get('outcome') in publish_receipts.OUTCOMES:
        return receipt
    status_file = PUBLISH_DIR / (receipt['receiptId'] + '.status.json')
    try:
        progress = json.loads(status_file.read_text(encoding='utf-8'))
        if (isinstance(progress, dict) and isinstance(progress.get('state'), str)
                and progress['state'] in publish_receipts.PROGRESS_STATES):
            return {**receipt, 'state': progress['state'],
                    'message': str(progress.get('message') or receipt['message'])[:600]}
    except (OSError, ValueError):
        pass
    # A script's "success" state is not a publication receipt. Keep waiting for
    # the runner to validate stdout and persist its actual terminal outcome.
    return receipt


def _get_publish_receipt(receipt_id: str) -> dict:
    if not publish_receipts.RECEIPT_ID.fullmatch(receipt_id):
        raise HTTPException(404, '发布回执不存在')
    cached = _PUBLISH_VOLATILE.get(receipt_id)
    if cached and cached.get('storageWarning'):
        return _refresh_publish_receipt(dict(cached))
    try:
        receipt = _publish_receipt_store().get(receipt_id)
    except local_records.RecordError as exc:
        if cached:
            return _refresh_publish_receipt({**cached, 'storageWarning':
                '发布回执文件读取失败，当前显示本次运行的缓存结果；请检查保存目录。'})
        raise HTTPException(exc.status_code, str(exc)) from None
    if receipt is None:
        raise HTTPException(404, '发布回执不存在')
    with _PUBLISH_LOCK:
        _PUBLISH_VOLATILE.setdefault(receipt_id, dict(receipt))
    return _refresh_publish_receipt(receipt)


def _recent_publish_receipts(limit: int = 50) -> list[dict]:
    with _PUBLISH_LOCK:
        cached = {key: dict(value) for key, value in _PUBLISH_VOLATILE.items()}
        read_warning = ''
        try:
            receipts = _publish_receipt_store().recent(limit)
        except local_records.RecordError as exc:
            if not cached:
                raise HTTPException(exc.status_code, str(exc)) from None
            receipts = []
            read_warning = '发布回执文件读取失败，当前仅显示本次运行的缓存结果，历史可能不完整；请检查保存目录。'
        combined = {item['receiptId']: item for item in receipts}
        for receipt_id, item in cached.items():
            saved = combined.get(receipt_id)
            if (saved is None or item.get('storageWarning')
                    or str(item.get('updatedAt', '')) >= str(saved.get('updatedAt', ''))):
                combined[receipt_id] = item
        ordered = sorted(combined.values(), key=lambda item: str(item.get('updatedAt') or item.get('createdAt') or ''), reverse=True)
        selected = ordered[:max(1, min(200, limit))]
        selected_ids = {item['receiptId'] for item in selected}
        selected += [item for item in ordered if item.get('outcome') not in publish_receipts.OUTCOMES
                     and item['receiptId'] not in selected_ids]
        if read_warning:
            selected = [{**item, 'storageWarning': '\n'.join(filter(None, [
                item.get('storageWarning'), read_warning]))} for item in selected]
    return [_refresh_publish_receipt(item) for item in selected]


def _awaiting_publish_verification() -> list[dict]:
    with _PUBLISH_LOCK:
        items = _publish_receipt_store().awaiting_verification()
        return [{**item, **_PUBLISH_VOLATILE.get(item['receiptId'], {})} for item in items]


def _acquire_publish_verification(platform: str, receipt_id: str) -> bool:
    with _PUBLISH_LOCK:
        if (platform in _PUBLISH_ACTIVE or platform in _ACCOUNT_CLEARING
                or _account_browser_busy(platform)):
            return False
        _PUBLISH_ACTIVE[platform] = receipt_id
        return True


def _run_publish_verification(receipt: dict, stop_event) -> dict:
    command = publish_followup.verification_command(
        receipt, python=sys.executable, root=PROJECT_ROOT, data_dir=DATA_DIR)
    env = _publish_env()
    env['EASEL_PUBLISH_RECEIPT_ID'] = receipt['receiptId']
    env['EASEL_CALENDAR_AUTORECORD'] = '0'
    process = publish_followup.run_process(command, cwd=PROJECT_ROOT, env=env, stop_event=stop_event)
    return publish_receipts.parse_result(receipt['platform'], receipt['receiptId'],
                                         process.stdout, process.returncode)


def _publish_verification_service() -> publish_followup.VerificationService:
    global _PUBLISH_VERIFIER
    with _PUBLISH_LOCK:
        if _PUBLISH_VERIFIER is None:
            _PUBLISH_VERIFIER = publish_followup.VerificationService(
                list_items=_awaiting_publish_verification, get_item=_get_publish_receipt,
                save_item=_save_publish_receipt, acquire=_acquire_publish_verification,
                release=_release_publish, run_check=_run_publish_verification,
                on_confirmed=_complete_publish_receipt)
        return _PUBLISH_VERIFIER


@app.get("/api/publish/receipts")
async def api_publish_receipts(limit: int = 50):
    return _recent_publish_receipts(limit)


@app.get("/api/publish/receipts/{receipt_id}")
async def api_publish_receipt(receipt_id: str):
    return _get_publish_receipt(receipt_id)


class PublishVerificationRequest(BaseModel):
    automatic: bool


@app.post("/api/publish/receipts/{receipt_id}/verify")
async def api_verify_publish_receipt(receipt_id: str):
    try:
        return _publish_verification_service().request(receipt_id)
    except publish_followup.VerificationError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None


@app.post("/api/publish/receipts/{receipt_id}/verification")
async def api_set_publish_verification(receipt_id: str, req: PublishVerificationRequest):
    try:
        return _publish_verification_service().request(receipt_id, automatic=req.automatic)
    except publish_followup.VerificationError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None


def _read_publish_status(platform: str) -> dict:
    """Legacy platform polling reads the newest durable receipt, not stale JSON."""
    receipt = next((item for item in _recent_publish_receipts(200)
                    if item['platform'] == platform), None)
    return _refresh_publish_receipt(receipt) if receipt else {'state': 'unknown', 'message': ''}


def _finish_publish(platform: str, receipt_id: str, title: str, body: str, cfg: dict,
                    out: str, returncode: int | None, failure_message: str = '') -> dict:
    result = publish_receipts.parse_result(platform, receipt_id, out, returncode,
                                          failure_message=failure_message)
    result['notification'] = {'state': 'skipped', 'message': '仅在平台确认公开发布后发送成功提醒。'}
    result['summary'] = body[:300]
    result['submissionFinishedAt'] = publish_receipts._now()
    result['completionPending'] = result['outcome'] == 'published'
    result['verification'] = publish_followup.initial_verification({**_get_publish_receipt(receipt_id), **result})
    receipt = _save_publish_receipt(receipt_id, result)
    if result['outcome'] != 'published':
        return receipt
    return _complete_publish_receipt(receipt)


def _complete_publish_receipt(receipt: dict) -> dict:
    """Claim effects durably before sending: verification cannot resend mail."""
    receipt_id = receipt['receiptId']
    with _PUBLISH_LOCK:
        receipt = _get_publish_receipt(receipt_id)
        if receipt.get('outcome') != 'published' or receipt.get('completionHandled'):
            return receipt
        receipt = _save_publish_receipt(receipt_id, {
            'completionHandled': True, 'completionPending': False,
            'notification': {'state': 'queued', 'message': '正在处理成功提醒，邮件投递结果尚未确认。'}})
        if receipt.get('outcome') != 'published':
            return receipt
        if receipt.get('storageWarning'):
            return _save_publish_receipt(receipt_id, {'notification': {
                'state': 'failed', 'message': '提醒状态无法保存，本次未发送邮件；请检查数据目录。'}})
    title, body = receipt['title'], receipt.get('summary') or ''
    cfg = LOGIN_RUNNERS[receipt['platform']]

    calendar_warning = _record_published_schedule(title, body, cfg['name'],
                                                   url=receipt['url'], receipt_id=receipt_id)
    if calendar_warning:
        receipt = _save_publish_receipt(receipt_id, {
            'message': receipt['message'] + '\n' + calendar_warning})
    notified = []
    def notification_changed(notification):
        if isinstance(notification, dict) and notification.get('state') in {
                'unconfigured', 'queued', 'sent', 'failed', 'skipped'}:
            notified.append(True)
            _save_publish_receipt(receipt_id, {'notification': notification})
    if _notify_email_completion is None:
        notification_changed({'state': 'skipped', 'message': '邮箱通知模块不可用。'})
    else:
        try:
            state = _notify_email_completion(
                title=title, platform=cfg['name'], summary=body[:300], source='publish',
                url=receipt['url'], receipt_id=receipt_id, outcome='published',
                on_result=notification_changed)
            if not notified:
                valid_state = isinstance(state, dict) and state.get('state') in {
                    'unconfigured', 'queued', 'sent', 'failed', 'skipped'}
                notification_changed(state if valid_state else {
                    'state': 'skipped', 'message': '旧版通知模块未提供发送回执，邮件结果未确认。'})
        except Exception:
            notification_changed({'state': 'failed', 'message': '邮件提醒未能启动，请检查通知设置。'})
    return dict(_PUBLISH_VOLATILE.get(receipt_id, receipt))


def _run_publish_job(platform: str, cmd: list, title: str, body: str, cfg: dict,
                     status_file: Path, code_file: Path, receipt_id: str,
                     timeout: int = 600) -> dict:
    out = err = ''
    returncode = None
    failure_message = ''
    try:
        try:
            env = _proxy_env() if platform == 'wechat-oa' else _publish_env()
            env['EASEL_PUBLISH_RECEIPT_ID'] = receipt_id
            # Calendar writes happen only after receipt validation in Web.
            env['EASEL_CALENDAR_AUTORECORD'] = '0'
            proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT), env=env,
                                  capture_output=True, text=True, encoding='utf-8',
                                  errors='replace', timeout=timeout)
            out, err, returncode = proc.stdout or '', proc.stderr or '', proc.returncode
        except subprocess.TimeoutExpired as exc:
            out = exc.stdout or ''
            if isinstance(out, bytes):
                out = out.decode('utf-8', errors='replace')
            err = '发布进程超时'
            failure_message = '发布等待超时，平台结果尚未核实；请先到平台查看，避免重复发布。'
        except Exception as exc:
            returncode = -1
            err = f'发布进程异常：{type(exc).__name__}'
            failure_message = '发布进程未能正常执行，请检查运行环境和本地发布日志。'
        try:
            OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
            with (OUTPUTS_DIR / '_publish.log').open('a', encoding='utf-8') as handle:
                handle.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} "
                             f"{platform} receipt={receipt_id} rc={returncode} =====\n")
                handle.write('STDOUT:\n' + out[-4000:] + '\nSTDERR:\n' + err[-2000:] + '\n')
        except OSError:
            pass
        return _finish_publish(platform, receipt_id, title, body, cfg, out, returncode,
                               failure_message)
    finally:
        try:
            code_file.unlink(missing_ok=True)
        except OSError:
            pass
        _release_publish(platform, receipt_id)


def _run_publish_bg(platform: str, cmd: list, title: str, body: str, cfg: dict,
                    status_file: Path, code_file: Path, receipt_id: str) -> None:
    _run_publish_job(platform, cmd, title, body, cfg, status_file, code_file,
                     receipt_id, timeout=900)


def _start_async_publish(platform: str, cmd: list, title: str, body: str, cfg: dict,
                         status_file: Path, code_file: Path, receipt_id: str) -> dict:
    _write_publish_status(status_file, 'starting', '发布处理中；如需短信验证会在此显示。')
    try:
        threading.Thread(target=_run_publish_bg,
                         args=(platform, cmd, title, body, cfg, status_file, code_file, receipt_id),
                         daemon=True, name=f'easel-publish-{platform}').start()
    except Exception:
        _finish_publish(platform, receipt_id, title, body, cfg, '', -1, '发布任务未能启动。')
        _release_publish(platform, receipt_id)
        raise HTTPException(503, '发布任务未能启动，请稍后重试。') from None
    return {'async': True, 'pending': True, 'receiptId': receipt_id,
            'state': 'starting', 'outcome': None, 'message': '发布已启动，请等待平台回执。'}


@app.get("/api/publish/{platform}/status")
async def api_publish_status(platform: str):
    if platform not in LOGIN_RUNNERS:
        raise HTTPException(404, '未知平台')
    return {'mode': 'publish', **_read_publish_status(platform)}


class PublishSmsRequest(BaseModel):
    code: str
    receiptId: str = ''


@app.post("/api/publish/{platform}/sms")
async def api_publish_sms(platform: str, req: PublishSmsRequest):
    if platform not in LOGIN_RUNNERS:
        raise HTTPException(404, '未知平台')
    with _PUBLISH_LOCK:
        receipt_id = _PUBLISH_ACTIVE.get(platform)
        if not receipt_id or (req.receiptId and req.receiptId != receipt_id):
            raise HTTPException(409, '对应发布任务已结束或已变化，请刷新任务状态。')
        if _get_publish_receipt(receipt_id).get('state') != 'sms_required':
            raise HTTPException(409, '该发布任务当前不需要短信验证码。')
        code = ''.join(ch for ch in (req.code or '') if ch.isascii() and ch.isdigit())
        if not (4 <= len(code) <= 8):
            raise HTTPException(400, '验证码应为 4-8 位数字')
        code_file = PUBLISH_DIR / (receipt_id + '.code')
        if code_file.is_symlink():
            raise HTTPException(503, '验证码文件不可写，请检查保存目录。')
        try:
            code_file.write_text(code, encoding='utf-8')
        except OSError:
            raise HTTPException(503, '验证码未保存，请检查保存目录后重试。') from None
    return {'ok': True, 'receiptId': receipt_id}


@app.post("/api/publish/{platform}")
async def api_publish(platform: str, req: PublishRequest):
    """Run an explicitly requested publication and retain its platform receipt."""
    cfg = LOGIN_RUNNERS.get(platform)
    if not cfg:
        raise HTTPException(404, '未知平台')
    if cfg['backend'] == 'unsupported':
        raise HTTPException(400, f"{cfg['name']} 暂不支持一键发布")
    if not req.title.strip() and not req.body.strip():
        raise HTTPException(400, '标题/正文不能为空')
    imgs, vids = [], []
    for rel in req.media or []:
        full = _safe_output_path(rel)
        if full.suffix.lower() in VIDEO_EXTS:
            vids.append(str(full))
        elif full.suffix.lower() in IMAGE_EXTS:
            imgs.append(str(full))
    if platform in MEDIA_REQUIRED and not imgs and not vids:
        raise HTTPException(400, f"{cfg['name']} 需附带图片或视频")
    if imgs and vids:
        raise HTTPException(400, '同一条内容不能同时发图片和视频，请二选一')
    if platform in VIDEO_ONLY_PUBLISH and not vids:
        raise HTTPException(400, f"{cfg['name']} 只能发视频，请附带一个视频文件")
    if platform == 'wechat-oa':
        if _mp_login_status().get('state') != 'success':
            raise HTTPException(400, '公众号后台未登录：请先在账号页点「登录公众号后台」扫码')
        if not imgs or vids:
            raise HTTPException(400, '公众号文章需要封面图，请附带图片而非视频')
    title = req.title.strip() or req.body.strip()[:20]
    tags = req.tags or ''
    py = sys.executable
    receipt = _begin_publish(platform, title)
    receipt_id = receipt['receiptId']
    status_file = PUBLISH_DIR / (receipt_id + '.status.json')
    code_file = PUBLISH_DIR / (receipt_id + '.code')
    try:
        if platform == 'xiaohongshu':
            base = [py, '-X', 'utf8', str(SHARED_SCRIPTS / 'xhs_publish.py')]
            cmd = base + ['publish-video', '--no-proxy', '--video', vids[0]] if vids else base + ['publish', '--no-proxy', '--images', ','.join(imgs)]
            cmd += ['--title', title, '--content', req.body, '--tags', tags, '--exec']
        elif platform == 'bilibili':
            bili_tag = tags.replace('#', '').replace('，', ',').strip().strip(',') or '日常'
            cmd = [py, '-X', 'utf8', str(PROJECT_ROOT / 'skills' / 'openclaw' / 'skill-bilibili-upload'
                           / 'scripts' / 'bili_upload.py'), 'upload', '--video', vids[0],
                   '--title', title[:80], '--tid', '36', '--copyright', '1', '--tag', bili_tag,
                   '--cookie', str(DATA_DIR / 'cookies.json'), '--exec']
            if req.body.strip():
                cmd += ['--desc', req.body[:2000]]
        elif platform == 'douyin':
            base = [py, '-X', 'utf8', str(SHARED_SCRIPTS / 'douyin_publish.py')]
            cmd = base + ['publish-video', '--no-proxy', '--video', vids[0]] if vids else base + ['publish', '--no-proxy', '--images', ','.join(imgs)]
            cmd += ['--title', title, '--content', req.body, '--tags', tags, '--exec',
                    '--status-file', str(status_file), '--sms-code-file', str(code_file)]
        elif platform == 'wechat-oa':
            # This platform endpoint creates a draft. The resulting receipt
            # must retain that outcome instead of calling it a publication.
            md_path = PUBLISH_DIR / f'wechat-oa-{receipt_id}.md'
            html_path = PUBLISH_DIR / f'wechat-oa-{receipt_id}.html'
            body_md = req.body or ''
            if imgs[1:]:
                body_md += "\n\n" + "\n\n".join(f'![]({path})' for path in imgs[1:])
            md_path.write_text(f"# {title}\n\n{body_md}\n", encoding='utf-8')
            conv = await asyncio.to_thread(
                subprocess.run, [py, '-X', 'utf8', str(WECHAT_SKILL_SCRIPTS / 'html_converter.py'),
                                 str(md_path), '-o', str(html_path)],
                cwd=str(PROJECT_ROOT), env=_proxy_env(), capture_output=True,
                text=True, encoding='utf-8', errors='replace', timeout=60)
            if conv.returncode != 0 or not html_path.is_file():
                raise HTTPException(500, '公众号排版失败，请检查正文、图片和本地日志。')
            wx_proxy = os.environ.get('EASEL_PROXY') or os.environ.get('https_proxy') or ''
            cmd = [py, '-X', 'utf8', str(SHARED_SCRIPTS / 'weixin_mp_stats.py'), 'publish', '--proxy', wx_proxy,
                   '--html', str(html_path), '--cover', imgs[0], '--title', title,
                   '--digest', (req.body or '').strip()[:100], '--author', '']
        else:
            cmd = [py, '-X', 'utf8', str(SHARED_SCRIPTS / 'web_publisher.py'), 'publish',
                   '--platform', cfg['wp'], '--title', title, '--desc', req.body,
                   '--tags', tags, '--exec']
            media = vids[0] if vids else (imgs[0] if imgs else None)
            if media:
                cmd += ['--media', media]
        if platform == 'douyin':
            return _start_async_publish(platform, cmd, title, req.body, cfg,
                                         status_file, code_file, receipt_id)
        _write_publish_status(status_file, 'starting', '正在等待平台处理和回执。')
    except BaseException:
        _finish_publish(platform, receipt_id, title, req.body, cfg, '', -1,
                        '发布准备未完成，内容尚未交给平台发布。')
        _release_publish(platform, receipt_id)
        raise
    # The worker owns finalization and cleanup, even if an HTTP client leaves
    # while awaiting it. A disconnect must never unlock an active publication.
    return await asyncio.shield(asyncio.to_thread(
        _run_publish_job, platform, cmd, title, req.body, cfg, status_file, code_file, receipt_id))


class ProfileBuildRequest(BaseModel):
    name: str
    form: dict


@app.post("/api/profile/build")
async def api_profile_build(req: ProfileBuildRequest):
    """首次引导：表单 → 写基线画像（确定性，秒可用）→ **后台**跑 agent 分析社媒链接增强。

    改异步：立即返回（基线已写、画像即可用），避免 agent 增强(~2min)阻塞请求被 code-server
    代理超时掐断（前端曾因此报 API 400）。前端轮询 /api/profile/build/status/{name} 看增强进度。
    """
    name = (req.name or '').strip()  # 自动去掉首尾空格
    if not name:
        raise HTTPException(400, '画像名不能为空（去掉首尾空格后为空，请输入有效名称）')
    if '/' in name or '\\' in name:
        raise HTTPException(400, '画像名不能包含 / 或 \\ 字符，请改掉后重试')
    if name.startswith(('.', '_')):
        raise HTTPException(400, '画像名不能以 . 或 _ 开头，请换个开头')
    pd = PROFILES_DIR / name
    if pd.exists():
        raise HTTPException(409, f'画像「{name}」已存在，请换一个名字')
    _write_baseline_profile(name, req.form or {})
    instruction = _form_to_instruction(name, req.form or {})
    msg = (f"请执行 /skill-profile-builder 完善已存在的画像「{name}」。用户已通过表单提供以下信息，我已按此写好 profiles/{name}"
           f"/ 的基线六维文件。请：①尽力抓取用户给的社媒链接分析已发内容/风格/受众（抓不到就降级，标注[待补充]，勿臆造）②据分析结果润色/补全各维度文件 ③给出一句话完成度摘要。表单信息如下：\n\n{instruction}")

    _write_profile_status(name, 'running', 'AI 正在分析并增强画像…')

    def _enhance() -> None:
        try:
            log = run_agent_sync(msg, TIMEOUT_PRODUCE)
            _write_profile_status(name, 'done', log)
        except Exception as e:  # noqa: BLE001
            _write_profile_status(name, 'failed', f'AI 增强失败（基线画像已可用）：{e}')

    threading.Thread(target=_enhance, daemon=True).start()
    # 基线已写、画像立即可用；增强在后台，前端轮询状态
    return {'created': pd.is_dir(), 'name': name, 'async': True, 'status': 'running'}


def _profile_status_file(name: str) -> Path:
    return PROFILE_BUILD_DIR / f'{name}.json'


def _write_profile_status(name: str, state: str, log: str = '') -> None:
    """原子写画像增强状态。"""
    try:
        PROFILE_BUILD_DIR.mkdir(parents=True, exist_ok=True)
        f = _profile_status_file(name)
        tmp = f.with_suffix('.tmp')
        tmp.write_text(json.dumps({'state': state, 'log': log, 'ts': int(time.time())},
                                  ensure_ascii=False), encoding='utf-8')
        os.replace(tmp, f)
    except Exception:
        pass


@app.get("/api/profile/build/status/{name}")
async def api_profile_build_status(name: str):
    """查画像增强进度：running / done / failed / unknown。"""
    f = _profile_status_file(name)
    if f.is_file():
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
            return {'state': d.get('state', 'unknown'), 'log': d.get('log', '')}
        except Exception:
            pass
    return {'state': 'unknown', 'log': ''}


def _form_to_instruction(name: str, form: dict) -> str:
    def g(k: str, default: str = '（未填）') -> str:
        v = form.get(k)
        if isinstance(v, list):
            return '、'.join(str(x) for x in v) if v else default
        return str(v).strip() if v not in (None, '') else default
    links = form.get('links') or {}
    links_txt = '\n'.join(f'  - {p}: {u}' for p, u in links.items() if u) or '  （未提供）'
    return (f"画像名：{name}\n运营平台：{g('platforms')}\n起号状态：{g('accountStage')}"
            f"\n社媒主页链接：\n{links_txt}\n想做的方向：{g('direction')}"
            f"\n为什么做/我的优势：{g('reason')}\n运营目标：{g('goal')}"
            f"\n想产出的形式：{g('formats')}\n喜欢看的内容/对标账号：{g('likes')}"
            f"\n期望调性：{g('tone')}\n不做的内容/红线：{g('avoid')}\n")


def _write_baseline_profile(name: str, form: dict) -> None:
    """从表单确定性生成六维基线文件。链接派生字段标 [待 AI 分析]。"""
    pd = PROFILES_DIR / name
    pd.mkdir(parents=True, exist_ok=True)

    def g(k: str, default: str = '') -> str:
        v = form.get(k)
        if isinstance(v, list):
            return '、'.join(str(x) for x in v)
        return str(v).strip() if v not in (None, '') else default
    direction = g('direction') or '[待补充]'
    reason = g('reason') or '[待补充]'
    goal = g('goal')
    formats = g('formats')
    tone = g('tone') or '[待分析]'
    likes = g('likes')
    avoid = g('avoid')
    platforms = form.get('platforms') or []
    links = form.get('links') or {}
    (pd / 'identity.md').write_text(
        f"# 身份定位\n\n## 我是谁\n\n{direction}\n\n## 差异化\n\n{reason}\n\n## 内容方向\n\n{direction}"
        f"{'（形式：' + formats + '）' if formats else ''}\n"
        f"{'运营目标：' + goal if goal else ''}\n",
        encoding='utf-8')
    (pd / 'style.md').write_text(
        f"# 内容风格\n\n## 语气\n\n{tone}\n\n## 开头结构\n\n[待 AI 分析已发内容]\n\n## 视觉风格\n\n[待 AI 分析]\n\n## 内容节奏\n\n{formats or '[待补充]'}\n\n## 标志性元素\n\n[待 AI 分析]\n",
        encoding='utf-8')
    (pd / 'audience.md').write_text(
        '# 目标受众\n\n## 核心人群\n\n[待 AI 分析/待补充]\n\n## 兴趣标签\n\n[待补充]\n\n## 痛点\n\n[待补充]\n\n## 互动特征\n\n[待 AI 分析已发内容]\n',
        encoding='utf-8')
    plat_lines = []
    for p in platforms:
        url = links.get(p, '')
        plat_lines.append(f"## {p}\n\n主页：{url or '[待补充]'}\n粉丝量级 / 内容形式：[待补充]\n")
    (pd / 'platforms.md').write_text(
        '# 平台运营\n\n' + ('\n'.join(plat_lines) if plat_lines else '[待补充]\n'),
        encoding='utf-8')
    (pd / 'preferences.md').write_text(
        f"# 偏好与红线\n\n## 要做的\n\n{direction}\n\n## 不做的\n\n{avoid or '[待补充]'}\n\n## 合规底线\n\n{avoid or '[待补充]'}\n",
        encoding='utf-8')
    (pd / 'memory.md').write_text(
        f"# 经验沉淀\n\n## 内容洞察\n\n{'喜欢的内容/对标：' + likes if likes else '[待 AI 分析已收藏/点赞]'}\n\n## 踩过的坑\n\n[待积累]\n",
        encoding='utf-8')


@app.delete("/api/session/{session_key}")
async def api_delete_session(session_key: str):
    """删除 OpenClaw 本地的 session 记录。"""
    sessions_file = openclaw_state_dir() / 'agents' / 'main' / 'sessions' / 'sessions.json'
    if not sessions_file.is_file():
        return {'deleted': False, 'reason': 'sessions file not found'}
    data = json.loads(sessions_file.read_text(encoding="utf-8"))
    full_key = f'agent:main:{session_key}' if not session_key.startswith('agent:') else session_key
    for key in (full_key, session_key):
        if key in data:
            del data[key]
            sessions_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return {'deleted': True}
    return {'deleted': False, 'reason': 'session not found'}


@app.get("/api/trends")
async def api_trends(platforms: str = "weibo,douyin,zhihu", limit: int = 12, refresh: bool = False):
    from trend_sources import fetch_trends
    return await fetch_trends(platforms, limit, refresh)


SCHEDULE_FILE = OUTPUTS_DIR / "_schedule.json"
SCHEDULE_STATUSES = {"idea", "draft", "scheduled", "published"}
SCHEDULE_KINDS = {"content", "event"}


def _read_schedule() -> list[dict]:
    try:
        return local_records.read(SCHEDULE_FILE, '排期')
    except local_records.RecordError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None


def _write_schedule(items: list[dict]) -> None:
    try:
        local_records.write(SCHEDULE_FILE, items, '排期')
    except local_records.RecordError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None


def _record_published_schedule(title: str, body: str, platform: str,
                               url: str = '', receipt_id: str = '') -> str:
    """Keep a completed publish successful, but make failed calendar saving visible."""
    try:
        items = _read_schedule()
        if receipt_id and any(item.get('receiptId') == receipt_id for item in items):
            return ''
        items.append({'id': uuid.uuid4().hex[:12], 'title': title,
                      'date': time.strftime('%Y-%m-%d'), 'platform': platform,
                      'time': time.strftime('%H:%M'), 'status': 'published', 'note': body[:200],
                      'kind': 'content', 'source': 'publish-page', 'url': url,
                      'receiptId': receipt_id})
        _write_schedule(items)
    except HTTPException as exc:
        return f'发布已完成，但排期记录未保存：{exc.detail}'
    return ''


class ScheduleItem(BaseModel):
    title: str
    date: str
    platform: str = ""
    time: str = ""
    status: str = "idea"
    note: str = ""
    kind: str = "content"          # content（内容/发布）| event（平台活动/节日/特殊日期）
    url: str = ""                  # 已发布内容链接（可选）
    source: str = "manual"         # manual | publish-page | chat | scheduler
    event_type: str = ""           # event 专属：节日/电商/平台活动/行业
    end_date: str = ""             # event 专属：活动区间结束日


@app.get("/api/schedule")
async def api_schedule_list():
    return _read_schedule()


@app.post("/api/schedule")
async def api_schedule_create(req: ScheduleItem):
    items = _read_schedule()
    kind = req.kind if req.kind in SCHEDULE_KINDS else "content"
    st = req.status if req.status in SCHEDULE_STATUSES else "idea"
    item = {
        "id": uuid.uuid4().hex[:12],
        "title": req.title.strip() or ("未命名活动" if kind == "event" else "未命名"),
        "date": req.date,
        "platform": req.platform,
        "time": req.time,
        "status": st,
        "note": req.note,
        "kind": kind,
        "url": req.url,
        "source": req.source if req.source in {"manual", "publish-page", "chat", "scheduler"} else "manual",
        "event_type": req.event_type,
        "end_date": req.end_date,
    }
    items.append(item)
    _write_schedule(items)
    return item


@app.put("/api/schedule/{sid}")
async def api_schedule_update(sid: str, req: ScheduleItem):
    items = _read_schedule()
    for it in items:
        if it.get("id") == sid:
            kind = req.kind if req.kind in SCHEDULE_KINDS else it.get("kind", "content")
            it.update({
                "title": req.title.strip() or it.get("title", "未命名"),
                "date": req.date,
                "platform": req.platform,
                "time": req.time,
                "status": req.status if req.status in SCHEDULE_STATUSES else it.get("status", "idea"),
                "note": req.note,
                "kind": kind,
                "url": req.url,
                "event_type": req.event_type,
                "end_date": req.end_date,
            })
            _write_schedule(items)
            return it
    raise HTTPException(404, "排期不存在")


@app.delete("/api/schedule/{sid}")
async def api_schedule_delete(sid: str):
    items = _read_schedule()
    new = [it for it in items if it.get("id") != sid]
    if len(new) == len(items):
        raise HTTPException(404, "排期不存在")
    items[:] = new
    _write_schedule(items)
    return {"ok": True, "deleted": sid}


@app.get("/api/schedule/context")
async def api_schedule_context(days: int = 14):
    """规划摘要（发布节奏/断更缺口 + 待发排期 + 临近节点 + 建议）——薄封装 calendar_ops，
    前端页头「近期节点/建议」与 Agent 读回共用同一逻辑，失败明确报错。"""
    cmd = [sys.executable, str(SHARED_SCRIPTS / "calendar_ops.py"),
           "--data", str(SCHEDULE_FILE), "context", "--days", str(max(1, min(days, 90)))]
    try:
        proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT), env=_proxy_env(),
                              capture_output=True, text=True, timeout=20)
        if proc.returncode == 0 and proc.stdout.strip():
            value = json.loads(proc.stdout)
            if isinstance(value, dict):
                return value
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    raise HTTPException(503, '排期摘要读取失败；请检查排期文件和运行环境后重试。')


IDEAS_FILE = OUTPUTS_DIR / "_ideas.json"
IDEA_STATUSES = {"pending", "doing", "done"}


# ── AI 生图直通车（工作台「生图工坊」用） ──────────────────────────────
# 走 skills/shared/scripts/ai_image.py（OpenAI 协议 /images/generations + apimart 异步轮询），
# 配置只认 .env 的 IMG_BASE_URL / IMG_MODEL / IMG_API_KEY（生图专用通道，不借聊天的 OPENAI_*，
# 避免把 chat 中转误当生图端点）。聚合站生成可能要几分钟 → 任务化：POST 起线程，GET 轮询。
IMAGEGEN_DIR = OUTPUTS_DIR / "AI生图"
IMAGEGEN_INPUT_DIR = OUTPUTS_DIR / "_image_references"
_IMAGEGEN_JOBS: dict[str, dict] = {}
_IMAGEGEN_TIMEOUT = 900   # 秒；聚合站实测单张可到分钟级
_IMAGEGEN_SIZES = {
    "auto",
    "1024x1024", "768x1024", "1024x768", "864x1536", "1536x864",
    "1024x1280", "1280x1024", "1024x1536", "1536x1024",
}
_IMAGEGEN_EXTS = {".png", ".jpg", ".jpeg", ".webp"}

# The video tab shares uploaded references, settings and the content library.
from videogen import VideoService, create_router as _videogen_router
_VIDEO_SERVICE = VideoService(PROJECT_ROOT, lambda: OUTPUTS_DIR, lambda: IMAGEGEN_INPUT_DIR,
                              _read_env, _proxy_env)
app.include_router(_videogen_router(_VIDEO_SERVICE))


def _imagegen_dimensions(path: Path) -> dict[str, int]:
    """Expose actual image dimensions without resizing or assuming the provider obeyed size."""
    from PIL import Image
    try:
        with Image.open(path) as image:
            return {"width": image.width, "height": image.height}
    except (OSError, ValueError):
        return {}


def _imagegen_metadata_path(path: Path) -> Path:
    return path.with_name(f'.{path.name}.easel-image.json')


def _read_imagegen_metadata(path: Path) -> dict:
    """Older images remain browsable even when no generation metadata was saved."""
    try:
        data = json.loads(_imagegen_metadata_path(path).read_text(encoding='utf-8'))
        if not isinstance(data, dict) or not isinstance(data.get('prompt'), str):
            return {}
        result = {'prompt': data['prompt'][:2000]}
        for key in ('size', 'model', 'jobId', 'mode', 'referenceId', 'maskId'):
            if isinstance(data.get(key), str):
                result[key] = data[key][:200]
        if isinstance(data.get('created'), (int, float)):
            result['created'] = data['created']
        return result
    except (OSError, ValueError, TypeError):
        return {}


def _imagegen_channel_ready() -> tuple[bool, str]:
    env = _read_env()
    base = env.get("IMG_BASE_URL", "").strip()
    key = env.get("IMG_API_KEY", "").strip()
    model = env.get("IMG_MODEL", "").strip()
    if not base or not key or not model:
        return False, "生图通道未配置：请在「设置 → 生图通道」填 IMG_BASE_URL / IMG_API_KEY / IMG_MODEL"
    return True, ""


class ImagegenRequest(BaseModel):
    prompt: str
    size: str = "1024x1024"
    n: int = 1
    mode: str = "text2img"
    referenceId: str | None = None
    maskId: str | None = None
    model: str | None = None


@app.post("/api/imagegen/references")
async def api_imagegen_reference(file: UploadFile = File(...)):
    from image_inputs import MAX_BYTES, store_reference
    try:
        data = await file.read(MAX_BYTES + 1)
        return await asyncio.to_thread(store_reference, IMAGEGEN_INPUT_DIR, data, file.filename or "参考图")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        await file.close()


@app.get("/api/imagegen/references/{reference_id}")
async def api_imagegen_reference_file(reference_id: str):
    from image_inputs import reference_path
    try:
        path = reference_path(IMAGEGEN_INPUT_DIR, reference_id)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/api/imagegen")
async def api_imagegen_start(req: ImagegenRequest):
    """发起文生图或参考图编辑任务，沿用同一任务/图库持久化链路。"""
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt 不能为空")
    if len(prompt) > 2000:
        raise HTTPException(400, "prompt 过长（≤2000 字）")
    size = req.size.strip().lower()
    if size not in _IMAGEGEN_SIZES:
        raise HTTPException(400, "不支持的画面尺寸，请从生图工坊的画面比例中选择")
    if req.mode not in {"text2img", "img2img"}:
        raise HTTPException(400, "不支持的生图模式")
    channel_env = _read_env()
    model = (req.model if req.model is not None else channel_env.get("IMG_MODEL", "")).strip()
    reference = mask = None
    if req.mode == "text2img" and (req.referenceId or req.maskId):
        raise HTTPException(400, "使用参考图时请选择图生图模式")
    if req.mode == "img2img":
        from image_inputs import reference_path, validate_mask
        try:
            reference = reference_path(IMAGEGEN_INPUT_DIR, req.referenceId)
            if req.maskId:
                mask = reference_path(IMAGEGEN_INPUT_DIR, req.maskId)
                validate_mask(reference, mask)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(400, str(exc)) from exc
        if mask and "apimart" in _read_env().get("IMG_BASE_URL", "").lower():
            raise HTTPException(400, "当前异步生图通道不支持蒙版局部编辑；请移除蒙版或切换支持 Images edits 的服务")
    ok, hint = _imagegen_channel_ready()
    if not ok:
        raise HTTPException(400, hint)
    if not model or len(model) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in model):
        raise HTTPException(400, "请填写 1–200 个字符的有效生图模型名称")
    job_id = uuid.uuid4().hex[:12]
    # 任务表容量护栏：只留最近 40 条
    if len(_IMAGEGEN_JOBS) >= 40:
        for k, _ in sorted(_IMAGEGEN_JOBS.items(), key=lambda kv: kv[1].get("started", 0))[:20]:
            _IMAGEGEN_JOBS.pop(k, None)
    _IMAGEGEN_JOBS[job_id] = {
        "jobId": job_id, "state": "running", "prompt": prompt[:120], "size": size,
        "started": time.time(), "url": None, "error": None,
        "mode": req.mode, "referenceId": req.referenceId, "maskId": req.maskId,
        "model": model,
    }
    IMAGEGEN_DIR.mkdir(parents=True, exist_ok=True)
    out = IMAGEGEN_DIR / f"{time.strftime('%m%d-%H%M%S')}-{job_id[:4]}.png"
    generation = {'prompt': prompt, 'size': size, 'model': model,
                  'created': _IMAGEGEN_JOBS[job_id]['started'], 'jobId': job_id,
                  'mode': req.mode, 'referenceId': req.referenceId, 'maskId': req.maskId}

    def _run() -> None:
        cmd = [sys.executable, str(SHARED_SCRIPTS / "ai_image.py"), req.mode,
               "--prompt", prompt, "--output", str(out),
               "--size", size, "--n", str(max(1, min(4, req.n)))]
        if reference:
            cmd += ["--image", str(reference)]
        if mask:
            cmd += ["--mask", str(mask)]
        try:
            # Freeze the dedicated channel and selected model for this task.
            # ai_image.py preserves explicit environment values when reading .env.
            process_env = child_env(PROJECT_ROOT)
            process_env.update({key: channel_env.get(key, "").strip() for key in ("IMG_BASE_URL", "IMG_API_KEY")})
            process_env["IMG_MODEL"] = model
            proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT), env=process_env,
                                  capture_output=True, text=True, timeout=_IMAGEGEN_TIMEOUT)
            # The helper preserves URL image formats and numbers multi-image results.
            # Match this job's unique stem instead of requiring the original .png path.
            images = sorted(p for p in IMAGEGEN_DIR.glob(f"{out.stem}*")
                            if p.is_file() and p.suffix.lower() in _IMAGEGEN_EXTS
                            and p.stat().st_size > 0)
            result = images[0] if images else None
            ok = proc.returncode == 0 and result is not None
            if ok:
                for image in images:
                    _imagegen_metadata_path(image).write_text(
                        json.dumps(generation, ensure_ascii=False), encoding='utf-8')
            _IMAGEGEN_JOBS[job_id].update({
                "state": "done" if ok else "error",
                "url": f"/api/media/{IMAGEGEN_DIR.name}/{result.name}" if ok else None,
                "error": None if ok else (proc.stderr or proc.stdout or "生成失败")[-400:],
                **(_imagegen_dimensions(result) if ok else {}),
            })
        except Exception as exc:  # noqa: BLE001 — 任务失败落状态，不崩进程
            _IMAGEGEN_JOBS[job_id].update({"state": "error", "error": str(exc)[:400]})

    threading.Thread(target=_run, daemon=True, name="easel-imagegen").start()
    return {"jobId": job_id, "state": "running"}


@app.get("/api/imagegen/{job_id}")
async def api_imagegen_status(job_id: str):
    job = _IMAGEGEN_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "任务不存在或已过期")
    return job


class NotifyTestRequest(BaseModel):
    subject: str = "Easel 通知测试"


@app.post("/api/notify/test")
async def api_notify_test(req: NotifyTestRequest):
    """发一封测试邮件（通知中心用）：按 .env 当前配置真发，返回脱敏结果。"""
    sys.path.insert(0, str(PROJECT_ROOT / "mcp" / "easel-notify"))
    try:
        import mailer as _mailer
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"通知模块缺失：{exc}")
    cfg = _mailer.load_email_config()
    if not cfg.configured:
        raise HTTPException(400, "邮箱通知未配置：先填收件人与 SMTP 主机并保存")
    result = await asyncio.to_thread(
        _mailer.send_email, cfg,
        (req.subject or "Easel 通知测试").strip()[:80],
        f"这是一封来自 Easel 的测试邮件。\n\n收到即代表 SMTP 配置正确。\n时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
    )
    result["to"] = [_mailer.mask(x) for x in (result.get("to") or [])]
    result["from"] = _mailer.mask(cfg.sender) if cfg.sender else ""
    return result


@app.get("/api/imagegen")
async def api_imagegen_gallery():
    """生图通道与最近产物兼容接口；完整历史统一由 /api/outputs 内容库读取。"""
    env = _read_env()
    base = env.get("IMG_BASE_URL", "").strip()
    key = env.get("IMG_API_KEY", "").strip()
    model = env.get("IMG_MODEL", "").strip()
    channel = {"configured": bool(base and key and model), "baseUrl": base,
               "keyMasked": _mask_key(key), "model": model}
    directories = {IMAGEGEN_DIR, OUTPUTS_DIR / 'images'}
    files = sorted((p for directory in directories if directory.is_dir() for p in directory.iterdir()
                    if p.is_file() and not p.name.startswith('.') and p.suffix.lower() in _IMAGEGEN_EXTS),
                   key=lambda p: p.stat().st_mtime, reverse=True)[:12]
    return {"images": [{"name": p.name,
                        "url": f"/api/media/{p.parent.name}/{p.name}",
                        "mtime": int(p.stat().st_mtime),
                        **_imagegen_dimensions(p)} for p in files], "channel": channel}





def _read_ideas() -> list[dict]:
    try:
        return local_records.read(IDEAS_FILE, '选题')
    except local_records.RecordError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None


def _write_ideas(items: list[dict]) -> None:
    try:
        local_records.write(IDEAS_FILE, items, '选题')
    except local_records.RecordError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None


class IdeaItem(BaseModel):
    title: str
    note: str = ""
    source: str = ""
    status: str = "pending"


@app.get("/api/ideas")
async def api_ideas_list():
    return _read_ideas()


@app.post("/api/ideas")
async def api_ideas_create(req: IdeaItem):
    items = _read_ideas()
    st = req.status if req.status in IDEA_STATUSES else "pending"
    item = {
        "id": uuid.uuid4().hex[:12],
        "title": req.title.strip() or "未命名选题",
        "note": req.note,
        "source": req.source,
        "status": st,
        "created": int(time.time()),
    }
    items.insert(0, item)
    _write_ideas(items)
    return item


@app.put("/api/ideas/{iid}")
async def api_ideas_update(iid: str, req: IdeaItem):
    items = _read_ideas()
    for it in items:
        if it.get("id") == iid:
            it.update({
                "title": req.title.strip() or it.get("title", "未命名选题"),
                "note": req.note,
                "source": req.source,
                "status": req.status if req.status in IDEA_STATUSES else it.get("status", "pending"),
            })
            _write_ideas(items)
            return it
    raise HTTPException(404, "选题不存在")


@app.delete("/api/ideas/{iid}")
async def api_ideas_delete(iid: str):
    items = _read_ideas()
    new = [it for it in items if it.get("id") != iid]
    if len(new) == len(items):
        raise HTTPException(404, "选题不存在")
    items[:] = new
    _write_ideas(items)
    return {"ok": True, "deleted": iid}


@app.get('/api/skill-audits')
async def api_skill_audits(sessionId: str, turnId: str | None = None):
    import skill_audit
    try:
        return {'records': await asyncio.to_thread(skill_audit.records, OUTPUTS_DIR / '_skill_audits', sessionId,
                                                   OPENCLAW_SESSIONS_DIR, _ACTIVE_SKILL_TURNS.get(sessionId, ''), turnId)}
    except OSError:
        raise HTTPException(503, '技能核验记录暂不可读，请稍后重试') from None


@app.get('/api/chat/execution/{session_id}/{turn_id}')
async def api_chat_execution(session_id: str, turn_id: str):
    import chat_execution
    process = _RUNNING_CHAT.get(session_id)
    live = process is not None and process.poll() is None and _ACTIVE_SKILL_TURNS.get(session_id) == turn_id
    result = await asyncio.to_thread(chat_execution.snapshot, session_id, turn_id,
        OUTPUTS_DIR / '_skill_audits', OPENCLAW_SESSIONS_DIR, live=live, credentials=gateway_credentials())
    if live and (_RUNNING_CHAT.get(session_id) is not process or _ACTIVE_SKILL_TURNS.get(session_id) != turn_id):
        result['operations'] = []
        result['warnings'] = ['执行轮次正在更新，请稍后查看。']
    return result


@app.get('/api/agent-office')
async def api_agent_office(sessionId: str):
    import agent_office
    def execution_state():
        process = _RUNNING_CHAT.get(sessionId)
        turn_id = _ACTIVE_SKILL_TURNS.get(sessionId, '')
        try:
            live = process is not None and process.poll() is None
        except OSError:
            live = False
        return process, turn_id, live

    process, turn_id, live = execution_state()
    result = await asyncio.to_thread(agent_office.snapshot, sessionId, SESSIONS_DIR,
                                     OUTPUTS_DIR / '_skill_audits', OPENCLAW_SESSIONS_DIR,
                                     live=live, active_turn_id=turn_id)
    current_process, current_turn_id, current_live = execution_state()
    # to_thread may wait behind other work or read while the supervisor moves
    # on. A boolean alone cannot distinguish two successive live processes.
    if current_process is not process or current_turn_id != turn_id or current_live != live:
        return agent_office.updating_snapshot(sessionId)
    import office_controls
    result = await asyncio.to_thread(office_controls.confirmed_stop_snapshot, sys.modules[__name__], result)
    current_process, current_turn_id, current_live = execution_state()
    if current_process is not process or current_turn_id != turn_id or current_live != live:
        return agent_office.updating_snapshot(sessionId)
    return result


class OfficeControlRequest(BaseModel):
    sessionId: str = Field(min_length=1, max_length=120)
    turnId: str = Field(min_length=1, max_length=120)
    agentId: str = Field(min_length=1, max_length=140)


class OfficeModelRequest(OfficeControlRequest):
    modelRef: str = Field(min_length=1, max_length=300)


class OfficeStopRequest(OfficeControlRequest):
    expectedRunId: str | None = Field(default=None, min_length=1, max_length=120)


@app.get('/api/agent-office/models')
async def api_office_models(sessionId: str | None = None):
    import office_controls
    return await asyncio.to_thread(office_controls.turn_model_capability, sys.modules[__name__], sessionId)


@app.get('/api/agent-office/controls')
async def api_office_controls(sessionId: str, turnId: str, agentId: str):
    import office_controls
    return await asyncio.to_thread(office_controls.operate, sys.modules[__name__], sessionId, turnId, agentId)


@app.post('/api/agent-office/model')
async def api_office_model(req: OfficeModelRequest):
    import office_controls
    async def apply():
        return await asyncio.to_thread(office_controls.operate, sys.modules[__name__], req.sessionId,
                                       req.turnId, req.agentId, 'model', req.modelRef)
    if req.agentId != f'root:{req.sessionId}':
        return await apply()
    # A root-model save cannot race the next locally initiated chat turn.
    lock = _session_lock(req.sessionId)
    if lock.locked():
        raise HTTPException(409, '请先停止当前会话并等待收尾完成，再分配模型。')
    async with lock:
        xlock = _CrossProcLock(req.sessionId)
        try:
            if not await asyncio.to_thread(xlock.acquire, 0):
                raise HTTPException(409, '当前会话正在使用中，请稍后重试。')
            return await apply()
        finally:
            xlock.release()


@app.post('/api/agent-office/stop')
async def api_office_stop(req: OfficeStopRequest):
    import office_controls
    return await asyncio.to_thread(office_controls.operate, sys.modules[__name__], req.sessionId,
                                   req.turnId, req.agentId, 'stop', expected_run_id=req.expectedRunId)


class SkillCritiqueRequest(BaseModel):
    sessionId: str
    turnId: str


_SKILL_REVIEW_BUSY: set[tuple[str, str]] = set()


@app.post('/api/skill-audits/critique')
async def api_skill_critique(req: SkillCritiqueRequest):
    import skill_audit
    directory = OUTPUTS_DIR / '_skill_audits'
    path = skill_audit.audit_path(directory, req.sessionId, req.turnId)
    ident = (req.sessionId, req.turnId)
    if ident in _SKILL_REVIEW_BUSY:
        raise HTTPException(409, '本轮效果评估正在进行，请稍候')
    _SKILL_REVIEW_BUSY.add(ident)
    try:
        try:
            record = json.loads(await asyncio.to_thread(path.read_text, encoding='utf-8'))
        except FileNotFoundError:
            raise HTTPException(404, '未找到本轮技能核验记录') from None
        except (OSError, ValueError):
            raise HTTPException(503, '本轮技能核验记录暂不可读') from None
        if not isinstance(record, dict) or record.get('sessionId') != req.sessionId or record.get('turnId') != req.turnId:
            raise HTTPException(404, '未找到本轮技能核验记录')
        if record.get('status') == 'running':
            raise HTTPException(409, '请等待本轮创作结束后再评估')
        providers = await asyncio.to_thread(_image_reverse_providers)
        provider = next((item for item in providers if item.configured), None)
        review = await asyncio.to_thread(skill_audit.critique, record, OUTPUTS_DIR, provider)
        record['critique'] = review
        try:
            await asyncio.to_thread(skill_audit.save, directory, record)
        except OSError:
            raise HTTPException(503, '评估已返回但记录保存失败，请检查数据目录') from None
        return review
    finally:
        _SKILL_REVIEW_BUSY.discard(ident)


@app.get("/api/usage")
async def api_usage(sessionId: str = '', limit: int = 60, offset: int = 0):
    """Current-project usage, persisted without conversation content or secrets."""
    import sqlite3
    from usage_stats import collect_usage
    if limit < 1 or limit > 100 or offset < 0:
        raise HTTPException(400, '分页参数无效')
    try:
        return await asyncio.to_thread(collect_usage, PROJECT_ROOT, openclaw_state_dir(),
                                       SESSIONS_DIR, sessionId, limit, offset)
    except ValueError:
        raise HTTPException(400, '会话标识无效') from None
    except (OSError, sqlite3.Error):
        raise HTTPException(500, '用量记录暂不可读，请检查数据目录访问权限后重试') from None


@app.get('/api/usage/pricing')
async def api_usage_prices():
    from usage_stats import read_prices
    return {'prices': await asyncio.to_thread(read_prices, SESSIONS_DIR)}


class UsagePriceRequest(BaseModel):
    provider: str
    model: str
    pricing: dict


@app.put('/api/usage/pricing')
async def api_usage_save_price(req: UsagePriceRequest):
    from usage_stats import save_price
    try:
        prices = await asyncio.to_thread(save_price, SESSIONS_DIR, req.provider, req.model, req.pricing)
        return {'prices': prices}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    except OSError:
        raise HTTPException(500, '价格保存失败，请检查数据目录权限') from None


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("EASEL_PORT", "7860"))
    proxy_url = os.environ.get("VSCODE_PROXY_URI", "").replace("{{port}}", str(port))
    print("\n  ✦ Easel Web")
    print(f"  http://localhost:{port}")
    if proxy_url:
        print(f"  {proxy_url}")
    print()
    uvicorn.run(app, host=os.environ.get("EASEL_HOST", "0.0.0.0"), port=port, log_level="warning")
