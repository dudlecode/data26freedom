"""Full API flow on a temporary database with the stub provider injected into make_provider."""

from __future__ import annotations

import copy
import json
import time

import pytest
from conftest import DEV_JSON, StubProvider
from fastapi.testclient import TestClient

from cqa import app as app_module
from cqa import calibration, providers


@pytest.fixture
def client(temp_db, monkeypatch):
    stub = StubProvider(appeal={"value": "NO", "appeal_valid": True})
    monkeypatch.setattr(providers, "make_provider", lambda settings: stub)
    with TestClient(app_module.app) as c:
        c.stub = stub  # type: ignore[attr-defined]
        yield c


def wait_done(c: TestClient, ids: list[int], timeout: float = 10.0) -> list[dict]:
    t0 = time.time()
    while time.time() - t0 < timeout:
        items = c.get("/api/evaluations", params={"ids": ",".join(map(str, ids))}).json()["items"]
        if items and all(i["status"] in ("done", "error") for i in items):
            return items
        time.sleep(0.05)
    raise AssertionError("evaluations did not finish")


def test_health_settings_seed(client):
    h = client.get("/api/health").json()
    assert h["ok"] is True and {"has_anthropic_key", "source_configured", "version"} <= set(h)
    s = client.get("/api/settings").json()
    assert s["settings"]["provider"] == "anthropic" and s["models"] and s["efforts"]
    assert [p["id"] for p in s["providers"]] == ["anthropic", "openai_compat"]
    r = client.put("/api/settings", json={"votes": 2, "effort": "medium", "api_key": "nope"}).json()
    assert r["settings"]["votes"] == 2 and r["settings"]["effort"] == "medium" and "api_key" not in r["settings"]
    assert client.put("/api/settings", json={"votes": 0}).status_code == 400
    lst = client.get("/api/checklists").json()["items"]
    assert len(lst) == 1 and lst[0]["version"] == 1 and lst[0]["is_active"] and lst[0]["total_weight"] == 100
    k = client.get("/api/settings/anthropic-key").json()
    assert set(k) == {"configured", "masked"}


def test_full_flow(client):
    payload = json.loads(DEV_JSON.read_text(encoding="utf-8"))
    r = client.post("/api/dialogs/import", json={"group_id": "DEV", "payload": payload}).json()
    assert r["imported"] == 65
    dl = client.get("/api/dialogs", params={"language": "KZ"}).json()
    assert len(dl["items"]) == 15 and dl["groups"] == ["DEV"]
    assert client.get("/api/dialogs", params={"q": "p4-ru"}).json()["items"][0]["channel"] == "voice call"
    d = client.get("/api/dialogs/p4-ru-001").json()
    assert d["dialog"]["has_audio"] is True and d["turns"][0]["idx"] == 0 and "phase" in d["turns"][0]
    assert "first_response_s" in d["facts"]

    # free-text import
    r = client.post("/api/dialogs/import", json={"payload": {"text": "[00:01] Клиент: привет\n[00:10] Оператор: Здравствуйте!", "conversation_id": "txt-1"}})
    assert r.json() == {"imported": 1, "ids": ["txt-1"], "group_id": "UPLOAD", "renamed": {}}
    assert client.get("/api/dialogs", params={"group_id": "UPLOAD"}).json()["items"][0]["id"] == "txt-1"

    # new checklist version: replace c07 with another criterion
    cfg = client.get("/api/checklists/active").json()["config"]
    assert client.post("/api/checklists/validate", json={"config": {"criteria": []}}).json()["errors"]
    bad = client.post("/api/checklists", json={"config": {"name": "x", "criteria": []}})
    assert bad.status_code == 422 and bad.json()["detail"]["errors"]
    new = copy.deepcopy(cfg)
    new["criteria"] = [c for c in new["criteria"] if c["id"] != "c07"] + [
        {"id": "c09", "code": "09", "name": "Предложение доп. помощи", "section": "conduct", "type": "binary",
         "weight": 5, "na_allowed": False, "description": "Оператор спросил, остались ли вопросы.",
         "na_condition": "", "scale": [], "guidance": ""}
    ]
    v = client.post("/api/checklists/validate", json={"config": new}).json()
    assert v == {"errors": [], "total_weight": 100}
    created = client.post("/api/checklists", json={"config": new, "note": "замена c07"}).json()
    assert created["version"] == 2 and created["is_active"] is True
    assert client.get("/api/checklists/active").json()["id"] == created["id"]
    assert client.get("/api/checklists/default").json()["criteria"][6]["id"] == "c07"

    # evaluate two dialogs with the new checklist (votes=1 override)
    r = client.post("/api/evaluations", json={"dialog_ids": ["p1-ru-001", "p1-en-001"], "settings": {"votes": 1}})
    ids = r.json()["evaluation_ids"]
    items = wait_done(client, ids)
    assert all(i["status"] == "done" for i in items), items
    assert all(i["checklist_version"] == 2 for i in items)
    ev = client.get(f"/api/evaluations/{ids[0]}").json()
    assert "c09" in ev["result"]["criteria"] and "c07" not in ev["result"]["criteria"]
    assert "Предложение доп. помощи" in client.stub.calls[0]["system"]
    assert ev["total"] == 100.0 and ev["final_total"] == 100.0  # stub answers top values
    assert len(ev["result"]["runs"]) == 1 and ev["result"]["runs"][0]["model"] == "stub-model"
    assert ev["checklist"]["version"] == 2 and ev["settings"]["votes"] == 1
    assert set(ev["final"]) == {"values", "score", "overrides"}
    assert client.get("/api/evaluations", params={"status": "active"}).json()["items"] == []

    # the old checklist version can still be used explicitly
    r = client.post("/api/evaluations", json={"dialog_ids": ["p1-ru-001"], "checklist_id": 1, "settings": {"votes": 2}})
    old = wait_done(client, r.json()["evaluation_ids"])[0]
    assert old["checklist_version"] == 1
    old_full = client.get(f"/api/evaluations/{old['id']}").json()
    assert "c07" in old_full["result"]["criteria"] and len(old_full["result"]["runs"]) == 2

    # appeal -> ai-review -> decide change
    eid = ids[0]
    a = client.post(f"/api/evaluations/{eid}/appeals", json={"criterion_id": "c05", "comment": "Не было эмпатии", "author": "QA"})
    assert a.status_code == 200, a.text
    appeal = a.json()
    assert appeal["status"] == "open" and appeal["original"]["value"] == "YES" and appeal["original"]["points"] is not None
    assert appeal["criterion_name"] == "Эмпатия и клиентоориентированность"
    assert client.post(f"/api/evaluations/{eid}/appeals", json={"criterion_id": "c05", "comment": "x"}).status_code == 409
    assert client.post(f"/api/evaluations/{eid}/appeals", json={"criterion_id": "zzz"}).status_code == 400

    detail = client.get(f"/api/appeals/{appeal['id']}").json()
    assert detail["criterion"]["id"] == "c05" and detail["fragment"] and detail["evaluation"]["id"] == eid

    rv = client.post(f"/api/appeals/{appeal['id']}/ai-review").json()["appeal"]
    op = rv["ai_opinion"]
    assert op["value"] == "NO" and op["appeal_valid"] is True and op["model"] == "stub-model"
    assert 999 not in op["evidence_turns"]
    assert "Не было эмпатии" in client.stub.calls[-1]["user"]

    assert client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "change", "value": "MAYBE", "reason": "x"}).status_code == 400
    assert client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "change", "value": "NO", "reason": ""}).status_code == 400
    dec = client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "change", "value": "no", "reason": "Согласен с апелляцией", "reviewer": "Старший QA"}).json()
    assert dec["final_total"] == 85.0
    assert dec["appeal"]["decision"] == "changed" and dec["appeal"]["decision_value"] == "NO"
    assert dec["appeal"]["total_before"] == 100.0 and dec["appeal"]["total_after"] == 85.0
    ev = client.get(f"/api/evaluations/{eid}").json()
    assert ev["total"] == 100.0 and ev["final_total"] == 85.0
    assert ev["final"]["overrides"]["c05"]["from"] == "YES" and ev["final"]["overrides"]["c05"]["to"] == "NO"
    assert ev["result"]["criteria"]["c05"]["value"] == "YES"  # original kept
    assert ev["decided_appeals"] == 1 and ev["open_appeals"] == 0
    assert client.post(f"/api/appeals/{appeal['id']}/decide", json={"action": "confirm", "reason": "x"}).status_code == 409

    # second appeal confirmed -> total unchanged
    a2 = client.post(f"/api/evaluations/{eid}/appeals", json={"criterion_id": "c01", "comment": "?"}).json()
    d2 = client.post(f"/api/appeals/{a2['id']}/decide", json={"action": "confirm", "reason": "Оценка верна"}).json()
    assert d2["final_total"] == 85.0 and d2["appeal"]["decision"] == "confirmed"
    assert len(client.get("/api/appeals", params={"status": "decided"}).json()["items"]) == 2
    assert client.get("/api/appeals", params={"status": "open"}).json()["items"] == []
    assert client.get("/api/appeals").json()["items"][0]["dialog_language"] in ("RU", "EN")

    # rerun
    rr = client.post(f"/api/evaluations/{eid}/rerun").json()
    re_ev = wait_done(client, [rr["evaluation_id"]])[0]
    assert re_ev["status"] == "done" and re_ev["checklist_id"] == created["id"]

    # stats, export, calibration
    st = client.get("/api/stats").json()
    assert st["dialogs"] == 66 and st["evaluated"] == 2 and st["total_cost_usd"] > 0
    assert "c09" in st["by_criterion"] or "c07" in st["by_criterion"]
    csv_r = client.get("/api/export", params={"group_id": "DEV", "format": "csv"})
    assert csv_r.status_code == 200 and csv_r.content.startswith(b"\xef\xbb\xbf")
    text = csv_r.content.decode("utf-8-sig")
    header = text.splitlines()[0].split(";")
    assert header[0] == "ID диалога" and len(text.splitlines()) == 3
    js = client.get("/api/export", params={"format": "json"}).json()
    assert {r["dialog_id"] for r in js} == {"p1-ru-001", "p1-en-001"}
    cal = client.get("/api/calibration").json()
    assert cal["available"] is True and cal["n_dialogs"] == 2
    assert {"overall_exact", "total_mae", "by_criterion", "dialogs"} <= set(cal)


def test_errors_and_failed_provider(client, monkeypatch):
    assert client.get("/api/dialogs/nope").status_code == 404
    assert client.post("/api/evaluations", json={"dialog_ids": []}).status_code == 400
    assert client.post("/api/evaluations", json={"dialog_ids": ["nope"]}).status_code == 404
    assert client.post("/api/dialogs/import", json={"payload": {"text": "без ролей"}}).status_code == 400
    client.post("/api/dialogs/import", json={"payload": {"text": "Клиент: тест\nОператор: ответ", "conversation_id": "t1"}})

    class Failing:
        name, model = "stub", "stub-model"

        async def complete_json(self, *a):
            raise providers.ProviderError("Ключ Claude API не принят (401).")

    monkeypatch.setattr(providers, "make_provider", lambda s: Failing())
    ids = client.post("/api/evaluations", json={"dialog_ids": ["t1"], "settings": {"votes": 2}}).json()["evaluation_ids"]
    item = wait_done(client, ids)[0]
    assert item["status"] == "error" and item["error"] == "Ключ Claude API не принят (401)."
    assert client.post(f"/api/evaluations/{ids[0]}/appeals", json={"criterion_id": "c01"}).status_code == 409
    full = client.get(f"/api/evaluations/{ids[0]}").json()
    assert len(full["result"]["runs"]) == 2 and all(r["error"] for r in full["result"]["runs"])
    assert client.get("/api/audio/t1").status_code == 404


def test_stale_jobs_marked_on_startup(temp_db, monkeypatch):
    from cqa import db

    with TestClient(app_module.app):
        pass
    db.insert("evaluations", {"dialog_id": "x", "checklist_id": 1, "status": "running", "created_at": db.now()})
    with TestClient(app_module.app) as c:
        e = c.get("/api/evaluations").json()["items"][0]
        assert e["status"] == "error" and e["error"] == "прервано перезапуском сервера"


def test_calibration_without_reference(client, monkeypatch, tmp_path):
    monkeypatch.setattr(calibration, "REFERENCE_PATH", tmp_path / "missing.json")
    assert client.get("/api/calibration").json()["available"] is False


def test_review_fixes_import_checklist_appeals(client):
    dev = json.loads(DEV_JSON.read_text(encoding="utf-8"))
    # organizers' response keeps its dataset_group_id when no group_id is given
    r = client.post("/api/dialogs/import", json={"payload": dev}).json()
    assert r["group_id"] == "DEV" and r["imported"] == 65
    # RU role names in JSON are mapped to operator/client; IDs are made URL-safe
    rec = {"conversation_id": "a/b c", "transcript": [
        {"timestamp": "2025-01-01T10:00:00Z", "speaker": "Клиент", "text": "Здравствуйте"},
        {"timestamp": "2025-01-01T10:00:05", "speaker": "Оператор", "text": "Добрый день!"}]}
    r = client.post("/api/dialogs/import", json={"payload": rec}).json()
    assert r["ids"] == ["a-b-c"]
    d = client.get("/api/dialogs/a-b-c")
    assert d.status_code == 200
    body = d.json()
    assert [t["speaker"] for t in body["turns"]] == ["client", "operator"]
    assert body["facts"]["operator_turns"] == 1 and body["turns"][1]["t"] == 5.0
    # empty transcript is rejected
    assert client.post("/api/dialogs/import", json={"payload": {"conversation_id": "e", "transcript": []}}).status_code == 400
    # re-import of a changed transcript of an evaluated dialog goes to a new id
    ev = client.post("/api/evaluations", json={"dialog_ids": ["a-b-c"]}).json()["evaluation_ids"]
    wait_done(client, ev)
    rec2 = copy.deepcopy(rec)
    rec2["transcript"][1]["text"] = "Другой текст"
    r = client.post("/api/dialogs/import", json={"payload": rec2}).json()
    assert r["renamed"] == {"a-b-c": "a-b-c-2"} and r["ids"] == ["a-b-c-2"]
    assert client.get("/api/dialogs/a-b-c").json()["turns"][1]["text"] == "Добрый день!"
    # same transcript again: no rename
    assert client.post("/api/dialogs/import", json={"payload": rec}).json()["renamed"] == {}

    # checklist validation: NaN weight, fractional/negative steps, ids differing by spaces
    base = client.get("/api/checklists/active").json()["config"]
    def bad(mut):
        cfg = copy.deepcopy(base)
        mut(cfg)
        v = client.post("/api/checklists/validate", json={"config": cfg})
        assert v.status_code == 200 and v.json()["errors"], v.json()
        assert client.post("/api/checklists", json={"config": cfg}).status_code == 422
    bad(lambda c: c["criteria"][0].__setitem__("weight", "NaN"))
    bad(lambda c: c["criteria"][0].__setitem__("weight", "Infinity"))
    scale = next(c for c in base["criteria"] if c["type"] == "scale")
    i = base["criteria"].index(scale)
    bad(lambda c: c["criteria"][i].__setitem__("scale", [{"value": 1, "label": "a"}, {"value": 0.5, "label": "b"}, {"value": 0, "label": "c"}]))
    bad(lambda c: c["criteria"][i].__setitem__("scale", [{"value": 0, "label": "a"}, {"value": -5, "label": "b"}]))
    bad(lambda c: c["criteria"][1].__setitem__("id", " " + c["criteria"][0]["id"] + " "))
    assert client.get("/api/checklists").status_code == 200

    # appeal changed back to the AI value leaves no override; ai-review refused once decided
    eid = ev[0]
    full = client.get(f"/api/evaluations/{eid}").json()
    cid, crit = next((c["id"], c) for c in full["checklist"]["config"]["criteria"] if c["type"] == "binary")
    orig = full["result"]["criteria"][cid]["value"]
    other = "NO" if orig == "YES" else "YES"
    a1 = client.post(f"/api/evaluations/{eid}/appeals", json={"criterion_id": cid, "comment": "x"}).json()
    client.post(f"/api/appeals/{a1['id']}/decide", json={"action": "change", "value": other, "reason": "r"})
    a2 = client.post(f"/api/evaluations/{eid}/appeals", json={"criterion_id": cid, "comment": "y"}).json()
    client.post(f"/api/appeals/{a2['id']}/decide", json={"action": "change", "value": orig, "reason": "r2"})
    full = client.get(f"/api/evaluations/{eid}").json()
    assert cid not in full["final"]["overrides"] and full["final_total"] == full["total"]
    assert client.post(f"/api/appeals/{a2['id']}/ai-review").status_code == 409
    g = client.get(f"/api/appeals/{a2['id']}").json()
    assert g["has_audio"] is False
