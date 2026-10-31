"""API keys + JWT. Only active in docker mode; ubuntu mode trusts loopback."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import Header, HTTPException, Request

from overmem_runtime.config import get_config
from overmem_runtime import logs

try:  # bcrypt is a declared dependency, but keep the runtime importable without it
    import bcrypt
except Exception:  # pragma: no cover
    bcrypt = None

try:  # pyjwt likewise
    import jwt as pyjwt
except Exception:  # pragma: no cover
    pyjwt = None


PBKDF2_ROUNDS = 120_000
ALL_SCOPES = ["capabilities:read", "invoke", "plugins:read", "plugins:admin", "market:read", "logs:read", "admin"]


@dataclass
class Principal:
    sub: str
    scopes: list[str] = field(default_factory=list)
    key_id: str | None = None

    def has(self, scope: str) -> bool:
        return "*" in self.scopes or "admin" in self.scopes or scope in self.scopes


# ----------------------------------------------------------------------------
# storage
# ----------------------------------------------------------------------------


def _connect() -> sqlite3.Connection:
    cfg = get_config()
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(cfg.runtime_db), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _connect()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL DEFAULT '',
                key_hash TEXT NOT NULL,
                scopes TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                last_used_at TEXT,
                revoked INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def _hash_key(key: str) -> str:
    if bcrypt is not None:
        digest = bcrypt.hashpw(key.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        return "bcrypt$" + digest
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", key.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS)
    return "pbkdf2$" + salt + "$" + digest.hex()


def _verify_hash(key: str, stored: str) -> bool:
    try:
        if stored.startswith("bcrypt$"):
            if bcrypt is None:
                return False
            return bcrypt.checkpw(key.encode("utf-8"), stored[len("bcrypt$"):].encode("utf-8"))
        if stored.startswith("pbkdf2$"):
            _, salt, digest = stored.split("$", 2)
            calc = hashlib.pbkdf2_hmac("sha256", key.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS)
            return hmac.compare_digest(calc.hex(), digest)
    except Exception:
        return False
    return False


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def create_key(label: str = "", scopes: list[str] | None = None) -> dict[str, Any]:
    key_id = "key_" + secrets.token_hex(6)
    plaintext = "ok_" + key_id + "_" + secrets.token_urlsafe(24)
    scopes = scopes or ["capabilities:read", "invoke", "plugins:read", "market:read"]
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO api_keys (id, label, key_hash, scopes, created_at, last_used_at, revoked)"
            " VALUES (?, ?, ?, ?, ?, NULL, 0)",
            (key_id, label, _hash_key(plaintext), json.dumps(scopes), _now()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": key_id, "label": label, "scopes": scopes, "key": plaintext, "created_at": _now()}


def list_keys() -> list[dict[str, Any]]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, label, scopes, created_at, last_used_at, revoked FROM api_keys ORDER BY created_at"
        ).fetchall()
    finally:
        conn.close()
    out = []
    for row in rows:
        out.append(
            {
                "id": row["id"],
                "label": row["label"],
                "scopes": json.loads(row["scopes"] or "[]"),
                "created_at": row["created_at"],
                "last_used_at": row["last_used_at"] or "",
                "revoked": bool(row["revoked"]),
            }
        )
    return out


def revoke_key(key_id: str) -> bool:
    conn = _connect()
    try:
        cur = conn.execute("UPDATE api_keys SET revoked = 1 WHERE id = ?", (key_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def authenticate_key(plaintext: str) -> dict[str, Any] | None:
    if not plaintext:
        return None
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM api_keys WHERE revoked = 0").fetchall()
    finally:
        conn.close()
    for row in rows:
        if _verify_hash(plaintext, row["key_hash"]):
            conn = _connect()
            try:
                conn.execute("UPDATE api_keys SET last_used_at = ? WHERE id = ?", (_now(), row["id"]))
                conn.commit()
            finally:
                conn.close()
            return {
                "id": row["id"],
                "scopes": json.loads(row["scopes"] or "[]"),
                "label": row["label"],
            }
    return None


def ensure_bootstrap_key() -> None:
    """First docker start: create one admin key so the console is usable."""
    conn = _connect()
    try:
        count = conn.execute("SELECT COUNT(*) AS c FROM api_keys").fetchone()["c"]
    finally:
        conn.close()
    if count:
        return
    preset = os.environ.get("OVERMEM_BOOTSTRAP_KEY", "").strip()
    if preset:
        key_id = "key_boot"
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO api_keys (id, label, key_hash, scopes, created_at, revoked)"
                " VALUES (?, 'bootstrap', ?, ?, ?, 0)",
                (key_id, _hash_key(preset), json.dumps(["*"]), _now()),
            )
            conn.commit()
        finally:
            conn.close()
        logs.log("INFO", "已创建 bootstrap API Key（来自 OVERMEM_BOOTSTRAP_KEY）")
        return
    created = create_key("bootstrap", ["*"])
    cfg = get_config()
    try:
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        (cfg.data_dir / "bootstrap_key.txt").write_text(created["key"] + "\n", "utf-8")
    except OSError:
        pass
    logs.log("INFO", f"已创建 bootstrap API Key: {created['id']}（明文见 data/bootstrap_key.txt）")


# ----------------------------------------------------------------------------
# JWT (HS256), pyjwt when available, stdlib fallback otherwise
# ----------------------------------------------------------------------------


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _fallback_encode(payload: dict[str, Any], secret: str) -> str:
    header = _b64e(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode("ascii")
    sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header}.{body}.{_b64e(sig)}"


def _fallback_decode(token: str, secret: str) -> dict[str, Any]:
    try:
        header_b64, body_b64, sig_b64 = token.split(".")
    except ValueError as exc:
        raise ValueError("token 格式错误") from exc
    signing_input = f"{header_b64}.{body_b64}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _b64d(sig_b64)):
        raise ValueError("签名校验失败")
    payload = json.loads(_b64d(body_b64).decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("payload 非对象")
    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and exp < time.time():
        raise ValueError("token 已过期")
    return payload


def issue_token(key_id: str, scopes: list[str]) -> dict[str, Any]:
    cfg = get_config()
    now = int(time.time())
    payload = {
        "sub": key_id,
        "scopes": scopes,
        "iat": now,
        "exp": now + cfg.jwt_ttl_seconds,
    }
    if pyjwt is not None:
        token = pyjwt.encode(payload, cfg.jwt_secret, algorithm="HS256")
    else:
        token = _fallback_encode(payload, cfg.jwt_secret)
    return {"token": token, "expires_in": cfg.jwt_ttl_seconds, "scopes": scopes}


def decode_token(token: str) -> dict[str, Any]:
    cfg = get_config()
    if pyjwt is not None:
        return pyjwt.decode(token, cfg.jwt_secret, algorithms=["HS256"])
    return _fallback_decode(token, cfg.jwt_secret)


# ----------------------------------------------------------------------------
# FastAPI dependencies
# ----------------------------------------------------------------------------


def _principal_from_request(request: Request) -> Principal | None:
    cfg = get_config()
    if not cfg.is_docker:
        return Principal(sub="local", scopes=["*"])
    principal = getattr(request.state, "principal", None)
    return principal if isinstance(principal, Principal) else None


async def get_principal(request: Request) -> Principal:
    principal = _principal_from_request(request)
    if principal is None:
        raise HTTPException(status_code=401, detail="缺少或无效的访问令牌")
    return principal


def require_scope(scope: str):
    async def dependency(request: Request) -> Principal:
        principal = _principal_from_request(request)
        if principal is None:
            raise HTTPException(status_code=401, detail="缺少或无效的访问令牌")
        if not principal.has(scope):
            raise HTTPException(status_code=403, detail=f"缺少权限: {scope}")
        return principal

    return dependency


require_admin = require_scope("admin")
require_read = require_scope("capabilities:read")


async def auth_middleware(request: Request, call_next):
    cfg = get_config()
    if cfg.is_docker:
        path = request.url.path
        if path.startswith("/v1") and path not in ("/v1/auth/token",):
            header = request.headers.get("authorization", "")
            if header.lower().startswith("bearer "):
                token = header[7:].strip()
                try:
                    payload = decode_token(token)
                    scopes = payload.get("scopes") or []
                    if not isinstance(scopes, list):
                        scopes = []
                    request.state.principal = Principal(
                        sub=str(payload.get("sub") or ""),
                        scopes=[str(s) for s in scopes],
                        key_id=str(payload.get("sub") or ""),
                    )
                except Exception as exc:  # invalid token -> treated as anonymous
                    logs.log("WARN", f"JWT 校验失败: {exc}")
    return await call_next(request)


async def basic_guard(authorization: str | None = Header(default=None)) -> None:
    """Optional HTTP Basic protection for /admin in docker mode."""
    cfg = get_config()
    if not (cfg.is_docker and cfg.admin_user and cfg.admin_password):
        return
    if not authorization or not authorization.lower().startswith("basic "):
        raise HTTPException(status_code=401, detail="需要管理员认证", headers={"WWW-Authenticate": "Basic"})
    try:
        decoded = base64.b64decode(authorization[6:]).decode("utf-8")
        user, _, password = decoded.partition(":")
    except Exception:
        raise HTTPException(status_code=401, detail="认证头格式错误")
    if not (hmac.compare_digest(user, cfg.admin_user) and hmac.compare_digest(password, cfg.admin_password)):
        raise HTTPException(status_code=401, detail="管理员凭据错误")
