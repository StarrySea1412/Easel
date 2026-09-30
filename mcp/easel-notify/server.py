#!/usr/bin/env python3
"""server.py — easel-notify MCP 服务器（stdio，纯标准库）.

生成/发布等任务完成后给用户发邮件通知。注册进 OpenClaw（easel profile）后，
Agent 在任务收尾时调用 `notify_email` 工具；也可被 `openclaw attach` 挂给
Claude Code 等外部 harness 使用。发送核心在 mailer.py（单一真相源）。

MCP 协议：JSON-RPC 2.0 over stdio，逐行 JSON（LSP 式分隔），实现
initialize / notifications/initialized / tools/list / tools/call / ping。
无第三方依赖——OpenClaw 的 mcp client 对 stdio server 只要求这两样。

注册（easel profile，一次性）：
    openclaw --profile easel mcp add easel-notify \
      --command "<python>" --arg "<项目根>/mcp/easel-notify/server.py" \
      --env "EASEL_DATA_DIR=<项目根>" --cwd "<项目根>"

工具：
    notify_email   发一封通知邮件。收件人/SMTP 从项目根 .env 读取；
                   未配置时返回明确提示，不报裸错。subject/body 必填，
                   可选 to 覆盖默认收件人、dry_run 预览。
    notify_status  返回脱敏邮箱配置与启用状态（供 Agent 先查再发）。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mailer  # noqa: E402

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "easel-notify"
SERVER_VERSION = "0.1.0"

# 工具输入 schema（JSON Schema Draft 2020-12 子集）
TOOLS: list[dict] = [
    {
        "name": "notify_email",
        "description": (
            "发送邮件通知：生成/发布等任务完成后，把结果（状态 + 标题 + 产物/链接）"
            "发到用户邮箱。收件人与 SMTP 配置从 Easel 项目根 .env 读取"
            "（EASEL_NOTIFY_EMAIL / EASEL_NOTIFY_SMTP_HOST 等），未配置时返回"
            "明确提示而不是报错。发通知前可先用 dry_run 预览。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string", "description": "邮件主题"},
                "body": {"type": "string", "description": "邮件正文（纯文本）"},
                "to": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "收件人列表（缺省用 .env 里的 EASEL_NOTIFY_EMAIL）",
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "true 只预览将发送的内容，不真发",
                },
            },
            "required": ["subject", "body"],
        },
    },
    {
        "name": "notify_status",
        "description": (
            "查询邮箱通知配置状态：返回脱敏后的 SMTP 主机、端口和收件人列表，"
            "以及是否已启用（configured）。发邮件前先调用它确认已配置。"
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _result(req_id, payload: dict) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": req_id, "result": payload},
                      ensure_ascii=False)


def _error(req_id, code: int, message: str) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": req_id,
                       "error": {"code": code, "message": message}},
                      ensure_ascii=False)


def _tool_text(payload: dict) -> dict:
    """把 dict 结果包成 MCP tool 的 text content（JSON 字符串）。"""
    return {"content": [{"type": "text",
                         "text": json.dumps(payload, ensure_ascii=False, indent=2)}]}


def call_tool(name: str, args: dict) -> dict:
    """执行一次工具调用（纯逻辑，供测试）。未知工具由调用方先拦。"""
    if name == "notify_status":
        cfg = mailer.load_email_config()
        return _tool_text({
            "configured": cfg.configured,
            "smtp_host": cfg.host,
            "smtp_port": cfg.port,
            "ssl": cfg.ssl,
            "to": [mailer.mask(x) for x in cfg.to],
            "to_count": len(cfg.to),
        })
    if name == "notify_email":
        subject = (args.get("subject") or "").strip()
        body = args.get("body") or ""
        to = [t.strip() for t in (args.get("to") or []) if t and t.strip()]
        if not subject or not body:
            return _tool_text({"ok": False, "detail": "subject/body 不能为空"})
        cfg = mailer.load_email_config()
        if not cfg.configured and not to:
            return _tool_text({
                "ok": False,
                "detail": ("邮箱通知未配置：请在 Easel 项目根 .env 填 "
                           "EASEL_NOTIFY_EMAIL（收件人）与 EASEL_NOTIFY_SMTP_HOST/"
                           "EASEL_NOTIFY_SMTP_PASS（SMTP 账号与授权码）后重试"),
            })
        result = mailer.send_email(cfg, subject, body, to=to or None,
                                   dry_run=bool(args.get("dry_run")))
        return _tool_text(result)
    return _tool_text({"ok": False, "detail": f"未知工具：{name}"})


def handle(msg: dict, req_id=None) -> str | None:
    """处理一条 JSON-RPC 消息，返回响应行（通知类返回 None）。"""
    method = msg.get("method", "")
    if method == "initialize":
        return _result(req_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    if method == "ping":
        return _result(req_id, {})
    if method == "tools/list":
        return _result(req_id, {"tools": TOOLS})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name", "")
        if name not in {t["name"] for t in TOOLS}:
            return _error(req_id, -32602, f"未知工具：{name}")
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            return _error(req_id, -32602, "arguments 需为对象")
        try:
            return _result(req_id, call_tool(name, args))
        except Exception as exc:  # noqa: BLE001 — 工具内异常按 MCP 结果返回，不崩进程
            return _result(req_id, _tool_text({"ok": False, "detail": f"执行异常：{exc}"}))
    if method.startswith("notifications/"):
        return None
    if req_id is not None:
        return _error(req_id, -32601, f"未知方法：{method}")
    return None


def serve(stdin=sys.stdin, stdout=sys.stdout) -> int:
    """stdio 主循环：逐行读 JSON-RPC，写响应行。EOF/退出码 0 结束。"""
    # Windows 下管道 stdout 可能是 GBK：显式 UTF-8，中文才不会把写行打崩。
    try:
        if hasattr(stdout, "reconfigure"):
            stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(stdin, "reconfigure"):
            stdin.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except (ValueError, TypeError):
            msg = {}
            resp = _error(None, -32700, "Parse error：不是合法 JSON")
        else:
            if not isinstance(msg, dict):
                resp = _error(None, -32600, "Invalid Request：需为 JSON-RPC 对象")
            else:
                req_id = msg.get("id")
                resp = handle(msg, req_id)
        if resp is not None:
            stdout.write(resp + "\n")
            stdout.flush()
    return 0


def main() -> int:
    return serve()


if __name__ == "__main__":
    sys.exit(main())
