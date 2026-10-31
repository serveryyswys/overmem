from __future__ import annotations

from fastapi import APIRouter, Request

from overmem_runtime.config import VERSION, get_config

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request) -> dict:
    lifecycle = getattr(request.app.state, "lifecycle", None)
    return {
        "ok": True,
        "version": VERSION,
        "mode": get_config().mode,
        "plugins_count": lifecycle.plugin_count() if lifecycle is not None else 0,
    }
