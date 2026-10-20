"""Automatic public catalog refresh is isolated from inference and user config."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import model_catalog as catalog


@pytest.fixture(autouse=True)
def fresh_cache():
    catalog._MEMORY.clear()
    yield
    catalog._MEMORY.clear()


def test_refresh_uses_exact_ids_and_updates_after_six_hours(tmp_path, monkeypatch):
    now, calls = [1_800_000_000], []
    monkeypatch.setattr(catalog.time, 'time', lambda: now[0])
    def fetch():
        calls.append(True)
        return [{'id': 'xiaomi/mimo-v2.6-flash', 'tokens': 1_050_000 if len(calls) == 1 else 1_100_000}]
    monkeypatch.setattr(catalog, '_fetch', fetch)
    assert catalog.catalog_reference('mimo-v2.6-flash', tmp_path)['tokens'] == 1_050_000
    assert catalog.catalog_reference('mimo-v2.6-flash-custom', tmp_path) is None
    assert len(calls) == 1
    now[0] += catalog.TTL + 1
    result = catalog.catalog_reference('xiaomi/mimo-v2.6-flash', tmp_path)
    assert result['tokens'] == 1_100_000 and len(calls) == 2
    assert result['source'] == 'OpenRouter 公共模型目录' and result['stale'] is False


def test_disk_cache_survives_restart_and_failed_refresh(tmp_path, monkeypatch):
    now = [1_800_000_000]
    monkeypatch.setattr(catalog.time, 'time', lambda: now[0])
    monkeypatch.setattr(catalog, '_fetch', lambda: [{'id': 'p/model', 'tokens': 500_000}])
    catalog.catalog_reference('model', tmp_path)
    catalog._MEMORY.clear()
    def offline():
        raise OSError('offline')
    monkeypatch.setattr(catalog, '_fetch', offline)
    assert catalog.catalog_reference('model', tmp_path)['tokens'] == 500_000
    now[0] += catalog.TTL + 1
    result = catalog.catalog_reference('model', tmp_path)
    assert result['tokens'] == 500_000 and result['stale'] is True


def test_conflicting_short_ids_are_unknown_but_full_id_is_exact(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog, '_fetch', lambda: [{'id': 'a/same', 'tokens': 100_000}, {'id': 'b/same', 'tokens': 200_000}])
    assert catalog.catalog_reference('same', tmp_path) is None
    assert catalog.catalog_reference('b/same', tmp_path)['tokens'] == 200_000


def test_invalid_catalog_values_are_not_accepted():
    assert catalog._rows({'data': [{'id': 'bad', 'context_length': True}, {'id': 'huge', 'context_length': 10**15},
                                   {'id': 'string', 'context_length': '100000'}, {'id': 'good', 'context_length': 100000}]}) == [{'id': 'good', 'tokens': 100000}]


def test_public_request_contains_no_model_or_channel_credentials(monkeypatch):
    requests = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return None
        def read(self, size): return json.dumps({'data': [{'id': 'p/model', 'context_length': 100000}]}).encode()
    def open_request(request, **options):
        requests.append((request, options))
        return Response()
    monkeypatch.setattr(catalog.urllib.request, 'urlopen', open_request)
    assert catalog._fetch() == [{'id': 'p/model', 'tokens': 100000}]
    request, options = requests[0]
    assert request.full_url == catalog.CATALOG_URL and request.data is None
    assert 'Authorization' not in request.headers and options['timeout'] == 3
