"""Successful account snapshots survive page navigation and Web restarts."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path


class AnalyticsSnapshots:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / 'account-snapshots.sqlite3'
        with sqlite3.connect(self.path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS snapshots (platform TEXT, identity_key TEXT, data TEXT NOT NULL, PRIMARY KEY(platform,identity_key))')

    def get(self, platform, identity_key):
        with sqlite3.connect(self.path) as db:
            row = db.execute('SELECT data FROM snapshots WHERE platform=? AND identity_key=?', (platform, identity_key)).fetchone()
        from account_metric_evidence import sanitize_metrics
        return sanitize_metrics(platform, json.loads(row[0])) if row else None

    def save(self, platform, identity_key, data):
        if data.get('loggedIn') is not True or data.get('error'):
            return
        with sqlite3.connect(self.path) as db:
            db.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?,?)', (platform, identity_key, json.dumps(data, ensure_ascii=False)))
