"""Explicit saved-model probes with durable cross-process rate and schedule state."""
from __future__ import annotations

import base64
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import io
import json
from pathlib import Path
import random
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request

from fastapi import HTTPException
from PIL import Image, ImageDraw

DEFAULT_PROMPT = '请用一句话说明你已收到这条连接测试消息。'
PALETTE = {'red': '#e61919', 'green': '#159447', 'blue': '#165bdd', 'yellow': '#ffdc00',
           'orange': '#ff851b', 'purple': '#8515bd', 'black': '#111111', 'white': '#ffffff'}


@dataclass(frozen=True)
class Target:
    model_ref: str
    provider: str
    model: str
    protocol: str
    base: str
    key: str

    @property
    def fingerprint(self):
        return hashlib.sha256(json.dumps([self.model_ref, self.protocol, self.base, self.key]).encode()).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def challenge(rng=None):
    """No labels, filenames or metadata contain the randomly chosen answer."""
    colors = (rng or random.SystemRandom()).sample(list(PALETTE), 4)
    image = Image.new('RGB', (320, 320), '#777777')
    draw = ImageDraw.Draw(image)
    for i, color in enumerate(colors):
        x, y = (i % 2) * 160, (i // 2) * 160
        draw.rectangle((x + 8, y + 8, x + 151, y + 151), fill=PALETTE[color])
    output = io.BytesIO()
    image.save(output, 'PNG')
    image.close()
    prompt = ('Identify the four large colored squares in the attached 2 by 2 image. '
              'Return ONLY a JSON array of four English color names in row-major order '
              '(top-left, top-right, bottom-left, bottom-right). '
              'Allowed names: red, green, blue, yellow, orange, purple, black, white.')
    return output.getvalue(), colors, prompt


def image_score(text, expected):
    try:
        value = json.loads(re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip()))
        valid = isinstance(value, list) and len(value) == 4 and all(isinstance(v, str) for v in value)
        correct = sum(a.strip().lower() == b for a, b in zip(value, expected)) if valid else 0
        return {'correct': correct, 'total': 4, 'passed': valid and correct == 4}
    except (ValueError, TypeError):
        return {'correct': 0, 'total': 4, 'passed': False}


def request_body(target, prompt, image=None):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Easel/0.2.6'}
    if target.protocol == 'anthropic':
        headers.update({'x-api-key': target.key, 'anthropic-version': '2023-06-01'})
        content = [{'type': 'text', 'text': prompt}]
        if image:
            content.insert(0, {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png',
                                                        'data': base64.b64encode(image).decode('ascii')}})
        payload = {'model': target.model, 'max_tokens': 200, 'messages': [{'role': 'user', 'content': content}]}
        url = target.base.rstrip('/') + ('/messages' if target.base.rstrip('/').endswith('/v1') else '/v1/messages')
    elif target.protocol == 'openai-responses':
        headers['Authorization'] = 'Bearer ' + target.key
        content = [{'type': 'input_text', 'text': prompt}]
        if image:
            content.append({'type': 'input_image', 'image_url': 'data:image/png;base64,' + base64.b64encode(image).decode('ascii')})
        payload = {'model': target.model, 'max_output_tokens': 200, 'input': [{'role': 'user', 'content': content}]}
        url = target.base.rstrip('/') + '/responses'
    else:
        headers['Authorization'] = 'Bearer ' + target.key
        content = prompt if not image else [{'type': 'text', 'text': prompt},
                   {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(image).decode('ascii')}}]
        payload = {'model': target.model, 'max_tokens': 200, 'messages': [{'role': 'user', 'content': content}]}
        url = target.base.rstrip('/') + '/chat/completions'
    return urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method='POST')


def dispatch(target, prompt, mode, opener=None):
    image, expected = None, None
    if mode == 'vision':
        image, expected, prompt = challenge()
    started = time.monotonic()
    try:
        request = request_body(target, prompt, image)
        with (opener or urllib.request.build_opener(NoRedirect)).open(request, timeout=20) as response:
            raw = response.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            raise ValueError('bounded response')
        payload = json.loads(raw)
        if target.protocol == 'anthropic':
            text = '\n'.join(block['text'] for block in payload.get('content', [])
                             if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str))
        elif target.protocol == 'openai-responses':
            text = '\n'.join(block['text'] for item in payload.get('output', []) if isinstance(item, dict)
                             for block in item.get('content', []) if isinstance(block, dict)
                             and block.get('type') == 'output_text' and isinstance(block.get('text'), str))
        else:
            text = payload['choices'][0]['message']['content']
            if not isinstance(text, str):
                text = '\n'.join(block['text'] for block in text
                                 if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str))
        if not isinstance(text, str) or not text.strip():
            raise ValueError('empty response')
        score = image_score(text, expected) if expected else None
        clean = text.replace(target.key, '[已隐藏]') if target.key else text
        clean = re.sub(r'data:image/[^;\s]+;base64,[A-Za-z0-9+/=]+', '[图片数据已隐藏]', clean)
        passed = score['passed'] if score else True
        return {'ok': passed, 'state': 'success' if passed else 'failed',
                'detail': ('随机图片四格全部匹配；仅验证本次图片输入。' if passed else '本次图片答案未全部匹配；不能据此断言模型不支持图片。') if score else '已收到非空文本响应。',
                'preview': clean[:300], 'score': score, 'ms': int((time.monotonic() - started) * 1000)}
    except urllib.error.HTTPError as exc:
        try:
            message = {401: '鉴权失败', 403: '权限不足', 429: '服务限流或额度不足'}.get(exc.code, '接口未接受本次请求')
            return {'ok': False, 'state': 'failed', 'detail': f'{message}（HTTP {exc.code}）', 'ms': int((time.monotonic() - started) * 1000)}
        finally:
            exc.close()
    except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError):
        return {'ok': False, 'state': 'failed', 'detail': '连接超时、网络异常或响应格式无效；未自动重试。', 'ms': int((time.monotonic() - started) * 1000)}


class Service:
    def __init__(self, root: Path, resolver, allowed, *, clock=time.time, sender=dispatch):
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / 'model-health.sqlite3'
        self.resolver, self.allowed, self.clock, self.sender = resolver, allowed, clock, sender
        self.stopped = threading.Event()
        self.thread = None
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS calls (at REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS results (ref TEXT, mode TEXT, fingerprint TEXT, data TEXT, PRIMARY KEY(ref,mode))')
            db.execute('CREATE TABLE IF NOT EXISTS schedules (ref TEXT PRIMARY KEY, provider TEXT, interval INTEGER, prompt TEXT, enabled INTEGER, due REAL)')
            if 'fingerprint' not in {row[1] for row in db.execute('PRAGMA table_info(schedules)')}:
                db.execute("ALTER TABLE schedules ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def target(self, ref):
        if not isinstance(ref, str) or not ref or len(ref) > 500:
            raise HTTPException(400, '模型标识无效。')
        target = self.resolver(ref)
        if not target or not target.key or not target.base or target.protocol not in ('openai', 'anthropic', 'openai-responses'):
            raise HTTPException(400, '所选模型没有完整的已保存渠道配置，请先保存配置。')
        if not self.allowed(target.base):
            raise HTTPException(400, '已保存目标地址不可用于测试，请核对最终接口地址。')
        return target

    @staticmethod
    def prompt(value):
        if not isinstance(value, str) or len(value) > 2000:
            raise HTTPException(400, '测试提示词需为不超过 2000 字的文本。')
        return value.strip() or DEFAULT_PROMPT

    def _reserve(self, db, now):
        # SQLite BEGIN IMMEDIATE makes all tabs, workers and service copies
        # sharing this data directory observe the same rolling quota.
        db.execute('DELETE FROM calls WHERE at<=?', (now - 60,))
        calls = [row[0] for row in db.execute('SELECT at FROM calls ORDER BY at')]
        if len(calls) >= 2:
            raise HTTPException(429, {'message': '滚动 60 秒内最多测活 2 次，请稍后再试。',
                                      'retryAfterSeconds': max(1, int(calls[0] + 60 - now) + 1)})
        db.execute('INSERT INTO calls VALUES(?)', (now,))

    def reserve_legacy(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._reserve(db, self.clock())

    def probe(self, ref, mode='text', prompt='', *, automatic=False):
        if mode not in ('text', 'vision'):
            raise HTTPException(400, '测试类型仅支持 text / vision。')
        target = self.target(ref)
        prompt = self.prompt(prompt)
        now = self.clock()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if automatic:
                row = db.execute('SELECT enabled,due,interval,fingerprint FROM schedules WHERE ref=?', (ref,)).fetchone()
                if not row or not row[0] or row[1] > now:
                    return None
                if row[3] != target.fingerprint:
                    db.execute('UPDATE schedules SET enabled=0 WHERE ref=?', (ref,))
                    return None
                db.execute('UPDATE schedules SET due=? WHERE ref=?', (now + row[2], ref))
            existing = db.execute('SELECT data FROM results WHERE ref=? AND mode=?', (ref, mode)).fetchone()
            old = json.loads(existing[0]) if existing else {}
            if old.get('state') == 'running' and now - old.get('startedAt', 0) < 60:
                raise HTTPException(409, '该模型正在测试，请等本次完成。')
            self._reserve(db, now)
            running = {'modelRef': ref, 'mode': mode, 'state': 'running', 'startedAt': now, 'automatic': automatic}
            db.execute('INSERT OR REPLACE INTO results VALUES(?,?,?,?)', (ref, mode, target.fingerprint, json.dumps(running)))
        try:
            result = self.sender(target, prompt, mode)
        except Exception:
            result = {'ok': False, 'state': 'failed', 'detail': '测试未完成；未自动重试。'}
        result.update(modelRef=ref, mode=mode, testedAt=self.clock(), automatic=automatic)
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO results VALUES(?,?,?,?)', (ref, mode, target.fingerprint, json.dumps(result)))
        return result

    def configure(self, rows):
        if not isinstance(rows, list) or len(rows) > 32:
            raise HTTPException(400, '自动测活目标最多 32 项。')
        parsed, seen, counts = [], set(), {}
        for row in rows:
            if not isinstance(row, dict):
                raise HTTPException(400, '自动测活目标格式无效。')
            ref, interval, enabled = row.get('modelRef'), row.get('intervalSeconds', 300), row.get('enabled', False)
            if not isinstance(ref, str) or ref in seen or type(interval) is not int or not 60 <= interval <= 86400 or type(enabled) is not bool:
                raise HTTPException(400, '目标须唯一，间隔为 60–86400 秒，开关为布尔值。')
            target = self.target(ref)
            seen.add(ref)
            if enabled:
                counts[target.provider] = counts.get(target.provider, 0) + 1
                if counts[target.provider] > 2:
                    raise HTTPException(400, '同渠道最多启用 2 个自动测活模型。')
            parsed.append((ref, target.provider, interval, self.prompt(row.get('prompt', '')), int(enabled), target.fingerprint))
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = {row[0]: row[1:] for row in db.execute('SELECT ref,interval,prompt,enabled,due FROM schedules')}
            db.execute('DELETE FROM schedules')
            for ref, provider, interval, prompt, enabled, fingerprint in parsed:
                old = previous.get(ref)
                due = old[3] if old and old[:3] == (interval, prompt, enabled) else self.clock() + interval
                db.execute('INSERT INTO schedules VALUES(?,?,?,?,?,?,?)', (ref, provider, interval, prompt, enabled, due, fingerprint))
        return self.status()

    def status(self):
        now = self.clock()
        with self.connect() as db:
            rows = list(db.execute('SELECT ref,mode,fingerprint,data FROM results'))
            schedules = [{'modelRef': r[0], 'provider': r[1], 'intervalSeconds': r[2], 'prompt': r[3], 'enabled': bool(r[4]), 'nextAt': r[5]}
                         for r in db.execute('SELECT ref,provider,interval,prompt,enabled,due FROM schedules ORDER BY ref')]
        results = []
        for ref, mode, fingerprint, raw in rows:
            item = json.loads(raw)
            target = self.resolver(ref)
            if not target or target.fingerprint != fingerprint:
                item = {'modelRef': ref, 'mode': mode, 'state': 'unverified', 'detail': '配置已变化，需重新检测。'}
            elif item.get('state') == 'running' and now - item.get('startedAt', 0) >= 60:
                item.update(state='failed', ok=False, detail='上一次检测中断或超时，需重新检测。')
            item['stale'] = now - item.get('testedAt', now) > 900
            results.append(item)
        return {'results': results, 'schedules': schedules, 'limit': {'requests': 2, 'windowSeconds': 60, 'automaticModelsPerProvider': 2},
                'staleAfterSeconds': 900, 'serverTime': now}

    def tick(self):
        with self.connect() as db:
            rows = list(db.execute('SELECT ref,prompt,interval FROM schedules WHERE enabled=1 AND due<=? ORDER BY due,ref', (self.clock(),)))
        for ref, prompt, interval in rows:
            if self.stopped.is_set():
                return
            try:
                self.probe(ref, 'text', prompt, automatic=True)
            except HTTPException as exc:
                if exc.status_code == 429:
                    return
                with self.connect() as db:
                    db.execute('UPDATE schedules SET due=?,enabled=? WHERE ref=?',
                               (self.clock() + interval, 0 if exc.status_code == 400 else 1, ref))

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stopped.clear()
        def run():
            while not self.stopped.wait(5):
                try:
                    self.tick()
                except (sqlite3.Error, OSError):
                    pass
        self.thread = threading.Thread(target=run, name='easel-model-health', daemon=True)
        self.thread.start()

    def stop(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=25)
