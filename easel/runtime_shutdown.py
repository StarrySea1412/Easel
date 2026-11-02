"""Ordered shutdown budgets; no task replay or inferred provider completion."""
import asyncio

# OpenClaw 2026.9.6 reserves 325s for native drain/close. Keep its full
# budget after the execution owner has finished recording accepted work.
DRAIN_SECONDS = 300
RUNTIME_EXIT_SECONDS = 60
GATEWAY_EXIT_SECONDS = 330
OBSERVER_EXIT_SECONDS = 10
CONTAINER_STOP_SECONDS = 720


def begin(web):
    """Fence background dispatch while existing workers retain their identity."""
    web._SERVICE_SHUTTING_DOWN = True
    worker = web._image_worker()
    with worker.lock:
        worker.stop_event.set()
    web._task_service.closing = True
    if web._task_service.loop:
        web._task_service.loop.cancel()


def active(web):
    # Durable unknown/pending rows are evidence to retain, not local runners
    # that can finish by waiting. Idle upgrade retains its stricter check.
    return bool(web._CHAT_JOBS or web._RUNNING_CHAT or web._BG_TASKS
        or web._DIRECT_CHAT_TASKS or web._HARNESS_TASKS or web._codex_service.active
        or web._task_service.work or any(not t.done() for t in web._ANALYTICS_TASKS.values())
        or web._image_worker().active)


async def close_chat_tasks(web):
    # Uvicorn only joins HTTP handlers. These producers also survive observer
    # disconnects, and must save their own interrupted receipts before exit.
    tasks = list(web._BG_TASKS | web._DIRECT_CHAT_TASKS | web._HARNESS_TASKS)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def interruption():
    return {'code': 'execution_service_shutdown', 'category': 'connection',
        'stage': 'execution', 'retryable': False,
        'message': '执行服务关闭，原轮次结果待核验；已保存内容保留，未自动重发。'}
