"""Runtime configuration (env driven, no secrets in code)."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

VERSION = "0.1.0"
DEFAULT_BASE_DIR = "/sdcard/Download/Operit/overmem/plugin_runtime"


def _path(env_name: str, default: Path) -> Path:
    raw = os.environ.get(env_name, "").strip()
    return Path(raw).expanduser() if raw else default


@dataclass(frozen=True)
class RuntimeConfig:
    mode: str
    base_dir: Path
    plugin_dir: Path
    data_dir: Path
    runtime_db: Path
    state_file: Path
    token_file: Path
    jwt_secret: str
    jwt_ttl_seconds: int
    admin_user: str
    admin_password: str
    logs_capacity: int

    @property
    def is_docker(self) -> bool:
        return self.mode == "docker"


def _read_or_create_secret(path: Path) -> str:
    env = os.environ.get("OVERMEM_JWT_SECRET", "").strip()
    if env:
        return env
    try:
        if path.exists():
            existing = path.read_text("utf-8").strip()
            if existing:
                return existing
        path.parent.mkdir(parents=True, exist_ok=True)
        value = secrets.token_urlsafe(48)
        path.write_text(value, "utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return value
    except OSError:
        return secrets.token_urlsafe(48)


def load_config() -> RuntimeConfig:
    mode = os.environ.get("OVERMEM_RUNTIME_MODE", "ubuntu").strip().lower() or "ubuntu"
    base_dir = _path("OVERMEM_BASE_DIR", Path(DEFAULT_BASE_DIR))
    plugin_dir = _path("OVERMEM_PLUGIN_DIR", base_dir / "plugins")
    data_dir = _path("OVERMEM_DATA_DIR", base_dir / "data")
    try:
        capacity = int(os.environ.get("OVERMEM_LOGS_CAPACITY", "500"))
    except ValueError:
        capacity = 500
    try:
        ttl = int(os.environ.get("OVERMEM_JWT_TTL", "3600"))
    except ValueError:
        ttl = 3600
    return RuntimeConfig(
        mode=mode,
        base_dir=base_dir,
        plugin_dir=plugin_dir,
        data_dir=data_dir,
        runtime_db=data_dir / "runtime.db",
        state_file=data_dir / "plugin_states.json",
        token_file=base_dir / ".runtime_token",
        jwt_secret=_read_or_create_secret(data_dir / ".jwt_secret"),
        jwt_ttl_seconds=max(60, ttl),
        admin_user=os.environ.get("OVERMEM_ADMIN_USERNAME", "").strip(),
        admin_password=os.environ.get("OVERMEM_ADMIN_PASSWORD", ""),
        logs_capacity=max(50, capacity),
    )


_cached: RuntimeConfig | None = None


def get_config() -> RuntimeConfig:
    global _cached
    if _cached is None:
        _cached = load_config()
    return _cached
