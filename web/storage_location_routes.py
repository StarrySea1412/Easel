"""Storage settings are staged for startup, not migrated during active work."""
import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from easel import storage_location


class StorageRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2000)


def create_router(root_getter):
    router = APIRouter(prefix='/api/storage')

    async def invoke(fn, *args):
        try:
            return await asyncio.to_thread(fn, root_getter(), *args)
        except (ValueError, OSError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get('/location')
    async def get_location():
        return await invoke(storage_location.status)

    @router.post('/location')
    async def set_location(request: StorageRequest):
        return await invoke(storage_location.schedule, request.path)

    @router.delete('/location')
    async def cancel_location():
        return await invoke(storage_location.cancel)

    return router
