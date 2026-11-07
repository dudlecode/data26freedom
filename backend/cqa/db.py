"""SQLite storage (single file, no server). JSON payloads are stored as TEXT."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Iterable

from . import config

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS dialogs (
    id TEXT PRIMARY KEY,
    group_id TEXT,
    channel TEXT,
    language TEXT,
    transcript TEXT NOT NULL,
    audio_url TEXT,
    source TEXT,
    imported_at TEXT
);
CREATE TABLE IF NOT EXISTS checklists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    config TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    note TEXT,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dialog_id TEXT NOT NULL,
    checklist_id INTEGER NOT NULL,
    status TEXT NOT NULL,            -- queued | running | done | error
    settings TEXT,
    result TEXT,                     -- original automatic result
    final TEXT,                      -- result after appeal decisions
    total REAL,
    final_total REAL,
    gross INTEGER,
    cost_usd REAL,
    usage TEXT,
    duration_ms INTEGER,
    error TEXT,
    created_at TEXT,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_eval_dialog ON evaluations(dialog_id);
CREATE TABLE IF NOT EXISTS appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id INTEGER NOT NULL,
    criterion_id TEXT NOT NULL,
    comment TEXT,
    author TEXT,
    status TEXT NOT NULL,            -- open | decided
    original TEXT,
    ai_opinion TEXT,
    decision TEXT,                   -- confirmed | changed
    decision_value TEXT,
    decision_reason TEXT,
    reviewer TEXT,
    created_at TEXT,
    decided_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

JSON_COLS = {"transcript", "config", "settings", "result", "final", "usage", "original", "ai_opinion", "value"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def conn() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.executescript(SCHEMA)
            _conn.commit()
        return _conn


def _row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    if r is None:
        return None
    d = dict(r)
    for k in list(d):
        if k in JSON_COLS and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except json.JSONDecodeError:
                pass
    return d


def _dump(v: Any) -> Any:
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return v


def query(sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
    with _lock:
        cur = conn().execute(sql, tuple(params))
        return [_row(r) for r in cur.fetchall()]  # type: ignore[misc]


def one(sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    with _lock:
        cur = conn().execute(sql, tuple(_dump(p) for p in params))
        conn().commit()
        return cur.lastrowid or 0


def insert(table: str, data: dict[str, Any]) -> int:
    cols = ", ".join(data)
    qs = ", ".join("?" for _ in data)
    return execute(f"INSERT INTO {table} ({cols}) VALUES ({qs})", list(data.values()))


def update(table: str, row_id: Any, data: dict[str, Any], key: str = "id") -> None:
    sets = ", ".join(f"{k} = ?" for k in data)
    execute(f"UPDATE {table} SET {sets} WHERE {key} = ?", [*data.values(), row_id])


def upsert_dialog(rec: dict[str, Any], group_id: str, source: str) -> None:
    execute(
        """INSERT INTO dialogs (id, group_id, channel, language, transcript, audio_url, source, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id, channel=excluded.channel,
             language=excluded.language, transcript=excluded.transcript, audio_url=excluded.audio_url,
             source=excluded.source, imported_at=excluded.imported_at""",
        [
            rec["conversation_id"],
            group_id,
            rec.get("channel", ""),
            rec.get("language", ""),
            rec.get("transcript", []),
            rec.get("audio_url"),
            source,
            now(),
        ],
    )


def get_setting(key: str, default: Any = None) -> Any:
    r = one("SELECT value FROM settings WHERE key = ?", [key])
    return r["value"] if r else default


def set_setting(key: str, value: Any) -> None:
    execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, json.dumps(value, ensure_ascii=False)],
    )
