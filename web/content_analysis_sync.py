"""Reuse authenticated collectors without pretending their first page is full history."""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from content_analysis import Store, now, scope, timestamp

SUPPORTED = {'xiaohongshu', 'bilibili'}
CACHE_SECONDS = 15 * 60
UNSUPPORTED = '当前平台采集器尚未同时返回稳定账号 ID 和作品 ID，不能安全自动载入；可先导出平台数据再导入。'
SUCCESS = {'ready', 'partial', 'empty'}


def live_account_id(live):
    value = live.get('accountId')
    if not value and isinstance(live.get('account'), dict):
        account = live['account']
        if account.get('source') == 'import' or account.get('verified') is False:
            return ''
        # The evidence layer's id can be live:<id>; externalId is the platform id.
        value = account.get('externalId') or account.get('id')
    return str(value).strip() if isinstance(value, (str, int)) and not isinstance(value, bool) else ''


def live_contents(live, account_id):
    """Only structured records; never derive identity from nickname, title or row position."""
    notes = live.get('notes')
    if not isinstance(notes, list) or len(notes) > 2000 or any(not isinstance(n, dict) for n in notes):
        raise ValueError('平台作品列表格式无效，原有数据已保留')
    result, skipped, seen = [], 0, set()
    fetched_at = timestamp(live.get('fetched_at'), default=now())
    for note in notes:
        declared = note.get('accountId') or note.get('account_id')
        if declared and str(declared) not in {account_id, 'live:' + account_id}:
            raise ValueError('作品账号与平台核验账号不符，未写入分析库')
        ident = note.get('id') or note.get('note_id') or note.get('noteId') or note.get('bvid')
        if not isinstance(ident, (str, int)) or isinstance(ident, bool) or not str(ident).strip():
            skipped += 1
            continue
        ident = str(ident).strip()
        if ident in seen:
            skipped += 1
            continue
        seen.add(ident)
        item = {'id': ident, 'title': note.get('title') or '未提供标题',
                'metrics': note.get('metrics') or {}, 'snapshotAt': fetched_at, 'period': 'unknown'}
        # A metric refresh does not erase materials previously supplied by the operator.
        for key in ('tags', 'body'):
            if note.get(key):
                item[key] = note[key]
        result.append(item)
    return result, skipped


class SyncService:
    def __init__(self, root_getter, capture, session_getter=None, generation_getter=None):
        self.root_getter = root_getter
        self.capture = capture
        self.session_getter = session_getter
        self.generation_getter = generation_getter or (lambda platform: '')
        self.tasks = {}

    def _store(self):
        return Store(Path(self.root_getter()))

    def _base(self, platform, account_id=None):
        accounts = self._store().accounts()
        saved = next((a for a in accounts if a['platform'] == platform and a['accountId'] == account_id), None)
        return {'scope': {'platform': platform, 'accountId': account_id},
                'status': 'idle' if platform in SUPPORTED else 'unsupported',
                'supported': platform in SUPPORTED, 'accountName': saved['name'] if saved else '',
                'loadedCount': saved['contentCount'] if saved else 0,
                'receivedCount': 0, 'skippedCount': 0, 'totalCount': None, 'totalKnown': False,
                'complete': False, 'fetchedAt': None, 'startedAt': None, 'finishedAt': None,
                'pagesFetched': None, 'pageLimit': 20, 'cached': False, 'cacheExpiresAt': None,
                'retryable': platform in SUPPORTED,
                'message': '登录账号后将自动载入平台当前可读取的作品。' if platform in SUPPORTED else UNSUPPORTED}

    def _public(self, state, *, cached=False, report=False):
        value = {k: v for k, v in state.items() if not k.startswith('_')}
        value['cached'] = cached
        account_id = value['scope']['accountId']
        if account_id:
            saved = next((a for a in self._store().accounts() if a['platform'] == value['scope']['platform'] and a['accountId'] == account_id), None)
            value['loadedCount'] = saved['contentCount'] if saved else 0
            if report and saved:
                value['report'] = self._store().report(value['scope']['platform'], account_id)
        return value

    def _cached_state(self, platform, account_id):
        state = self._store().sync_state(platform, account_id)
        if state and state.get('_generation') == self.generation_getter(platform):
            return state
        return None

    def status(self, platform, account_id=None):
        scope(platform, account_id or '__discover__')
        if platform not in SUPPORTED:
            return self._base(platform, account_id)
        key = (str(Path(self.root_getter()).resolve()), platform)
        active = self.tasks.get(key)
        if active:
            pending_id, _, pending = active
            if account_id is None or pending_id == account_id:
                return self._public(pending)
        cached = self._cached_state(platform, account_id)
        # An interrupted process cannot leave a permanently spinning persisted status.
        if cached and cached['status'] != 'syncing':
            return self._public(cached, cached=True)
        return self._base(platform, account_id)

    async def sync(self, platform, account_id=None, *, force=False):
        scope(platform, account_id or '__discover__')
        if type(force) is not bool:
            raise ValueError('force 必须为布尔值')
        if platform not in SUPPORTED:
            return self._base(platform, account_id)
        # Local session markers are a prerequisite, never proof of current platform identity.
        if self.session_getter is not None and self.session_getter(platform) is not True:
            return {**self._base(platform, account_id), 'status': 'logged_out',
                    'message': '请先在账号管理登录并核验该平台账号，再载入作品。'}
        cached = self._cached_state(platform, account_id)
        if not force and cached and cached['status'] in SUCCESS and 0 <= time.time() - cached.get('_savedAt', 0) < CACHE_SECONDS:
            return self._public(cached, cached=True, report=True)
        root = Path(self.root_getter()).resolve()
        key = (str(root), platform)
        active = self.tasks.get(key)
        if active:
            pending_id, task, _ = active
            if pending_id != account_id:
                return {**self._base(platform, account_id), 'status': 'syncing',
                        'message': '该平台正在载入另一个账号的作品，请等待完成后再刷新。'}
            return await asyncio.shield(task)
        state = {**self._base(platform, account_id), 'status': 'syncing', 'startedAt': now(),
                 'message': '正在核验账号并读取平台当前返回的作品；已有数据会保留。',
                 '_generation': self.generation_getter(platform)}
        self._store().save_sync_state(platform, account_id, state)
        task = asyncio.create_task(self._collect(root, platform, account_id, state))
        self.tasks[key] = (account_id, task, state)
        def clear_completed(completed):
            if self.tasks.get(key, (None, None))[1] is completed:
                self.tasks.pop(key, None)
        task.add_done_callback(clear_completed)
        try:
            return await asyncio.shield(task)
        finally:
            if task.done() and self.tasks.get(key, (None, None))[1] is task:
                self.tasks.pop(key, None)

    async def _collect(self, root, platform, requested_id, state):
        try:
            live = await self.capture(platform)
            if root != Path(self.root_getter()).resolve():
                raise HTTPException(409, '账号或数据目录已切换，已丢弃旧载入结果；请刷新后重试。')
            current_generation = self.generation_getter(platform)
            if state['_generation'] != current_generation:
                # A platform-confirmed logout and a missing local session agree. It is
                # safe to report that fact (without writing content) in the new scope.
                if isinstance(live, dict) and live.get('loggedIn') is False and not live.get('error') \
                        and self.session_getter is not None and self.session_getter(platform) is False:
                    state['_generation'] = current_generation
                else:
                    raise HTTPException(409, '账号或数据目录已切换，已丢弃旧载入结果；请刷新后重试。')
            if not isinstance(live, dict) or live.get('error'):
                raise ValueError('平台作品读取未完成，请检查登录状态和网络后重试。')
            if live.get('loggedIn') is not True:
                state.update(status='logged_out', message='平台登录已失效，请重新登录；已有作品数据已保留。')
            else:
                actual_id = live_account_id(live)
                if not actual_id:
                    state.update(status='identity_unverified', message='平台未返回稳定账号 ID，无法确认作品归属；请重新核验账号或导入数据。')
                else:
                    scope(platform, actual_id)
                    if requested_id is not None and actual_id != requested_id:
                        state.update(status='account_mismatch', connectedAccountId=actual_id,
                                     connectedAccountName=str(live.get('nickname') or '')[:200],
                                     message='当前登录账号与所选分析账号不同，未向所选账号写入作品；请选择当前登录账号后重新载入。')
                    else:
                        state['scope']['accountId'] = actual_id
                        state['accountName'] = str(live.get('nickname') or actual_id)[:200]
                        contents, skipped = live_contents(live, actual_id)
                        if contents:
                            self._store().ingest({'platform': platform, 'accountId': actual_id,
                                                  'name': state['accountName'], 'contents': contents}, identity='live_verified')
                        # Only Bilibili's authenticated archives API provides an exact total.
                        # Other collectors parse page text; their overview count is not pagination evidence.
                        total = live.get('posts') if platform == 'bilibili' else None
                        total = total if type(total) is int and 0 <= total <= 10**18 else None
                        state.update(receivedCount=len(contents), skippedCount=skipped,
                                     totalCount=total, totalKnown=total is not None,
                                     fetchedAt=timestamp(live.get('fetched_at'), default=now()), pagesFetched=1,
                                     status='partial' if contents else 'empty',
                                     message=(f'本次载入 {len(contents)} 篇作品，当前只读取第一页（最多 20 篇），尚未读取完整历史。'
                                              if contents else '本次没有返回可确认 ID 的作品，不能据此判断账号没有作品；可刷新或导入数据。'))
                        if skipped:
                            state['message'] += f' {skipped} 条缺少或重复稳定 ID 的记录未载入。'
        except HTTPException as exc:
            # Do not leak child-process output, login state, cookies or URLs into the UI.
            detail = ('账号状态已变化，已丢弃旧载入结果；请刷新后重试。' if exc.status_code == 409
                      else '平台作品读取超时，请稍后刷新；已有数据已保留。' if exc.status_code == 504
                      else '平台作品读取未完成，请检查登录状态和网络后重试；已有数据已保留。')
            state.update(status='error', message=detail)
        except (ValueError, TypeError, OSError):
            state.update(status='error', message='平台返回的账号或作品数据无法核验，未更新作品；请检查登录状态后重试。')
        except Exception:
            state.update(status='error', message='平台作品读取未完成，请稍后刷新；已有数据已保留。')
        state.update(finishedAt=now(), _savedAt=time.time())
        if state['status'] in SUCCESS:
            state['cacheExpiresAt'] = datetime.fromtimestamp(state['_savedAt'] + CACHE_SECONDS, timezone.utc).isoformat(timespec='seconds')
        # Saving state to the captured root cannot pollute a newly selected data directory.
        persisted = Store(root)
        persisted.save_sync_state(platform, requested_id, state)
        actual_id = state['scope']['accountId']
        if actual_id and state['status'] in SUCCESS:
            persisted.save_sync_state(platform, actual_id, state)
            persisted.save_sync_state(platform, None, state)
        key = (str(root), platform)
        self.tasks.pop(key, None)
        if root != Path(self.root_getter()).resolve():
            return {**self._base(platform, requested_id), 'status': 'error',
                    'message': '数据目录已切换，已丢弃旧载入结果；请刷新后重试。'}
        return self._public(state, report=state['status'] in SUCCESS)
