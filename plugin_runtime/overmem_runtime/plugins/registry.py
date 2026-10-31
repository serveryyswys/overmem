"""Capability registry keyed by "<plugin_id>:<capability>"."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable


@dataclass
class CapabilityEntry:
    plugin: str
    capability: str
    description: str
    handler: Callable[..., Awaitable[Any]]

    @property
    def key(self) -> str:
        return f"{self.plugin}:{self.capability}"

    def to_dict(self) -> dict[str, str]:
        return {
            "plugin": self.plugin,
            "capability": self.capability,
            "description": self.description,
        }


class CapabilityRouter:
    def __init__(self) -> None:
        self._entries: dict[str, CapabilityEntry] = {}

    def register(self, entry: CapabilityEntry) -> None:
        self._entries[entry.key] = entry

    def unregister_plugin(self, plugin_id: str) -> None:
        for key in [k for k in self._entries if self._entries[k].plugin == plugin_id]:
            del self._entries[key]

    def get(self, plugin_id: str, capability: str) -> CapabilityEntry | None:
        return self._entries.get(f"{plugin_id}:{capability}")

    def list(self) -> list[dict[str, str]]:
        return [entry.to_dict() for entry in sorted(self._entries.values(), key=lambda e: e.key)]

    def count(self) -> int:
        return len(self._entries)

    def clear(self) -> None:
        self._entries.clear()
