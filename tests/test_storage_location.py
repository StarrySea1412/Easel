"""Storage relocation uses temporary directories only, never user content."""
import asyncio
import json
import os
from pathlib import Path
import sys

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from easel import storage_location as storage
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from storage_location_routes import create_router
import app as web


@pytest.fixture
def content(tmp_path):
    root = tmp_path / 'data'
    (root / 'outputs' / '作品').mkdir(parents=True)
    (root / 'outputs' / '作品' / 'note.md').write_text('原有内容', encoding='utf-8')
    (root / '.env').write_text('private config remains here', encoding='utf-8')
    return root, tmp_path / 'custom & saved'


def test_stage_restart_migrate_and_legacy_path_remains_valid(content, monkeypatch):
    root, target = content
    planned = storage.schedule(root, str(target))
    assert planned['requiresRestart'] and planned['status'] == 'pending_restart'
    assert not target.exists()
    result = storage.apply_pending(root)
    assert result['status'] == 'ready', result
    assert (root / 'outputs').resolve() == target
    assert (target / '作品' / 'note.md').read_text(encoding='utf-8') == '原有内容'
    assert (Path(result['backupPath']) / '作品' / 'note.md').exists()
    assert (root / '.env').exists() and not (target / '.env').exists()
    # Existing producers and download path guards keep using logical outputs.
    (root / 'outputs' / 'new.txt').write_text('new artifact', encoding='utf-8')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', root / 'outputs')
    assert web._safe_output_path('new.txt') == target / 'new.txt'
    with pytest.raises(HTTPException) as denied:
        web._safe_output_path('../.env')
    assert denied.value.status_code == 403
    assert storage.apply_pending(root)['currentPath'] == str(target)


def test_second_relocation_keeps_first_destination_and_backups(content):
    root, first = content
    storage.schedule(root, str(first))
    assert storage.apply_pending(root)['status'] == 'ready'
    second = first.parent / 'second-location'
    storage.schedule(root, str(second))
    result = storage.apply_pending(root)
    assert result['status'] == 'ready', result
    assert (root / 'outputs').resolve() == second
    assert (first / '作品' / 'note.md').exists()
    assert Path(result['backupPath']).resolve() == first


def test_cancel_and_restart_preserve_original(content):
    root, target = content
    storage.schedule(root, str(target))
    assert storage.cancel(root)['pendingPath'] is None
    assert storage.apply_pending(root)['currentPath'] == str(root / 'outputs')
    assert not target.exists()


@pytest.mark.parametrize('kind', ['relative', 'inside-data', 'ancestor', 'nonempty', 'file'])
def test_reject_unsafe_or_overwriting_destinations(content, kind):
    root, target = content
    if kind == 'relative': target = Path('relative')
    if kind == 'inside-data': target = root / 'new'
    if kind == 'ancestor': target = root.parent
    if kind == 'nonempty':
        target.mkdir()
        (target / 'unrelated').write_text('keep')
    if kind == 'file': target.write_text('keep')
    with pytest.raises(ValueError): storage.schedule(root, str(target))
    assert (root / 'outputs' / '作品' / 'note.md').exists()


def test_link_failure_rolls_back_original(content, monkeypatch):
    root, target = content
    storage.schedule(root, str(target))
    def fail(source, destination):
        source.mkdir()  # Some native link failures leave an empty directory.
        raise OSError('injected link failure')
    monkeypatch.setattr(storage, '_make_link', fail)
    result = storage.apply_pending(root)
    assert result['status'] == 'failed' and 'injected' in result['error']
    assert (root / 'outputs' / '作品' / 'note.md').read_text(encoding='utf-8') == '原有内容'
    assert (target / '作品' / 'note.md').exists()  # Failed copy is never deleted.


def test_copy_failure_does_not_switch(content, monkeypatch):
    root, target = content
    storage.schedule(root, str(target))
    monkeypatch.setattr(storage.shutil, 'copytree', lambda *a, **k: (_ for _ in ()).throw(OSError('copy denied')))
    assert storage.apply_pending(root)['status'] == 'failed'
    assert (root / 'outputs').resolve() == root / 'outputs'


def test_target_becoming_nonempty_between_save_and_restart_never_overwritten(content):
    root, target = content
    storage.schedule(root, str(target))
    target.mkdir()
    unrelated = target / 'unrelated'
    unrelated.write_text('do not overwrite')
    assert storage.apply_pending(root)['status'] == 'failed'
    assert unrelated.read_text() == 'do not overwrite'


def test_subdirectory_link_cannot_escape_download_root_or_migrate(content, monkeypatch):
    root, target = content
    external = root.parent / 'external'
    external.mkdir()
    (external / 'private.txt').write_text('outside data')
    nested = root / 'outputs' / 'escape'
    storage._make_link(nested, external)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', root / 'outputs')
    with pytest.raises(HTTPException) as denied: web._safe_output_path('escape/private.txt')
    assert denied.value.status_code == 403
    with pytest.raises(ValueError, match='子级链接'): storage.schedule(root, str(target))


def test_storage_http_schedule_and_cancel(content):
    root, target = content
    app = FastAPI()
    app.include_router(create_router(lambda: root))
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            assert (await client.get('/api/storage/location')).json()['fileCount'] == 1
            response = await client.post('/api/storage/location', json={'path': str(target)})
            assert response.status_code == 200 and response.json()['requiresRestart']
            assert (await client.delete('/api/storage/location')).json()['status'] == 'ready'
            assert (await client.post('/api/storage/location', json={'path': 'relative'})).status_code == 400
    asyncio.run(exercise())
