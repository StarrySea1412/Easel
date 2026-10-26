import asyncio
from types import SimpleNamespace

from easel.browser_runtime import BrowserService


def test_unresponsive_cast_does_not_block_context_and_driver_cleanup(tmp_path, monkeypatch):
    cancelled = []
    class CDP:
        async def send(self, method):
            try:
                await asyncio.Future()
            finally:
                cancelled.append(method)
    service = BrowserService(tmp_path)
    service.sessions['owner'] = object()
    closed = []
    async def close_session(_):
        tab = SimpleNamespace(cast=None, cdp=CDP())
        await service._cast_stop(tab)
        closed.append('context')
    async def close_browser(): closed.append('browser')
    async def stop_driver(): closed.append('driver')
    monkeypatch.setattr(service, '_close_session', close_session)
    service.browser = SimpleNamespace(close=close_browser)
    service.playwright = SimpleNamespace(stop=stop_driver)
    async def run():
        await asyncio.wait_for(service._shutdown(), timeout=4)
    asyncio.run(run())
    assert cancelled == ['Page.stopScreencast']
    assert closed == ['context', 'browser', 'driver']
