"""Account-scoped registry, login audit and confirmed distribution ledger.

Only identifiers and controlled status messages belong here. Browser profiles,
QR images and subprocess logs are stored separately and are never API fields.
SQLite transactions reserve an account before any external operation starts.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import uuid

ID = re.compile(r'^[0-9a-f]{32}$')
EXTERNAL_ID = re.compile(r'^[0-9a-f]{24}$')
PLATFORMS = frozenset({'xiaohongshu', 'douyin', 'kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'wechat-oa'})


def valid_external(platform: str, value) -> bool:
    if not isinstance(value, str):
        return False
    if platform == 'xiaohongshu':
        return bool(EXTERNAL_ID.fullmatch(value))
    return bool(re.fullmatch(r'[A-Za-z0-9_.:@-]{1,128}', value))
BUSY = {'connecting', 'checking', 'logging_out'}


class AccountError(Exception):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


class SocialStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.path, timeout=15)
        con.row_factory = sqlite3.Row
        try:
            con.execute('PRAGMA foreign_keys=ON')
            con.executescript('''
                CREATE TABLE IF NOT EXISTS accounts (
                    accountId TEXT PRIMARY KEY, platform TEXT NOT NULL,
                    label TEXT NOT NULL, externalAccountId TEXT NOT NULL DEFAULT '',
                    name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'logged_out',
                    generation INTEGER NOT NULL DEFAULT 0, attemptId TEXT NOT NULL DEFAULT '',
                    checkedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS login_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, accountId TEXT NOT NULL REFERENCES accounts(accountId),
                    attemptId TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL,
                    message TEXT NOT NULL, at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS distribution_batches (
                    batchId TEXT PRIMARY KEY, requestKey TEXT UNIQUE NOT NULL,
                    payloadHash TEXT NOT NULL, createdAt TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS distribution_jobs (
                    jobId TEXT PRIMARY KEY, batchId TEXT NOT NULL REFERENCES distribution_batches(batchId),
                    accountId TEXT NOT NULL REFERENCES accounts(accountId), generation INTEGER NOT NULL,
                    externalAccountId TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
                    outcome TEXT, receiptId TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
                    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS social_jobs_account ON distribution_jobs(accountId,state);
                CREATE TABLE IF NOT EXISTS distribution_assets (
                    jobId TEXT NOT NULL REFERENCES distribution_jobs(jobId),
                    source TEXT NOT NULL, digest TEXT NOT NULL,
                    PRIMARY KEY(jobId,source));
                CREATE INDEX IF NOT EXISTS social_events_account ON login_events(accountId,id);
                CREATE TABLE IF NOT EXISTS default_login_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL,
                    attemptId TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL,
                    message TEXT NOT NULL, at TEXT NOT NULL);
            ''')
            con.execute('BEGIN IMMEDIATE')
            yield con
            con.commit()
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    @staticmethod
    def _account(con, account_id):
        if not isinstance(account_id, str) or not ID.fullmatch(account_id):
            raise AccountError('未找到该本地账号。', 404)
        row = con.execute('SELECT * FROM accounts WHERE accountId=?', (account_id,)).fetchone()
        if row is None:
            raise AccountError('未找到该本地账号。', 404)
        return dict(row)

    @staticmethod
    def _event(con, account, action, state, message):
        con.execute('INSERT INTO login_events(accountId,attemptId,action,state,message,at) VALUES(?,?,?,?,?,?)',
                    (account['accountId'], account['attemptId'], action, state, message, now()))
        con.execute('DELETE FROM login_events WHERE accountId=? AND id NOT IN '
                    '(SELECT id FROM login_events WHERE accountId=? ORDER BY id DESC LIMIT 200)',
                    (account['accountId'], account['accountId']))

    @staticmethod
    def _ensure_idle(con, account):
        pending = con.execute("SELECT 1 FROM distribution_jobs WHERE accountId=? AND state IN ('queued','running')",
                              (account['accountId'],)).fetchone()
        if account['status'] in BUSY or pending:
            raise AccountError('该账号正在登录、核验或分发，请等待结束后再操作。')

    def create(self, label: str, platform: str = 'xiaohongshu') -> dict:
        if platform not in PLATFORMS:
            raise AccountError('该平台尚未接入多账号。', 400)
        label = label.strip()
        if not label or len(label) > 40 or any(ord(c) < 32 for c in label):
            raise AccountError('账号备注需为 1–40 个可见字符。', 400)
        with self.db() as con:
            if con.execute('SELECT count(*) FROM accounts WHERE platform=?', (platform,)).fetchone()[0] >= 20:
                raise AccountError('每个平台最多保留 20 个独立账号。', 400)
            if con.execute('SELECT 1 FROM accounts WHERE label=? AND platform=?', (label, platform)).fetchone():
                raise AccountError('账号备注已存在，请使用可区分的名称。', 400)
            identifier, stamp = uuid.uuid4().hex, now()
            con.execute('INSERT INTO accounts(accountId,platform,label,createdAt,updatedAt) VALUES(?,?,?,?,?)',
                        (identifier, platform, label, stamp, stamp))
            row = self._account(con, identifier)
            self._event(con, row, 'create', 'logged_out', '已建立独立账号槽，尚未连接平台。')
            return row

    def get(self, identifier: str) -> dict:
        with self.db() as con:
            return self._account(con, identifier)

    def list(self) -> list[dict]:
        with self.db() as con:
            rows = [dict(row) for row in con.execute('SELECT * FROM accounts ORDER BY createdAt,accountId')]
            for row in rows:
                row['busy'] = row['status'] in BUSY or bool(con.execute(
                    "SELECT 1 FROM distribution_jobs WHERE accountId=? AND state IN ('queued','running')",
                    (row['accountId'],)).fetchone())
            return rows

    def history(self, identifier: str) -> list[dict]:
        with self.db() as con:
            self._account(con, identifier)
            return [dict(row) for row in con.execute(
                'SELECT * FROM login_events WHERE accountId=? ORDER BY id DESC LIMIT 200', (identifier,))]

    def reserve(self, identifier: str, action: str) -> dict:
        statuses = {'login': 'connecting', 'check': 'checking', 'logout': 'logging_out'}
        if action not in statuses:
            raise ValueError('Invalid account action')
        with self.db() as con:
            account = self._account(con, identifier)
            self._ensure_idle(con, account)
            con.execute('UPDATE accounts SET generation=generation+1,attemptId=?,status=?,updatedAt=? WHERE accountId=?',
                        (uuid.uuid4().hex, statuses[action], now(), identifier))
            account = self._account(con, identifier)
            self._event(con, account, action, statuses[action], '操作已受理。')
            return account

    def finish(self, identifier: str, generation: int, action: str, status: str,
               message: str, identity: dict | None = None) -> dict:
        allowed = {'logged_out', 'unverified', 'ready', 'login_required', 'error', 'identity_changed'}
        if status not in allowed:
            raise ValueError('Invalid account status')
        with self.db() as con:
            account = self._account(con, identifier)
            if account['generation'] != generation:
                raise AccountError('账号状态已变化，旧操作结果已丢弃。')
            identity = identity or {}
            external = identity.get('externalAccountId', '')
            if status == 'ready':
                if not valid_external(account['platform'], external):
                    status, message = 'unverified', '已登录但未读到可靠的平台账号编号，不能分发。'
                elif account['externalAccountId'] and account['externalAccountId'] != external:
                    status, message = 'identity_changed', '平台身份与该账号记录不一致；请连接原账号，或新增账号槽。'
                elif con.execute('SELECT 1 FROM accounts WHERE platform=? AND externalAccountId=? AND accountId<>?',
                                 (account['platform'], external, identifier)).fetchone():
                    status, message = 'identity_changed', '该平台账号已绑定另一账号槽，请使用已有记录。'
                else:
                    con.execute('UPDATE accounts SET externalAccountId=?,name=?,checkedAt=? WHERE accountId=?',
                                (external, str(identity.get('name') or '')[:80], now(), identifier))
            con.execute('UPDATE accounts SET status=?,updatedAt=? WHERE accountId=?', (status, now(), identifier))
            account = self._account(con, identifier)
            self._event(con, account, action, status, message)
            return account

    def cancel(self, identifier: str, attempt_id: str) -> dict:
        with self.db() as con:
            account = self._account(con, identifier)
            if account['attemptId'] != attempt_id or account['status'] != 'connecting':
                raise AccountError('登录尝试已变化，未取消其他登录。')
            con.execute("UPDATE accounts SET generation=generation+1,status='unverified',updatedAt=? WHERE accountId=?",
                        (now(), identifier))
            self._event(con, account, 'cancel', 'unverified', '本次登录已取消；原有身份记录保留，使用前需重新核验。')
            return self._account(con, identifier)

    def batch(self, batch_id: str) -> dict:
        with self.db() as con:
            row = con.execute('SELECT batchId,createdAt FROM distribution_batches WHERE batchId=?', (batch_id,)).fetchone()
            if not row:
                raise AccountError('未找到分发批次。', 404)
            jobs = [dict(job) for job in con.execute('SELECT j.*,a.label AS accountLabel,a.platform AS platform FROM distribution_jobs j '
                    'JOIN accounts a ON a.accountId=j.accountId WHERE batchId=? ORDER BY j.rowid', (batch_id,))]
            for job in jobs:
                job['payload'] = json.loads(job['payload'])
                job['mediaHashes'] = dict(con.execute('SELECT source,digest FROM distribution_assets WHERE jobId=?', (job['jobId'],)))
            return {**dict(row), 'state': 'running' if any(j['state'] != 'finished' for j in jobs) else 'finished', 'jobs': jobs}

    def batches(self) -> list[dict]:
        with self.db() as con:
            ids = [row[0] for row in con.execute('SELECT batchId FROM distribution_batches ORDER BY rowid DESC LIMIT 20')]
        return [self.batch(identifier) for identifier in ids]

    def admit(self, requests: list[dict], request_key: str, media_hashes: dict | None = None) -> tuple[dict, bool]:
        if not ID.fullmatch(request_key) or not requests or len(requests) > 20:
            raise AccountError('请选择 1–20 个目标，并提供有效请求编号。', 400)
        digest = hashlib.sha256(json.dumps(requests, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        identifiers = [row['accountId'] for row in requests]
        if len(set(identifiers)) != len(identifiers):
            raise AccountError('同一账号不可在一个批次重复出现。', 400)
        with self.db() as con:
            existing = con.execute('SELECT * FROM distribution_batches WHERE requestKey=?', (request_key,)).fetchone()
            if existing:
                if existing['payloadHash'] != digest:
                    raise AccountError('请求编号已用于另一份确认稿，请重新确认。')
                batch_id, created = existing['batchId'], False
            else:
                accounts = [self._account(con, identifier) for identifier in identifiers]
                for account in accounts:
                    self._ensure_idle(con, account)
                    if account['status'] != 'ready' or not account['externalAccountId']:
                        raise AccountError('所有目标账号都需先在线核验；已保留内容。')
                batch_id, stamp, created = uuid.uuid4().hex, now(), True
                con.execute('INSERT INTO distribution_batches VALUES(?,?,?,?)', (batch_id, request_key, digest, stamp))
                for request, account in zip(requests, accounts):
                    job_id = uuid.uuid4().hex
                    con.execute('INSERT INTO distribution_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                        (job_id, batch_id, account['accountId'], account['generation'], account['externalAccountId'],
                         json.dumps(request['payload'], ensure_ascii=False), 'queued', None, uuid.uuid4().hex, '', stamp, stamp))
                    for source, digest in (media_hashes or {}).get(account['accountId'], {}).items():
                        con.execute('INSERT INTO distribution_assets VALUES(?,?,?)', (job_id, source, digest))
        return self.batch(batch_id), created

    def existing_request(self, requests: list[dict], request_key: str) -> dict | None:
        digest = hashlib.sha256(json.dumps(requests, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.db() as con:
            existing = con.execute('SELECT * FROM distribution_batches WHERE requestKey=?', (request_key,)).fetchone()
            if not existing:
                return None
            if existing['payloadHash'] != digest:
                raise AccountError('请求编号已用于另一份确认稿，请重新确认。')
            batch_id = existing['batchId']
        return self.batch(batch_id)

    def job_for_receipt(self, receipt_id):
        with self.db() as con:
            row = con.execute('SELECT * FROM distribution_jobs WHERE receiptId=?', (receipt_id,)).fetchone()
            return dict(row) if row else None

    def set_job(self, job_id: str, state: str, outcome: str | None = None, message: str = '') -> None:
        if state not in {'running', 'finished'}:
            raise ValueError('Invalid job state')
        with self.db() as con:
            con.execute("UPDATE distribution_jobs SET state=?,outcome=?,message=?,updatedAt=? WHERE jobId=? AND state<>'finished'",
                        (state, outcome, message[:600], now(), job_id))

    def claim_job(self, job_id: str) -> bool:
        with self.db() as con:
            return con.execute("UPDATE distribution_jobs SET state='running',updatedAt=? WHERE jobId=? AND state='queued'",
                               (now(), job_id)).rowcount == 1

    def default_event(self, platform: str, attempt_id: str, action: str, state: str) -> None:
        # Callers pass controlled states only, never subprocess text or credentials.
        messages = {'starting': '登录已启动。', 'qr_ready': '二维码已就绪。', 'scanned': '已扫码，等待确认。',
                    'verifying': '等待平台核验。', 'sms_required': '平台要求额外验证。',
                    'success': '登录流程完成，使用前仍需在线核验。', 'expired': '二维码或会话已过期。',
                    'cancelled': '本次登录已取消。', 'error': '操作未完成，请检查平台或浏览器环境。',
                    'ready': '在线核验确认账号已登录。', 'login_required': '在线核验确认账号未登录。',
                    'unverified': '未取得可靠在线结论，保留原有记录。', 'logged_out': '默认账号已退出。',
                    'superseded': '该尝试已被替代，未改变新登录。', 'credentials': '该平台使用独立凭据入口。'}
        if state not in messages:
            return
        with self.db() as con:
            last = con.execute('SELECT attemptId,action,state FROM default_login_events WHERE platform=? ORDER BY id DESC LIMIT 1',
                               (platform,)).fetchone()
            if last and tuple(last) == (attempt_id, action, state):
                return
            con.execute('INSERT INTO default_login_events(platform,attemptId,action,state,message,at) VALUES(?,?,?,?,?,?)',
                        (platform, attempt_id, action, state, messages[state], now()))
            con.execute('DELETE FROM default_login_events WHERE platform=? AND id NOT IN '
                        '(SELECT id FROM default_login_events WHERE platform=? ORDER BY id DESC LIMIT 200)', (platform, platform))

    def default_history(self) -> list[dict]:
        with self.db() as con:
            return [dict(row) for row in con.execute('SELECT * FROM default_login_events ORDER BY id DESC LIMIT 200')]

    def progress(self, account_id: str, generation: int, state: str) -> None:
        labels = {'starting': '正在启动登录。', 'qr_ready': '登录二维码已就绪。',
                  'scanned': '已扫码，等待手机确认。', 'verifying': '等待平台完成登录核验。',
                  'sms_required': '平台要求额外验证，请在官方页面处理。'}
        if state not in labels:
            return
        with self.db() as con:
            account = self._account(con, account_id)
            if account['generation'] != generation:
                return
            last = con.execute('SELECT state,attemptId FROM login_events WHERE accountId=? ORDER BY id DESC LIMIT 1',
                               (account_id,)).fetchone()
            if not last or last['state'] != state or last['attemptId'] != account['attemptId']:
                self._event(con, account, 'login', state, labels[state])

    def recover(self) -> list[dict]:
        with self.db() as con:
            interrupted = [dict(row) for row in con.execute("SELECT * FROM distribution_jobs WHERE state IN ('queued','running')")]
            for row in con.execute("SELECT * FROM accounts WHERE status IN ('connecting','checking','logging_out')").fetchall():
                self._event(con, dict(row), 'interrupted', 'unverified', '服务重启，旧操作已中断；请重新核验该账号。')
            con.execute("UPDATE accounts SET status='unverified',generation=generation+1 WHERE status IN ('connecting','checking','logging_out')")
            con.execute("UPDATE distribution_jobs SET state='finished',outcome='unverified',message=?,updatedAt=? WHERE state IN ('queued','running')",
                        ('服务重启，任务未继续提交；请先核对对应账号的作品结果，避免重复发布。', now()))
        return interrupted
