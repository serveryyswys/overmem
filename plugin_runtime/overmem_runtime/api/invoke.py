from __future__ import annotations

import traceback
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from overmem_runtime import auth, logs

router = APIRouter(tags=["invoke"])


class InvokeRequest(BaseModel):
    plugin: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    args: dict[str, Any] = Field(default_factory=dict)


def _error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


@router.post("/v1/invoke")
async def invoke(
    payload: InvokeRequest,
    request: Request,
    _principal: auth.Principal = Depends(auth.require_scope("invoke")),
) -> dict[str, Any]:
    app_router = getattr(request.app.state, "router", None)
    loader = getattr(request.app.state, "loader", None)
    if app_router is None:
        return _error("CAPABILITY_NOT_FOUND", "运行时未就绪")

    entry = app_router.get(payload.plugin, payload.capability)
    if entry is None:
        return _error("CAPABILITY_NOT_FOUND", f"未注册的能力: {payload.plugin}:{payload.capability}")
    instance = loader.plugins.get(payload.plugin) if loader is not None else None
    if instance is None:
        return _error("CAPABILITY_NOT_FOUND", f"插件未加载: {payload.plugin}")

    if not isinstance(payload.args, dict):
        return _error("INVALID_ARGS", "args 必须是对象")

    try:
        result = await entry.handler(instance.context, **payload.args)
    except TypeError as exc:
        logs.log("WARN", f"参数不匹配 {entry.key}: {exc}", payload.plugin)
        return _error("INVALID_ARGS", f"参数不匹配: {exc}")
    except Exception as exc:  # single-process fallback: never let one plugin kill the runtime
        logs.log("ERROR", f"插件异常 {entry.key}: {exc}\n{traceback.format_exc()}", payload.plugin)
        return _error("PLUGIN_CRASHED", f"插件执行失败: {exc}")
    return {"ok": True, "result": result}
