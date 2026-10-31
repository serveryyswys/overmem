"""Enable / disable / reload / install / uninstall plugins."""

from __future__ import annotations

import json
import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Any

import yaml

from overmem_runtime import logs
from overmem_runtime.plugins.loader import ManifestError, PluginLoader, validate_manifest


class PluginLifecycle:
    def __init__(self, loader: PluginLoader, state_file: Path) -> None:
        self.loader = loader
        self.state_file = Path(state_file)
        self._states: dict[str, dict[str, Any]] = self._read_state()

    # ------------------------------------------------------------------ state

    def _read_state(self) -> dict[str, dict[str, Any]]:
        try:
            data = json.loads(self.state_file.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write_state(self) -> None:
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.state_file.write_text(json.dumps(self._states, ensure_ascii=False, indent=2), "utf-8")
        except OSError as exc:
            logs.log("WARN", f"写入插件状态失败: {exc}")

    def is_enabled(self, plugin_id: str) -> bool:
        return bool(self._states.get(plugin_id, {}).get("enabled", True))

    # ---------------------------------------------------------------- startup

    async def startup(self) -> None:
        for plugin_dir in self.loader.scan_dirs():
            plugin_id = self._peek_id(plugin_dir)
            if plugin_id and not self.is_enabled(plugin_id):
                logs.log("INFO", f"插件已禁用，跳过加载: {plugin_id}", plugin_id)
                continue
            try:
                await self.loader.load_one(plugin_dir)
            except Exception as exc:
                name = plugin_id or plugin_dir.name
                self.loader.errors[name] = str(exc)
                logs.log("ERROR", f"加载插件失败 {plugin_dir.name}: {exc}")

    @staticmethod
    def _peek_id(plugin_dir: Path) -> str:
        try:
            manifest = yaml.safe_load((Path(plugin_dir) / "manifest.yaml").read_text("utf-8"))
            if isinstance(manifest, dict) and isinstance(manifest.get("id"), str):
                return manifest["id"]
        except (OSError, yaml.YAMLError):
            pass
        return ""

    # ------------------------------------------------------------------ query

    def plugin_count(self) -> int:
        return len(self.loader.plugins)

    def capability_count(self) -> int:
        return self.loader.router.count()

    def list_plugins(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for plugin_dir in self.loader.scan_dirs():
            manifest: dict[str, Any] = {}
            try:
                manifest = validate_manifest(
                    yaml.safe_load((plugin_dir / "manifest.yaml").read_text("utf-8"))
                )
            except Exception as exc:
                items.append(
                    {
                        "id": plugin_dir.name,
                        "name": plugin_dir.name,
                        "version": "",
                        "description": "",
                        "author": "",
                        "status": "error",
                        "error": str(exc),
                        "capabilities": [],
                        "config_schema": [],
                        "config": {},
                        "path": str(plugin_dir),
                    }
                )
                seen.add(plugin_dir.name)
                continue
            plugin_id = manifest["id"]
            seen.add(plugin_id)
            loaded = plugin_id in self.loader.plugins
            status = "enabled" if loaded else ("error" if plugin_id in self.loader.errors else "disabled")
            items.append(self._describe(plugin_id, manifest, plugin_dir, status))
        for plugin_id in self.loader.plugins:
            if plugin_id not in seen:
                manifest = self.loader.manifests.get(plugin_id, {})
                plugin_dir = self.loader.dirs.get(plugin_id, self.loader.plugin_dir / plugin_id)
                items.append(self._describe(plugin_id, manifest, plugin_dir, "enabled"))
        items.sort(key=lambda i: str(i.get("id", "")))
        return items

    def _describe(
        self, plugin_id: str, manifest: dict[str, Any], plugin_dir: Path, status: str
    ) -> dict[str, Any]:
        schema = list((manifest.get("spec") or {}).get("config") or [])
        try:
            config = self.loader.load_config(plugin_dir, manifest)
        except Exception:
            config = {}
        return {
            "id": plugin_id,
            "name": manifest.get("name", plugin_id),
            "version": manifest.get("version", ""),
            "description": manifest.get("description", ""),
            "author": manifest.get("author", ""),
            "status": status,
            "error": self.loader.errors.get(plugin_id, ""),
            "capabilities": list(manifest.get("capabilities") or []),
            "config_schema": schema,
            "config": config,
            "path": str(plugin_dir),
        }

    def get_plugin(self, plugin_id: str) -> dict[str, Any] | None:
        for item in self.list_plugins():
            if item["id"] == plugin_id:
                return item
        return None

    # ----------------------------------------------------------- transitions

    async def set_enabled(self, plugin_id: str, enabled: bool) -> dict[str, Any]:
        info = self.get_plugin(plugin_id)
        if info is None:
            raise ManifestError(f"插件不存在: {plugin_id}")
        if enabled:
            plugin_dir = self.loader.find_dir(plugin_id)
            if plugin_dir is None:
                raise ManifestError(f"插件目录不存在: {plugin_id}")
            if plugin_id not in self.loader.plugins:
                await self.loader.load_one(plugin_dir)
            self._states[plugin_id] = {"enabled": True}
        else:
            await self.loader.unload(plugin_id)
            self._states[plugin_id] = {"enabled": False}
        self._write_state()
        refreshed = self.get_plugin(plugin_id) or info
        logs.log("INFO", f"插件 {'启用' if enabled else '禁用'}: {plugin_id}", plugin_id)
        return refreshed

    async def reload(self, plugin_id: str) -> dict[str, Any]:
        info = self.get_plugin(plugin_id)
        if info is None:
            raise ManifestError(f"插件不存在: {plugin_id}")
        plugin_dir = self.loader.find_dir(plugin_id)
        if plugin_dir is None:
            raise ManifestError(f"插件目录不存在: {plugin_id}")
        if plugin_id in self.loader.plugins:
            await self.loader.unload(plugin_id)
        if self.is_enabled(plugin_id):
            await self.loader.load_one(plugin_dir)
        logs.log("INFO", f"插件已重载: {plugin_id}", plugin_id)
        return self.get_plugin(plugin_id) or info

    async def uninstall(self, plugin_id: str) -> None:
        info = self.get_plugin(plugin_id)
        if info is None:
            raise ManifestError(f"插件不存在: {plugin_id}")
        await self.loader.unload(plugin_id)
        plugin_dir = Path(str(info.get("path") or self.loader.plugin_dir / plugin_id))
        root = self.loader.plugin_dir.resolve()
        try:
            if plugin_dir.resolve().parent == root and plugin_dir.exists():
                shutil.rmtree(plugin_dir)
        finally:
            self._states.pop(plugin_id, None)
            self._write_state()
        logs.log("INFO", f"插件已卸载: {plugin_id}", plugin_id)

    def save_config(self, plugin_id: str, values: dict[str, Any]) -> dict[str, Any]:
        merged = self.loader.save_config(plugin_id, values)
        logs.log("INFO", f"插件配置已更新: {plugin_id}", plugin_id)
        return merged

    # -------------------------------------------------------------- install

    async def install_from_zip(self, data: bytes, filename: str) -> dict[str, Any]:
        self.loader.plugin_dir.mkdir(parents=True, exist_ok=True)
        staging = self.loader.plugin_dir / f".staging-{uuid.uuid4().hex[:8]}"
        staging.mkdir(parents=True, exist_ok=True)
        try:
            self._extract_zip(data, staging)
            root = self._find_plugin_root(staging)
            manifest = validate_manifest(yaml.safe_load((root / "manifest.yaml").read_text("utf-8")))
            plugin_id = manifest["id"]
            if not (root / "main.py").exists():
                raise ManifestError("插件缺少 main.py")
            target = self.loader.plugin_dir / plugin_id
            if plugin_id in self.loader.plugins:
                await self.loader.unload(plugin_id)
            if target.exists():
                shutil.rmtree(target)
            shutil.move(str(root), str(target))
            if self.is_enabled(plugin_id):
                await self.loader.load_one(target)
            info = self.get_plugin(plugin_id) or {"id": plugin_id}
            logs.log("INFO", f"插件已安装: {plugin_id}（{filename}）", plugin_id)
            return info
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)

    def _extract_zip(self, data: bytes, dest: Path) -> None:
        import io

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for member in zf.infolist():
                if member.is_dir():
                    continue
                target = (dest / member.filename).resolve()
                try:
                    target.relative_to(dest.resolve())
                except ValueError as exc:
                    raise ManifestError(f"压缩包包含非法路径: {member.filename}") from exc
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)

    @staticmethod
    def _find_plugin_root(staging: Path) -> Path:
        if (staging / "manifest.yaml").exists():
            return staging
        children = [c for c in staging.iterdir() if c.is_dir() and not c.name.startswith(".")]
        candidates = [c for c in children if (c / "manifest.yaml").exists()]
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            raise ManifestError("压缩包内未找到 manifest.yaml")
        raise ManifestError("压缩包内包含多个插件，请一次只安装一个")
