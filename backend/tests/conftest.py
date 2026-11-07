"""Shared test fixtures. The stub provider lives ONLY here (never reachable from the app)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from cqa import config, db  # noqa: E402
from cqa.providers import ProviderError, RunResult  # noqa: E402

DEV_JSON = ROOT / "data" / "dev.json"


def load_checklist() -> dict[str, Any]:
    return json.loads(config.DEFAULT_CHECKLIST_PATH.read_text(encoding="utf-8"))


class StubProvider:
    """Deterministic test double for providers.*Provider.

    script: list of per-run overrides {cid: value} (or an Exception to raise); runs beyond
    the script use the first allowed value from the schema enum (or `default`)."""

    name = "stub"

    def __init__(self, script: list[Any] | None = None, appeal: dict[str, Any] | None = None, model: str = "stub-model"):
        self.script = list(script or [])
        self.appeal = appeal or {}
        self.model = model
        self.calls: list[dict[str, Any]] = []

    async def complete_json(self, system: str, user: str, schema: dict[str, Any]) -> RunResult:
        self.calls.append({"system": system, "user": user, "schema": schema})
        props = schema["properties"]
        if "appeal_valid" in props:  # appeal schema
            enum = props["value"]["enum"]
            data = {
                "value": self.appeal.get("value", enum[0]),
                "reasoning": self.appeal.get("reasoning", "Повторная проверка (stub)."),
                "evidence_turns": self.appeal.get("evidence_turns", [1, 999]),
                "appeal_valid": self.appeal.get("appeal_valid", True),
                "recommendation": "Изменить оценку (stub).",
            }
            return RunResult(data=data, model=self.model, usage={"input_tokens": 10, "output_tokens": 5},
                             duration_ms=1, cost_usd=0.001, provider=self.name)
        run_no = len([c for c in self.calls if "appeal_valid" not in c["schema"]["properties"]]) - 1
        override = self.script[run_no] if run_no < len(self.script) else {}
        if isinstance(override, Exception):
            raise override
        def item(cid: str, enum: list[str]) -> dict[str, Any]:
            return {
                "reasoning": f"{cid}: обоснование прогона {run_no + 1} (T1).",
                "value": override.get(cid, enum[0]),
                "evidence_turns": [1, 2, 10_000, -3],
                "checked_from": -1,
                "checked_to": -1,
                "na_reason": "",
            }

        if props["criteria"]["type"] == "array":  # compact schema (many criteria)
            ip = props["criteria"]["items"]["properties"]
            criteria: Any = [{"criterion_id": cid, **item(cid, ["YES"])} for cid in ip["criterion_id"]["enum"]]
        else:
            criteria = {cid: item(cid, p["properties"]["value"]["enum"]) for cid, p in props["criteria"]["properties"].items()}
        return RunResult(
            data={"client_request": f"Запрос клиента (прогон {run_no + 1})", "criteria": criteria},
            model=self.model,
            usage={"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 20 * run_no},
            duration_ms=5,
            cost_usd=0.01,
            provider=self.name,
        )


def login_as(c: Any, role: str) -> None:
    """Switch the TestClient session to the demo user of `role` (operator, supervisor, reviewer)."""
    r = c.post("/api/auth/login", json={"username": role, "password": "freedom2026"})
    assert r.status_code == 200 and r.json()["user"]["role"] == role, r.text


@pytest.fixture
def checklist() -> dict[str, Any]:
    return load_checklist()


@pytest.fixture
def dev_records() -> list[dict[str, Any]]:
    return json.loads(DEV_JSON.read_text(encoding="utf-8"))["data"]["records"]


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """Point cqa.db at a fresh SQLite file for the duration of a test."""
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.sqlite3")
    if db._conn is not None:
        db._conn.close()
    db._conn = None
    yield tmp_path
    if db._conn is not None:
        db._conn.close()
    db._conn = None


__all__ = ["StubProvider", "ProviderError", "load_checklist", "login_as"]
