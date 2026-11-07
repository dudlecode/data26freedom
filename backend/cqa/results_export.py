"""Export evaluations in the organizers' results format (JSON 1.0) and validate it.

Format: CQA_Student_Guide_Appendix_Results.pdf
- one object per file: {schema_version, team_name, model: {mode, name}, results: [...]}
- per dialog: {conversation_id, status: "ok", criteria: [8 x {criterion_id, value, rationale,
  evidence_turns}], score: {final_score, critical_flag}} or the error form
  {conversation_id, status: "error", criteria: [], score: null, error}
- value: true = Да, false = Нет, null = N/A, number = scale step before weighting
- evidence_turns: 1-based positions in the original transcript array (client, bot and
  system lines included)
"""

from __future__ import annotations

import os
from typing import Any

from . import scoring
from .text import plain

SCHEMA_VERSION = "1.0"

# Organizers' criterion codes, in their order, with the allowed values.
STANDARD = [
    ("contact", {True, False}),
    ("discovery", {True, False, None}),
    ("identification", {True, False, None}),
    ("consultation", {0, 5, 10, 15, 20, None}),
    ("empathy", {True, False}),
    ("dialogue", {0, 4, 7, 10}),
    ("closure", {True, False, None}),
    ("critical", {True, False}),
]
STANDARD_IDS = [c for c, _ in STANDARD]
# Fallback mapping for checklists saved before criteria carried an export_id.
DEFAULT_EXPORT_IDS = dict(zip(["c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08"], STANDARD_IDS))


def export_id(criterion: dict[str, Any]) -> str:
    return criterion.get("export_id") or DEFAULT_EXPORT_IDS.get(criterion["id"]) or criterion["id"]


def json_value(criterion: dict[str, Any], value: str | None) -> Any:
    if value is None or value == scoring.NA:
        return None
    if criterion.get("type") == "scale":
        return int(float(value))
    return value == scoring.YES


def model_block(evals: list[dict[str, Any]]) -> dict[str, str]:
    providers, names = set(), []
    for e in evals:
        for r in ((e.get("result") or {}).get("runs") or []):
            if r.get("error"):
                continue
            providers.add(r.get("provider") or "")
            m = r.get("model")
            if m and m not in names:
                names.append(m)
    local = {"openai_compat"}
    if providers and providers <= local:
        mode = "local"
    elif providers & local:
        mode = "hybrid"
    else:
        mode = "external_api"
    return {"mode": mode, "name": ", ".join(names) or "unknown"}


def dialog_entry(dialog_id: str, evaluation: dict[str, Any] | None, cfg: dict[str, Any] | None, n_turns: int) -> dict[str, Any]:
    if evaluation is None or evaluation.get("status") != "done" or not cfg:
        reason = (evaluation or {}).get("error") or "Диалог не был оценён."
        return {"conversation_id": dialog_id, "status": "error", "criteria": [], "score": None, "error": plain(str(reason))}
    res = evaluation.get("result") or {}
    crit_res = res.get("criteria") or {}
    criteria = []
    for c in cfg.get("criteria", []):
        r = crit_res.get(c["id"]) or {}
        ev = [int(i) + 1 for i in (r.get("evidence_turns") or []) if isinstance(i, int) and 0 <= i < n_turns]
        if not ev and r.get("checked_range"):
            a, b = r["checked_range"]
            ev = list(range(a + 1, min(b, a + 9) + 2))
        rationale = plain(str(r.get("reasoning") or "").strip())
        if r.get("value") == scoring.NA and r.get("na_reason") and r["na_reason"] not in rationale:
            rationale = f"{rationale} {plain(r['na_reason'])}".strip()
        criteria.append({
            "criterion_id": export_id(c),
            "value": json_value(c, r.get("value")),
            "rationale": rationale,
            "evidence_turns": ev,
        })
    score = res.get("score") or scoring.compute(cfg, {k: v.get("value") for k, v in crit_res.items()})
    critical = next((x["value"] for x in criteria if x["criterion_id"] == "critical"), None)
    return {
        "conversation_id": dialog_id,
        "status": "ok",
        "criteria": criteria,
        "score": {
            "final_score": score.get("total"),
            "critical_flag": bool(critical) if critical is not None else bool(score.get("gross_error")),
        },
    }


def build(dialogs: list[dict[str, Any]], evals_by_dialog: dict[str, dict[str, Any]],
          configs: dict[int, dict[str, Any]], team_name: str | None = None) -> dict[str, Any]:
    """dialogs: [{id, transcript}] in output order; evals_by_dialog: dialog_id -> evaluation row."""
    results = []
    for d in dialogs:
        e = evals_by_dialog.get(d["id"])
        cfg = configs.get(e["checklist_id"]) if e else None
        results.append(dialog_entry(d["id"], e, cfg, len(d.get("transcript") or [])))
    return {
        "schema_version": SCHEMA_VERSION,
        "team_name": team_name or os.getenv("CQA_TEAM_NAME", "CQA"),
        "model": model_block([e for e in evals_by_dialog.values() if e]),
        "results": results,
    }


def validate(doc: Any, expected_ids: list[str] | None = None) -> list[str]:
    """Problems that would break the organizers' parser (empty list = OK)."""
    errs: list[str] = []
    if not isinstance(doc, dict):
        return ["Корень файла должен быть JSON-объектом."]
    if doc.get("schema_version") != SCHEMA_VERSION:
        errs.append('schema_version должен быть "1.0".')
    if not isinstance(doc.get("team_name"), str) or not doc["team_name"].strip():
        errs.append("Не задано team_name.")
    m = doc.get("model")
    if not isinstance(m, dict) or m.get("mode") not in ("local", "external_api", "hybrid") or not m.get("name"):
        errs.append("model: нужен объект {mode: local|external_api|hybrid, name}.")
    results = doc.get("results")
    if not isinstance(results, list):
        return errs + ["results должен быть массивом."]
    ids = [r.get("conversation_id") for r in results if isinstance(r, dict)]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        errs.append(f"Повторяющиеся conversation_id: {', '.join(map(str, dup))}.")
    if expected_ids is not None:
        missing = [i for i in expected_ids if i not in ids]
        extra = [i for i in ids if i not in expected_ids]
        if missing:
            errs.append(f"Нет записей для: {', '.join(missing)}.")
        if extra:
            errs.append(f"Лишние записи: {', '.join(map(str, extra))}.")
    for r in results:
        cid = r.get("conversation_id") if isinstance(r, dict) else None
        where = f"{cid}: " if cid else ""
        if not isinstance(r, dict) or not isinstance(cid, str) or not cid:
            errs.append("Запись без conversation_id.")
            continue
        if r.get("status") == "error":
            if r.get("criteria") != [] or r.get("score") is not None or not r.get("error"):
                errs.append(f"{where}для status=error нужны criteria=[], score=null и текст error.")
            continue
        if r.get("status") != "ok":
            errs.append(f"{where}status должен быть ok или error.")
            continue
        crits = r.get("criteria")
        if not isinstance(crits, list):
            errs.append(f"{where}criteria должен быть массивом.")
            continue
        got = [c.get("criterion_id") for c in crits if isinstance(c, dict)]
        if sorted(got) != sorted(STANDARD_IDS) or len(got) != len(set(got)):
            errs.append(f"{where}нужны все 8 критериев ровно по одному разу ({', '.join(STANDARD_IDS)}).")
        allowed = dict(STANDARD)
        for c in crits:
            if not isinstance(c, dict):
                continue
            k, v = c.get("criterion_id"), c.get("value")
            if k in allowed:
                ok = (v is None and None in allowed[k]) or (isinstance(v, bool) and v in allowed[k]) or (
                    not isinstance(v, bool) and isinstance(v, int) and v in allowed[k])
                if not ok:
                    errs.append(f"{where}{k}: недопустимое значение {v!r}.")
            if not isinstance(c.get("rationale"), str):
                errs.append(f"{where}{k}: rationale должен быть строкой.")
            ev = c.get("evidence_turns")
            if not isinstance(ev, list) or not all(isinstance(i, int) and not isinstance(i, bool) and i >= 1 for i in ev):
                errs.append(f"{where}{k}: evidence_turns должен быть списком номеров реплик с 1.")
        s = r.get("score")
        if not isinstance(s, dict):
            errs.append(f"{where}нет объекта score.")
            continue
        fs = s.get("final_score")
        if fs is not None and (isinstance(fs, bool) or not isinstance(fs, (int, float)) or not 0 <= fs <= 100 or round(fs, 2) != fs):
            errs.append(f"{where}final_score должен быть числом 0..100 с двумя знаками.")
        crit_val = next((c.get("value") for c in crits if isinstance(c, dict) and c.get("criterion_id") == "critical"), None)
        if s.get("critical_flag") is not bool(crit_val):
            errs.append(f"{where}critical_flag должен совпадать со значением critical.")
    return errs
