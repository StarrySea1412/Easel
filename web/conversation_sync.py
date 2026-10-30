"""Authenticated workbench conversation copies; never start a model run."""
import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from easel import conversations
from easel.task_store import TaskConflict


def router(store):
    routes = APIRouter()

    @routes.get('/conversations')
    def index(after: str = ''):
        try:
            return JSONResponse(conversations.index(store, after), headers={'Cache-Control': 'no-store'})
        except ValueError:
            raise HTTPException(400, '无效分页标识') from None

    @routes.post('/conversations')
    async def save(request: Request):
        raw = await request.body()
        if len(raw) > conversations.MAX_BYTES:
            raise HTTPException(413, '对话超过同步上限，本地记录仍保留')
        try:
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError('invalid body')
            return await asyncio.to_thread(conversations.save, store, body.get('conversation', body), body.get('baseRevision'))
        except TaskConflict as exc:
            raise HTTPException(409, str(exc)) from None
        except (ValueError, UnicodeError):
            raise HTTPException(400, '对话格式无效，本地记录仍保留') from None

    @routes.get('/conversations/{session}')
    def read(session: str):
        try:
            result = conversations.read(store, session, with_revision=True)
        except TaskConflict as exc:
            raise HTTPException(410, str(exc)) from None
        except ValueError:
            raise HTTPException(400, '无效对话标识') from None
        if result is None:
            raise HTTPException(404, '原对话尚未同步，请在原浏览器刷新一次后重试')
        return JSONResponse(result, headers={'Cache-Control': 'no-store'})

    return routes
