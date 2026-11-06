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


def gateway_error(raw='', *, status=None, fallback='agent_execution_failed', include_detail=False):
    message = str(raw).lower()
    # Exact provider diagnostic, not a quoted model reply or a generic HTTP 404.
    unavailable = re.fullmatch(r'(?:Error:[ \t]*)?404 Model "[A-Za-z0-9_.:/+-]{1,300}" is not available for this group', str(raw))
    if unavailable or str(raw) == 'Easel AI Hub model unavailable for group':
        result = {'code': 'model_group_unavailable', 'category': 'configuration',
                  'retryable': False, 'stage': 'model_response', 'upstreamStatus': 404,
                  'upstreamReason': 'model_not_available_for_group',
                  'message': '渠道拒绝当前模型：此 API Key 所属分组无法使用该模型（HTTP 404）。请核对渠道分组权限及可调用模型；原请求未自动重发。'}
        if include_detail:
            result['detail'] = 'HTTP 404: model_not_available_for_group'
        return result
    # Preserve the actionable runtime rejection without echoing arbitrary CLI
    # output (which can contain credentials or private request contents).
    thinking = re.search(r'Thinking level "([a-z]+)" is not supported for ([A-Za-z0-9_.:/+-]{1,300})\. Use one of: ([a-z, ]+)\.', str(raw))
    if thinking:
        level, model, allowed = thinking.groups()
        legal = {'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra'}
        levels = [value.strip() for value in allowed.split(',') if value.strip() in legal]
        if level in legal and levels:
            return {'code': 'thinking_level_unsupported', 'category': 'configuration', 'retryable': False,
                    'modelRef': model, 'requestedThinkingLevel': level, 'supportedThinkingLevels': levels,
                    'message': f'当前模型 {model} 不支持思考档位 {level}。运行时允许：{", ".join(levels)}。请调整思考强度后重新发送；未自动降档或重试。'}
    if any(s in message for s in ('requires credentials before opening a websocket', 'gateway_credentials_required', 'gatewaysecretrefunavailable', 'gateway_secret_ref_unavailable')):
        code = 'gateway_auth_missing'
    elif any(s in message for s in ('not_paired', 'pairing required', 'device pairing', 'pair this device', 'scope-upgrade')):
        code = 'gateway_pairing_required'
    elif status in (401, 403) or any(s in message for s in ('unauthorized', 'token mismatch', 'auth_token_mismatch', 'password mismatch', 'authentication failed')):
        code = 'gateway_auth_rejected'
    elif re.fullmatch(r'(?:Error:[ \t]*)?(?:Connection error\.?|LLM request failed: network connection was interrupted\.?|Easel AI Hub connection interrupted)', str(raw)):
        code = 'model_provider_connection_failed'
    elif str(raw) == 'Easel AI Hub upstream rejected request':
        code = 'model_service_unavailable'
    elif re.match(r'^(?:Error:[ \t]*)?(?:Provider returned an incomplete or malformed tool call|Easel tool call recovery exhausted)\.?(?:\r?\n|$)', str(raw), re.I):
        # This is the adapter's explicit rejection, not a guess from model text
        # or usage counts. Do not promote quoted diagnostics or JSON failures.
        code = 'model_tool_call_invalid'
    elif re.match(r'^(?:Error:[ \t]*)?Easel model stream idle timeout\.?(?:\r?\n|$)', str(raw), re.I):
        code = 'model_stream_idle_timeout'
    elif re.match(r'^(?:Error:[ \t]*)?Easel request recovery exhausted\.?(?:\r?\n|$)', str(raw), re.I):
        code = 'model_recovery_stopped'
    elif status == 524 or re.match(r'^(?:Error:[ \t]*)?(?:(?:504|524) status code(?: \(no body\)|:.*)?|Easel provider request recovery stopped)\.?(?:\r?\n|$)', str(raw), re.I):
        code = 'model_provider_timeout'
    elif status in (408, 504) or any(s in message for s in ('timed out', 'timeout', 'timeouterror')):
        code = 'gateway_timeout'
    elif any(s in message for s in ('econnrefused', 'connection refused', 'connecterror', 'connection reset', 'ehostunreach', '[winerror 10054]', '[winerror 10061]', 'connectionreseterror', 'connectionabortederror')):
        code = 'gateway_connection_failed'
    elif 'stream ended before a terminal event' in message or 'stream ended before terminal' in message:
        code = 'model_stream_interrupted'
    elif re.fullmatch(r'\s*(?:aborted|cancelled|canceled)\s*', message):
        code = 'agent_request_aborted'
    elif status == 429 or any(s in message for s in (
            'rate limit', 'too many requests', '并发请求数限制', '最多同时处理', '请求频率超限', '请求过于频繁')):
        code = 'model_rate_limited'
    elif (status in (500, 502, 503) and fallback != 'gateway_request_failed') or 'overloaded' in message:
        code = 'model_service_unavailable'
    else:
        code = fallback
    messages = {
        'gateway_auth_missing': ('authentication', False, '当前网关未找到可用凭据。请检查正在使用的 OpenClaw 配置、网关 token/password 或设备配对；模型 API Key 不能代替网关凭据。'),
        'gateway_pairing_required': ('authentication', False, '网关要求设备配对或权限确认。请在当前 OpenClaw 环境完成授权后重试。'),
        'gateway_auth_rejected': ('authentication', False, '网关拒绝了当前凭据。请检查 Easel 与网关是否使用同一配置和凭据，然后重试。'),
        'gateway_timeout': ('timeout', True, '网关请求超时，请检查服务响应和网络后重试。'),
        'model_stream_idle_timeout': ('timeout', False, '本地等待模型流事件超时，Easel 已停止本轮等待；这不是模型总运行时限，也不能据此确定供应商是否仍在处理。此前工具结果保留，未自动重发原请求；请核对运行记录后继续。'),
        'model_recovery_stopped': ('execution', False, '旧版 Easel 已停止模型请求恢复。此诊断不能单独区分本地截止或渠道错误，也不代表已经重试；请结合当时的恢复审计确认原因。此前工具结果保留，未重放原任务。'),
        'model_provider_timeout': ('timeout', True, '模型渠道响应超时，本轮未完成，已停止自动恢复。此前已完成的工具结果保留；请核对原任务记录后再重试，持续出现时检查渠道状态或手动切换模型。'),
        'model_provider_connection_failed': ('connection', False, '模型渠道连接中断，本轮未完成。已保留收到的内容和此前工具结果；请核对运行记录后手动继续，反复出现时检查渠道状态或手动切换模型。'),
        'gateway_connection_failed': ('connection', True, '无法连接当前网关，请检查网关是否启动，以及主机和端口是否匹配。'),
        'gateway_request_failed': ('execution', True, '网关请求失败，请检查网关服务及接口配置后重试。'),
        'gateway_stream_interrupted': ('connection', True, '网关响应流未正常结束，已保留收到的内容，请检查连接后重试。'),
        'model_stream_interrupted': ('connection', True, '模型服务的响应流在结束事件到达前中断，本轮没有正常完成。已保留收到的内容；可手动重试，若重复出现请检查此渠道的流式接口兼容性或改用其他渠道。'),
        'model_tool_call_invalid': ('execution', False, '模型服务返回的工具调用不完整或格式无效，网关未派发该调用。此前已完成的工具结果保留，本轮不会自动重发；请核对执行记录后手动重试，重复出现时检查渠道的工具格式兼容性。'),
        'agent_request_aborted': ('execution', True, '网关报告本轮请求被中断（aborted），但没有说明由谁取消或中断原因。已保留收到的内容；请查看本轮失败详情，确认后手动重试。'),
        'model_rate_limited': ('execution', True, '模型服务限制了本次请求。请稍后重试，或检查当前渠道的额度与并发限制。'),
        'model_service_unavailable': ('connection', True, '模型服务暂不可用。请稍后手动重试，若持续失败请检查渠道状态。'),
        'agent_execution_failed': ('execution', True, '本轮执行失败。请查看运行记录中的具体失败步骤后重试；仅凭退出码不能确定原因。'),
    }
    category, retryable, public_message = messages.get(code, messages['agent_execution_failed'])
    result = {'code': code, 'category': category, 'retryable': retryable, 'message': public_message}
    if include_detail and str(raw).strip():
        detail = ('Provider returned an incomplete or malformed tool call'
                  if code == 'model_tool_call_invalid' else redact_gateway_text(raw))
        detail = re.sub(r'https?://[^\s"\']+', '[服务地址]', detail)
        detail = re.sub(r'\bsk-[A-Za-z0-9_-]+', '[REDACTED]', detail)
        result['detail'] = detail[:600]
    return result
