from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from typing import Any

from overmem_runtime import auth

router = APIRouter(tags=["capabilities"])


@router.get("/v1/capabilities")
async def capabilities(request: Request, _principal: auth.Principal = Depends(auth.require_scope("capabilities:read"))) -> list[dict[str, Any]]:
    router_obj = getattr(request.app.state, "router", None)
    return router_obj.list() if router_obj is not None else []
