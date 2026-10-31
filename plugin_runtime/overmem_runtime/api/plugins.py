from __future__ import annotations

import base64
import binascii
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from overmem_runtime import auth
from overmem_runtime.config import get_config
from overmem_runtime.plugins.loader import ManifestError

router = APIRouter(prefix="/v1/plugins", tags=["plugins"])
MAX_ZIP_BYTES = 5 * 1024 * 1024


class EnableRequest(BaseModel):
    enabled: bool


class ConfigRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


class Base64InstallRequest(BaseModel):
    filename: str = "plugin.zip"
    data_base64: str = Field(min_length=1)


def _lifecycle(request: Request):
    lifecycle = getattr(request.app.state, "lifecycle", None)
    if lifecycle is None:
        raise HTTPException(status_code=503, detail="运行时未就绪")
    return lifecycle


@router.get("")
async def list_plugins(request: Request, _principal: auth.Principal = Depends(auth.require_scope("plugins:read"))) -> dict[str, Any]:
    lifecycle = _lifecycle(request)
    return {"ok": True, "mode": get_config().mode, "plugins": lifecycle.list_plugins()}


@router.post("/install")
async def install_plugin(
    request: Request,
    file: UploadFile = File(...),
    _principal: auth.Principal = Depends(auth.require_scope("plugins:admin")),
) -> dict[str, Any]:
    lifecycle = _lifecycle(request)
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="只接受 .zip 插件包")
    data = await file.read()
    if len(data) > MAX_ZIP_BYTES:
        raise HTTPException(status_code=413, detail="插件包超过 5MB")
    try:
        info = await lifecycle.install_from_zip(data, file.filename or "plugin.zip")
    except ManifestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "plugin": info}


@router.post("/install-base64")
async def install_plugin_base64(
    payload: Base64InstallRequest,
    request: Request,
    _principal: auth.Principal = Depends(auth.require_scope("plugins:admin")),
) -> dict[str, Any]:
    """JS 侧走 JSON 更稳（QuickJS 里拼 multipart 二进制不现实）。"""
    lifecycle = _lifecycle(request)
    if not payload.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="只接受 .zip 插件包")
    try:
        data = base64.b64decode(payload.data_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"base64 解码失败: {exc}") from exc
    if len(data) > MAX_ZIP_BYTES:
        raise HTTPException(status_code=413, detail="插件包超过 5MB")
    try:
        info = await lifecycle.install_from_zip(data, payload.filename)
    except ManifestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "plugin": info}


@router.post("/{plugin_id}/enable")
async def enable_plugin(
    plugin_id: str,
    payload: EnableRequest,
    request: Request,
    _principal: auth.Principal = Depends(auth.require_scope("plugins:admin")),
) -> dict[str, Any]:
    lifecycle = _lifecycle(request)
    try:
        info = await lifecycle.set_enabled(plugin_id, payload.enabled)
    except ManifestError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "plugin": info}


@router.post("/{plugin_id}/reload")
async def reload_plugin(
    plugin_id: str,
    request: Request,
    _principal: auth.Principal = Depends(auth.require_scope("plugins:admin")),
) -> dict[str, Any]:
    lifecycle = _lifecycle(request)
    try:
        info = await lifecycle.reload(plugin_id)
    except ManifestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "plugin": info}


@router.put("/{plugin_id}/config")
async def update_config(
    plugin_id: str,
    payload: ConfigRequest,
    request: Request,
    _principal: auth.Principal = Depends(auth.require_scope("plugins:admin")),
) -> dict[str, Any]:
    lifecycle = _lifecycle(request)
    try:
        config = lifecycle.save_config(plugin_id, payload.values)
    except ManifestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "config": config}


@router.delete("/{plugin_id}")
async def uninstall_plugin(
    plugin_id: str,
    request: Request,
    _principal: auth.Principal = Depends(auth.require_scope("plugins:admin")),
) -> dict[str, Any]:
    lifecycle = _lifecycle(request)
    try:
        await lifecycle.uninstall(plugin_id)
    except ManifestError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}
