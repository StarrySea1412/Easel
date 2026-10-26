"""Memory HTTP routes. Acceptance is a browser action, never a candidate flag.

Origin/fetch checks add CSRF protection, not isolation from same-user exec.
"""
import json
import sqlite3

from fastapi import APIRouter, HTTPException, Request

from easel.profile_memory import Conflict


def create_router(store_getter, extraction_recorder=None):
    router = APIRouter(prefix='/api/persona/{name}/memory')

    async def payload(request, ui=False):
        if ui and (request.headers.get('origin') != str(request.base_url).rstrip('/') or request.headers.get('sec-fetch-site') != 'same-origin'):
            raise HTTPException(403, '请在画像经验管理页面确认此操作；候选提案不能自签生效')
        if not request.headers.get('content-type', '').startswith('application/json'):
            raise HTTPException(415, '请使用JSON请求')
        raw = await request.body()
        if len(raw) > 100_000:
            raise HTTPException(413, '经验请求过大')
        try:
            value = json.loads(raw)
        except ValueError:
            raise HTTPException(400, '请求JSON无效') from None
        if not isinstance(value, dict):
            raise HTTPException(400, '请求须为对象')
        return value

    def run(fn, *args):
        try:
            return fn(*args)
        except Conflict as exc:
            raise HTTPException(409, str(exc)) from None
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        except (OSError, sqlite3.Error):
            raise HTTPException(503, '经验存储暂不可用，请修复数据目录或数据库后重试') from None

    @router.get('')
    def read(name: str):
        return run(run(store_getter).state, name)

    @router.post('/candidates')
    async def propose(name: str, request: Request):
        entry = run(run(store_getter).propose, name, await payload(request))
        return {'entry': entry, 'state': run(run(store_getter).state, name)}

    @router.post('/extract-analysis')
    async def extract_analysis(name: str, request: Request):
        store = run(store_getter)
        receipt = run(store.extract_analysis, name, await payload(request))
        if extraction_recorder:
            run(extraction_recorder, receipt)
        return {'extraction': receipt, 'state': run(store.state, name)}

    @router.post('/policy')
    async def policy(name: str, request: Request):
        store = run(store_getter)
        run(store.set_policy, name, await payload(request, True))
        return run(store.state, name)

    @router.post('/import')
    async def migrate(name: str, request: Request):
        run(run(store_getter).import_legacy, name, await payload(request, True))
        return run(run(store_getter).state, name)

    @router.get('/file-changes')
    def file_changes(name: str):
        from easel.profile_memory import digest
        store = run(store_getter)
        path = run(store.directory, name) / 'memory.md'
        text = path.read_text(encoding='utf-8') if path.exists() else ''
        return {'text': text, 'hash': digest(text)}

    @router.post('/reconcile')
    async def reconcile(name: str, request: Request):
        run(run(store_getter).reconcile, name, await payload(request, True))
        return run(run(store_getter).state, name)

    @router.get('/context')
    def context(name: str, query: str = '', platform: str | None = None, accountId: str | None = None, taskType: str | None = None):
        return run(lambda: store_getter().context(name, query[:2000], platform, accountId, task_type=taskType))

    @router.get('/legacy')
    def legacy(name: str):
        return {'snapshot': run(run(store_getter).legacy_snapshot, name)}

    @router.get('/usage')
    def usage(name: str, sessionId: str):
        return {'turns': run(run(store_getter).usage, name, sessionId)}

    @router.get('/entries/{entry_id}/history')
    def history(name: str, entry_id: str):
        return {'revisions': run(run(store_getter).history, name, entry_id)}

    @router.post('/entries/{entry_id}/{action}')
    async def change(name: str, entry_id: str, action: str, request: Request):
        run(run(store_getter).change, name, entry_id, action, await payload(request, True))
        return run(run(store_getter).state, name)

    return router
