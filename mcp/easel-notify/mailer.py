#!/usr/bin/env python3
"""mailer.py — easel-notify MCP 的邮件发送核心（确定性、纯标准库）.

生成/发布完成后把结果发到用户邮箱。配置只从项目根 .env 读取（凭证不进仓库、不外泄）。
server.py（MCP stdio）与 web/notify_hook.py（生成完成钩子）都走这里，发送逻辑单一真相源。

配置（.env）：
    EASEL_NOTIFY_EMAIL       收件人，逗号分隔（host + 至少一个收件人才算启用）
    EASEL_NOTIFY_SMTP_HOST   SMTP 主机，如 smtp.qq.com / smtp.163.com / smtp.exmail.qq.com
    EASEL_NOTIFY_SMTP_PORT   端口，默认 465（SSL）
    EASEL_NOTIFY_SMTP_USER   认证账号（缺省=首个收件人）
    EASEL_NOTIFY_SMTP_PASS   密码 / 授权码（QQ/163 需在邮箱后台开授权码，不是登录密码）
    EASEL_NOTIFY_SMTP_SSL    1（默认）=SSL(465)；0=STARTTLS(587)
    EASEL_NOTIFY_FROM        发件人显示地址（缺省=认证账号或首个收件人）

子命令：
    send      发送一封邮件（--dry-run 只打印将发内容，不真发）
    check     打印脱敏配置与启用状态
    selftest  自检（配置解析 + 消息构造 + dry-run，不联网）
"""
from __future__ import annotations

import argparse
import json
import os
import smtplib
import sys
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formatdate
from pathlib import Path

# PROJECT_ROOT：优先 EASEL_DATA_DIR（gateway/安装器注入），其次 EASEL_ROOT，
# 否则按 __file__ 上溯（mcp/easel-notify/ → 项目根）。
PROJECT_ROOT = Path(os.environ.get("EASEL_DATA_DIR") or os.environ.get("EASEL_ROOT")
                    or Path(__file__).resolve().parents[2])
DEFAULT_ENV_FILE = PROJECT_ROOT / ".env"

DEFAULT_PORT = 465


@dataclass
class EmailConfig:
    host: str = ""
    port: int = DEFAULT_PORT
    user: str = ""
    password: str = ""
    sender: str = ""
    to: list[str] = field(default_factory=list)
    ssl: bool = True

    @property
    def configured(self) -> bool:
        """host + 至少一个收件人才算启用；密码可缺（内部中继/免认证 SMTP）。"""
        return bool(self.host and self.to)


def _read_env_file(path: Path) -> dict[str, str]:
    """宽松解析 KEY=value（跳过注释/空行/非 KEY 行）。与 web/app.py _read_env 同款。"""
    result: dict[str, str] = {}
    if not path.is_file():
        return result
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, val = s.split("=", 1)
        key = key.strip()
        if key.isidentifier() or key.replace("-", "_").isidentifier():
            result[key] = val.strip()
    return result


def _split_addresses(raw: str) -> list[str]:
    """逗号/分号/空白分隔的收件人列表，去空去重，保序。"""
    seen: set[str] = set()
    out: list[str] = []
    for part in (raw or "").replace(";", ",").replace("；", ",").replace("，", ",").split(","):
        addr = part.strip()
        if addr and addr not in seen:
            seen.add(addr)
            out.append(addr)
    return out


def load_email_config(env: dict[str, str] | None = None,
                      env_file: Path | str | None = None) -> EmailConfig:
    """解析邮箱配置。env 缺省自读项目根 .env（每次调用现读，配置改动即生效）。"""
    if env is None:
        path = Path(env_file) if env_file else DEFAULT_ENV_FILE
        e = _read_env_file(path)
    else:
        e = env
    to = _split_addresses(e.get("EASEL_NOTIFY_EMAIL", ""))
    user = e.get("EASEL_NOTIFY_SMTP_USER", "").strip()
    port_raw = e.get("EASEL_NOTIFY_SMTP_PORT", "").strip()
    try:
        port = int(port_raw) if port_raw else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    ssl_raw = e.get("EASEL_NOTIFY_SMTP_SSL", "").strip().lower()
    use_ssl = ssl_raw not in ("0", "false", "no", "off")
    sender = e.get("EASEL_NOTIFY_FROM", "").strip() or user or (to[0] if to else "")
    return EmailConfig(
        host=e.get("EASEL_NOTIFY_SMTP_HOST", "").strip(),
        port=port,
        user=user,
        password=e.get("EASEL_NOTIFY_SMTP_PASS", "").strip(),
        sender=sender,
        to=to,
        ssl=use_ssl,
    )


def mask(addr: str) -> str:
    """脱敏：地址 local 部分只留首尾字符（短值全遮），域名保留。"""
    if not addr or "@" not in addr:
        return "••••"
    local, domain = addr.split("@", 1)
    if len(local) <= 2:
        shown = local[:1] + "*"
    else:
        shown = local[0] + "*" * (len(local) - 2) + local[-1]
    return f"{shown}@{domain}"


def build_message(cfg: EmailConfig, subject: str, body: str,
                  to: list[str] | None = None) -> EmailMessage:
    """构造 RFC822 邮件（纯函数，供测试）。收件人缺省用配置默认。"""
    recipients = to if to else cfg.to
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg.sender or (recipients[0] if recipients else "easel@localhost")
    msg["To"] = ", ".join(recipients)
    msg["Date"] = formatdate(localtime=False)
    msg.set_content(body, charset="utf-8")
    return msg


def _connect(cfg: EmailConfig, timeout: int) -> smtplib.SMTP:
    if cfg.ssl:
        return smtplib.SMTP_SSL(cfg.host, cfg.port, timeout=timeout)
    client = smtplib.SMTP(cfg.host, cfg.port, timeout=timeout)
    client.starttls()
    return client


def send_email(cfg: EmailConfig, subject: str, body: str, to: list[str] | None = None,
               dry_run: bool = False, timeout: int = 20) -> dict:
    """发送邮件。返回 {ok, detail, ...}；dry_run 只回将要发送的内容，不联网。"""
    recipients = to if to else cfg.to
    if not recipients:
        return {"ok": False, "detail": "没有收件人（EASEL_NOTIFY_EMAIL 或 --to）"}
    if not cfg.host:
        return {"ok": False, "detail": "没有 SMTP 主机（EASEL_NOTIFY_SMTP_HOST）"}
    if not subject or not body:
        return {"ok": False, "detail": "subject/body 不能为空"}
    msg = build_message(cfg, subject, body, to)
    if dry_run:
        return {"ok": True, "dry_run": True, "detail": "dry-run：未真发",
                "from": cfg.sender, "to": recipients, "subject": subject,
                "body_head": body[:200]}
    try:
        client = _connect(cfg, timeout)
    except (OSError, smtplib.SMTPException) as exc:
        return {"ok": False, "detail": f"SMTP 连接失败：{exc}"}
    try:
        if cfg.user and cfg.password:
            client.login(cfg.user, cfg.password)
        refused = client.send_message(msg)
        if refused:
            bad = ", ".join(sorted(refused))
            return {"ok": False, "detail": f"部分收件人被拒：{bad}"}
        return {"ok": True, "detail": f"已发送给 {len(recipients)} 个收件人",
                "to": recipients, "subject": subject}
    except smtplib.SMTPAuthenticationError as exc:
        return {"ok": False, "detail": f"SMTP 认证失败（检查授权码，QQ/163 不是登录密码）：{exc}"}
    except (OSError, smtplib.SMTPException) as exc:
        return {"ok": False, "detail": f"发送失败：{exc}"}
    finally:
        try:
            client.quit()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def cmd_send(a) -> int:
    cfg = load_email_config(env_file=a.env_file)
    to = _split_addresses(a.to) if a.to else None
    result = send_email(cfg, a.subject, a.body, to=to, dry_run=a.dry_run)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


def cmd_check(a) -> int:
    cfg = load_email_config(env_file=a.env_file)
    print(json.dumps({
        "configured": cfg.configured,
        "smtp_host": cfg.host,
        "smtp_port": cfg.port,
        "ssl": cfg.ssl,
        "user": mask(cfg.user) if cfg.user else "",
        "from": mask(cfg.sender) if cfg.sender else "",
        "to": [mask(x) for x in cfg.to],
        "to_count": len(cfg.to),
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_selftest(_a) -> int:
    # 1) 配置解析：逗号/分号/中文逗号都拆分
    cfg = load_email_config(env={
        "EASEL_NOTIFY_EMAIL": "a@x.com, b@x.com；c@x.com",
        "EASEL_NOTIFY_SMTP_HOST": "smtp.x.com",
        "EASEL_NOTIFY_SMTP_PORT": "587",
        "EASEL_NOTIFY_SMTP_SSL": "0",
        "EASEL_NOTIFY_SMTP_USER": "u@x.com",
        "EASEL_NOTIFY_SMTP_PASS": "p",
    })
    assert cfg.configured and cfg.port == 587 and cfg.ssl is False
    assert cfg.to == ["a@x.com", "b@x.com", "c@x.com"], "分号/中文逗号也应拆分"
    assert cfg.sender == "u@x.com"
    # 2) 未配置不算启用：只有 host、没有收件人不算；空配置不算
    assert not load_email_config(env={}).configured
    assert not load_email_config(env={"EASEL_NOTIFY_SMTP_HOST": "smtp.x.com"}).configured, \
        "只有 host、没有收件人不算启用"
    # 3) 消息构造
    msg = build_message(cfg, "标题", "正文")
    assert msg["Subject"] == "标题" and "a@x.com" in str(msg["To"])
    # 4) 缺收件人报错
    assert send_email(EmailConfig(host="smtp.x.com"), "s", "b")["ok"] is False
    # 5) dry-run 不联网
    assert send_email(cfg, "s", "b", dry_run=True).get("dry_run") is True
    print("✅ selftest 通过（配置解析 + 消息构造 + dry-run）")
    return 0


def main() -> int:
    # Windows 下管道 stdout 可能是 GBK：显式 UTF-8，✅/中文才不会把 print 打崩。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser(
        description="easel-notify 邮件发送核心（MCP server.py 与 web 完成钩子共用）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("send", help="发送一封邮件")
    p.add_argument("--subject", required=True, help="邮件主题")
    p.add_argument("--body", required=True, help="邮件正文（纯文本）")
    p.add_argument("--to", help="收件人，多个逗号分隔（缺省用 EASEL_NOTIFY_EMAIL）")
    p.add_argument("--env-file", help="显式指定 .env（缺省项目根 .env）")
    p.add_argument("--dry-run", action="store_true", help="只打印将发送的内容，不真发")
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("check", help="打印脱敏配置与启用状态")
    p.add_argument("--env-file", help="显式指定 .env（缺省项目根 .env）")
    p.set_defaults(func=cmd_check)

    sub.add_parser("selftest", help="自检").set_defaults(func=cmd_selftest)

    a = ap.parse_args()
    if not getattr(a, "func", None):
        ap.print_help()
        return 1
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
