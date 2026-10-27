"""Private, authenticated execution owner. Started by RuntimeManager only."""
from __future__ import annotations

import asyncio
import base64
import hmac
import importlib
import json
import os
import socket

from easel.runtime_host import (RuntimeManager, RuntimeUnavailable, ownership,
                                PREFIX, TOKEN_HEADER, CONTEXT_HEADER, code_digest)


class PrivateApplication:
    def __init__(self, app, state, busy=lambda: False, quiesce=lambda: True, shutdown=lambda: None):
        self.app, self.state, self.busy = app, state, busy
        self.requests = 0
        self.draining = False
        self.server = None
        self.quiesce = quiesce
        self.shutdown = shutdown

    async def __call__(self, scope, receive, send):
        from starlette.responses import JSONResponse
        if scope['type'] == 'lifespan':
            return await self.app(scope, receive, send)
        headers = dict(scope.get('headers', []))
        supplied = headers.get(TOKEN_HEADER, b'')
        if (scope.get('client', ('',))[0] != '127.0.0.1'
                or not hmac.compare_digest(supplied, self.state['token'].encode())):
            return await JSONResponse({'detail': 'Not found'}, status_code=404)(scope, receive, send)
        if scope['path'].startswith(PREFIX):
            value = {'instance': self.state['instance'], 'code': self.state['code'],
                     'pid': os.getpid(), 'running': True, 'busy': bool(self.requests or self.busy())}
            if scope['path'] == PREFIX + 'stop' and scope['method'] == 'POST':
                if value['busy']:
                    return await JSONResponse({'detail': 'busy'}, status_code=409)(scope, receive, send)
                # No await between checking runners/requests and fencing admission.
                if self.quiesce() is False:
                    return await JSONResponse({'detail': 'busy'}, status_code=409)(scope, receive, send)
                self.draining = True
                self.server.should_exit = True
            elif scope['path'] == PREFIX + 'shutdown' and scope['method'] == 'POST':
                # Used only by the enclosing server's explicit SIGTERM. A full
                # installation shutdown is distinct from idle upgrade/stop.
                self.draining = True
                self.shutdown()
                self.server.should_exit = True
            elif scope['path'] != PREFIX + 'health' or scope['method'] != 'GET':
                return await JSONResponse({'detail': 'Not found'}, status_code=404)(scope, receive, send)
            return await JSONResponse(value, headers={'Cache-Control': 'no-store'})(scope, receive, send)
        if self.draining:
            return await JSONResponse({'detail': '执行服务正在关闭。'}, status_code=503)(scope, receive, send)
        try:
            context = json.loads(base64.urlsafe_b64decode(headers[CONTEXT_HEADER]))
            if (context['scheme'] not in ('http', 'https')
                    or not isinstance(context.get('client'), (list, type(None)))
                    or not isinstance(context.get('server'), (list, type(None)))
                    or not isinstance(context.get('root_path'), str)):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            return await JSONResponse({'detail': 'Invalid forwarding context'}, status_code=400)(scope, receive, send)
        scope = {**scope, **context, 'headers': [(k, v) for k, v in scope['headers']
                    if not k.lower().startswith(b'x-easel-runtime-')]}
        self.requests += 1
        try:
            return await self.app(scope, receive, send)
        finally:
            self.requests -= 1


def application_busy(web):
    """Refuse shutdown while any original runner or resource remains in flight."""
    return bool(web._CHAT_JOBS or web._RUNNING_CHAT or web._BG_TASKS
        or web._DIRECT_CHAT_TASKS or web._HARNESS_TASKS or web._codex_service.active
        or web._task_service.work or any(not task.done() for task in web._ANALYTICS_TASKS.values())
        or web._task_service.store.running() or web._image_worker().active)


def main():
    import uvicorn
    manager = RuntimeManager()
    state = manager.read()
    if (state is None or os.environ.get('EASEL_RUNTIME_WORKER') != '1'
            or not hmac.compare_digest(state['token'], os.environ.get('EASEL_RUNTIME_TOKEN', ''))
            or state['instance'] != os.environ.get('EASEL_RUNTIME_INSTANCE')):
        raise RuntimeUnavailable('Missing runtime launch identity')
    with ownership(manager.directory / 'runtime.lock'):
        manager._matching(state, code_digest())
        # Do not hand service control credentials to Agent/tool subprocesses.
        os.environ.pop('EASEL_RUNTIME_TOKEN', None)
        os.environ.pop('EASEL_RUNTIME_INSTANCE', None)
        target = os.environ.get('EASEL_RUNTIME_APP') or (
            'deployment.138.application:app' if os.environ.get('EASEL_ACCESS_FILE') else 'web.app:app')
        module_name, attribute = target.split(':', 1)
        module = importlib.import_module(module_name)
        app = getattr(module, attribute)
        web = module.workspace if hasattr(module, 'workspace') else module
        def quiesce():
            if hasattr(web, '_task_service'):
                if not web._image_worker().pause_if_idle():
                    return False
                web._task_service.closing = True
                if web._task_service.loop:
                    web._task_service.loop.cancel()
            return True

        def shutdown():
            if hasattr(web, '_task_service'):
                web._task_service.closing = True
                web._image_worker().stop_event.set()
                if web._task_service.loop:
                    web._task_service.loop.cancel()

        private = PrivateApplication(app, state, busy=(lambda: application_busy(web))
            if hasattr(web, '_task_service') else getattr(module, 'runtime_busy', lambda: False),
            quiesce=quiesce, shutdown=shutdown)
        server = uvicorn.Server(uvicorn.Config(private, host='127.0.0.1', port=0,
            proxy_headers=False, log_level='warning', timeout_graceful_shutdown=30))
        private.server = server
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(128)
            state.update(port=listener.getsockname()[1], pid=os.getpid())
            manager.write(state)
            try:
                asyncio.run(server.serve(sockets=[listener]))
            finally:
                current = manager.read()
                if current and current['instance'] == state['instance']:
                    manager.state_file.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
