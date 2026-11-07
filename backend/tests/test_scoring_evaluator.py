from __future__ import annotations

import asyncio

import pytest
from conftest import ProviderError, StubProvider

from cqa import evaluator, scoring

ALL_GOOD = {"c01": "YES", "c02": "YES", "c03": "YES", "c04": "20", "c05": "YES", "c06": "10", "c07": "YES", "c08": "NO"}


# --- scoring ------------------------------------------------------------------------------

def test_full_marks_is_100(checklist):
    s = scoring.compute(checklist, ALL_GOOD)
    assert s["total"] == 100.0
    assert s["max_total"] == 100.0
    assert s["gross_error"] is False
    assert sum(sec["max_points"] for sec in s["sections"]) == pytest.approx(100.0, abs=0.02)


def test_na_redistribution_reference_example(checklist):
    # p1-ru-001 reference: c02/c03 N/A -> 65 applicable weight; c07 NO loses 5 of 65
    v = {**ALL_GOOD, "c02": "NA", "c03": "NA", "c07": "NO"}
    s = scoring.compute(checklist, v)
    assert s["applicable_weight"] == 65
    assert s["redistribution_factor"] == pytest.approx(100 / 65, abs=1e-4)
    assert s["total"] == 92.31
    assert s["criteria"]["c01"]["effective_weight"] == pytest.approx(15.38, abs=0.01)
    assert s["criteria"]["c02"]["points"] is None and s["criteria"]["c02"]["applicable"] is False


def test_scale_points_proportional(checklist):
    v = {**ALL_GOOD, "c06": "7", "c04": "10"}
    s = scoring.compute(checklist, v)
    assert s["criteria"]["c06"]["points"] == 10.5  # 15 * 7/10
    assert s["criteria"]["c04"]["points"] == 10.0  # 20 * 10/20
    assert s["total"] == 85.5


def test_flag_reported_separately(checklist):
    s = scoring.compute(checklist, {**ALL_GOOD, "c08": "YES"})
    assert s["gross_error"] is True and s["gross_criteria"] == ["c08"]
    assert s["total"] == 100.0  # gross_error_zeroes_total = false in the default checklist
    cfg = {**checklist, "gross_error_zeroes_total": True}
    assert scoring.compute(cfg, {**ALL_GOOD, "c08": "YES"})["total"] == 0.0


def test_all_na_gives_no_total():
    cfg = {"criteria": [{"id": "a", "type": "binary", "weight": 10, "na_allowed": True}], "sections": []}
    s = scoring.compute(cfg, {"a": "NA"})
    assert s["total"] is None and s["max_total"] is None


def test_normalize_value(checklist):
    c = {x["id"]: x for x in checklist["criteria"]}
    assert scoring.normalize_value(c["c01"], "да") == "YES"
    assert scoring.normalize_value(c["c01"], "NA") == "NO"  # N/A not allowed for c01
    assert scoring.normalize_value(c["c02"], "n/a") == "NA"
    assert scoring.normalize_value(c["c04"], 17) == "15"  # tie 15/20 -> 17 is closer to 15
    assert scoring.normalize_value(c["c04"], 18) == "20"
    assert scoring.normalize_value(c["c06"], "8") == "7"
    assert scoring.normalize_value(c["c08"], "NA") == "NO"


# --- aggregation --------------------------------------------------------------------------

def crit(checklist, cid):
    return next(c for c in checklist["criteria"] if c["id"] == cid)


def test_pick_value_majority_and_ties(checklist):
    c04, c01 = crit(checklist, "c04"), crit(checklist, "c01")
    assert evaluator.pick_value(c01, ["NO", "YES", "NO"]) == "NO"
    assert evaluator.pick_value(c01, ["YES", "NO"]) == "YES"  # binary tie -> first run
    assert evaluator.pick_value(c01, ["NO", "YES"]) == "NO"
    assert evaluator.pick_value(c04, ["20", "10"]) == "15"  # scale tie -> median snapped
    assert evaluator.pick_value(c04, ["20", "15"]) == "15"  # 17.5 equidistant -> lower step
    assert evaluator.pick_value(c04, ["20", "NA"]) == "20"
    assert evaluator.pick_value(c04, ["5", "5", "20"]) == "5"


def test_aggregate_agreement_and_reasoning_source(checklist):
    def run(v04, reason):
        return {"criteria": {"c04": {"value": v04, "reasoning": reason, "evidence_turns": [3, 3, 50, "x"],
                                     "checked_from": 5, "checked_to": 2, "na_reason": "x"}}}

    out = evaluator.aggregate(checklist, [run("10", "r1"), run("15", "r2"), run("15", "r3")], n_turns=10)
    c = out["c04"]
    assert c["value"] == "15" and c["votes"] == ["10", "15", "15"]
    assert c["agreement"] == pytest.approx(2 / 3, abs=1e-4)
    assert c["reasoning"] == "r2"  # first run that produced the winning value
    assert c["evidence_turns"] == [2]  # model's T3 (1-based) -> index 2
    assert c["checked_range"] == [1, 4]
    assert c["na_reason"] == ""  # only for NA
    # criterion missing from every run -> default value, zero agreement
    assert out["c01"]["votes"] == [] and out["c01"]["agreement"] == 0.0


def test_checked_range_rules():
    assert evaluator.checked_range(-1, -1, 10) is None
    assert evaluator.checked_range(0, 0, 10) is None  # T0 does not exist in 1-based numbering
    assert evaluator.checked_range(2, 20, 10) is None
    assert evaluator.checked_range(4, 6, 10) == [3, 5]
    assert evaluator.checked_range(10, 10, 10) == [9, 9]


# --- evaluator end-to-end -----------------------------------------------------------------

def test_evaluate_end_to_end(checklist, dev_records):
    rec = next(r for r in dev_records if r["conversation_id"] == "p1-ru-001")
    stub = StubProvider(script=[{"c07": "NO"}, {"c07": "NO"}, {"c07": "YES"}])
    out = asyncio.run(evaluator.evaluate(rec, checklist, {"votes": 3}, stub))
    assert len(stub.calls) == 3
    # same prompt for every vote (prompt caching)
    assert len({c["system"] for c in stub.calls}) == 1 and len({c["user"] for c in stub.calls}) == 1
    assert "p1-ru-001" in stub.calls[0]["user"]
    res = out["result"]
    assert set(res["criteria"]) == {c["id"] for c in checklist["criteria"]}
    assert res["criteria"]["c07"]["value"] == "NO"
    assert res["criteria"]["c07"]["agreement"] == pytest.approx(2 / 3, abs=1e-4)
    n = len(rec["transcript"])
    assert all(0 <= t < n for c in res["criteria"].values() for t in c["evidence_turns"])
    assert len(res["runs"]) == 3 and res["runs"][2]["values"]["c07"] == "YES"
    assert {"model", "provider", "usage", "duration_ms", "cost_usd", "values"} <= set(res["runs"][0])
    assert out["cost_usd"] == pytest.approx(0.03)
    assert out["usage"]["input_tokens"] == 300
    assert out["total"] == res["score"]["total"] == out["final_total"]
    assert out["final"]["overrides"] == {} and out["final"]["values"]["c07"] == "NO"
    assert res["client_request"] == "Запрос клиента (прогон 1)"


def test_evaluate_partial_failure_and_total_failure(checklist, dev_records):
    rec = dev_records[0]
    stub = StubProvider(script=[{}, ProviderError("сбой 2"), {}])
    out = asyncio.run(evaluator.evaluate(rec, checklist, {"votes": 3}, stub))
    errs = [r for r in out["result"]["runs"] if r.get("error")]
    assert len(errs) == 1 and errs[0]["error"] == "сбой 2"
    assert all(len(c["votes"]) == 2 for c in out["result"]["criteria"].values())

    bad = StubProvider(script=[ProviderError("ключ не принят"), ProviderError("ещё")])
    with pytest.raises(ProviderError, match="ключ не принят"):
        asyncio.run(evaluator.evaluate(rec, checklist, {"votes": 2}, bad))


def test_final_from_overrides(checklist):
    result = {"criteria": {cid: {"value": v} for cid, v in ALL_GOOD.items()}}
    decided = [
        {"id": 1, "criterion_id": "c07", "decision": "changed", "decision_value": "NO", "decision_reason": "a"},
        {"id": 2, "criterion_id": "c01", "decision": "confirmed", "decision_value": "YES", "decision_reason": "b"},
        {"id": 3, "criterion_id": "c07", "decision": "changed", "decision_value": "NA", "decision_reason": "c"},
    ]
    f = evaluator.final_from_overrides(checklist, result, decided)
    assert f["values"]["c07"] == "NA"
    assert f["overrides"] == {"c07": {"appeal_id": 3, "from": "YES", "to": "NA", "reason": "c"}}
    assert f["score"]["total"] == 100.0


def test_half_up_rounding_is_exact():
    from cqa import scoring
    cl = {"criteria": [
        {"id": "a", "type": "binary", "weight": 3},
        {"id": "b", "type": "scale", "weight": 13, "scale": [{"value": 0}, {"value": 14}, {"value": 20}]},
    ]}
    assert scoring.compute(cl, {"a": "NO", "b": "14"})["total"] == 56.88


def test_median_tie_reasoning_is_labelled(checklist):
    from cqa import evaluator
    c = next(c for c in checklist["criteria"] if c["type"] == "scale")
    steps = sorted(int(s["value"]) for s in c["scale"])
    if len(steps) < 3:
        return
    lo, hi = str(steps[0]), str(steps[-1])
    runs = [{"criteria": {c["id"]: {"value": lo, "reasoning": "low"}}},
            {"criteria": {c["id"]: {"value": hi, "reasoning": "high"}}}]
    out = evaluator.aggregate({"criteria": [c]}, runs, 5)[c["id"]]
    if out["value"] not in (lo, hi):
        assert out["reasoning"].startswith("Итог: медиана голосов")


# --- schema size: many criteria -----------------------------------------------------------

def _big_checklist(checklist, n_extra=4):
    import copy as _copy
    cfg = _copy.deepcopy(checklist)
    sec = cfg["criteria"][0]["section"]
    for i in range(n_extra):
        cfg["criteria"].append({"id": f"c{9 + i:02d}", "code": f"{9 + i:02d}", "name": f"Доп. критерий {i + 1}",
                                "type": "binary", "weight": 5, "section": sec, "description": "Правило.",
                                "na_allowed": False})
    return cfg


def test_schema_compact_above_eight_criteria(checklist):
    import json as _json
    from cqa import prompting
    strict = prompting.build_schema(checklist)
    assert strict["properties"]["criteria"]["type"] == "object"  # 8 criteria: calibrated schema kept
    big = _big_checklist(checklist)
    assert len(big["criteria"]) == 12
    sch = prompting.build_schema(big)
    items = sch["properties"]["criteria"]["items"]
    assert sch["properties"]["criteria"]["type"] == "array"
    assert items["properties"]["criterion_id"]["enum"] == [c["id"] for c in big["criteria"]]
    # constant structure: one item schema whatever the number of criteria
    assert len(_json.dumps(prompting.build_schema(_big_checklist(checklist, 12)))) < 2 * len(_json.dumps(sch))
    assert "criterion_id" in prompting.build_system(big)
    assert prompting.criteria_map({"criteria": [{"criterion_id": "c01", "value": "NO"}, {"criterion_id": "c01", "value": "YES"}]}) == {
        "c01": {"criterion_id": "c01", "value": "NO"}}


def test_evaluate_with_twelve_criteria(checklist, dev_records):
    big = _big_checklist(checklist)
    rec = next(r for r in dev_records if r["conversation_id"] == "p1-ru-001")
    stub = StubProvider(script=[{"c09": "NO", "c06": "7"}])
    out = asyncio.run(evaluator.evaluate(rec, big, {"votes": 1}, stub))
    res = out["result"]
    assert set(res["criteria"]) == {c["id"] for c in big["criteria"]}
    assert res["criteria"]["c09"]["value"] == "NO"
    assert res["criteria"]["c06"]["value"] == "7"
    assert res["runs"][0]["values"]["c12"] == "YES"
    assert out["total"] is not None


def test_api_message_strips_envelope():
    from cqa.providers import api_message

    class E(Exception):
        body = {"type": "error", "error": {"type": "invalid_request_error", "message": "The compiled grammar is too large."}}
    assert api_message(E()) == "The compiled grammar is too large."


def test_provider_retries_without_strict_format_when_grammar_too_large(monkeypatch):
    from types import SimpleNamespace

    import anthropic
    import httpx

    from cqa import config, providers

    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")
    p = providers.AnthropicProvider(model="claude-test")
    calls = []

    async def fake_create(kwargs):
        calls.append(kwargs)
        if "format" in kwargs["output_config"]:
            resp = httpx.Response(400, request=httpx.Request("POST", "https://api.test/v1/messages"))
            raise anthropic.BadRequestError(
                "Error code: 400", response=resp,
                body={"type": "error", "error": {"message": "The compiled grammar is too large, simplify."}})
        return SimpleNamespace(stop_reason="end_turn", model="claude-test",
                               content=[SimpleNamespace(type="text", text='{"client_request": "x", "criteria": {}}')],
                               usage=SimpleNamespace(input_tokens=1, output_tokens=1))

    monkeypatch.setattr(p, "_create", fake_create)
    rr = asyncio.run(p.complete_json("SYS", "USER", {"type": "object"}))
    assert rr.data["client_request"] == "x"
    assert len(calls) == 2 and "format" not in calls[1]["output_config"]
    assert "строго по схеме" in calls[1]["system"][0]["text"]
