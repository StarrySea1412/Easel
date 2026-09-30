"""HTTP surface for the local content evidence workbench."""
from __future__ import annotations

import json
import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from content_analysis import METRICS, PLATFORMS, Store, markdown, now, scope


def create_router(root_getter, capture, providers_getter=lambda: []):
    router = APIRouter(prefix='/api/content-analysis')

    def store():
        return Store(Path(root_getter()))

    def run(fn, *args):
        try:
            return fn(*args)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    async def payload(request):
        raw = await request.body()
        if len(raw) > 10 * 1024 * 1024:
            raise HTTPException(413, '导入文件不能超过 10 MB')
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as exc:
            raise HTTPException(400, '请输入有效 JSON') from exc
        if not isinstance(value, dict):
            raise HTTPException(400, '请求必须是 JSON 对象')
        return value

    @router.get('/accounts')
    async def accounts():
        return {'accounts': store().accounts()}

    @router.get('/report')
    async def report(platform: str, accountId: str):
        return run(store().report, platform, accountId)

    @router.post('/import')
    async def import_content(request: Request):
        return run(store().ingest, await payload(request))

    @router.get('/template')
    async def template(platform: str = 'xiaohongshu'):
        run(scope, platform, 'your-account-id')
        return {'platform': platform, 'accountId': '请替换为实际账号ID', 'name': '请替换为账号名称',
                'contents': [{'id': '请替换为稳定作品ID', 'title': '请替换为实际作品标题', 'body': '', 'tags': [],
                              'comments': [], 'coverText': '', 'transcript': '',
                              'format': 'unknown', 'publishedAt': None, 'snapshotAt': now(), 'period': 'unknown', 'paid': None,
                              'url': '', 'metrics': {key: None for key in METRICS}}]}

    @router.post('/experiments')
    async def create_experiment(request: Request):
        return run(store().experiment, await payload(request))

    @router.patch('/experiments/{experiment_id}')
    async def update_experiment(experiment_id: str, request: Request):
        return run(store().experiment, await payload(request), experiment_id)

    @router.get('/export')
    async def export(platform: str, accountId: str, format: str = 'json'):
        result = run(store().report, platform, accountId)
        if format == 'markdown':
            body, mime, ext = markdown(result), 'text/markdown; charset=utf-8', 'md'
        elif format == 'json':
            body, mime, ext = json.dumps(result, ensure_ascii=False, indent=2), 'application/json', 'json'
        else:
            raise HTTPException(400, '仅支持 json / markdown 导出')
        return Response(body, media_type=mime, headers={'Content-Disposition': f'attachment; filename="content-analysis-{platform}.{ext}"'})

    @router.post('/capture')
    async def capture_content(request: Request):
        data = await payload(request)
        platform, account_id = run(scope, data.get('platform'), data.get('accountId'))
        live = await capture(platform)
        # Display names are never identity. Some legacy collectors cannot yet persist safely.
        returned_id = live.get('accountId')
        if not returned_id and isinstance(live.get('account'), dict):
            returned_id = live['account'].get('externalId') or live['account'].get('id')
        if live.get('loggedIn') is not True or str(returned_id or '') != account_id:
            raise HTTPException(409, '采集结果未返回匹配的稳定账号 ID，未写入分析库；可使用明确归属的规范导入')
        contents = []
        skipped = 0
        for note in live.get('notes', []):
            ident = note.get('id') or note.get('note_id') or note.get('noteId') or note.get('bvid')
            if not ident:
                skipped += 1
                continue
            item = {'id': str(ident), 'title': note.get('title') or '未提供标题',
                    'metrics': note.get('metrics') or {}, 'snapshotAt': now(), 'period': 'unknown'}
            if note.get('tags'):
                item['tags'] = note['tags']
            if note.get('body'):
                item['body'] = note['body']
            # Do not promote loose creator-centre links or unparsed publication strings.
            contents.append(item)
        if not contents:
            raise HTTPException(409, '当前采集没有可确认稳定 ID 的作品，未写入分析库')
        try:
            result = store().ingest({'platform': platform, 'accountId': account_id,
                                     'name': live.get('nickname') or account_id, 'contents': contents}, identity='live_verified')
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        result['quality']['warnings'].append(f'本次采集 {len(contents)} 篇，跳过 {skipped} 篇缺少稳定 ID 的记录；不代表完整账号历史。')
        return result

    @router.post('/interpret')
    async def interpret_content(request: Request):
        from content_analysis_ai import interpret
        data = await payload(request)
        platform, account_id = run(scope, data.get('platform'), data.get('accountId'))
        report = run(store().report, platform, account_id)
        content = next((c for c in report['contents'] if c['id'] == data.get('contentId')), None)
        if content is None:
            raise HTTPException(404, '所选账号下未找到该作品')
        providers = await asyncio.to_thread(providers_getter)
        provider = next((p for p in providers if p.configured), None)
        review = await asyncio.to_thread(interpret, content, provider)
        run(store().save_review, platform, account_id, content, review)
        return review

    return router
