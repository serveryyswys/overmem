"""In-memory ring buffer used by the admin console."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any

_records: deque[dict[str, Any]] = deque(maxlen=500)
_lock = threading.Lock()
_installed = False


class RingBufferHandler(logging.Handler):
    def __init__(self, capacity: int = 500) -> None:
        super().__init__()
        global _records
        with _lock:
            _records = deque(_records, maxlen=capacity)
        self.plugin_id = ""
        self.setFormatter(logging.Formatter("%(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
        except Exception:
            message = str(record.msg)
        plugin = getattr(record, "plugin_id", "") or self.plugin_id
        push(record.levelname, message, plugin)


def push(level: str, message: str, plugin: str = "") -> None:
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "level": str(level).upper(),
        "plugin": plugin or "",
        "message": message,
    }
    with _lock:
        _records.append(entry)


def setup_logging(level: str = "INFO", capacity: int = 500) -> None:
    global _installed
    root = logging.getLogger()
    root.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    if _installed:
        handler = _find_ring()
        if handler is not None:
            with _lock:
                _records = deque(_records, maxlen=capacity)
        return
    handler = RingBufferHandler(capacity=capacity)
    root.addHandler(handler)
    _installed = True


def _find_ring() -> RingBufferHandler | None:
    for h in logging.getLogger().handlers:
        if isinstance(h, RingBufferHandler):
            return h
    return None


def log(level: str, message: str, plugin: str = "") -> None:
    """Write once through Python logging; RingBufferHandler captures the record."""
    py = logging.getLogger("overmem.runtime")
    py.log(getattr(logging, str(level).upper(), logging.INFO), message, extra={"plugin_id": plugin})


def get_logs(limit: int = 100, plugin: str | None = None) -> list[dict[str, Any]]:
    with _lock:
        items = list(_records)
    if plugin:
        items = [i for i in items if i["plugin"] == plugin]
    if limit > 0:
        items = items[-limit:]
    return items
