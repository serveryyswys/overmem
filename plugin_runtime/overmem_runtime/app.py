"""FastAPI application: routers, lifecycle, admin console."""

from __future__ import annotations

import base64
import hmac
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import Response
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


class GuardedStaticFiles(StaticFiles):
    """Serve the console; in docker mode optionally require HTTP Basic."""

    async def __call__(self, scope, receive, send):
        cfg = get_config()
        if cfg.is_docker and cfg.admin_user and cfg.admin_password:
            headers = dict(scope.get("headers") or [])
            raw = headers.get(b"authorization", b"").decode("latin-1")
            if not self._authorized(raw):
                response = Response(
                    status_code=401,
                    content="需要管理员认证",
                    headers={"WWW-Authenticate": 'Basic realm="OverMem Runtime"'},
                )
                await response(scope, receive, send)
                return
        await super().__call__(scope, receive, send)

    @staticmethod
    def _authorized(header: str) -> bool:
        cfg = get_config()
        if not (header and header.lower().startswith("basic ")):
            return False
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8")
            user, _, password = decoded.partition(":")
        except Exception:
            return False
        return hmac.compare_digest(user, cfg.admin_user) and hmac.compare_digest(password, cfg.admin_password)


app.mount("/admin", GuardedStaticFiles(directory=str(STATIC_DIR), html=True), name="admin")
