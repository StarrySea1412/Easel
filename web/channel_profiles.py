"""Display names bound to exact saved channels; never credentials or protocols as names."""
import hashlib
import json


def fingerprint(target):
    return hashlib.sha256(json.dumps([target.base, target.key, target.protocol]).encode()).hexdigest()


def channel_fingerprint(web, provider, ref):
    # A display name does not require the channel to support direct health probes
    # (custom headers, env credentials and Responses are valid gateway configs).
    target = web._model_health_target(ref) if ref else None
    if target:
        return fingerprint(target)
    config = json.loads((web.openclaw_state_dir() / 'openclaw.json').read_text(encoding='utf-8-sig'))
    saved = config.get('models', {}).get('providers', {}).get(provider)
    if not isinstance(saved, dict):
        return None
    identity = {key: saved.get(key) for key in ('baseUrl', 'apiKey', 'api', 'auth', 'headers', 'authHeader')}
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def read(web):
    path = web.DATA_DIR / 'channel-names.json'
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('Invalid channel names')
    return data


def labels(web):
    import office_controls
    import local_config_import
    try:
        saved = read(web)
    except (OSError, ValueError):
        saved = {}
    # Recover older imports only from an exact endpoint + credential + protocol
    # match. Ambiguous sources remain unnamed; no automatic configuration import.
    candidates = []
    try:
        path, _ = local_config_import.resolve_source('cc-switch', '')
        if path:
            candidates, _ = local_config_import.read_source('cc-switch', path)
    except (OSError, ValueError):
        pass
    result = {}
    for row in office_controls.configured_models(web.openclaw_state_dir() / 'openclaw.json'):
        provider = row['provider']
        if provider in result:
            continue
        target = web._model_health_target(row['id'])
        bound = channel_fingerprint(web, provider, row['id'])
        stored = saved.get(provider, {})
        if isinstance(stored, dict) and stored.get('fingerprint') == bound and isinstance(stored.get('name'), str):
            result[provider] = {'name': stored['name'], 'sourceName': stored.get('sourceName', ''), 'source': stored.get('source', 'manual')}
            continue
        matches = {item['name'] for item in candidates if target and item.get('baseUrl', '').rstrip('/') == target.base.rstrip('/')
                   and item.get('key') == target.key and item.get('protocol') == target.protocol and item.get('name')}
        if len(matches) == 1:
            name = next(iter(matches))
            result[provider] = {'name': name, 'sourceName': name, 'source': 'cc-switch'}
        else:
            result[provider] = {'name': '未命名渠道', 'sourceName': '', 'source': 'unknown'}
    return result


def save(web, provider, name, source_name=None, source=None):
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80 or any(ord(c) < 32 for c in name):
        raise ValueError('渠道名称需为 1–80 字，不能包含控制字符。')
    options = __import__('office_controls').configured_models(web.openclaw_state_dir() / 'openclaw.json')
    ref = next((row['id'] for row in options if row['provider'] == provider), None)
    bound = channel_fingerprint(web, provider, ref)
    if not bound:
        raise ValueError('渠道配置不可用，请先保存模型配置。')
    data = read(web)
    current = labels(web).get(provider, {})
    data[provider] = {'name': name.strip(), 'sourceName': source_name if source_name is not None else current.get('sourceName', ''),
                      'source': source or ('cc-switch' if source_name is not None else current.get('source', 'manual')),
                      'fingerprint': bound}
    web._atomic_model_bytes(web.DATA_DIR / 'channel-names.json', json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8'))
    return data[provider]['name']
