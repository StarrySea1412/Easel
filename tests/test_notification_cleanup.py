"""Targeted notification cleanup: ids-only removal with tombstones; clear-all stays intact."""
import asyncio
from pathlib import Path
import sys
import time

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from easel.notifications import NotificationStore


def value(ident, message='对话 · 已完成'):
    return dict(id=ident, message=message, tone='success', at=int(time.time() * 1000), read=False)


def test_store_removes_only_requested_ids_and_keeps_tombstones(tmp_path):
    store = NotificationStore(tmp_path)
    store.add([value('keep'), value('noise-a', '已选择思考强度：高，下一轮生效'), value('noise-b')])
    removed = store.remove(['noise-a', 'noise-b'])
    assert removed == 2 and [row['id'] for row in store.list()['notices']] == ['keep']
    # A stale client pushing the removed rows again cannot revive them.
    store.add([value('noise-a')])
    assert [row['id'] for row in store.list()['notices']] == ['keep']
    # Empty or invalid requests are safe no-ops; clear still removes everything.
    assert store.remove([]) == 0
    assert store.remove([123, '']) == 0
    store.clear()
    assert store.list()['notices'] == []


def test_notification_remove_route_keeps_clear_all_separate(tmp_path, monkeypatch):
    import app
    monkeypatch.setattr(app, 'OUTPUTS_DIR', tmp_path)

    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url='http://127.0.0.1:7880') as client:
            await client.post('/api/notifications', json={'notices': [value('keep'), value('noise', '已选择思考强度：Ultra，下一轮生效')]})
            # Targeted removal lives on its own route so a stale backend fails closed.
            response = await client.post('/api/notifications/remove', json={'ids': ['noise']})
            assert response.status_code == 200
            rows = (await client.get('/api/notifications')).json()['notices']
            assert [row['id'] for row in rows] == ['keep']
            assert (await client.post('/api/notifications/remove', json={})).status_code == 400
            # DELETE keeps the legacy clear-all meaning.
            await client.delete('/api/notifications')
            assert (await client.get('/api/notifications')).json()['notices'] == []

    asyncio.run(exercise())
