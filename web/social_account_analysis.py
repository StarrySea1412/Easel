"""Read-only analytics bound to an explicit local account, never the default profile."""
from __future__ import annotations

import math
import sys
from pathlib import Path

from content_analysis import Store, now
from content_analysis_sync import SUPPORTED, live_account_id, live_contents
from easel.social_accounts import AccountError, SocialStore


class AccountAnalysis:
    def __init__(self, service):
        self.service = service
        self.w = service.w

    def roots(self, account_id):
        self.service.store.get(account_id)
        return (Path(self.w.DATA_DIR).resolve(), Path(self.w.OUTPUTS_DIR).resolve(),
                Path(self.w.DATA_DIR).resolve() / 'social-accounts' / account_id)

    @staticmethod
    def state(account):
        return {'scope': {'platform': account['platform'], 'accountId': account['externalAccountId'] or None},
                'status': 'idle', 'supported': account['platform'] in SUPPORTED,
                'accountName': account['name'] or account['label'], 'loadedCount': 0,
                'totalCount': None, 'totalKnown': False, 'complete': False,
                'fetchedAt': None, 'retryable': True,
                'message': '点击读取该账号数据；仅使用此独立账号的登录资料。'}

    def read(self, account_id):
        account = self.service.store.get(account_id)
        _, output, root = self.roots(account_id)
        state = self.state(account)
        saved = Store(root / 'analysis').sync_state(account['platform'], account['externalAccountId'] or None)
        if saved:
            state.update({key: value for key, value in saved.items() if not key.startswith('_')})
        report = None
        if account['externalAccountId']:
            try:
                report = Store(output / '_analytics' / 'workbench').report(account['platform'], account['externalAccountId'])
            except LookupError:
                pass
        if report:
            state['loadedCount'] = report['overview']['contentCount']
        if account['status'] == 'analyzing':
            state.update(status='syncing', message='正在核验并读取此账号；上次数据保留。')
        elif account['status'] != 'ready':
            state.update(status='logged_out', message='该账号需连接并在线核验；历史数据保留，不代表当前在线。')
        return {'account': account, 'sync': state, 'report': report}

    def command(self, account_id):
        profile, _ = self.service.paths(account_id)
        platform = self.service.store.get(account_id)['platform']
        if platform in {'bilibili', 'wechat-oa'}:
            return self.service.command(account_id, 'stats')
        return [sys.executable, '-X', 'utf8', str(self.w.SHARED_SCRIPTS / 'account_stats.py'),
                'fetch', '--platform', platform, '--profile-base', str(profile), '--no-proxy']

    @staticmethod
    def summary(live):
        # Only allow public metrics into persisted API responses, not raw child logs/session data.
        result = {'fetchedAt': live.get('fetched_at') or now(), 'metrics': []}
        for key in ('followers', 'likes', 'posts', 'following'):
            value = live.get(key)
            result[key] = value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None
        for item in (live.get('metrics') or [])[:80]:
            if isinstance(item, dict):
                result['metrics'].append({key: str(item[key])[:150] if item.get(key) is not None else ''
                                          for key in ('label', 'value', 'vs')})
        return result

    def collect(self, account_id):
        data, output, root = self.roots(account_id)
        store = SocialStore(data / 'social-accounts' / 'registry.sqlite')
        before = store.get(account_id)
        if before['status'] != 'ready' or not before['externalAccountId']:
            raise AccountError('请先连接并在线核验这个独立账号，再读取数据。')
        account = store.reserve(account_id, 'analyze')
        state, terminal, identity = self.state(account), 'ready', None
        expected = account['externalAccountId']
        try:
            with self.service.browser_lease():
                self.ensure_current(account, data, output, store)
                identity = self.service.identity(self.service.execute(self.service.command(account_id, 'whoami')))
                if not identity['loggedIn']:
                    terminal = 'login_required'
                    raise AccountError('平台登录已失效，请重新连接此账号；历史数据保留。')
                if identity.get('externalAccountId') != expected:
                    terminal = 'identity_changed'
                    raise AccountError('在线身份与绑定账号不一致，未读取或写入分析数据。')
                result = self.service.execute(self.command(account_id), data_root=root, timeout=180)
                live = self.service.identity(result)
                self.ensure_current(account, data, output, store)
                if not live['loggedIn']:
                    terminal = 'login_required'
                    raise AccountError('读取时平台登录已失效，原有分析数据保留。')
                actual = live_account_id(live)
                if not actual:
                    terminal = 'unverified'
                    raise AccountError('采集器未返回稳定平台账号编号，无法确认归属，未写入分析库。')
                if actual != expected or live.get('platform') not in (None, account['platform']):
                    terminal = 'identity_changed'
                    raise AccountError('采集结果与绑定账号不一致，未写入分析库。')
                contents, skipped = live_contents(live, expected) if account['platform'] in SUPPORTED else ([], 0)
                overview = self.summary(live)
                if contents:
                    Store(output / '_analytics' / 'workbench').ingest({
                        'platform': account['platform'], 'accountId': expected,
                        'name': account['name'] or account['label'], 'contents': contents}, identity='live_verified')
                state.update(status='partial' if contents else 'empty' if account['platform'] in SUPPORTED else 'unsupported',
                             fetchedAt=now(), overview=overview, receivedCount=len(contents), skippedCount=skipped,
                             message=(f'已读取此独立账号概览及 {len(contents)} 篇作品；当前仅第一页，非完整历史。'
                                      if account['platform'] in SUPPORTED else '已读取此独立账号概览；此平台尚不支持稳定作品自动载入，可导入明确归属的记录。'))
                Store(root / 'analysis').save_sync_state(account['platform'], expected, state)
        except AccountError:
            if terminal == 'ready':
                terminal = 'error'
            raise
        except Exception:
            terminal = 'error'
            raise AccountError('此账号的数据读取未完成，请检查平台与网络后重试；历史数据保留。') from None
        finally:
            # Settle the captured registry only. Never touch a newly selected data directory.
            current = store.get(account_id)
            if current['generation'] == account['generation']:
                store.finish(account_id, account['generation'], 'analyze', terminal,
                             '账号分析读取完成。' if terminal == 'ready' else '账号分析未完成，历史数据保留。', identity)
        return self.read(account_id)

    def ensure_current(self, account, data, output, store):
        current = store.get(account['accountId'])
        if data != Path(self.w.DATA_DIR).resolve() or output != Path(self.w.OUTPUTS_DIR).resolve() \
                or current['generation'] != account['generation'] or current['status'] != 'analyzing':
            raise AccountError('账号或数据目录已变化，已丢弃旧读取结果；请刷新后重试。')
