"""Authenticated XHS identity parsing, adapted from upstream bb3c8ff0.

Never evaluate platform script text or infer ownership from a displayed nickname.
"""
from __future__ import annotations

import json
import re
from urllib.parse import urlparse

CREATOR_HOME_URL = "https://creator.xiaohongshu.com/new/home"
CREATOR_ACCOUNT_URL = "https://creator.xiaohongshu.com/api/galaxy/user/info"
EXPLORE_URL = "https://www.xiaohongshu.com/explore"

def _initial_state(html: str) -> dict:
    if len(html) > 2_000_000:
        return {}
    match = re.search(
        r"<script\b[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)</script>",
        html, re.IGNORECASE)
    if not match:
        return {}
    serialized = re.sub(
        r'"(?:\\.|[^"\\])*"|\bundefined\b',
        lambda token: "null" if token.group() == "undefined" else token.group(),
        match.group(1).strip().rstrip(";"))
    try:
        state = json.loads(serialized)
        return state if isinstance(state, dict) else {}
    except ValueError:
        return {}

def _unwrap_state(value):
    if isinstance(value, dict) and "userId" not in value and "basicInfo" not in value:
        if "value" in value:
            return value["value"]
        if "_value" in value:
            return value["_value"]
    return value

def _account_identity(account: dict) -> dict:
    name = next((account[key].strip()[:40] for key in ("userName", "nickname", "user_name", "name")
                 if isinstance(account.get(key), str) and account[key].strip()), "")
    avatar = ""
    for key in ("userAvatar", "imageb", "images", "avatar", "user_avatar"):
        candidate = account.get(key)
        if not isinstance(candidate, str):
            continue
        candidate = candidate.strip()
        if candidate.startswith("//"):
            candidate = "https:" + candidate
        try:
            parsed = urlparse(candidate)
            if (parsed.scheme in ("https", "http") and parsed.hostname
                    and not parsed.username and not parsed.password
                    and not any(ord(character) < 32 for character in candidate)):
                avatar = candidate
                break
        except ValueError:
            continue
    return {"name": name, "avatar": avatar}

def _state_account(state: dict) -> dict | None:
    user = state.get("user")
    account = _unwrap_state(user.get("userInfo")) if isinstance(user, dict) else None
    if (not isinstance(account, dict) or _unwrap_state(user.get("loggedIn")) is not True
            or not isinstance(account.get("userId"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]+", account["userId"])):
        return None
    identity = _account_identity(account)
    return {**account, "userName": identity["name"], "userAvatar": identity["avatar"]}
