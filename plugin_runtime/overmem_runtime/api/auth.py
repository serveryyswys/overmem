from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from overmem_runtime import auth, logs

router = APIRouter(prefix="/v1", tags=["auth"])


class TokenRequest(BaseModel):
    api_key: str = Field(min_length=1)


class KeyRequest(BaseModel):
    label: str = ""
    scopes: list[str] = Field(default_factory=list)


@router.post("/auth/token")
async def issue_token(payload: TokenRequest) -> dict[str, Any]:
    row = auth.authenticate_key(payload.api_key)
    if row is None:
        logs.log("WARN", "API Key 校验失败")
        raise HTTPException(status_code=401, detail="API Key 无效")
    token = auth.issue_token(row["id"], list(row["scopes"]))
    return {"ok": True, **token}


@router.get("/keys")
async def list_keys(_principal: auth.Principal = Depends(auth.require_admin)) -> dict[str, Any]:
    return {"ok": True, "keys": auth.list_keys()}


@router.post("/keys")
async def create_key(payload: KeyRequest, _principal: auth.Principal = Depends(auth.require_admin)) -> dict[str, Any]:
    scopes = payload.scopes or list(auth.ALL_SCOPES)
    unknown = [s for s in scopes if s not in auth.ALL_SCOPES and s != "*"]
    if unknown:
        raise HTTPException(status_code=400, detail=f"未知 scope: {', '.join(unknown)}")
    created = auth.create_key(payload.label, scopes)
    return {"ok": True, "key": created}


@router.delete("/keys/{key_id}")
async def revoke_key(key_id: str, _principal: auth.Principal = Depends(auth.require_admin)) -> dict[str, Any]:
    if not auth.revoke_key(key_id):
        raise HTTPException(status_code=404, detail="key 不存在")
    return {"ok": True}
