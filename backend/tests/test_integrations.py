"""Журнал аудита и исходящие вебхуки (Power Automate / Dynamics 365) без сети: httpx через MockTransport."""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import httpx
import pytest
from conftest import DEV_JSON, StubProvider
from fastapi.testclient import TestClient

from cqa import app as app_module
from cqa import integrations as ig
from cqa import providers

HOOK = "https://prod-00.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=SECRET123"


class Received(list):
    status: dict


@pytest.fixture
def received(monkeypatch):
    """Перехватываем все исходящие POST вебхуков."""
    got = Received()
    status = {"code": 202}

    def handler(request: httpx.Request) -> httpx.Response:
        got.append(request)
        return httpx.Response(status["code"], text="accepted")

    real = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    monkeypatch.setattr(ig.httpx, "AsyncClient", fake_client)
    monkeypatch.setattr(ig.asyncio, "sleep", _no_sleep)
    got.status = status
    return got


async def _no_sleep(_s):
    return None


@pytest.fixture
def client(temp_db, monkeypatch, received):
    monkeypatch.setenv("CQA_WEBHOOK_URLS", HOOK)
    monkeypatch.setenv("CQA_WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("CQA_PUBLIC_URL", "https://cqa.example.kz/")
    stub = StubProvider(appeal={"value": "NO", "appeal_valid": True})
    monkeypatch.setattr(providers, "make_provider", lambda settings: stub)
    with TestClient(app_module.app) as c:
        yield c


def events(got: list[httpx.Request]) -> list[dict]:
    return [json.loads(r.content) for r in got]


def wait_for(pred, timeout: float = 10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = pred()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError("condition not met")


def test_mask_url_hides_signature():
    assert ig.mask_url(HOOK).endswith("api-version=1&sig=***")
    assert ig.mask_url("https://x.test/hook") == "https://x.test/hook"


def test_audit_and_webhooks_full_flow(client, received):
    payload = json.loads(DEV_JSON.read_text(encoding="utf-8"))
    client.post("/api/dialogs/import", json={"group_id": "DEV", "payload": payload})

    st = client.get("/api/integrations").json()
    assert st["webhooks"]["configured"] and st["webhooks"]["signed"]
    assert st["webhooks"]["urls"] == [ig.mask_url(HOOK)] and "SECRET123" not in json.dumps(st)
    assert st["swagger"] == "/docs" and "appeal.decided" in st["webhooks"]["events"]

    ids = client.post("/api/evaluations", json={"dialog_ids": ["p1-ru-001"], "settings": {"votes": 1}},
                      headers={"X-CQA-Role": "supervisor"}).json()["evaluation_ids"]
    done = wait_for(lambda: [e for e in events(received) if e["event"] == "evaluation.completed"])
    ev = done[0]
    assert ev["source"] == "cqa" and ev["version"] == 1 and ev["url"] == "https://cqa.example.kz/#/dialog/p1-ru-001"
    data = ev["data"]
    assert data["evaluation_id"] == ids[0] and data["conversation_id"] == "p1-ru-001" and data["group_id"] == "DEV"
    full = client.get(f"/api/evaluations/{ids[0]}").json()
    assert data["final_total"] == full["final_total"] and data["gross_error"] is full["gross"]
    assert data["gross_criteria"] == full["final"]["score"]["gross_criteria"]
    assert {c["id"] for c in data["criteria"]} >= {"c01", "c04", "c08"} and data["checklist"]["version"] == 1

    # подпись HMAC-SHA256 по телу запроса
    req = next(r for r in received if json.loads(r.content)["event"] == "evaluation.completed")
    expected = "sha256=" + hmac.new(b"s3cret", req.content, hashlib.sha256).hexdigest()
    assert req.headers["X-CQA-Signature"] == expected and req.headers["X-CQA-Event"] == "evaluation.completed"

    # апелляция -> решение: события и журнал
    eid = ids[0]
    appeal = client.post(f"/api/evaluations/{eid}/appeals", json={"criterion_id": "c05", "comment": "Нет эмпатии", "author": "Супервайзер Иванов"}).json()
    client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "change", "value": "NO", "reason": "Согласен", "reviewer": "Старший QA"})
    wait_for(lambda: {"appeal.created", "appeal.decided"} <= {e["event"] for e in events(received)})
    decided = next(e for e in events(received) if e["event"] == "appeal.decided")
    assert decided["data"]["decision"] == "changed" and decided["data"]["final_total"] == 85.0
    assert decided["url"] == f"https://cqa.example.kz/#/appeal/{appeal['id']}"

    log = client.get("/api/audit", params={"entity": "appeal", "entity_id": appeal["id"]}).json()["items"]
    assert [x["event"] for x in log] == ["appeal.decided", "appeal.created"]
    assert log[0]["actor"] == "Старший QA" and log[1]["actor"] == "Супервайзер Иванов"
    assert log[0]["data"]["from"] == "YES" and log[0]["data"]["to"] == "NO" and log[0]["data"]["total_after"] == 85.0
    assert "итог 100.0 → 85.0" in log[0]["summary"]

    all_events = {x["event"] for x in client.get("/api/audit").json()["items"]}
    assert {"dataset.imported", "evaluation.started", "appeal.created", "appeal.decided"} <= all_events
    started = client.get("/api/audit", params={"event": "evaluation.started"}).json()["items"][0]
    assert started["actor"] == "supervisor"

    # чек-лист: новая версия -> событие и запись
    cfg = client.get("/api/checklists/active").json()["config"]
    cfg["criteria"][0]["weight"] = 10
    created = client.post("/api/checklists", json={"config": cfg, "note": "проверка"}).json()
    wait_for(lambda: any(e["event"] == "checklist.created" for e in events(received)))
    assert client.get("/api/audit", params={"entity": "checklist", "entity_id": created["id"]}).json()["items"][0]["event"] == "checklist.created"

    # журнал доставок: всё доставлено, подпись в URL скрыта
    dl = client.get("/api/integrations/deliveries").json()["items"]
    assert dl and all(d["status"] == "ok" and d["http_status"] == 202 for d in dl)
    assert all("SECRET123" not in d["url"] for d in dl)


def test_webhook_test_endpoint_and_retries(client, received):
    r = client.post("/api/integrations/webhook/test").json()
    assert r["deliveries"][0]["status"] == "ok" and r["event"]["event"] == "webhook.test"

    received.status["code"] = 500  # type: ignore[attr-defined]
    r = client.post("/api/integrations/webhook/test", json={"url": "https://other.test/hook"}).json()
    d = r["deliveries"][0]
    assert d["status"] == "error" and d["http_status"] == 500 and d["url"] == "https://other.test/hook"
    assert sum(1 for x in received if str(x.url) == "https://other.test/hook") == ig.RETRIES
    assert client.post("/api/integrations/webhook/test", json={"url": "ftp://x"}).status_code == 400


def test_no_webhooks_configured(temp_db, monkeypatch, received):
    monkeypatch.delenv("CQA_WEBHOOK_URLS", raising=False)
    monkeypatch.delenv("CQA_WEBHOOK_URL", raising=False)
    with TestClient(app_module.app) as c:
        assert c.get("/api/integrations").json()["webhooks"]["configured"] is False
        assert c.post("/api/integrations/webhook/test").status_code == 400
        c.put("/api/settings", json={"votes": 2})
        item = c.get("/api/audit", params={"event": "settings.changed"}).json()["items"][0]
        assert item["data"]["votes"]["to"] == 2
    assert received == []
