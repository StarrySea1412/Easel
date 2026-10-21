"""Authenticated by the host app's existing middleware; files resolve by delivery ID."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response

from .artifacts import ArtifactStore, file_path, preview_html, preview_prefix, CSS_URL, related_path
from urllib.parse import quote

CSP = ("default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; "
       "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
       "font-src 'self' data:; connect-src 'none'; frame-src 'none'; "
       "form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts")
HEADERS = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}


def router(outputs, history=None):
    routes = APIRouter(prefix='/api/chat/artifacts')

    def store():
        return ArtifactStore(outputs())

    def get(session, ident):
        try:
            return store(), store().get(session, ident)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc

    @routes.get('/{session}')
    def snapshot(session: str, after: int = 0):
        try:
            from .image_jobs import ImageJobs
            from .creation_drafts import CreationDrafts
            projected = history(session) if history else {'messages': [], 'warnings': []}
            return {**store().snapshot(session, after=after), 'jobs': ImageJobs(outputs()).list(session), 'creationDrafts': CreationDrafts(outputs()).list(session), **projected}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @routes.get('/{session}/jobs')
    def jobs(session: str):
        from .image_jobs import ImageJobs
        try:
            return {'sessionId': session, 'jobs': ImageJobs(outputs()).list(session)}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @routes.post('/{session}/jobs/{ident}/acknowledge')
    def acknowledge(session: str, ident: str):
        from .image_jobs import ImageJobs
        try:
            jobs = ImageJobs(outputs())
            jobs.get(ident, session=session)
            return jobs.acknowledge(ident)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @routes.post('/{session}/{ident}/refresh')
    def refresh(session: str, ident: str):
        repository, _ = get(session, ident)
        return repository.refresh(session, ident)

    @routes.get('/{session}/{ident}/file')
    def media(session: str, ident: str, download: bool = False):
        repository, value = get(session, ident)
        try:
            path, _ = file_path(repository.root, value['path'])
            if not path.is_file() or path.stat().st_size == 0:
                raise FileNotFoundError()
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(404, '文件已移动或删除，请刷新产物') from exc
        # Active documents use only the isolated preview endpoint; raw downloads
        # cannot execute as part of the main application origin.
        active = value['mimeType'] in ('text/html', 'image/svg+xml')
        return FileResponse(path, media_type=value['mimeType'], headers=HEADERS,
                            filename=value['name'] if download or active else None,
                            content_disposition_type='attachment')

    @routes.get('/{session}/{ident}/preview')
    def preview(session: str, ident: str):
        repository, value = get(session, ident)
        if value['mimeType'] != 'text/html':
            raise HTTPException(415, '该文件不是HTML')
        try:
            return HTMLResponse(preview_html(repository, value), headers={**HEADERS, 'Content-Security-Policy': CSP})
        except (ValueError, OSError) as exc:
            raise HTTPException(409, '预览文件不可读，请刷新') from exc

    @routes.get('/{session}/{ident}/resource/{version}/{relative:path}')
    def resource(session: str, ident: str, version: str, relative: str):
        repository, value = get(session, ident)
        if value['version'] != version or relative not in value['dependencies']:
            raise HTTPException(404, '关联资源不属于当前产物版本')
        try:
            path, _ = file_path(repository.root, relative)
            if not path.is_file():
                raise FileNotFoundError()
            if path.suffix.lower() == '.css':
                prefix = preview_prefix(session, ident, version)
                def rewrite(match):
                    raw = match[1] or match[2]
                    related = related_path(repository.root, relative, raw)
                    target = prefix + '/'.join(quote(p) for p in related.split('/')) if related in value['dependencies'] else raw
                    return 'url("' + target + '")' if match[1] else '@import "' + target + '"'
                return Response(CSS_URL.sub(rewrite, path.read_text(encoding='utf-8')), media_type='text/css', headers=HEADERS)
            return FileResponse(path, headers={**HEADERS, 'Content-Security-Policy': CSP})
        except (ValueError, OSError) as exc:
            raise HTTPException(404, '关联资源不可读') from exc

    return routes
