"""Per-turn channel provenance without credentials or mutable-config backfills."""
from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

SAFE = re.compile(r'^[A-Za-z0-9_.-]{1,100}$')


def capture_channels(config_path: Path, labels: dict | None = None) -> dict:
    try:
        providers = json.loads(config_path.read_text(encoding='utf-8')).get('models', {}).get('providers', {})
    except (OSError, ValueError, AttributeError):
        return {}
    result = {}
    for provider, config in providers.items() if isinstance(providers, dict) else ():
        if not isinstance(provider, str) or not SAFE.fullmatch(provider) or not isinstance(config, dict):
            continue
        try:
            url = urlsplit(config.get('baseUrl') or '')
            host = url.hostname
            if url.scheme not in ('https', 'http') or not host:
                continue
            endpoint = host + (f':{url.port}' if url.port else '')
            # Only a host is displayed; userinfo, query and fragment never leave config.
            fingerprint = f'{provider}\n{url.scheme}://{endpoint}{url.path.rstrip("/")}'
        except (TypeError, ValueError):
            continue
        result[provider] = {
            'channelId': 'ch_' + hashlib.sha256(fingerprint.encode()).hexdigest()[:24],
            'channelName': (labels or {}).get(provider, {}).get('name') or '未命名渠道', 'channelEndpoint': endpoint,
            'channelProtocol': str(config.get('api') or '')[:80],
            'channelSource': 'turn_config',
        }
    return result


def read_snapshots(web_sessions_dir: Path, session: str) -> list[dict]:
    folder = web_sessions_dir.parent / '_skill_audits' / hashlib.sha256(session.encode()).hexdigest()[:24]
    result = []
    for path in sorted(folder.glob('*.json'))[-1000:]:
        if path.is_symlink():
            continue
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get('sessionId') == session and isinstance(record.get('_usageChannels'), dict):
            result.append(record)
    return result


def attach_channel(call: dict, snapshots: list[dict], old: dict | None = None) -> None:
    previous = old or call
    if previous.get('channelSource') == 'turn_config' and SAFE.fullmatch(str(previous.get('channelId', ''))):
        call.update({key: previous.get(key) for key in ('channelId', 'channelName', 'channelEndpoint', 'channelProtocol', 'channelSource')})
        return
    provider = call.get('provider') or '未上报'
    call.update(channelId=provider if SAFE.fullmatch(provider) else 'unknown',
                channelName=provider, channelEndpoint=None, channelProtocol=None,
                channelSource='transcript_provider' if provider != '未上报' else 'unknown')
    try:
        stamp = datetime.fromisoformat(call['timestamp']).timestamp()
        end = datetime.fromisoformat(call.get('endTimestamp') or call['timestamp']).timestamp()
    except (KeyError, TypeError, ValueError):
        return
    matches = []
    for record in snapshots:
        started, finished = record.get('started'), record.get('finished')
        if not isinstance(started, (float, int)) or isinstance(started, bool):
            continue
        if finished is None and record.get('status') == 'running':
            finished = time.time()
        if not isinstance(finished, (float, int)) or isinstance(finished, bool):
            continue
        # Match actual transcript provider, never the requested model/brand.
        channel = record['_usageChannels'].get(provider)
        if started - .1 <= stamp <= end <= finished + 1 and isinstance(channel, dict) and SAFE.fullmatch(str(channel.get('channelId', ''))):
            matches.append(channel)
    if len(matches) == 1:
        call.update(matches[0])


def channel_groups(calls: list[dict], summarize) -> list[dict]:
    groups = {}
    for call in calls:
        groups.setdefault(call['channelId'], []).append(call)
    result = []
    for channel_id, rows in groups.items():
        row = rows[0]
        result.append({'id': channel_id, 'name': row['channelName'], 'endpoint': row.get('channelEndpoint'),
                       'source': row['channelSource'], 'models': sorted({item['model'] for item in rows}),
                       'summary': summarize(rows)})
    return sorted(result, key=lambda item: (-item['summary']['calls'], item['id']))
