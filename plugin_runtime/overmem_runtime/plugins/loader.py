"""Scan plugins/*/manifest.yaml, import main.py, register capabilities."""

from __future__ import annotations

import importlib.util
import re
import sys
import uuid
from pathlib import Path
from typing import Any

import yaml

from overmem_runtime import logs
from overmem_runtime.config import VERSION
from overmem_runtime.plugins.base import BasePlugin, PluginContext
from overmem_runtime.plugins.registry import CapabilityEntry, CapabilityRouter

ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CAPABILITY_NAMESPACES = ("ingest.", "transform.", "inject.", "consolidate.")


class ManifestError(Exception):
    pass


def _version_tuple(value: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", value or "")
    return tuple(int(p) for p in parts[:3]) or (0,)


def _satisfies(requirement: str, current: str = VERSION) -> bool:
    req = (requirement or "").strip()
    if not req:
        return True
    match = re.match(r"^(>=|<=|==|>|<)?\s*([0-9][0-9A-Za-z.\-]*)$", req)
    if not match:
        return True
    op = match.group(1) or ">="
    target = _version_tuple(match.group(2))
    cur = _version_tuple(current)
    if op == ">=":
        return cur >= target
    if op == "<=":
        return cur <= target
    if op == "==":
        return cur == target
    if op == ">":
        return cur > target
    return cur < target


def validate_manifest(manifest: Any) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        raise ManifestError("manifest.yaml 必须是对象")
    for field in ("id", "name", "version"):
        value = manifest.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ManifestError(f"manifest 缺少字段: {field}")
    if not ID_PATTERN.match(manifest["id"]):
        raise ManifestError(f"插件 id 非法: {manifest['id']}")
    caps = manifest.get("capabilities") or []
    if not isinstance(caps, list) or not all(isinstance(c, str) for c in caps):
        raise ManifestError("capabilities 必须是字符串列表")
    for cap in caps:
        if not cap.startswith(CAPABILITY_NAMESPACES):
            raise ManifestError(f"能力命名空间不支持: {cap}")
    runtime_api = manifest.get("runtime_api")
    if runtime_api and not _satisfies(str(runtime_api)):
        raise ManifestError(f"插件要求 runtime_api {runtime_api}，当前 {VERSION}")
    spec = manifest.get("spec") or {}
    if not isinstance(spec, dict):
        raise ManifestError("spec 必须是对象")
    configs = spec.get("config") or []
    if not isinstance(configs, list):
        raise ManifestError("spec.config 必须是列表")
    for item in configs:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ManifestError("spec.config 每项必须包含 name")
    return manifest


class PluginLoader:
    def __init__(self, plugin_dir: Path, router: CapabilityRouter) -> None:
        self.plugin_dir = Path(plugin_dir)
        self.router = router
        self.plugins: dict[str, BasePlugin] = {}
        self.manifests: dict[str, dict[str, Any]] = {}
        self.dirs: dict[str, Path] = {}
        self.modules: dict[str, str] = {}
        self.errors: dict[str, str] = {}

    # ------------------------------------------------------------------ scan

    def scan_dirs(self) -> list[Path]:
        if not self.plugin_dir.exists():
            return []
        found = []
        for entry in sorted(self.plugin_dir.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if (entry / "manifest.yaml").exists() and (entry / "main.py").exists():
                found.append(entry)
        return found

    def find_dir(self, plugin_id: str) -> Path | None:
        known = self.dirs.get(plugin_id)
        if known is not None:
            return known
        for plugin_dir in self.scan_dirs():
            try:
                manifest = yaml.safe_load((plugin_dir / "manifest.yaml").read_text("utf-8"))
            except (OSError, yaml.YAMLError):
                continue
            if isinstance(manifest, dict) and manifest.get("id") == plugin_id:
                return plugin_dir
        return None

    async def load_all(self) -> None:
        for plugin_dir in self.scan_dirs():
            try:
                await self.load_one(plugin_dir)
            except Exception as exc:  # keep one broken plugin from blocking the rest
                logs.log("ERROR", f"加载插件失败 {plugin_dir.name}: {exc}")
                self.errors[plugin_dir.name] = str(exc)

    # ------------------------------------------------------------------ load

    async def load_one(self, plugin_dir: Path) -> str:
        plugin_dir = Path(plugin_dir)
        manifest = validate_manifest(yaml.safe_load((plugin_dir / "manifest.yaml").read_text("utf-8")))
        plugin_id = manifest["id"]
        if plugin_id in self.plugins:
            await self.unload(plugin_id)

        module_name = f"overmem_plugin_{re.sub(r'[^A-Za-z0-9_]', '_', plugin_id)}_{uuid.uuid4().hex[:8]}"
        spec = importlib.util.spec_from_file_location(module_name, plugin_dir / "main.py")
        if spec is None or spec.loader is None:
            raise ManifestError(f"无法导入 {plugin_dir / 'main.py'}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(module_name, None)
            raise

        instance: BasePlugin | None = None
        for attr in vars(module).values():
            if isinstance(attr, type) and issubclass(attr, BasePlugin) and attr is not BasePlugin:
                instance = attr()
                break
        if instance is None:
            sys.modules.pop(module_name, None)
            raise ManifestError("main.py 中没有 BasePlugin 子类")

        config = self.load_config(plugin_dir, manifest)
        instance.manifest = manifest
        instance.config = config
        instance.context = PluginContext(plugin_id, config)

        registered: list[str] = []
        for name in dir(instance):
            method = getattr(instance, name)
            cap = getattr(method, "__overmem_capability__", None)
            if not cap or not callable(method):
                continue
            description = (method.__doc__ or "").strip().splitlines()[0] if method.__doc__ else ""
            self.router.register(
                CapabilityEntry(plugin=plugin_id, capability=cap, description=description, handler=method)
            )
            registered.append(cap)

        declared = list(manifest.get("capabilities") or [])
        missing = [c for c in declared if c not in registered]
        extra = [c for c in registered if c not in declared]
        if missing:
            logs.log("WARN", f"插件 {plugin_id} 声明了未实现的能力: {', '.join(missing)}", plugin_id)
        if extra:
            logs.log("WARN", f"插件 {plugin_id} 实现了未声明的能力: {', '.join(extra)}", plugin_id)

        self.plugins[plugin_id] = instance
        self.manifests[plugin_id] = manifest
        self.dirs[plugin_id] = plugin_dir
        self.modules[plugin_id] = module_name
        self.errors.pop(plugin_id, None)

        try:
            await instance.on_load()
        except Exception as exc:
            await self.unload(plugin_id)
            raise ManifestError(f"on_load 失败: {exc}") from exc
        logs.log("INFO", f"插件已加载: {plugin_id} v{manifest.get('version')}（{len(registered)} 个能力）", plugin_id)
        return plugin_id

    async def unload(self, plugin_id: str) -> None:
        instance = self.plugins.pop(plugin_id, None)
        module_name = self.modules.pop(plugin_id, None)
        self.manifests.pop(plugin_id, None)
        self.dirs.pop(plugin_id, None)
        self.router.unregister_plugin(plugin_id)
        if instance is not None:
            try:
                await instance.on_unload()
            except Exception as exc:
                logs.log("WARN", f"插件 {plugin_id} on_unload 失败: {exc}", plugin_id)
        if module_name:
            sys.modules.pop(module_name, None)
        if instance is not None:
            logs.log("INFO", f"插件已卸载: {plugin_id}", plugin_id)

    # ---------------------------------------------------------------- config

    def load_config(self, plugin_dir: Path, manifest: dict[str, Any]) -> dict[str, Any]:
        cfg_file = Path(plugin_dir) / "config.yaml"
        if cfg_file.exists():
            data = yaml.safe_load(cfg_file.read_text("utf-8")) or {}
            if isinstance(data, dict):
                defaults = {
                    item["name"]: item.get("default")
                    for item in (manifest.get("spec") or {}).get("config") or []
                    if isinstance(item, dict) and item.get("name")
                }
                defaults.update({k: v for k, v in data.items() if k in defaults})
                return defaults
        return {
            item["name"]: item.get("default")
            for item in (manifest.get("spec") or {}).get("config") or []
            if isinstance(item, dict) and item.get("name")
        }

    def save_config(self, plugin_id: str, values: dict[str, Any]) -> dict[str, Any]:
        plugin_dir = self.find_dir(plugin_id)
        if plugin_dir is None:
            raise ManifestError(f"插件不存在: {plugin_id}")
        manifest = self.manifests.get(plugin_id)
        if manifest is None:
            try:
                manifest = validate_manifest(
                    yaml.safe_load((plugin_dir / "manifest.yaml").read_text("utf-8"))
                )
            except (OSError, yaml.YAMLError, ManifestError) as exc:
                raise ManifestError(f"插件 manifest 读取失败: {exc}") from exc
        schema = {
            item["name"]: item
            for item in (manifest.get("spec") or {}).get("config") or []
            if isinstance(item, dict) and item.get("name")
        }
        merged = self.load_config(plugin_dir, manifest)
        for key, value in (values or {}).items():
            if key not in schema:
                raise ManifestError(f"未知配置项: {key}")
            item = schema[key]
            kind = item.get("type", "string")
            if kind == "int":
                try:
                    value = int(value)
                except (TypeError, ValueError) as exc:
                    raise ManifestError(f"配置项 {key} 需要 int") from exc
            elif kind == "float":
                try:
                    value = float(value)
                except (TypeError, ValueError) as exc:
                    raise ManifestError(f"配置项 {key} 需要 float") from exc
            elif kind == "bool":
                if isinstance(value, str):
                    value = value.strip().lower() in ("1", "true", "yes", "on")
                value = bool(value)
            elif kind == "string":
                value = str(value)
            enum = item.get("enum")
            if isinstance(enum, list) and enum and value not in enum:
                raise ManifestError(f"配置项 {key} 取值必须是 {enum}")
            merged[key] = value
        (plugin_dir / "config.yaml").write_text(yaml.safe_dump(merged, allow_unicode=True), "utf-8")
        instance = self.plugins.get(plugin_id)
        if instance is not None:
            instance.config = merged
            instance.context.config = dict(merged)
        return merged
