from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from overmem_runtime import auth, logs

router = APIRouter(tags=["admin"])


@router.get("/logs")
async def recent_logs(
    limit: int = Query(default=100, ge=1, le=500),
    plugin: str = Query(default=""),
    _principal: auth.Principal = Depends(auth.require_admin),
) -> dict[str, Any]:
    return {"ok": True, "logs": logs.get_logs(limit=limit, plugin=plugin or None)}
