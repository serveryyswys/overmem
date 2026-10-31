"""FastAPI application: routers, lifecycle, admin console."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from overmem_runtime import auth, logs
from overmem_runtime.api import admin, capabilities, health, invoke, market, plugins
from overmem_runtime.api import auth as auth_api
from overmem_runtime.config import VERSION, get_config
from overmem_runtime.plugins.lifecycle import PluginLifecycle
from overmem_runtime.plugins.loader import PluginLoader
from overmem_runtime.plugins.registry import CapabilityRouter

MODE = get_config().mode
STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = get_config()
    logs.setup_logging("INFO", cfg.logs_capacity)
    logs.log("INFO", f"运行时启动 version={VERSION} mode={cfg.mode} plugin_dir={cfg.plugin_dir}")

    if cfg.is_docker:
        auth.init_db()
        auth.ensure_bootstrap_key()

    router = CapabilityRouter()
    loader = PluginLoader(cfg.plugin_dir, router)
    lifecycle = PluginLifecycle(loader, cfg.state_file)
    app.state.router = router
    app.state.loader = loader
    app.state.lifecycle = lifecycle
    await lifecycle.startup()
    logs.log("INFO", f"插件加载完成：{lifecycle.plugin_count()} 个，能力 {router.count()} 个")

    try:
        yield
    finally:
        for plugin_id in list(loader.plugins):
            await loader.unload(plugin_id)
        logs.log("INFO", "运行时已停止")


app = FastAPI(
    title="OverMem Plugin Runtime",
    version=VERSION,
    lifespan=lifespan,
    docs_url=None if MODE == "docker" else "/docs",
    openapi_url=None if MODE == "docker" else "/openapi.json",
)

app.middleware("http")(auth.auth_middleware)

app.include_router(health.router)
app.include_router(capabilities.router)
app.include_router(invoke.router)
app.include_router(plugins.router)
app.include_router(market.router)
if MODE == "docker":
    app.include_router(auth_api.router)
app.include_router(admin.router, prefix="/v1")


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    """管后台入口：根路径直接跳到登录页/控制台。"""
    return RedirectResponse(url="/admin/", status_code=302)


@app.get("/admin", include_in_schema=False)
async def admin_without_slash() -> RedirectResponse:
    return RedirectResponse(url="/admin/", status_code=308)


# 控制台静态页公开可达；真正的权限在 /v1/*（docker 模式下需要 JWT）。
app.mount("/admin", StaticFiles(directory=str(STATIC_DIR), html=True), name="admin")
