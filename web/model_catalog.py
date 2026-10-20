"""Read public model limits; never send channel credentials or write runtime config."""
from __future__ import annotations

import json
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CATALOG_URL = 'https://openrouter.ai/api/v1/models'
TTL = 6 * 60 * 60
MAX_BYTES = 8 * 1024 * 1024
_LOCK = threading.Lock()
_MEMORY: dict[str, dict] = {}


def _rows(payload):
    rows = payload.get('data', []) if isinstance(payload, dict) else []
    return [{'id': row['id'], 'tokens': row['context_length']} for row in rows
            if isinstance(row, dict) and isinstance(row.get('id'), str)
            and len(row['id']) <= 300 and type(row.get('context_length')) is int
            and 1024 <= row['context_length'] <= 10_000_000] if isinstance(rows, list) else []


def _fetch():
    request = urllib.request.Request(CATALOG_URL, headers={'Accept': 'application/json', 'User-Agent': 'Easel-model-catalog/0.8.1'})
    with urllib.request.urlopen(request, timeout=3) as response:
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('Model catalog too large')
    rows = _rows(json.loads(raw))
    if not rows:
        raise ValueError('Empty model catalog')
    return rows


def catalog_reference(model_id: str, cache_dir: Path):
    """Refresh on reads after six hours. Keep a prior catalog during outages."""
    if not model_id or len(model_id) > 300:
        return None
    path = cache_dir / 'model-context-catalog.json'
    key, now = str(path.resolve()), time.time()
    with _LOCK:
        cache = _MEMORY.get(key)
        if cache is None:
            try:
                saved = json.loads(path.read_text(encoding='utf-8')) if path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_BYTES else {}
                stamp = saved.get('checkedAt', 0)
                cache = {'checkedAt': stamp if type(stamp) in (int, float) and 0 <= stamp <= now else 0,
                         'rows': _rows({'data': [{'id': r.get('id'), 'context_length': r.get('tokens')} for r in saved.get('rows', []) if isinstance(r, dict)]}), 'retryAt': 0}
            except (OSError, ValueError, TypeError, AttributeError):
                cache = {'checkedAt': 0, 'rows': [], 'retryAt': 0}
            _MEMORY[key] = cache
        if now - cache['checkedAt'] >= TTL and now >= cache.get('retryAt', 0):
            try:
                cache.update(rows=_fetch(), checkedAt=now, retryAt=0)
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = path.with_suffix('.tmp')
                    temporary.write_text(json.dumps({'checkedAt': now, 'rows': cache['rows']}), encoding='utf-8')
                    temporary.replace(path)
                except OSError:
                    pass  # In-memory refresh remains usable with read-only storage.
            except (OSError, ValueError):
                cache['retryAt'] = now + 300
        exact = [row for row in cache['rows'] if row['id'].lower() == model_id.lower()]
        matches = exact or [row for row in cache['rows'] if row['id'].partition('/')[2].lower() == model_id.lower()]
        limits = {row['tokens'] for row in matches}
        if len(limits) != 1:
            return None  # Ambiguous aliases never borrow a different model's limit.
        tokens = limits.pop()
        return dict(modelId=model_id, tokens=tokens, label=f'{tokens:,} Token', source='OpenRouter 公共模型目录',
                    url=CATALOG_URL, checkedAt=datetime.fromtimestamp(cache['checkedAt'], timezone.utc).isoformat(),
                    stale=now - cache['checkedAt'] >= TTL,
                    note='公共目录标称窗口，不代表本渠道已开放；每6小时自动刷新，手动窗口优先。')
