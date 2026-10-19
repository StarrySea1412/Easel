"""Shared, opaque chat attachment identities (uploads and browser evidence)."""
import hashlib


def attachment_scope(session_id: str) -> str:
    value = session_id.strip()
    if not value or len(value) > 256:
        raise ValueError('无效的会话标识')
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:20]


def attachment_id(scope: str, path: str) -> str:
    return hashlib.sha256(f'{scope}\0{path}'.encode('utf-8')).hexdigest()[:24]
