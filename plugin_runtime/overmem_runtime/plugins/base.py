"""Plugin base class and the @capability decorator."""

from __future__ import annotations

from abc import ABC
from typing import Any, Awaitable, Callable

from overmem_runtime import logs


class _ContextLogger:
    def __init__(self, plugin_id: str) -> None:
        self.plugin_id = plugin_id

    def info(self, message: Any) -> None:
        logs.log("INFO", str(message), self.plugin_id)

    def warn(self, message: Any) -> None:
        logs.log("WARN", str(message), self.plugin_id)

    def error(self, message: Any) -> None:
        logs.log("ERROR", str(message), self.plugin_id)

    debug = info


class PluginContext:
    """Passed to capability handlers as the first argument."""

    def __init__(self, plugin_id: str, config: dict[str, Any] | None = None) -> None:
        self.plugin_id = plugin_id
        self.config = dict(config or {})
        self.log = _ContextLogger(plugin_id)
        self.state: dict[str, Any] = {}


class BasePlugin(ABC):
    manifest: dict[str, Any] = {}
    config: dict[str, Any] = {}

    def __init__(self) -> None:
        self.context = PluginContext(str(self.manifest.get("id", "")))

    async def on_load(self) -> None:  # noqa: A003 - lifecycle hook name is part of the plugin contract
        return None

    async def on_unload(self) -> None:
        return None


Handler = Callable[..., Awaitable[Any]]


def capability(name: str) -> Callable[[Handler], Handler]:
    """Mark a plugin method as a capability handler."""

    def decorator(fn: Handler) -> Handler:
        setattr(fn, "__overmem_capability__", name)
        return fn

    return decorator
