from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from overmem_runtime import auth

router = APIRouter(prefix="/v1/market", tags=["market"])


@router.get("/index")
async def market_index(_principal: auth.Principal = Depends(auth.require_scope("market:read"))) -> dict:
    return {"plugins": []}


@router.post("/install")
async def market_install(_principal: auth.Principal = Depends(auth.require_scope("plugins:admin"))) -> JSONResponse:
    return JSONResponse(
        status_code=501,
        content={"ok": False, "error": {"code": "NOT_IMPLEMENTED", "message": "插件市场尚未实现"}},
    )
