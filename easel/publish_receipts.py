"""Durable publish results, separate from process exit codes and mail delivery.

Only a versioned receipt emitted by the current platform runner can confirm a
publication. Reading receipts never submits content or retries notifications.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, urlsplit

from easel import local_records

MARKER = 'EASEL_PUBLISH_RECEIPT='
OUTCOMES = frozenset({'published', 'submitted', 'draft', 'unverified', 'failed'})
PROGRESS_STATES = frozenset({'starting', 'sms_required', 'verifying'})
RECEIPT_ID = re.compile(r'^[0-9a-f]{32}$')
LABEL = '发布回执'
MESSAGES = {
    'published': '平台已确认发布。',
    'submitted': '内容已提交，尚未确认公开发布；请在平台查看审核结果。',
    'draft': '已保存到平台草稿箱，尚未公开发布。',
    'unverified': '发布结果尚未核实，请先到平台核对，避免重复发布。',
    'failed': '发布未完成，请查看平台状态和本地发布日志。',
}


def _now(after: str | None = None) -> str:
    now = datetime.now(timezone.utc)
    now = now.replace(microsecond=now.microsecond // 1000 * 1000)
    if after:
        try:
            previous = datetime.fromisoformat(after.replace('Z', '+00:00'))
            if previous.tzinfo is not None and now <= previous:
                now = previous + timedelta(milliseconds=1)
        except (TypeError, ValueError):
            pass
    return now.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _text(value, limit: int = 600) -> str:
    if not isinstance(value, str):
        return ''
    return ''.join(ch for ch in value if ch >= ' ' or ch in '\n\t').strip()[:limit]


def public_url(platform: str, value) -> str:
    """Accept content URLs only; creator-console and credential URLs are excluded."""
    if not isinstance(value, str) or not value or len(value) > 4096:
        return ''
    if any(ch.isspace() or ord(ch) < 32 for ch in value) or '\\' in value:
        return ''
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != 'https' or parsed.username or parsed.password
                or parsed.port not in (None, 443)):
            return ''
        host, path = (parsed.hostname or '').lower(), parsed.path
        patterns = {
            'douyin': {'www.douyin.com': r'/(?:video|note)/\d+/?'},
            'xiaohongshu': {'www.xiaohongshu.com': r'/(?:explore|discovery/item)/[0-9a-fA-F]{24}/?'},
            'bilibili': {'www.bilibili.com': r'/video/BV[0-9A-Za-z]{10}/?'},
            'kuaishou': {'www.kuaishou.com': r'/short-video/[0-9A-Za-z_-]+/?'},
            'zhihu': {'zhuanlan.zhihu.com': r'/p/\d+/?',
                      'www.zhihu.com': r'/question/\d+/answer/\d+/?'},
        }
        if platform == 'wechat-oa' and host == 'mp.weixin.qq.com':
            query = parse_qs(parsed.query)
            allowed = bool(re.fullmatch(r'/s/[0-9A-Za-z_-]+', path)) or (
                path == '/s' and all(query.get(key) for key in ('__biz', 'mid', 'idx')))
        else:
            pattern = patterns.get(platform, {}).get(host)
            allowed = bool(pattern and re.fullmatch(pattern, path))
        if not allowed:
            return ''
        if any(key.lower() in {'access_token', 'authorization', 'password', 'auth', 'token'}
               for key in parse_qs(parsed.query)):
            return ''
        return value
    except (ValueError, TypeError):
        return ''


def _evidence(value) -> dict:
    """Keep a small explanation, never arbitrary API responses or login state."""
    if not isinstance(value, dict):
        return {}
    allowed = {'source', 'type', 'kind', 'readbackOutcome', 'status', 'platformStatus',
               'contentId', 'uiSignal', 'verification', 'verified', 'method', 'reason',
               'matched', 'publicAccessChecked', 'urlSource', 'signal', 'submissionAttempted'}
    return {key: (_text(val, 160) if isinstance(val, str) else val)
            for key, val in value.items()
            if key in allowed and isinstance(val, (str, bool, int))}


def parse_result(platform: str, receipt_id: str, stdout: str, returncode: int | None,
                 *, failure_message: str = '') -> dict:
    """Parse only this invocation's receipt; ordinary log prose is not evidence."""
    result = None
    for line in (stdout or '').splitlines():
        if not line.startswith(MARKER) or len(line) > 65536:
            continue
        try:
            raw = json.loads(line[len(MARKER):])
        except (ValueError, TypeError):
            continue
        if (not isinstance(raw, dict) or type(raw.get('schemaVersion')) is not int
                or raw.get('schemaVersion') != 1 or raw.get('receiptId') != receipt_id
                or raw.get('platform') != platform or not isinstance(raw.get('outcome'), str)
                or raw.get('outcome') not in OUTCOMES):
            continue
        result = {
            'outcome': raw['outcome'], 'contentId': _text(raw.get('contentId'), 128),
            'platformStatus': _text(raw.get('platformStatus'), 100),
            'url': public_url(platform, raw.get('url')),
            'message': _text(raw.get('message')) or MESSAGES[raw['outcome']],
            'evidence': _evidence(raw.get('evidence')),
        }
    if result is None:
        # Compatibility for older WeChat draft runners and biliup. Even an
        # upload ID does not establish that moderation/publication has finished.
        result = _legacy_result(platform, stdout, returncode)
    if result is None:
        outcome = 'unverified' if returncode in (0, None) else 'failed'
        result = {'outcome': outcome, 'contentId': '', 'platformStatus': '', 'url': '',
                  'message': failure_message or MESSAGES[outcome], 'evidence': {}}
    elif result['outcome'] == 'published' and returncode != 0:
        result.update(outcome='unverified', url='', message=(
            '发布脚本异常结束，成功回执仍需核对；请到平台检查，避免重复发布。'))
    if result['outcome'] not in {'published', 'submitted'}:
        result['url'] = ''
    if result['outcome'] == 'published' and not result['url']:
        result['message'] += ' 平台未返回可验证的公开作品地址。'
    result.update(ok=result['outcome'] == 'published', state='finished', pending=False)
    return result


def _legacy_result(platform: str, stdout: str, returncode: int | None) -> dict | None:
    if returncode != 0 or platform not in {'wechat-oa', 'bilibili'}:
        return None
    for line in reversed((stdout or '').splitlines()):
        try:
            raw = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(raw, dict):
            continue
        if (platform == 'wechat-oa' and raw.get('success') is True
                and isinstance(raw.get('media_id'), str) and raw['media_id'].strip()):
            return {'outcome': 'draft', 'contentId': _text(raw['media_id'], 128),
                    'platformStatus': 'draft', 'url': '', 'message': MESSAGES['draft'],
                    'evidence': {'source': 'wechat-draft-response'}}
        data = raw.get('data') if isinstance(raw.get('data'), dict) else raw
        bvid = data.get('bvid')
        if (platform == 'bilibili' and isinstance(bvid, str)
                and re.fullmatch(r'BV[0-9A-Za-z]{10}', bvid)
                and raw.get('code', 0) == 0):
            return {'outcome': 'submitted', 'contentId': bvid, 'platformStatus': 'submitted',
                    'url': '', 'message': MESSAGES['submitted'],
                    'evidence': {'source': 'biliup-upload-response'}}
    return None


class ActivePublishError(Exception):
    def __init__(self, receipt_id: str):
        self.receipt_id = receipt_id
        super().__init__('该平台已有发布任务，请先查看现有任务。')


class ReceiptStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _read(self):
        items = local_records.read(self.path, LABEL)
        for item in items:
            if (not isinstance(item.get('receiptId'), str)
                    or not RECEIPT_ID.fullmatch(item['receiptId'])
                    or not isinstance(item.get('platform'), str)
                    or (item.get('outcome') is not None
                        and (not isinstance(item['outcome'], str) or item['outcome'] not in OUTCOMES))
                    or not isinstance(item.get('notification'), dict)):
                raise local_records.RecordError('发布回执格式不受支持，原文件已保留；请从备份恢复。')
        return items

    def _change(self, operation):
        for attempt in range(10):
            items = self._read()
            value = operation(items)
            try:
                local_records.write(self.path, items, LABEL)
                return value
            except local_records.RecordConflict:
                if attempt == 9:
                    raise
                time.sleep(0.01 * (attempt + 1))

    def create(self, receipt_id: str, platform: str, title: str) -> dict:
        if not RECEIPT_ID.fullmatch(receipt_id):
            raise ValueError('Invalid receipt ID')
        def operation(items):
            for item in items:
                if item['platform'] == platform and item.get('outcome') not in OUTCOMES:
                    raise ActivePublishError(item['receiptId'])
                if item['receiptId'] == receipt_id:
                    raise ValueError('Duplicate receipt ID')
            now = _now()
            item = {'receiptId': receipt_id, 'platform': platform, 'title': title[:300],
                    'state': 'starting', 'outcome': None, 'ok': False, 'pending': True,
                    'contentId': '', 'platformStatus': '', 'url': '',
                    'message': '发布处理中，请等待平台回执。',
                    'createdAt': now, 'updatedAt': now,
                    'notification': {'state': 'skipped', 'message': '待平台确认发布后再提醒。'}}
            items.append(item)
            return dict(item)
        return self._change(operation)

    def get(self, receipt_id: str) -> dict | None:
        return next((dict(item) for item in self._read() if item['receiptId'] == receipt_id), None)

    def recent(self, limit: int = 50) -> list[dict]:
        items = list(reversed(self._read()))
        selected = items[:max(1, min(200, limit))]
        selected_ids = {item['receiptId'] for item in selected}
        # Active operations remain discoverable even when other platforms have
        # produced more recent history while one upload is still waiting.
        selected += [item for item in items if item.get('outcome') not in OUTCOMES
                     and item['receiptId'] not in selected_ids]
        return selected

    def update(self, receipt_id: str, changes: dict) -> dict:
        def operation(items):
            for item in items:
                if item['receiptId'] == receipt_id:
                    item.update({key: value for key, value in changes.items()
                                 if key not in {'receiptId', 'platform', 'createdAt'}})
                    item['updatedAt'] = _now(item.get('updatedAt'))
                    return dict(item)
            raise KeyError(receipt_id)
        return self._change(operation)

    def recover_interrupted(self) -> None:
        """Called once at Web startup; do not resubmit or resend after a restart."""
        items = self._read()
        if not any(item.get('outcome') not in OUTCOMES
                   or item.get('notification', {}).get('state') == 'queued' for item in items):
            return
        def operation(records):
            for item in records:
                if item.get('outcome') not in OUTCOMES:
                    item.update(outcome='unverified', state='finished', ok=False, pending=False,
                                message='服务已重启，发布结果尚未核实；请先到平台查看，避免重复发布。',
                                updatedAt=_now())
                if item.get('notification', {}).get('state') == 'queued':
                    item.update(notification={'state': 'failed', 'message': (
                        '服务已重启，邮件发送结果未确认；请检查邮箱。系统不会自动重发。')},
                                updatedAt=_now())
        self._change(operation)
