"""Successful account snapshots survive page navigation and Web restarts."""
from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path


WINDOWS = {'last': None, 'day': 1, 'week': 7, 'month': 30, 'year': 365}


def overview(data):
    from content_analysis_sync import live_account_id
    account_id = live_account_id(data)
    ts = data.get('fetched_at')
    if not account_id or type(ts) not in (int, float) or not math.isfinite(ts) or ts <= 0:
        return None
    return {'account_id': account_id, 'ts': ts, **{
        key: value if type(value := data.get(key)) is int and value >= 0 else None
        for key in ('followers', 'likes', 'posts')}}


def growth(history, current):
    """Use only this account's older observations, with a bounded baseline gap."""
    result = dict.fromkeys(WINDOWS)
    older = sorted((row for row in history if row['ts'] < current['ts']), key=lambda row: row['ts'])
    for window, days in WINDOWS.items():
        candidates = older if days is None else [row for row in older
            if current['ts'] - (days + max(1, days * .1)) * 86400 < row['ts'] <= current['ts'] - days * 86400]
        if not candidates:
            continue
        base = candidates[-1]
        result[window] = {key: current[key] - base[key]
                          if current[key] is not None and base[key] is not None else None
                          for key in ('followers', 'likes', 'posts')}
        result[window].update(baseline_at=base['ts'], current_at=current['ts'],
                              since_days=round((current['ts'] - base['ts']) / 86400, 1))
    return result


class AnalyticsSnapshots:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / 'account-snapshots.sqlite3'
        with sqlite3.connect(self.path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS snapshots (platform TEXT, identity_key TEXT, data TEXT NOT NULL, PRIMARY KEY(platform,identity_key))')
            db.execute('''CREATE TABLE IF NOT EXISTS overview_history (
                platform TEXT, identity_key TEXT, account_id TEXT, ts REAL,
                followers INTEGER, likes INTEGER, posts INTEGER,
                PRIMARY KEY(platform,identity_key,account_id,ts))''')

    def _growth(self, db, platform, identity_key, data):
        current = overview(data)
        if not current:
            # Existing payloads without collection timestamps remain readable.
            return {**data, 'growth': dict.fromkeys(WINDOWS), 'growthSchema': 'account-history-v1'} if 'growth' in data else data
        db.row_factory = sqlite3.Row
        history = db.execute('''SELECT ts,followers,likes,posts FROM overview_history
            WHERE platform=? AND identity_key=? AND account_id=? AND ts<? ORDER BY ts''',
            (platform, identity_key, current['account_id'], current['ts'])).fetchall()
        return {**data, 'growth': growth(history, current), 'growthSchema': 'account-history-v1'}

    def get(self, platform, identity_key):
        with sqlite3.connect(self.path) as db:
            row = db.execute('SELECT data FROM snapshots WHERE platform=? AND identity_key=?', (platform, identity_key)).fetchone()
            if not row:
                return None
            data = self._growth(db, platform, identity_key, json.loads(row[0]))
        from account_metric_evidence import sanitize_metrics
        return sanitize_metrics(platform, data)

    def save(self, platform, identity_key, data):
        if data.get('loggedIn') is not True or data.get('error'):
            return data
        with sqlite3.connect(self.path) as db:
            # An older scoped success can seed history; unscoped platform JSONL cannot.
            previous = db.execute('SELECT data FROM snapshots WHERE platform=? AND identity_key=?', (platform, identity_key)).fetchone()
            for candidate in ([json.loads(previous[0])] if previous else []) + [data]:
                snap = overview(candidate)
                if identity_key and snap and any(snap[key] is not None for key in ('followers', 'likes', 'posts')):
                    db.execute('INSERT OR REPLACE INTO overview_history VALUES(?,?,?,?,?,?,?)',
                               (platform, identity_key, snap['account_id'], snap['ts'],
                                snap['followers'], snap['likes'], snap['posts']))
            data = self._growth(db, platform, identity_key, data)
            db.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?,?)', (platform, identity_key, json.dumps(data, ensure_ascii=False)))
        return data
