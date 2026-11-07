"""results.json в формате организаторов (CQA Student Guide Appendix, JSON 1.0)."""

from __future__ import annotations

import json
import time

import pytest
from conftest import DEV_JSON, StubProvider
from fastapi.testclient import TestClient

from cqa import app as app_module
from cqa import providers
from cqa import results as R

CODES = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"]


@pytest.fixture
def client(temp_db, monkeypatch):
    # c02 = N/A, c04 = 15, c06 = 7, грубая ошибка есть: проверяем типы значений и что итог не обнуляется
    stub = StubProvider(script=[{"c02": "NA", "c04": "15", "c06": "7", "c08": "YES"}] * 20)
    monkeypatch.setattr(providers, "make_provider", lambda settings: stub)
    monkeypatch.setenv("CQA_TEAM_NAME", "Тестовая команда")
    with TestClient(app_module.app) as c:
        c.post("/api/dialogs/import", json={"group_id": "DEV", "payload": json.loads(DEV_JSON.read_text(encoding="utf-8"))})
        yield c


def wait_done(c, ids):
    t0 = time.time()
    while time.time() - t0 < 10:
        items = c.get("/api/evaluations", params={"ids": ",".join(map(str, ids))}).json()["items"]
        if all(i["status"] in ("done", "error") for i in items):
            return
        time.sleep(0.05)
    raise AssertionError("not finished")


def test_value_ok_bool_int_trap():
    assert R.value_ok("dialogue", 0) and not R.value_ok("dialogue", False)
    assert R.value_ok("contact", False) and not R.value_ok("contact", 0)
    assert R.value_ok("consultation", None) and not R.value_ok("dialogue", None)
    assert not R.value_ok("consultation", 12)


def test_results_document(client):
    ids = client.post("/api/evaluations", json={"dialog_ids": ["p1-ru-001", "p1-en-001"], "settings": {"votes": 1}}).json()["evaluation_ids"]
    wait_done(client, ids)
    r = client.get("/api/results", params={"group_id": "DEV"}).json()
    doc = r["document"]
    assert r["count"] == 65 and r["ok"] == 2 and r["error"] == 63
    assert r["errors"] == []  # неоценённые диалоги - корректные записи status=error
    assert doc["schema_version"] == "1.0" and doc["team_name"] == "Тестовая команда"
    assert doc["model"] == {"mode": "local", "name": "stub-model"}  # модель по умолчанию - на localhost

    res = {x["conversation_id"]: x for x in doc["results"]}
    ok = res["p1-ru-001"]
    assert ok["status"] == "ok" and [c["criterion_id"] for c in ok["criteria"]] == CODES
    vals = {c["criterion_id"]: c["value"] for c in ok["criteria"]}
    assert vals["discovery"] is None and vals["consultation"] == 15 and vals["dialogue"] == 7
    assert vals["contact"] is True and vals["critical"] is True
    assert ok["score"]["critical_flag"] is True
    # итог: N/A у discovery (15) перераспределён, грубая ошибка итог не обнуляет
    # contact 10 + identification 20 + consultation 15 + empathy 15 + dialogue 10.5 + closure 5 = 75.5 из 85
    assert ok["score"]["final_score"] == round(75.5 / 85 * 100, 2)
    # stub даёт evidence_turns [1, 2, 10000, -3] (с 0) -> в файле [2, 3] (с 1), мусор отброшен
    assert all(c["evidence_turns"] == [2, 3] for c in ok["criteria"])
    assert all(isinstance(c["rationale"], str) and c["rationale"] for c in ok["criteria"])

    err = res["p1-kz-001"]
    assert err == {"conversation_id": "p1-kz-001", "status": "error", "criteria": [], "score": None, "error": "Диалог не оценён."}

    # проверка числа записей для prod
    assert R.validate(doc, expect=10) == ["записей 65, ожидается ровно 10"]

    # выгрузка файлом
    f = client.get("/api/export", params={"group_id": "DEV", "format": "results"})
    assert f.headers["content-disposition"].endswith('"results.json"') and json.loads(f.content)["results"]
    assert client.get("/api/export", params={"format": "results"}).status_code == 400


def test_validate_catches_broken_files():
    good = {"schema_version": "1.0", "team_name": "t", "model": {"mode": "local", "name": "qwen3:30b"}, "results": [
        {"conversation_id": "a", "status": "ok", "score": {"final_score": 85.38, "critical_flag": False},
         "criteria": [{"criterion_id": c, "value": v, "rationale": "x", "evidence_turns": [1]} for c, v in zip(
             CODES, [True, None, None, 15, True, 7, True, False])]},
        {"conversation_id": "b", "status": "error", "criteria": [], "score": None, "error": "нет ответа"},
    ]}
    assert R.validate(good, expect=2, expected_ids=["a", "b"]) == []
    bad = json.loads(json.dumps(good))
    bad["results"][0]["criteria"][5]["value"] = False          # dialogue: булево вместо шкалы
    bad["results"][0]["criteria"][0]["evidence_turns"] = [0]   # нумерация с 1
    bad["results"][0]["score"]["critical_flag"] = True         # не совпадает с critical
    bad["results"].append(dict(bad["results"][1]))             # дубль ID
    bad["model"]["mode"] = "cloud"
    errs = R.validate(bad, expect=2)
    joined = "\n".join(errs)
    for needle in ("dialogue: недопустимое значение False", "evidence_turns", "critical_flag", "повторяются conversation_id: b",
                   "записей 3", "model:"):
        assert needle in joined, (needle, errs)
