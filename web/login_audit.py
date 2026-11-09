"""Persist controlled lifecycle events for legacy default-account login pages."""
from functools import wraps
import sys
import uuid

from easel.social_accounts import SocialStore


def audit_default(action):
    def decorate(call):
        @wraps(call)
        async def audited(*args, **kwargs):
            workspace = sys.modules[call.__module__]
            platform = kwargs.get('platform') or (args[0] if args else 'wechat-oa')
            attempt = kwargs.get('attemptId') or (args[1] if action == 'cancel' and len(args) > 1 else uuid.uuid4().hex)

            def record(state, attempt_id=attempt):
                try:
                    SocialStore(workspace.DATA_DIR / 'social-accounts' / 'registry.sqlite').default_event(
                        platform, attempt_id, action, state)
                except Exception:
                    # Login/cleanup must still settle if audit storage fails.
                    print('默认账号登录记录保存失败，请检查数据目录。', file=sys.stderr)

            try:
                result = await call(*args, **kwargs)
            except Exception:
                if action != 'poll':
                    record('error')
                raise
            if isinstance(result, dict):
                attempt = result.get('attemptId') or attempt
                if action == 'check':
                    state = ('ready' if result.get('loggedIn') else 'login_required') if result.get('verified') else 'unverified'
                    if result.get('checkedAt'):
                        attempt = uuid.uuid5(uuid.NAMESPACE_URL, f"{platform}:{result['checkedAt']}").hex
                elif action == 'logout':
                    state = 'logged_out' if result.get('ok') else 'error'
                else:
                    state = result.get('state') or result.get('mode') or 'starting'
                # Polls share the owned attempt, preventing one row per HTTP poll.
                if action != 'poll' or result.get('attemptId'):
                    record(state, attempt)
            return result
        return audited
    return decorate


def install_default_audit(workspace):
    actions = {'api_login_start': 'login', 'api_login_status': 'poll', 'api_login_cancel': 'cancel',
               'api_mp_login_start': 'login', 'api_mp_login_status': 'poll',
               'api_account_whoami': 'check', 'api_logout': 'logout'}
    for name, action in actions.items():
        original = getattr(workspace, name)
        wrapped = audit_default(action)(original)
        setattr(workspace, name, wrapped)
        for route in workspace.app.routes:
            if getattr(route, 'endpoint', None) is original:
                route.endpoint = route.dependant.call = wrapped
