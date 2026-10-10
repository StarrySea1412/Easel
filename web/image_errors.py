"""Bounded, redacted image generation failures with actionable summaries."""
import re

from easel.gateway_auth import redact_gateway_text


def image_failure(raw, *, key='', timed_out=False):
    text = str(raw or '').strip()
    lower = text.lower()
    if 'no_available_account' in lower:
        code, message = 'provider_no_account', '图片渠道当前没有可用的上游账号（HTTP 503）。请更换图片渠道，或联系服务商恢复账号。'
    elif 'modulenotfounderror' in lower or 'importerror' in lower:
        code, message = 'runtime_dependency', '生图运行组件缺失。请使用修复版便携包；重试同一安装无法解决。'
    elif '10060' in lower or any(s in lower for s in ('connection timed out', '无法连接接口', 'connection refused', 'getaddrinfo failed')):
        code, message = 'connection_failed', '无法连接图片服务。请检查网络、代理和渠道地址，或更换图片渠道后再试。'
    elif timed_out or any(s in lower for s in ('timed out', 'timeout', '超时')):
        code, message = 'provider_timeout', '等待图片服务响应超时。请检查渠道状态和网络，再手动重试；服务端可能仍在处理本次请求。'
    elif re.search(r'http\s*(?:401|403)', lower):
        code, message = 'authentication', '图片服务拒绝了鉴权。请检查该图片渠道的 API Key 和调用权限。'
    elif '429' in lower:
        code, message = 'rate_limited', '图片服务限流或额度不足。请检查额度，稍后手动重试。'
    elif 'does not support size' in lower:
        code, message = 'unsupported_size', '当前图片模型不支持所选尺寸。请选择其他画面比例，或更换图片模型后重试。'
    elif re.search(r'http\s*5\d\d', lower):
        code, message = 'provider_unavailable', '图片服务暂时不可用。请稍后手动重试，或更换图片渠道。'
    else:
        code, message = 'generation_failed', '本次图片生成未完成。请查看服务详情，核对图片渠道与模型后再试。'
    detail = text.replace(key, '[已隐藏]') if key else text
    detail = redact_gateway_text(detail)
    detail = re.sub(r'https?://[^\s"\'<>]+', '[图片服务地址]', detail)
    detail = re.sub(r'\bsk-[A-Za-z0-9_-]+', '[已隐藏]', detail)
    return {'error': message, 'errorCode': code, 'errorDetail': detail[-1600:]}
