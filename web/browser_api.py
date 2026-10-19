"""HTTP boundary for the session-owned browser adapter."""
from __future__ import annotations

import asyncio
from pathlib import Path
import uuid

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from easel.attachment_refs import attachment_scope, attachment_id
from easel.browser_runtime import BrowserError, BrowserService


class BrowserCommand(BaseModel):
    requestId: str = Field(min_length=1, max_length=120)
    action: str = Field(max_length=30)
    tabId: str | None = Field(default=None, max_length=120)
    snapshotId: str | None = Field(default=None, max_length=120)
    ref: str | None = Field(default=None, max_length=30)
    url: str | None = Field(default=None, max_length=4096)
    text: str | None = Field(default=None, max_length=8000)
    key: str | None = Field(default=None, max_length=40)
    x: float | None = None
    y: float | None = None
    deltaY: int = Field(default=600, ge=-1600, le=1600)


class BrowserControl(BaseModel):
    url: str = Field(max_length=4096)
    enabled: bool


def save_evidence(outputs: Path, sid: str, image: bytes, snapshot_id: str):
    scope = attachment_scope(sid)
    folder = outputs / '_inbox' / scope / ('browser-' + uuid.uuid4().hex[:12])
    folder.mkdir(parents=True, exist_ok=True)
    name = f'网页截图-{snapshot_id[:8]}.png'
    path = folder / name
    path.write_bytes(image)
    relative = path.relative_to(outputs).as_posix()
    return {'id': attachment_id(scope, relative), 'name': name, 'path': relative}


def router(service: BrowserService):
    api = APIRouter(prefix='/api/browser')

    async def invoke(method, *args, **kwargs):
        try:
            return await asyncio.wrap_future(service.submit(method, *args, **kwargs))
        except BrowserError as exc:
            raise HTTPException(exc.status, str(exc)) from None

    @api.get('/sessions/{sid}')
    async def state(sid: str):
        return await invoke('state', sid)

    @api.post('/sessions/{sid}/commands')
    async def command(sid: str, body: BrowserCommand):
        return await invoke('command', sid, body.model_dump(exclude_none=True))

    @api.post('/sessions/{sid}/agent/commands')
    async def agent_command(sid: str, body: BrowserCommand):
        return await invoke('command', sid, body.model_dump(exclude_none=True), actor='agent')

    @api.post('/sessions/{sid}/agent/tool')
    async def agent_tool(sid: str, body: dict):
        result, image = await invoke('tool_result', sid, body)
        if image:
            file = await asyncio.to_thread(save_evidence, service.outputs, sid, image, result['snapshotId'])
            result['image'] = file
            result['imagePath'] = str((service.outputs / file['path']).resolve())
        return result

    @api.post('/sessions/{sid}/commands/{request_id}/cancel')
    async def cancel(sid: str, request_id: str):
        return await invoke('cancel', sid, request_id)

    @api.post('/sessions/{sid}/control')
    async def control(sid: str, body: BrowserControl):
        return await invoke('control', sid, body.url, body.enabled)

    @api.delete('/sessions/{sid}')
    async def close(sid: str):
        return await invoke('close_session', sid)

    @api.get('/sessions/{sid}/tabs/{tab_id}/snapshots/{snapshot_id}/image')
    async def image(sid: str, tab_id: str, snapshot_id: str):
        data = await invoke('image', sid, tab_id, snapshot_id)
        return Response(data, media_type='image/png', headers={'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'})

    @api.post('/sessions/{sid}/tabs/{tab_id}/snapshots/{snapshot_id}/attachment')
    async def attach(sid: str, tab_id: str, snapshot_id: str):
        data = await invoke('image', sid, tab_id, snapshot_id)
        value = await asyncio.to_thread(save_evidence, service.outputs, sid, data, snapshot_id)
        return {'file': value, 'snapshotId': snapshot_id}

    return api
