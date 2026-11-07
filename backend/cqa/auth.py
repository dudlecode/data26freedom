"""Login, sessions and roles.

Roles:
  operator    - смотрит оценки, подаёт апелляцию на свою оценку
  supervisor  - смотрит оценки, запускает оценку, подаёт апелляции
  reviewer    - рассматривает апелляции (второе мнение ИИ, решение)
  admin       - всё, включая чек-листы, настройки и ключ API

Sessions are HMAC-signed tokens (no server-side state), sent as an HttpOnly cookie for the
web UI and accepted as "Authorization: Bearer <token>" for embedding (e.g. Dynamics 365).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import time
from contextvars import ContextVar
from typing import Any

from . import db

COOKIE = "cqa_session"
SESSION_TTL_S = 12 * 3600
ROLES = ("operator", "supervisor", "reviewer", "admin")
ROLE_LABEL = {"operator": "Оператор", "supervisor": "Супервайзер", "reviewer": "Проверяющий", "admin": "Администратор"}

current_user: ContextVar[dict[str, Any] | None] = ContextVar("current_user", default=None)

USERS_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT
);
"""

DEMO_USERS = [
    ("operator", "Руслан Ибраев", "operator"),
    ("supervisor", "Айгерим Сапарова", "supervisor"),
    ("reviewer", "Дамир Ахметов", "reviewer"),
    ("admin", "Администратор QA", "admin"),
]

# Paths reachable without a session.
PUBLIC_API = {("POST", "/api/auth/login"), ("POST", "/api/auth/quick"), ("GET", "/api/auth/quick"), ("GET", "/api/health"), ("POST", "/api/auth/logout")}

# (method, path regex) -> roles allowed. Anything else under /api needs any logged-in role.
RULES: list[tuple[str, re.Pattern[str], tuple[str, ...]]] = [
    ("PUT", re.compile(r"^/api/settings$"), ("admin",)),
    ("POST", re.compile(r"^/api/settings/anthropic-key$"), ("admin",)),
    ("POST", re.compile(r"^/api/checklists$"), ("admin",)),
    ("POST", re.compile(r"^/api/checklists/\d+/activate$"), ("admin",)),
    ("POST", re.compile(r"^/api/evaluations/\d+/appeals$"), ("operator", "supervisor", "admin")),
    ("POST", re.compile(r"^/api/appeals/\d+/(ai-review|decide)$"), ("reviewer", "admin")),
    ("POST", re.compile(r"^/api/(evaluations|datasets/fetch|dialogs/import)$"), ("supervisor", "admin")),
    ("POST", re.compile(r"^/api/evaluations/\d+/rerun$"), ("supervisor", "admin")),
]


def hash_password(password: str, *, iterations: int = 200_000) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, it, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(it))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def _secret() -> bytes:
    env = os.getenv("CQA_SECRET")
    if env:
        return env.encode()
    s = db.get_setting("auth_secret")
    if not s:
        s = secrets.token_hex(32)
        db.set_setting("auth_secret", s)
    return str(s).encode()


def ensure_users() -> None:
    with db._lock:
        db.conn().executescript(USERS_SCHEMA)
        db.conn().commit()
    password = os.getenv("CQA_DEMO_PASSWORD", "freedom2026")
    for username, name, role in DEMO_USERS:
        if db.one("SELECT id FROM users WHERE username = ?", [username]):
            continue
        db.insert(
            "users",
            {"username": username, "display_name": name, "role": role,
             "password_hash": hash_password(password), "created_at": db.now()},
        )


def public_user(u: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "role": u["role"],
        "role_label": ROLE_LABEL.get(u["role"], u["role"]),
    }


def login(username: str, password: str) -> tuple[dict[str, Any], str] | None:
    u = db.one("SELECT * FROM users WHERE username = ?", [username.strip().lower()])
    if not u or not verify_password(password, u["password_hash"]):
        return None
    return public_user(u), make_token(u["id"])


def quick_roles() -> set[str]:
    """Roles allowed to sign in with one click on the demo login screen (CQA_QUICK_LOGIN_ROLES).
    Empty by default: the password never leaves the server either way."""
    raw = os.getenv("CQA_QUICK_LOGIN_ROLES", "")
    return {r.strip() for r in raw.split(",") if r.strip() in ROLES}


def quick_login(username: str) -> tuple[dict[str, Any], str] | None:
    if username.strip().lower() not in {u for u, _, _ in DEMO_USERS}:
        return None
    u = db.one("SELECT * FROM users WHERE username = ?", [username.strip().lower()])
    if not u or u["role"] not in quick_roles():
        return None
    return public_user(u), make_token(u["id"])


def make_token(user_id: int, ttl: int = SESSION_TTL_S) -> str:
    exp = int(time.time()) + ttl
    msg = f"{user_id}.{exp}"
    sig = hmac.new(_secret(), msg.encode(), hashlib.sha256).digest()
    return msg + "." + base64.urlsafe_b64encode(sig).decode().rstrip("=")


def user_from_token(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    try:
        uid, exp, sig = token.split(".")
        msg = f"{uid}.{exp}"
        want = base64.urlsafe_b64encode(hmac.new(_secret(), msg.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(want, sig) or int(exp) < time.time():
            return None
    except (ValueError, TypeError):
        return None
    u = db.one("SELECT * FROM users WHERE id = ?", [int(uid)])
    return public_user(u) if u else None


def token_from_request(headers: Any, cookies: Any) -> str | None:
    h = headers.get("authorization") or ""
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return cookies.get(COOKIE)


def allowed_roles(method: str, path: str) -> tuple[str, ...]:
    for m, rx, roles in RULES:
        if m == method and rx.match(path):
            return roles
    return ROLES
