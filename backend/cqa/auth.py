"""Login, sessions and roles.

Roles (three, by owner decision):
  operator    - смотрит свои оценки, подаёт апелляцию на свою оценку
  supervisor  - загружает и оценивает диалоги, подаёт апелляции, ведёт чек-листы,
                настройки, ключ API и калибровку (бывшие права администратора)
  reviewer    - рассматривает апелляции (второе мнение ИИ, решение). Отдельно от
                супервайзера: кто оценивает, тот не решает спор по своей оценке.

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
ROLES = ("operator", "supervisor", "reviewer")
ROLE_LABEL = {"operator": "Оператор", "supervisor": "Супервайзер", "reviewer": "Проверяющий"}
# Roles that no longer exist and the role their users are moved to on startup (None: delete the user).
RETIRED_ROLES = {"admin": "supervisor"}

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
]

# Paths reachable without a session.
PUBLIC_API = {
    ("POST", "/api/auth/login"), ("POST", "/api/auth/quick"), ("GET", "/api/auth/quick"), ("GET", "/api/auth/session"),
    ("GET", "/api/health"), ("POST", "/api/auth/logout"),
}

# (method, path regex) -> roles allowed. Anything else under /api needs any logged-in role.
TEAM = ("supervisor", "reviewer")

RULES: list[tuple[str, re.Pattern[str], tuple[str, ...]]] = [
    ("GET", re.compile(r"^/api/(overview|operators(/.*)?|gross-errors|calibration|export(/.*)?)$"), TEAM),
    ("PUT", re.compile(r"^/api/settings$"), ("supervisor",)),
    ("GET", re.compile(r"^/api/(audit|integrations(/.*)?)$"), TEAM),
    ("POST", re.compile(r"^/api/integrations/webhook/test$"), ("supervisor",)),
    ("POST", re.compile(r"^/api/settings/anthropic-key$"), ("supervisor",)),
    ("POST", re.compile(r"^/api/checklists$"), ("supervisor",)),
    ("POST", re.compile(r"^/api/checklists/\d+/activate$"), ("supervisor",)),
    ("POST", re.compile(r"^/api/evaluations/\d+/appeals$"), ("operator", "supervisor")),
    ("POST", re.compile(r"^/api/appeals/\d+/(ai-review|decide|preview)$"), ("reviewer",)),
    ("POST", re.compile(r"^/api/(evaluations|datasets/fetch|dialogs/import)$"), ("supervisor",)),
    ("POST", re.compile(r"^/api/evaluations/\d+/rerun$"), ("supervisor",)),
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
    migrate_retired_roles()
    password = os.getenv("CQA_DEMO_PASSWORD", "freedom2026")
    for username, name, role in DEMO_USERS:
        if db.one("SELECT id FROM users WHERE username = ?", [username]):
            continue
        db.insert(
            "users",
            {"username": username, "display_name": name, "role": role,
             "password_hash": hash_password(password), "created_at": db.now()},
        )


def migrate_retired_roles() -> None:
    """Older databases have an "admin" user. The demo account `admin` is deleted (its rights
    now belong to `supervisor`); any other user with a retired role becomes a supervisor.
    Sessions of a deleted user stop working: the token points to a missing user id."""
    demo = {u for u, _, _ in DEMO_USERS}
    for old, new in RETIRED_ROLES.items():
        for u in db.query("SELECT id, username FROM users WHERE role = ? OR username = ?", [old, old]):
            if u["username"] == old or u["username"] in demo or not new:
                db.execute("DELETE FROM users WHERE id = ?", [u["id"]])
            else:
                db.execute("UPDATE users SET role = ? WHERE id = ?", [new, u["id"]])


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


ROLE_DUTY = {
    "operator": "Смотрит свои оценки и оспаривает их",
    "supervisor": "Оценивает диалоги, ведёт чек-лист и настройки",
    "reviewer": "Решает апелляции",
}
QUICK_OFF = {"none", "off", "0", "false", "no"}


def quick_roles() -> set[str]:
    """Roles allowed to sign in with one click, without a password (CQA_QUICK_LOGIN_ROLES).
    Unset, empty or "all": every demo role. "none": quick sign-in is off. Otherwise a
    comma-separated list of roles. The password never leaves the server either way."""
    raw = os.getenv("CQA_QUICK_LOGIN_ROLES")
    if raw is None or not raw.strip() or raw.strip().lower() == "all":
        return set(ROLES)
    if raw.strip().lower() in QUICK_OFF:
        return set()
    return {r.strip().lower() for r in raw.split(",") if r.strip().lower() in ROLES}


def quick_users() -> list[dict[str, Any]]:
    """Demo users available for quick sign-in, in role order."""
    allowed = quick_roles()
    out = []
    for username, _name, role in DEMO_USERS:
        if role not in allowed:
            continue
        u = db.one("SELECT * FROM users WHERE username = ?", [username])
        if not u or u["role"] != role:
            continue
        out.append({**public_user(u), "description": ROLE_DUTY.get(role, "")})
    return out


def quick_login(username: str, operator: tuple[str, str] | None = None) -> tuple[dict[str, Any], str] | None:
    if username.strip().lower() not in {u for u, _, _ in DEMO_USERS}:
        return None
    u = db.one("SELECT * FROM users WHERE username = ?", [username.strip().lower()])
    if not u or u["role"] not in quick_roles():
        return None
    bound = operator if u["role"] == "operator" else None
    token = make_token(u["id"], operator=bound)
    return user_from_token(token) or public_user(u), token


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def _unb64(text: str) -> str:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)).decode()


def make_token(user_id: int, ttl: int = SESSION_TTL_S, operator: tuple[str, str] | None = None) -> str:
    """`operator` = (key, name) binds an operator session to one operator from the data:
    the user then sees and disputes only that operator's dialogs."""
    exp = int(time.time()) + ttl
    msg = f"{user_id}.{exp}"
    if operator:
        msg += "." + _b64(f"{operator[0]}\t{operator[1]}")
    sig = hmac.new(_secret(), msg.encode(), hashlib.sha256).digest()
    return msg + "." + base64.urlsafe_b64encode(sig).decode().rstrip("=")


def user_from_token(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    try:
        parts = token.split(".")
        if len(parts) == 3:
            uid, exp, sig = parts
            scope = None
        elif len(parts) == 4:
            uid, exp, scope, sig = parts
        else:
            return None
        msg = f"{uid}.{exp}" + (f".{scope}" if scope else "")
        want = base64.urlsafe_b64encode(hmac.new(_secret(), msg.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(want, sig) or int(exp) < time.time():
            return None
        bound = _unb64(scope).split("\t", 1) if scope else None
    except (ValueError, TypeError, UnicodeDecodeError):
        return None
    u = db.one("SELECT * FROM users WHERE id = ?", [int(uid)])
    if not u:
        return None
    out = public_user(u)
    if bound and len(bound) == 2 and u["role"] == "operator":
        out["operator_key"], out["display_name"] = bound[0], bound[1]
        out["operator_name"] = bound[1]
    return out


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
