"""Material fingerprints shared by analysis and model-facing memory readers."""
import hashlib
import json

VERSION = '2026-10-08'
REVIEW_RULE_VERSION = 2
ADVANCED_METRICS = ('impressions', 'completions', 'averageWatchSeconds', 'durationSeconds',
                    'followersAttributed', 'coins', 'danmaku')


def material_hash(content):
    selected = {k: content.get(k) for k in ('id', 'title', 'body', 'coverText', 'transcript', 'comments', 'metrics', 'period', 'tags', 'format', 'paid', 'snapshotAt', 'publishedAt', 'identity')}
    selected['advancedMetrics'] = {key: (content.get('advancedMetrics') or {}).get(key) for key in ADVANCED_METRICS}
    return hashlib.sha256(json.dumps([REVIEW_RULE_VERSION, selected], ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def account_material_hash(contents):
    values = [(c['id'], material_hash(c)) for c in sorted(contents, key=lambda c: c['id'])]
    return hashlib.sha256(json.dumps([VERSION, values], ensure_ascii=False).encode()).hexdigest()
