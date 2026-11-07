"""Operator names, overview, operator profile, coaching sheet, checklist simulation and the
round-1 backend fixes. Stub provider only: no model calls."""

from __future__ import annotations

import copy
import json
import time

import pytest
from conftest import DEV_JSON, StubProvider, login_as
from fastapi.testclient import TestClient

from cqa import app as app_module
from cqa import operators, providers
from cqa.analytics import reason_body, violation_of
from cqa.preprocess import prepare

DASHES = ("—", "–", "→", "←", "⇒")


# --- operator name extraction --------------------------------------------------------------

@pytest.mark.parametrize("cid, name", [
    ("p1-ru-001", "Алина"),
    ("p1-ru-004", "Артём"),
    ("p1-ru-018", "Саша"),
    ("p1-kz-002", "Нұрлан"),   # «Нұрланмын»: the Kazakh suffix is cut
    ("p1-kz-004", "Айбек"),    # «Айбекпін»
    ("p1-kz-006", "Әсел"),
    ("p1-en-001", "Maya"),
    ("p1-en-014", "Tyler"),
    ("p1-ru-014", operators.UNKNOWN),  # «Привет, где именно ищете?»: no introduction
    ("p1-kz-008", operators.UNKNOWN),
    ("p1-en-015", operators.UNKNOWN),
    ("p4-ru-001", operators.UNKNOWN),  # «[Имя скрыто]» in a call transcript
    ("p4-ru-005", operators.UNKNOWN),
])
def test_operator_name_on_dev(dev_records, cid, name):
    rec = next(r for r in dev_records if r["conversation_id"] == cid)
    assert operators.operator_name(prepare(rec).turns) == name


def test_operator_names_whole_dev(dev_records):
    names = [operators.operator_name(prepare(r).turns) for r in dev_records]
    named = [n for n in names if n != operators.UNKNOWN]
    assert len(names) == 65 and len(named) == 57
    assert len({operators.name_key(n) for n in named}) == 57


def test_name_from_text_rules():
    f = operators.name_from_text
    assert f("Здравствуйте! Меня зовут Алина, чем помочь?") == "Алина"
    assert f("Hi, I'm Maya from support.") == "Maya"
    assert f("Hello, this is Noah.") == "Noah"
    assert f("Сәлеметсіз бе, менің атым Дана.") == "Дана"
    assert f("Я сейчас проверю.") == operators.UNKNOWN          # lower case: not a name
    assert f("Это Фридом, слушаю вас") == operators.UNKNOWN     # company name is skipped
    assert f("Здравствуйте, меня зовут [Имя скрыто].") == operators.UNKNOWN
    assert f("") == operators.UNKNOWN and f(None) == operators.UNKNOWN
    assert operators.name_key("Артём") == operators.name_key("АРТЕМ") == "артем"
    assert operators.name_key(operators.UNKNOWN) == operators.UNKNOWN_KEY
    assert operators.operator_name([{"speaker": "bot", "phase": "pre_operator", "text": "Я Бот"},
                                    {"speaker": "operator", "phase": "main", "text": "Я Олег"}]) == "Олег"


def test_reason_helpers():
    r = "Грубые ошибки: Да, вид (б): предложение платной услуги в обход компании. Оператор попросил личный номер (T12)."
    assert reason_body(r) == "Оператор попросил личный номер (T12)."
    assert reason_body("Грубые ошибки: Да, вид (б). Оператор предложил консультацию (T12).") == "Оператор предложил консультацию (T12)."
    assert reason_body("Эмпатия: Нет. Оператор нагрубил (T10).") == "Оператор нагрубил (T10)."
    assert violation_of(r)["id"] == "paid"
    assert violation_of("Грубые ошибки: Да. Выявлено оскорбление клиента (вид а).")["id"] == "insult"
    assert violation_of("что-то иное")["id"] == "other"


# --- API --------------------------------------------------------------------------------

A = {"c07": "NO", "c08": "NO"}                              # p1-ru-001: only the closing is missed
B = {"c08": "YES", "c05": "NO", "c06": "4"}                 # p1-ru-029: gross error
C = {"c08": "NO", "c02": "NA"}                              # p1-kz-002


@pytest.fixture
def client(temp_db, monkeypatch):
    monkeypatch.delenv("CQA_QUICK_LOGIN_ROLES", raising=False)
    stub = StubProvider(appeal={"value": "YES", "appeal_valid": True})
    monkeypatch.setattr(providers, "make_provider", lambda settings: stub)
    with TestClient(app_module.app) as c:
        assert c.post("/api/auth/quick", json={"username": "supervisor"}).status_code == 200
        c.stub = stub  # type: ignore[attr-defined]
        yield c


def wait_done(c: TestClient, ids: list[int], timeout: float = 10.0) -> list[dict]:
    t0 = time.time()
    while time.time() - t0 < timeout:
        items = c.get("/api/evaluations", params={"ids": ",".join(map(str, ids))}).json()["items"]
        if items and all(i["status"] in ("done", "error") for i in items):
            return items
        time.sleep(0.03)
    raise AssertionError("evaluations did not finish")


def evaluate(c: TestClient, dialog_id: str, script: dict) -> int:
    c.stub.script.append(script)
    eid = c.post("/api/evaluations", json={"dialog_ids": [dialog_id], "settings": {"votes": 1}}).json()["evaluation_ids"][0]
    assert wait_done(c, [eid])[0]["status"] == "done"
    return eid


@pytest.fixture
def seeded(client):
    payload = json.loads(DEV_JSON.read_text(encoding="utf-8"))
    assert client.post("/api/dialogs/import", json={"group_id": "DEV", "payload": payload}).json()["imported"] == 65
    ids = {"ru1": evaluate(client, "p1-ru-001", A), "ru29": evaluate(client, "p1-ru-029", B),
           "kz2": evaluate(client, "p1-kz-002", C)}
    return client, ids


def test_overview(seeded):
    c, ids = seeded
    o = c.get("/api/overview").json()
    assert o["options"] == {"groups": ["DEV"], "languages": ["EN", "KZ", "RU"], "channels": ["agent chat", "voice call"]}
    k = o["kpi"]
    assert (k["dialogs"], k["evaluated"], k["not_evaluated"], k["gross_dialogs"]) == (65, 3, 62, 1)
    assert [col["id"] for col in o["columns"]] == [f"c0{i}" for i in range(1, 9)]
    rows = o["rows"]
    assert rows[0]["dialog_id"] == "p1-ru-029" and rows[0]["gross"] is True  # worst first
    assert rows[0]["operator"] == "Алексей" and rows[0]["weakest_cid"] == "c08"
    cells = rows[0]["cells"]
    assert cells["c08"]["status"] == "fail" and cells["c08"]["f"] == 0.0
    assert cells["c06"]["status"] == "partial" and cells["c06"]["f"] == 0.4 and cells["c06"]["v"] == "4"
    assert cells["c05"]["status"] == "fail" and cells["c05"]["lost"] > 0
    kz = next(r for r in rows if r["dialog_id"] == "p1-kz-002")
    assert kz["cells"]["c02"]["status"] == "na" and kz["cells"]["c02"]["f"] is None
    ws = {w["criterion_id"]: w for w in o["weak_spots"]}
    assert ws["c08"]["fail"] == 1 and ws["c08"]["applicable"] == 3 and ws["c08"]["avg_points_lost"] is None
    assert ws["c07"]["fail"] == 1 and ws["c07"]["worst_dialogs"] == ["p1-ru-001"]
    assert ws["c02"]["na"] == 1 and ws["c02"]["applicable"] == 2
    assert [o_["name"] for o_ in o["operators"]] == ["Алексей", "Алина", "Нұрлан"]
    assert all(o_["low_data"] and o_["rank"] for o_ in o["operators"]) and o["unnamed"] is None
    g = o["recent_gross"]
    assert len(g) == 1 and g[0]["dialog_id"] == "p1-ru-029" and g[0]["criterion_id"] == "c08" and o["gross_total"] == 1
    kz_only = c.get("/api/overview", params={"language": "KZ"}).json()
    assert kz_only["kpi"]["dialogs"] == 15 and kz_only["kpi"]["evaluated"] == 1 and kz_only["filters"]["language"] == "KZ"


def test_operator_profile(seeded):
    c, ids = seeded
    p = c.get("/api/operators/Алина").json()  # the key is case-insensitive
    assert p["key"] == "алина" and p["name"] == "Алина" and p["languages"] == ["RU"]
    s = p["summary"]
    assert s["dialogs"] == 1 and s["low_data"] is True and s["of"] == 3 and s["rank"] == 2
    crit = {x["criterion_id"]: x for x in p["criteria"]}
    assert crit["c07"]["rate"] == 0.0 and crit["c07"]["failed_dialogs"] == ["p1-ru-001"]
    assert crit["c07"]["team_rate"] == pytest.approx(10.88 / 15.88, abs=1e-4) and crit["c07"]["delta"] < 0
    assert crit["c08"]["rate"] == 1.0 and crit["c08"]["team_rate"] < 1
    assert p["dialogs"][0]["dialog_id"] == "p1-ru-001" and p["dialogs"][0]["failed"] == ["c07"]
    assert c.get("/api/operators/Алексей").json()["gross_items"][0]["violation"]["id"]
    assert c.get("/api/operators/nobody").status_code == 404
    assert c.get("/api/operators").json()["items"][0]["name"] == "Алексей"


def test_coaching_sheet(seeded):
    c, ids = seeded
    sh = c.get(f"/api/evaluations/{ids['ru29']}/coaching").json()
    assert sh["dialog"]["operator"] == "Алексей" and sh["evaluation"]["gross"] is True
    assert [i["criterion_id"] for i in sh["items"]] == ["c08", "c05", "c06"]  # gross first, then lost points
    assert sh["items"][0]["status"] == "gross" and sh["items"][2]["status"] == "partial"
    assert sh["items"][2]["step_label"] and sh["items"][1]["max_points"] > 0
    assert all(q["turn"] == f"T{q['idx'] + 1}" for i in sh["items"] for q in i["quotes"])
    imp = {i["criterion_id"]: i["text"] for i in sh["improve"]}
    assert imp["c05"].startswith("Ожидается: ") and imp["c06"].startswith("Сейчас: ") and "Ожидается: " in imp["c06"]
    assert imp["c08"].startswith("Недопустимо: ")
    assert sh["passed_count"] == 5 and sh["applicable_count"] == 8
    assert not any(d in sh["plain_text"] for d in DASHES)
    clean = c.get(f"/api/evaluations/{ids['kz2']}/coaching").json()
    assert clean["items"] == [] and "Замечаний нет" in clean["plain_text"]
    assert c.get("/api/evaluations/999/coaching").status_code == 404


def test_appeal_flow_shows_in_overview_and_list(seeded):
    c, ids = seeded
    a = c.post(f"/api/evaluations/{ids['ru1']}/appeals", json={"criterion_id": "c07", "comment": "Оператор попрощался."}).json()
    assert a["author"] == "Айгерим Сапарова"
    login_as(c, "reviewer")
    rv = c.post(f"/api/appeals/{a['id']}/ai-review").json()["appeal"]["ai_opinion"]
    assert rv["requested_at"] and rv["requested_by"] == "Дамир Ахметов"
    c.post(f"/api/appeals/{a['id']}/decide", json={"action": "change", "value": "YES", "reason": "Итог подведён."})
    row = next(r for r in c.get("/api/overview").json()["rows"] if r["dialog_id"] == "p1-ru-001")
    assert row["final_total"] == 100.0 and row["cells"]["c07"]["overridden"] is True
    assert row["cells"]["c07"]["appeal"]["decision"] == "changed"
    assert c.get(f"/api/evaluations/{ids['ru1']}/coaching").json()["items"] == []
    item = c.get("/api/appeals").json()["items"][0]
    assert item["total_delta"] > 0 and item["original_value_label"] == "Нет" and item["decision_value_label"] == "Да"
    assert item["is_latest_evaluation"] is True
    login_as(c, "supervisor")
    assert len(c.get("/api/appeals", params={"mine": 1}).json()["items"]) == 1
    assert c.get("/api/appeals", params={"dialog_id": "p1-ru-029"}).json()["items"] == []
    new = evaluate(c, "p1-ru-001", A)  # a newer evaluation does not carry the decision over
    item = c.get("/api/appeals").json()["items"][0]
    assert item["is_latest_evaluation"] is False and item["latest_evaluation_id"] == new


def test_simulate_checklist(seeded):
    c, ids = seeded
    cfg = c.get("/api/checklists/active").json()["config"]
    same = c.post("/api/checklists/simulate", json={"config": cfg}).json()
    assert same["errors"] == [] and same["changed_count"] == 0 and same["before"] == same["after"]
    edited = copy.deepcopy(cfg)
    next(x for x in edited["criteria"] if x["id"] == "c07")["weight"] = 25
    edited["criteria"].append({"id": "c09", "code": "09", "name": "Проверка понимания", "section": "start",
                               "type": "binary", "weight": 5, "na_allowed": False,
                               "description": "Да: оператор уточнил, понятен ли ответ.", "scale": []})
    sim = c.post("/api/checklists/simulate", json={"config": edited}).json()
    assert sim["dialogs"] == 3 and sim["new_criteria"] == ["c09"]
    assert sim["after"]["avg_final"] < sim["before"]["avg_final"]
    ch = {x["dialog_id"]: x for x in sim["changed"]}
    assert ch["p1-ru-001"]["delta"] < 0 and "p1-kz-002" not in ch  # 100 stays 100
    bad = copy.deepcopy(cfg)
    bad["criteria"][0]["weight"] = -1
    r = c.post("/api/checklists/simulate", json={"config": bad}).json()
    assert r["errors"] and r["issues"][0]["field"] == "weight" and r["after"] is None


def test_validation_issues_and_section_order(client):
    cfg = client.get("/api/checklists/active").json()["config"]
    bad = copy.deepcopy(cfg)
    bad["criteria"][1]["code"] = "01"
    bad["criteria"][3]["scale"][1]["value"] = ""
    bad["criteria"][5]["scale"][2]["value"] = 10
    bad["criteria"][0]["na_allowed"] = True
    bad["criteria"][4]["description"] = " "
    v = client.post("/api/checklists/validate", json={"config": bad}).json()
    got = {(i["criterion_index"], i["field"], i["step_index"]) for i in v["issues"]}
    assert got == {(0, "na_condition", None), (1, "code", None), (3, "scale", 1), (4, "description", None),
                   (5, "scale", 2)}
    assert v["errors"] == [i["message"] for i in v["issues"]] and len(set(v["errors"])) == 5
    r = client.post("/api/checklists", json={"config": bad})
    assert r.status_code == 422 and len(r.json()["detail"]["issues"]) == 5
    # a criterion appended at the end goes next to its section
    new = copy.deepcopy(cfg)
    new["criteria"].append({"id": "c09", "code": "09", "name": "Проверка понимания", "section": "start",
                            "type": "binary", "weight": 5, "na_allowed": False, "description": "Да: уточнил."})
    saved = client.post("/api/checklists", json={"config": new, "activate": False}).json()
    assert [x["id"] for x in saved["config"]["criteria"]] == ["c01", "c02", "c09", "c03", "c04", "c05", "c06", "c07", "c08"]


def test_round1_backend_fixes(seeded, monkeypatch):
    c, ids = seeded
    # stats follow the dialogs filters
    st = c.get("/api/stats", params={"language": "KZ"}).json()
    assert (st["dialogs"], st["evaluated"], st["not_evaluated"], st["gross_count"]) == (15, 1, 14, 0)
    assert c.get("/api/stats").json()["gross_count"] == 1
    # search by operator name, operator in rows and in the card
    found = c.get("/api/dialogs", params={"q": "алина"}).json()["items"]
    assert "p1-ru-001" in [i["id"] for i in found] and found[0]["operator"]
    assert c.get("/api/dialogs/p1-kz-002").json()["dialog"]["operator"] == "Нұрлан"
    gross = c.get("/api/gross-errors").json()["items"][0]
    assert gross["operator"] == "Алексей" and gross["criteria"][0]["violation"]["id"]
    # results.json without a group leaves the manual UPLOAD test dialogs out
    c.post("/api/dialogs/import", json={"payload": {"text": "Клиент: привет\nОператор: Здравствуйте, я Олег."}})
    chk = c.get("/api/export/results/check").json()
    assert chk["groups"] == ["DEV"] and chk["count"] == 65
    assert c.get("/api/export/results/check", params={"group_id": "UPLOAD"}).json()["count"] == 1
    # only_missing skips dialogs already evaluated by this checklist version
    r = c.post("/api/evaluations", json={"dialog_ids": ["p1-ru-001", "p1-ru-002"], "only_missing": True,
                                         "settings": {"votes": 1}}).json()
    assert r["skipped"] == ["p1-ru-001"] and len(r["evaluation_ids"]) == 1
    wait_done(c, r["evaluation_ids"])
    # cost estimate from history (stub model differs from the settings model: defaults)
    est = c.get("/api/evaluations/estimate", params={"dialogs": 4, "votes": 3}).json()
    assert est["basis"]["source"] == "default" and est["per_dialog_usd"] == pytest.approx(0.08 + 2 * 0.016)
    assert est["total_usd"] == pytest.approx(round(4 * est["per_dialog_usd"], 2))
    assert c.get("/api/evaluations/estimate", params={"votes": 0}).status_code == 400
    # favicon, masked key only for the supervisor
    assert c.get("/favicon.ico").status_code in (200, 204)
    c.post("/api/auth/quick", json={"username": "operator"})
    assert c.get("/api/settings/anthropic-key").json()["masked"] == ""
    assert c.get("/api/overview").status_code == 403  # team analytics are not for operators


def test_operator_session_bound_to_own_dialogs(seeded):
    c, _ids = seeded
    ops = c.get("/api/auth/quick").json()["operators"]
    alina = next(o for o in ops if o["key"] == "алина")
    assert alina["name"] == "Алина" and alina["dialogs"] >= 1
    assert c.post("/api/auth/quick", json={"username": "operator", "operator_key": "нет-такого"}).status_code == 404
    r = c.post("/api/auth/quick", json={"username": "operator", "operator_key": "Алина"})
    assert r.status_code == 200
    u = r.json()["user"]
    assert u["role"] == "operator" and u["display_name"] == "Алина" and u["operator_key"] == "алина"
    assert c.get("/api/auth/me").json()["user"]["operator_key"] == "алина"
    items = c.get("/api/dialogs").json()["items"]
    assert items and all(i["operator_key"] == "алина" for i in items)
    assert c.get("/api/dialogs/p1-ru-001").status_code == 200
    other = c.get("/api/dialogs/p1-kz-002")
    assert other.status_code == 403
    assert c.get("/api/stats").json()["dialogs"] == len(items)
    assert c.get("/api/overview").status_code == 403
    # appeal on own evaluation works and is listed; someone else's is refused
    e_own = c.get("/api/evaluations", params={"dialog_id": "p1-ru-001"}).json()["items"]
    assert e_own
    assert all(e["dialog_id"] == "p1-ru-001" for e in c.get("/api/evaluations").json()["items"])
    r = c.post(f"/api/evaluations/{e_own[0]['id']}/appeals", json={"criterion_id": "c07", "comment": "Прощание было (T12)."})
    assert r.status_code == 200 and r.json()["author"] == "Алина"
    mine = c.get("/api/appeals", params={"mine": 1}).json()["items"]
    assert [a["id"] for a in mine] == [r.json()["id"]]


def test_overview_marks_version_mix(seeded):
    c, _ids = seeded
    o = c.get("/api/overview").json()
    assert o["checklist"]["mixed"] is False and o["checklist"]["evaluated_versions"][0]["dialogs"] == 3
    cfg = copy.deepcopy(c.get("/api/checklists/active").json()["config"])
    next(x for x in cfg["criteria"] if x["id"] == "c07")["weight"] = 15
    cfg["criteria"].append({"id": "c09", "code": "09", "name": "Проверка понимания", "section": "start",
                            "type": "binary", "weight": 5, "na_allowed": False,
                            "description": "Да: оператор уточнил, понятен ли ответ.", "scale": []})
    r = c.post("/api/checklists", json={"config": cfg, "activate": True})
    assert r.status_code == 200, r.text
    o = c.get("/api/overview").json()
    assert o["checklist"]["mixed"] is True and o["checklist"]["version"] == 2
    assert [v["version"] for v in o["checklist"]["evaluated_versions"]] == [1]
    cols = {col["id"]: col for col in o["columns"]}
    assert cols["c07"]["weight"] == 15 and cols["c07"]["scored_weights"] == [5] and cols["c07"]["weight_changed"]
    assert cols["c09"]["evaluated"] == 0 and cols["c01"]["evaluated"] == 3 and not cols["c01"]["weight_changed"]
