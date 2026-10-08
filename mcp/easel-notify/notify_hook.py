#!/usr/bin/env python3
"""notify_hook.py — Easel 生成/发布完成后的邮箱通知钩子（线程安全、绝不阻断主流程）.

三处完成信号各挂一次钩，条件全由 .env 决定，未配置时零开销跳过：

  1. web/app.py 对话流收尾（api_chat_stream supervisor finally）——图文/视频/文案等
     所有经 chat / skill 入口生成的内容，跑完（status=done）就发一封摘要邮件；
     失败/超时不发（用户在场看着呢），用户显式停止也不发。
  2. skills/shared/scripts/manifest.py 的 record/meta —— 生成完成可发摘要；
     仅有本地 ready/published 标记不能确认平台已经公开发布。
  3. web/app.py 收到当前任务的 published 平台回执后发送成功提醒，附公开作品地址。

设计约束：
- 发送在守护线程里跑，主流程不等它（SMTP 20s 超时不拖住对话收尾）。
- 通知异常不影响生成/发布结果；发布回执可观察排队、已发送、失败或未配置。
- 配置每次现读项目根 .env（EASEL_NOTIFY_EMAIL / EASEL_NOTIFY_SMTP_HOST 等），
  改动即生效，无需重启。EASEL_NOTIFY_ON_DONE=1 才自动发送；EASEL_NOTIFY_OFF=1 可临时关闭。
- 邮件正文只带状态 + 标题 + 平台/体裁 + 产物名；不带敏感信息（路径/配置/Key）。
"""
from __future__ import annotations

import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mailer  # noqa: E402

PROJECT_ROOT = Path(os.environ.get("EASEL_DATA_DIR") or os.environ.get("EASEL_ROOT")
                    or Path(__file__).resolve().parents[2])

_last_sent: dict[str, float] = {}
_LAST_SENT_GAP = 60.0  # 同 key 60s 内不重发（编排多层各登记一次时防轰炸）
_SEND_LOCK = threading.Lock()


def _enabled() -> bool:
    if os.environ.get("EASEL_NOTIFY_OFF", "").strip() == "1":
        return False
    try:
        cfg = mailer.load_email_config()
        return cfg.configured and cfg.on_done
    except Exception:  # noqa: BLE001
        return False


def _send_async(cfg: mailer.EmailConfig, subject: str, body: str,
                on_result: Callable[[dict], None] | None = None) -> None:
    """SMTP 完成后报告结果；排入线程不是已经送达。"""

    def _run() -> None:
        try:
            result = mailer.send_email(cfg, subject, body)
            status = ({'state': 'sent', 'message': '邮件已交给 SMTP 服务，实际收件情况请检查邮箱。'}
                      if isinstance(result, dict) and result.get('ok') is True
                      else {'state': 'failed', 'message': '邮件发送失败，请检查通知配置和邮箱服务。'})
        except Exception:  # noqa: BLE001
            status = {'state': 'failed', 'message': '邮件发送失败，请检查通知配置和邮箱服务。'}
        if on_result is not None:
            try:
                on_result(status)
            except Exception:
                pass

    threading.Thread(target=_run, daemon=True, name="easel-notify").start()


def notify_completion(*, topic: str = "", title: str = "", platform: str = "",
                      kind: str = "", summary: str = "", source: str = "generate",
                      deliverables: list[str] | None = None, url: str = "",
                      receipt_id: str = "", outcome: str = "",
                      on_result: Callable[[dict], None] | None = None) -> dict:
    """Return notification state; published receipts deduplicate by task ID."""
    def report(state: str, message: str) -> dict:
        result = {'state': state, 'message': message}
        if on_result is not None:
            try:
                on_result(result)
            except Exception:
                pass
        return result

    if source == 'publish' and (outcome != 'published'
                                or not re.fullmatch(r'[0-9a-f]{32}', receipt_id)):
        return report('skipped', '缺少已确认公开发布的任务回执，未发送成功提醒。')
    if os.environ.get('EASEL_NOTIFY_OFF', '').strip() == '1':
        return report('skipped', '邮箱通知已关闭。')
    try:
        cfg = mailer.load_email_config()
        if not cfg.configured:
            return report('unconfigured', '邮箱通知未配置，可在设置中填写收件人与 SMTP。')
        if not getattr(cfg, 'on_done', False):
            return report('skipped', '任务完成后自动邮件通知已关闭。')
        key = f'publish:{receipt_id}' if source == 'publish' else f'{source}:{topic}'
        now = time.monotonic()
        with _SEND_LOCK:
            duplicate = key in _last_sent and (source == 'publish'
                                              or now - _last_sent[key] < _LAST_SENT_GAP)
            if not duplicate:
                _last_sent[key] = now
        if duplicate:
            return report('skipped', '该任务已安排提醒，未重复发送。')
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
        if source == 'publish':
            try:
                parsed = urlsplit(url)
                safe_url = url if (parsed.scheme == 'https' and parsed.hostname
                                  and not parsed.username and not parsed.password
                                  and not any(ch.isspace() for ch in url)) else ''
            except ValueError:
                safe_url = ''
            lines.append('作品地址：' + (safe_url or '平台未返回可验证的公开作品地址，请在平台内查看。'))
            lines.append(f'发布回执：{receipt_id}')
        if summary:
            lines.append(f"\n{summary[:300]}")
        lines.append(f"\n时间：{time.strftime('%Y-%m-%d %H:%M:%S')}")
        queued = report('queued', '邮件提醒已排队，正在等待 SMTP 发送结果。')
        if on_result is None:
            _send_async(cfg, subject, "\n".join(lines))
        else:
            _send_async(cfg, subject, "\n".join(lines), on_result)
        return queued
    except Exception:  # noqa: BLE001
        return report('failed', '邮件提醒未能启动，请检查通知配置。')


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
