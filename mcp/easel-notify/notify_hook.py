#!/usr/bin/env python3
"""notify_hook.py — Easel 生成/发布完成后的邮箱通知钩子（线程安全、绝不阻断主流程）.

三处完成信号各挂一次钩，条件全由 .env 决定，未配置时零开销跳过：

  1. web/app.py 对话流收尾（api_chat_stream supervisor finally）——图文/视频/文案等
     所有经 chat / skill 入口生成的内容，跑完（status=done）就发一封摘要邮件；
     失败/超时不发（用户在场看着呢），用户显式停止也不发。
  2. skills/shared/scripts/manifest.py 的 record/meta —— 跨层编排登记产物时，
     record --status done / meta --status ready|published 发邮件；供 CLI 直接跑
     SKILL（不经过 chat 收尾）的场景。
  3. web/app.py 一键发布成功（api_publish / _run_publish_bg）—— 发布成功发邮件。

设计约束：
- 发送在守护线程里跑，主流程不等它（SMTP 20s 超时不拖住对话收尾）。
- 任何异常都吞掉：通知失败不影响生成/发布结果本身。
- 配置每次现读项目根 .env（EASEL_NOTIFY_EMAIL / EASEL_NOTIFY_SMTP_HOST 等），
  改动即生效，无需重启。EASEL_NOTIFY_OFF=1 可临时整机关掉。
- 邮件正文只带状态 + 标题 + 平台/体裁 + 产物名；不带敏感信息（路径/配置/Key）。
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mailer  # noqa: E402

PROJECT_ROOT = Path(os.environ.get("EASEL_DATA_DIR") or os.environ.get("EASEL_ROOT")
                    or Path(__file__).resolve().parents[2])

_last_sent: dict[str, float] = {}
_LAST_SENT_GAP = 60.0  # 同 key 60s 内不重发（编排多层各登记一次时防轰炸）


def _enabled() -> bool:
    if os.environ.get("EASEL_NOTIFY_OFF", "").strip() == "1":
        return False
    try:
        return mailer.load_email_config().configured
    except Exception:  # noqa: BLE001
        return False


def _send_async(cfg: mailer.EmailConfig, subject: str, body: str) -> None:
    """守护线程发送：主流程不等、异常不抛（通知失败不影响任务结果）。"""

    def _run() -> None:
        try:
            mailer.send_email(cfg, subject, body)
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=_run, daemon=True, name="easel-notify").start()


def notify_completion(*, topic: str = "", title: str = "", platform: str = "",
                      kind: str = "", summary: str = "", source: str = "generate",
                      deliverables: list[str] | None = None) -> None:
    """生成/发布完成 → 发一封摘要邮件。

    source 仅仅是正文里的动作词（生成完成/发布成功）；条件不满足（未配置）直接返回，
    不打日志、不抛错——对未启用邮箱通知的部署完全零开销。
    """
    if not _enabled():
        return
    key = f"{source}:{topic}" if topic else source
    now = time.monotonic()
    if now - _last_sent.get(key, 0.0) < _LAST_SENT_GAP:
        return
    _last_sent[key] = now
    try:
        cfg = mailer.load_email_config()
        action = "发布成功" if source == "publish" else "生成完成"
        subject = f"[Easel] {action}：{title or topic or '内容任务'}"
        lines = [f"Easel {action}。"]
        if title:
            lines.append(f"标题：{title}")
        if topic and topic != title:
            lines.append(f"项目：{topic}")
        if platform:
            lines.append(f"平台：{platform}")
        if kind:
            lines.append(f"体裁：{kind}")
        if deliverables:
            lines.append(f"产物：{'、'.join(deliverables[:8])}")
        if summary:
            lines.append(f"\n{summary[:300]}")
        lines.append(f"\n时间：{time.strftime('%Y-%m-%d %H:%M:%S')}")
        _send_async(cfg, subject, "\n".join(lines))
    except Exception:  # noqa: BLE001
        pass


def notify_web_turn(status: str, text: str, *, stop_reason: str | None = None,
                    user_stopped: bool = False, clean_end: bool = True) -> None:
    """web 对话流收尾钩子：只对「正常跑完且真的有产出」的一轮发邮件。

    失败/超时/用户停止不发（用户在场）；clean_end=False（被截断/流中断）也不发——
    那不是"生成完成"。正文取前 300 字做摘要。
    """
    if status != "done":
        return
    if user_stopped:
        return
    if stop_reason and stop_reason not in ("user_stopped",):
        return
    if not clean_end:
        return
    if not (text or "").strip():
        return
    # 对话轮没有结构化 topic/platform；标题从正文首个非空行截取
    first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    notify_completion(title=first_line[:60], summary=text[:300],
                      source="generate")
