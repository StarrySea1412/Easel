"""Resolve existing gateway credentials without creating, logging or weakening auth.

Gateway credentials are separate from model API keys and paired device tokens.
Only an explicit gateway SecretRef may read its exact team-store entry.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

from easel.openclaw_workspace import state_dir


@dataclass(frozen=True)
class GatewayCredentials:
    mode: str = ''
    token: str = field(default='', repr=False)
    password: str = field(default='', repr=False)
    source: str = 'unconfigured'

    def headers(self):
        if self.mode == 'trusted-proxy':
            return {}
        secret = self.password if self.mode == 'password' else self.token if self.mode == 'token' else self.token or self.password
        return {'Authorization': 'Bearer ' + secret} if secret else {}

    def environment(self, env):
        result = dict(env)
        # A missing explicit SecretRef must not silently fall back to a stale
        # inherited credential that the HTTP request deliberately did not use.
        result.pop('OPENCLAW_GATEWAY_TOKEN', None)
        result.pop('OPENCLAW_GATEWAY_PASSWORD', None)
        if self.token:
            result['OPENCLAW_GATEWAY_TOKEN'] = self.token
        if self.password:
            result['OPENCLAW_GATEWAY_PASSWORD'] = self.password
        return result

    def fingerprint(self):
        return hashlib.sha256((self.mode + '\0' + self.token + '\0' + self.password).encode()).hexdigest()

    def public(self):
        return {'mode': self.mode, 'hasToken': bool(self.token), 'hasPassword': bool(self.password), 'source': self.source}


def _string(value):
    if isinstance(value, str) and '\r' not in value and '\n' not in value:
        return value.strip()
    return ''


def _secret(value, env, root):
    if isinstance(value, str):
        match = re.fullmatch(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}', value.strip())
        return _string(env.get(match[1])) if match else _string(value)
    if not isinstance(value, dict):
        return ''
    name = value.get('id')
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
        return ''
    if value.get('source') == 'env':
        return _string(env.get(name))
    if value.get('source') == 'store':
        database = Path(root) / 'state' / 'openclaw.sqlite'
        if not database.is_file():
            return ''
        try:
            with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=2) as db:
                row = db.execute("SELECT value FROM secret_store_entries WHERE scope_kind='team' AND scope_id='' AND name=? AND deleted_at_ms IS NULL", (name,)).fetchone()
            return _string(row[0]) if row else ''
        except (OSError, sqlite3.Error):
            return ''
    # Never execute secret-provider commands or follow arbitrary file refs.
    return ''


def resolve_credentials(env=None, root=None):
    env = os.environ if env is None else env
    root = Path(root) if root is not None else Path(env.get('EASEL_OPENCLAW_STATE_DIR') or env.get('OPENCLAW_STATE_DIR') or state_dir())
    config_file = Path(env.get('OPENCLAW_CONFIG_PATH') or root / 'openclaw.json')
    try:
        config = json.loads(config_file.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        config = {}
    gateway = config.get('gateway', {}) if isinstance(config, dict) else {}
    gateway = gateway if isinstance(gateway, dict) else {}
    auth = gateway.get('auth', {})
    auth = auth if isinstance(auth, dict) else {}
    # Easel's gateway endpoints are local; never repurpose remote gateway
    # credentials or unrelated device/model credentials for that local endpoint.
    token = _secret(auth.get('token'), env, root)
    password = _secret(auth.get('password'), env, root)
    configured = bool(token or password)
    if not auth.get('token'):
        token = _string(env.get('OPENCLAW_GATEWAY_TOKEN'))
    if not auth.get('password'):
        password = _string(env.get('OPENCLAW_GATEWAY_PASSWORD'))
    return GatewayCredentials(_string(auth.get('mode')), token, password,
                              'configured_gateway' if configured else 'environment' if token or password else 'unconfigured')


def redact_gateway_text(value, credentials=None):
    text = str(value)
    credentials = credentials or resolve_credentials()
    for secret in (credentials.token, credentials.password):
        if secret:
            text = text.replace(secret, '[REDACTED]')
    text = re.sub(r'(?i)(bearer\s+)[^\s\"\']+', r'\1[REDACTED]', text)
    return re.sub(r'''(?ix)
        ((?:--)?(?:token|password|api[_-]?key|secret)["']?\s*[=: ]\s*)
        (?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)
    ''', r'\1[REDACTED]', text)


def gateway_error(raw='', *, status=None, fallback='agent_execution_failed'):
    message = str(raw).lower()
    if any(s in message for s in ('requires credentials before opening a websocket', 'gateway_credentials_required', 'gatewaysecretrefunavailable', 'gateway_secret_ref_unavailable')):
        code = 'gateway_auth_missing'
    elif any(s in message for s in ('not_paired', 'pairing required', 'device pairing', 'pair this device', 'scope-upgrade')):
        code = 'gateway_pairing_required'
    elif status in (401, 403) or any(s in message for s in ('unauthorized', 'token mismatch', 'auth_token_mismatch', 'password mismatch', 'authentication failed')):
        code = 'gateway_auth_rejected'
    elif status in (408, 504) or any(s in message for s in ('timed out', 'timeout', 'timeouterror')):
        code = 'gateway_timeout'
    elif any(s in message for s in ('econnrefused', 'connection refused', 'connecterror', 'connection reset', 'ehostunreach')):
        code = 'gateway_connection_failed'
    else:
        code = fallback
    messages = {
        'gateway_auth_missing': ('authentication', False, '当前网关未找到可用凭据。请检查正在使用的 OpenClaw 配置、网关 token/password 或设备配对；模型 API Key 不能代替网关凭据。'),
        'gateway_pairing_required': ('authentication', False, '网关要求设备配对或权限确认。请在当前 OpenClaw 环境完成授权后重试。'),
        'gateway_auth_rejected': ('authentication', False, '网关拒绝了当前凭据。请检查 Easel 与网关是否使用同一配置和凭据，然后重试。'),
        'gateway_timeout': ('timeout', True, '网关请求超时，请检查服务响应和网络后重试。'),
        'gateway_connection_failed': ('connection', True, '无法连接当前网关，请检查网关是否启动，以及主机和端口是否匹配。'),
        'gateway_request_failed': ('execution', True, '网关请求失败，请检查网关服务及接口配置后重试。'),
        'gateway_stream_interrupted': ('connection', True, '网关响应流未正常结束，已保留收到的内容，请检查连接后重试。'),
        'agent_execution_failed': ('execution', True, '本轮执行失败。请查看运行记录中的具体失败步骤后重试；仅凭退出码不能确定原因。'),
    }
    category, retryable, public_message = messages.get(code, messages['agent_execution_failed'])
    return {'code': code, 'category': category, 'retryable': retryable, 'message': public_message}
