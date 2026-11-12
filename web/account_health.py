"""Bounded, account-scoped login checks owned by the application, not a page.

Only local status metadata and notification IDs are persisted here. Existing
owned runners keep credentials, browser admission and account exclusion.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime
import json
import math
from pathlib import Path
import sqlite3
import time
import uuid

from fastapi import APIRouter
from easel.notifications import NotificationStore

INTERVAL = 300
FRESH_FOR = 600
TICK = 5


def stamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    except (AttributeError, TypeError, ValueError):
        return 0


class HealthStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.path, timeout=10)
        try:
            con.execute('CREATE TABLE IF NOT EXISTS account_health (key TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            con.execute('BEGIN IMMEDIATE')
            yield con
            con.commit()
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    def rows(self):
        with self.db() as con:
            return {key: json.loads(payload) for key, payload in con.execute('SELECT key,payload FROM account_health')}

    def change(self, key, update):
        with self.db() as con:
            old = con.execute('SELECT payload FROM account_health WHERE key=?', (key,)).fetchone()
            row = update(json.loads(old[0]) if old else {})
            con.execute('INSERT OR REPLACE INTO account_health VALUES (?,?)', (key, json.dumps(row, ensure_ascii=False)))
            return row

    def retain(self, keys):
        with self.db() as con:
            for key, in con.execute('SELECT key FROM account_health').fetchall():
                if key not in keys:
                    con.execute('DELETE FROM account_health WHERE key=?', (key,))


class AccountHealthService:
    def __init__(self, workspace, clock=time.time):
        self.w, self.clock = workspace, clock
        self.task = None
        self.stopping = None
        self.active = None
        self.last_scan = None
        self.scan_failed = False

    @property
    def store(self):
        return HealthStore(self.w.DATA_DIR / '.account-health.sqlite3')

    async def targets(self):
        defaults = await self.w.api_accounts()
        records = self.store.rows()
        targets = []
        for row in defaults:
            key = 'default:' + row['platform']
            if (not row['supported'] or not row.get('hasLocalSession')
                    or not (row.get('loggedIn') or row.get('identity') or key in records)):
                continue
            targets.append(dict(key=key, platform=row['platform'], label='默认账号',
                                source='default', binding=row['identityKey'], account=row))
        for row in await asyncio.to_thread(self.w._social_accounts.store.list):
            if row['status'] == 'logged_out' or not row.get('externalAccountId'):
                continue
            targets.append(dict(key='social:' + row['accountId'], platform=row['platform'],
                                accountId=row['accountId'], label=row['label'], source='independent',
                                binding=row['externalAccountId'], account=row))
        return defaults, targets

    def observe(self, target, state, *, checked_at=None, binding=None):
        at = int(self.clock() * 1000)
        if checked_at is not None and (not isinstance(checked_at, (int, float))
                or not math.isfinite(checked_at) or not 0 < checked_at <= at):
            # A corrupt/future proof cannot postpone the next real check.
            return self.store.rows().get(target['key'], {})
        checked_at = at if checked_at is None else checked_at
        def update(old):
            if checked_at <= old.get('checkedAt', 0) and old.get('binding') == (binding or target['binding']):
                return old
            failures = old.get('failures', 0) + 1 if state == 'unknown' else 0
            incident = old.get('incident', '')
            notices = list(old.get('outbox', []))
            title = self.w.LOGIN_RUNNERS[target['platform']]['name'] + ' · ' + target['label']
            problem = state in ('login_required', 'identity_changed') or state == 'unknown' and failures >= 2
            kind = old.get('incidentKind', '')
            notified = list(old.get('notifiedKinds', [kind] if incident and kind else []))
            if problem and state not in notified and (state != 'unknown' or not incident):
                incident, kind = incident or uuid.uuid4().hex, state
                notified.append(state)
                message = ('登录已失效，请重新连接。' if state == 'login_required' else
                           '平台身份不一致，已停止按原账号分发。' if state == 'identity_changed' else
                           '连续检查未能确认在线，请检查网络或重新核验；尚不能判定已退出。')
                notices.append(dict(id='account-health:' + incident + ':' + state, at=at, tone='error', read=False,
                                    message=title + '：' + message, target={'page': 'accounts', **(
                                        {'accountId': target['accountId']} if target.get('accountId') else
                                        {'platform': target['platform']})}))
            if state == 'online' and incident:
                notices.append(dict(id='account-health:' + incident + ':recovered', at=at, tone='success', read=False,
                                    message=title + '：在线核验已恢复。', target={'page': 'accounts', **(
                                        {'accountId': target['accountId']} if target.get('accountId') else
                                        {'platform': target['platform']})}))
                incident, kind, notified = '', '', []
            return dict(key=target['key'], binding=binding or target['binding'], state=state,
                        checkedAt=checked_at, lastOnlineAt=checked_at if state == 'online' else old.get('lastOnlineAt'),
                        nextCheckAt=(at if failures or state != 'online' else checked_at)
                        + (min(600, 60 * 2 ** min(failures - 1, 4)) if failures else INTERVAL) * 1000,
                        failures=failures, incident=incident, incidentKind=kind, notifiedKinds=notified, outbox=notices[-8:])
        return self.store.change(target['key'], update)

    def flush_notices(self):
        for key, row in self.store.rows().items():
            pending = row.get('outbox', [])
            if not pending:
                continue
            NotificationStore(self.w.OUTPUTS_DIR).add(pending)
            sent = {notice['id'] for notice in pending}
            self.store.change(key, lambda current: {**current, 'outbox': [n for n in current.get('outbox', []) if n['id'] not in sent]})

    def reconcile(self, targets):
        for target in targets:
            account = target['account']
            if target['source'] == 'default':
                proof = account.get('connection') or {}
                if proof.get('verified') is True:
                    state = 'online' if proof.get('loggedIn') else 'login_required'
                    self.observe(target, state, checked_at=proof.get('checkedAt'))
            elif not account.get('busy'):
                if account['status'] == 'ready' and stamp(account.get('checkedAt')):
                    self.observe(target, 'online', checked_at=stamp(account['checkedAt']))
                elif account['status'] in ('login_required', 'identity_changed'):
                    self.observe(target, account['status'], checked_at=stamp(account['updatedAt']))

    async def tick(self):
        _defaults, targets = await self.targets()
        self.reconcile(targets)
        self.store.retain({target['key'] for target in targets})
        rows = self.store.rows()
        targets.sort(key=lambda item: rows.get(item['key'], {}).get('nextCheckAt', 0))
        for target in targets:
            if self.stopping and self.stopping.is_set():
                break
            row = self.store.rows().get(target['key'], {})
            if (row.get('binding') == target['binding']
                    and row.get('checkedAt', 0) <= self.clock() * 1000 < row.get('nextCheckAt', 0)):
                continue
            if target['account'].get('busy'):
                continue
            self.active = target['key']
            lease = None
            try:
                if target['source'] == 'default':
                    platform = target['platform']
                    epoch = self.w._account_check_generation(platform)
                    pool = getattr(self.w.app.state, 'server_pools', {}).get('browser')
                    lease = pool.acquire() if pool else None
                    result = await self.w.api_account_whoami(platform, force=True)
                    if epoch != self.w._account_check_generation(platform):
                        continue
                    state = ('online' if result.get('loggedIn') else 'login_required') if result.get('verified') else 'unknown'
                    self.observe(target, state, binding=self.w._account_identity_key(platform))
                else:
                    result = await asyncio.to_thread(self.w._social_accounts.check, target['accountId'])
                    current = self.w._social_accounts.store.get(target['accountId'])
                    if current['generation'] != result['generation']:
                        continue
                    self.observe(target, {'ready': 'online', 'login_required': 'login_required',
                                          'identity_changed': 'identity_changed'}.get(result['status'], 'unknown'))
            except Exception as exc:
                # Busy admission is deferred, never called logout or check failure.
                if target['source'] == 'independent':
                    current = self.w._social_accounts.store.get(target['accountId'])
                    if (current['generation'] == target['account']['generation'] + 1
                            and current['status'] == 'error'):
                        self.observe(target, 'unknown')
                elif getattr(exc, 'status_code', None) not in (409, 429, 503):
                    self.observe(target, 'unknown')
            finally:
                if lease:
                    lease.release()
                self.active = None
                self.flush_notices()
        self.flush_notices()
        self.last_scan = int(self.clock() * 1000)
        self.scan_failed = False

    async def snapshot(self):
        defaults, targets = await self.targets()
        self.reconcile(targets)
        records, at = self.store.rows(), int(self.clock() * 1000)
        accounts = []
        for target in targets:
            row = records.get(target['key'], {})
            state = row.get('state', 'unknown')
            if row.get('binding') != target['binding'] or state == 'online' and not 0 <= at - row.get('checkedAt', 0) < FRESH_FOR * 1000:
                state = 'unknown'
            accounts.append({key: target[key] for key in ('key', 'source', 'platform', 'label', 'accountId') if key in target} | dict(
                state=state, checkedAt=row.get('checkedAt'), lastOnlineAt=row.get('lastOnlineAt'),
                nextCheckAt=row.get('nextCheckAt'), checking=self.active == target['key'], busy=bool(target['account'].get('busy'))))
        return dict(accounts=accounts, defaultAccounts=defaults, active=self.active,
                    running=self.task is not None and not self.task.done(), scanFailed=self.scan_failed,
                    lastScanAt=self.last_scan, intervalSeconds=INTERVAL, freshForSeconds=FRESH_FOR, serverTime=at)

    def start(self):
        if self.task and not self.task.done():
            return
        self.stopping = asyncio.Event()
        async def run():
            while not self.stopping.is_set():
                try:
                    await self.tick()
                except Exception:
                    self.scan_failed = True
                try:
                    await asyncio.wait_for(self.stopping.wait(), TICK)
                except asyncio.TimeoutError:
                    pass
        self.task = asyncio.create_task(run())

    async def stop(self):
        if self.stopping:
            self.stopping.set()
        if self.task:
            await self.task  # Runners have bounded timeouts; do not abandon a live profile owner.

    def router(self):
        router = APIRouter()
        @router.get('/api/account-health')
        async def status():
            from fastapi.responses import JSONResponse
            return JSONResponse(await self.snapshot(), headers={'Cache-Control': 'no-store'})
        return router
