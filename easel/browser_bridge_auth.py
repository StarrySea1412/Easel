"""Short-lived, request-bound authentication for the local browser CLI."""
from __future__ import annotations

import hashlib
import hmac
import re
import time

HEADER = 'X-Easel-Browser-Bridge'
MAX_BODY = 65536
TOOL_PATH = re.compile(r'/api/browser/sessions/[A-Za-z0-9_.-]{1,200}/agent/tool\Z')


def signature(key: bytes, path: str, body: bytes, issued: int) -> str:
    derived = hmac.new(key, b'easel-browser-bridge-v1', hashlib.sha256).digest()
    message = f'POST\n{path}\n{issued}\n{hashlib.sha256(body).hexdigest()}'.encode()
    return hmac.new(derived, message, hashlib.sha256).hexdigest()


def sign(key: bytes, path: str, body: bytes) -> str:
    issued = int(time.time())
    return f'{issued}.{signature(key, path, body, issued)}'


def verify(key: bytes, path: str, body: bytes, token: str) -> bool:
    if not TOOL_PATH.fullmatch(path) or len(body) > MAX_BODY:
        return False
    if not re.fullmatch(r'[0-9]{1,12}\.[a-f0-9]{64}', token):
        return False
    stamp, digest = token.split('.')
    issued = int(stamp)
    if not -5 <= time.time() - issued <= 60:
        return False
    return hmac.compare_digest(digest, signature(key, path, body, issued))
