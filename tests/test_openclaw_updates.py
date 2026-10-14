import json
import pytest
from easel import openclaw_updates as updates


@pytest.fixture(autouse=True)
def reset_cache(monkeypatch):
    updates._cache.clear()
    updates._notes_cache.clear()
    monkeypatch.setattr(updates, 'installed_runtime', lambda: {'installedVersion': '2026.9.6', 'installedState': 'ok'})


def test_official_version_cache_refresh_and_unavailable(monkeypatch):
    calls = []
    def read(url, limit):
        calls.append(url)
        return json.dumps({'version': '2026.10.3'})
    monkeypatch.setattr(updates, '_read_public', read)
    assert updates.update_info()['updateAvailable']
    assert updates.update_info()['latestVersion'] == '2026.10.3'
    assert calls == [updates.REGISTRY]
    monkeypatch.setattr(updates, '_read_public', lambda *_: '{}')
    result = updates.update_info(refresh=True)
    assert result['latestState'] == 'unavailable' and result['latestVersion'] is None


def test_notes_bound_version_range_and_preserve_partial_evidence(monkeypatch):
    calls = []
    def read(url, limit):
        calls.append(url)
        if url == updates.REGISTRY:
            return '{"version":"2026.10.3"}'
        if url.endswith('/CHANGELOG.md'):
            return '\n'.join(f'[{v}](CHANGELOG/{v}.md)' for v in ['2026.10.3', '2026.10.2', '2026.9.6', '2026.9.2'])
        if url.endswith('/2026.10.2.md'):
            raise OSError('offline')
        return 'official note' * 2000
    monkeypatch.setattr(updates, '_read_public', read)
    result = updates.release_notes()
    assert result['notesState'] == 'partial'
    assert [item['version'] for item in result['releases']] == ['2026.10.3', '2026.10.2']
    assert len(result['releases'][0]['text']) == 14000 and result['releases'][0]['truncated']
    assert result['releases'][1]['unavailable']
    assert not any(url.endswith('/2026.9.2.md') for url in calls)
    count = len(calls)
    assert updates.release_notes()['releases'] == result['releases'] and len(calls) == count


def test_newer_installed_version_has_no_upgrade_or_old_notes(monkeypatch):
    monkeypatch.setattr(updates, 'installed_runtime', lambda: {'installedVersion': '2026.10.5'})
    monkeypatch.setattr(updates, '_read_public', lambda *_: '{"version":"2026.10.3"}')
    assert not updates.update_info()['updateAvailable']
    assert updates.release_notes()['notesState'] == 'empty'


def test_missing_current_range_excludes_older_versions(monkeypatch):
    monkeypatch.setattr(updates, '_read_public', lambda url, _: '{"version":"2026.10.3"}' if url == updates.REGISTRY
                        else '[2026.10.3](CHANGELOG/2026.10.3.md)\n[2026.9.2](CHANGELOG/2026.9.2.md)' if url.endswith('CHANGELOG.md') else 'notes')
    result = updates.release_notes()
    assert result['rangeIncomplete'] and len(result['releases']) == 1
