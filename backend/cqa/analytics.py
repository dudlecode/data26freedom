"""Read-only analytics over stored evaluations (no model calls).

Source: the latest finished evaluation of every dialog, final values (after appeal
decisions). Columns are the criteria of the ACTIVE checklist; a criterion that an older
evaluation's version does not have gets an empty cell.

Per criterion and dialog:
  status  pass | partial | fail | na | none   (flag: fail = gross error found)
  f       share of the criterion weight earned (scale step / top step, 1 or 0 for binary,
          1 = no gross error for the flag), None for N/A or a missing criterion
  pts, w  points and effective weight after N/A redistribution (None for the flag)
"""

from __future__ import annotations

import re
from typing import Any, Callable, Iterable

from . import operators, scoring

LOW_DATA = 3  # fewer dialogs than this: "мало данных"

VIOLATIONS = [
    {"id": "insult", "label": "Оскорбление клиента", "mark": re.compile(r"вид\s*\(а\)", re.I),
     "rx": re.compile(r"оскорб|униж|насмеш|издев|хамств", re.I)},
    {"id": "paid", "label": "Услуга в обход компании", "mark": re.compile(r"вид\s*\(б\)", re.I),
     "rx": re.compile(r"обход|лично|частн|платн", re.I)},
    {"id": "disclosure", "label": "Раскрытие конфиденциальной информации", "mark": re.compile(r"вид\s*\(в\)", re.I),
     "rx": re.compile(r"конфиденц|раскры|идентификац", re.I)},
]
OTHER_VIOLATION = {"id": "other", "label": "Грубое нарушение"}


# --- small helpers ------------------------------------------------------------------------

def r2(x: float | None) -> float | None:
    return None if x is None else round(float(x) + 0.0, 2)


def mean(xs: Iterable[float | None]) -> float | None:
    vals = [float(x) for x in xs if x is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


def value_label(crit: dict[str, Any] | None, v: Any) -> str | None:
    if v is None:
        return None
    s = str(v)
    if s == scoring.YES:
        return "Да"
    if s == scoring.NO:
        return "Нет"
    if s == scoring.NA:
        return "N/A"
    if crit and crit.get("type") == "scale":
        steps = [int(x["value"]) for x in crit.get("scale") or [] if str(x.get("value", "")).lstrip("-").isdigit()]
        if steps:
            return f"{s} из {max(steps)}"
    return s


def step_label(crit: dict[str, Any], v: Any) -> str:
    for st in crit.get("scale") or []:
        if str(st.get("value")) == str(v):
            return str(st.get("label") or "").strip()
    return ""


def violation_of(reasoning: str | None) -> dict[str, str]:
    s = str(reasoning or "")
    hit = next((t for t in VIOLATIONS if t["mark"].search(s)), None) or next(
        (t for t in VIOLATIONS if t["rx"].search(s)), None)
    return {"id": hit["id"], "label": hit["label"]} if hit else dict(OTHER_VIOLATION)


_LEAD = re.compile(r"^\s*[^:.!?]{2,60}:\s*(?:да|нет|н/п|n/a|yes|no|\d+)\s*[.,:;]?\s*", re.I)
_KIND = re.compile(r"^(?:выявлен[оа]?\s+)?вид\s*\([абв]\)\s*(?::[^.!?]*[.!?]|[.,:;])?\s*", re.I)
_KIND_INLINE = re.compile(r"\s*\(\s*вид\s*[абв]\s*\)|,?\s*вид\s*\([абв]\)\s*:?", re.I)


def reason_body(reasoning: str | None) -> str:
    """Reasoning without the formula «Грубые ошибки: Да, вид (б): <вид>.»: the value and the
    violation type are shown separately. Falls back to the full text."""
    src = str(reasoning or "").strip()
    r = _LEAD.sub("", src, count=1)
    r = _KIND.sub("", r, count=1).strip()
    r = _KIND_INLINE.sub("", r).strip()
    if not r:
        return src
    return r[0].upper() + r[1:]


def first_sentence(text: str, limit: int = 220) -> str:
    text = (text or "").strip()
    m = re.search(r"[.!?](?:\s|$)", text)
    s = text[: m.end()].strip() if m else text
    return clip(s, limit)


def clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# --- cells --------------------------------------------------------------------------------

def cell(
    crit: dict[str, Any] | None,
    value: Any,
    score_entry: dict[str, Any] | None,
    res_entry: dict[str, Any] | None,
    overridden: bool,
    appeal: dict[str, Any] | None,
) -> dict[str, Any]:
    """One heatmap cell. `crit` is the criterion as configured in the evaluation's own version."""
    out: dict[str, Any] = {"v": None, "label": None, "status": "none", "f": None, "pts": None, "w": None,
                           "lost": 0.0, "split": False, "overridden": overridden, "appeal": appeal}
    if crit is None or value is None:
        return out
    v = str(value)
    agreement = (res_entry or {}).get("agreement")
    out.update({"v": v, "label": value_label(crit, v), "split": agreement is not None and agreement < 1})
    if v == scoring.NA:
        out["status"] = "na"
        return out
    if crit.get("type") == "flag":
        gross = v == scoring.YES
        out.update({"status": "fail" if gross else "pass", "f": 0.0 if gross else 1.0})
        return out
    f = scoring.fraction(crit, v)
    se = score_entry or {}
    pts, w = se.get("points"), se.get("effective_weight")
    out.update({
        "f": None if f is None else round(f, 4),
        "pts": pts,
        "w": w if pts is not None else None,
        "lost": r2(max(0.0, (w or 0) - (pts or 0))) if pts is not None else 0.0,
        "status": "pass" if f is not None and f >= 1 else "fail" if f is not None and f <= 0 else "partial",
    })
    return out


def columns(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in cfg.get("criteria") or []:
        mx = None
        if c.get("type") == "scale":
            steps = [s.get("value") for s in c.get("scale") or []]
            mx = max(steps) if steps else None
        out.append({"id": c["id"], "code": c.get("code") or c["id"], "name": c.get("name") or c["id"],
                    "type": c.get("type"), "weight": c.get("weight"), "max": mx, "section": c.get("section")})
    return out


def dialog_row(
    d: dict[str, Any],
    e: dict[str, Any],
    active_cfg: dict[str, Any],
    eval_cfg: dict[str, Any],
    eval_version: int | None,
    appeals: list[dict[str, Any]],
) -> dict[str, Any]:
    """Row for one dialog: final values of its latest finished evaluation against the active columns."""
    final = e.get("final") or {}
    result = e.get("result") or {}
    values = final.get("values") or {cid: (v or {}).get("value") for cid, v in (result.get("criteria") or {}).items()}
    score = final.get("score") or result.get("score") or {}
    sc = score.get("criteria") or {}
    res = result.get("criteria") or {}
    overrides = final.get("overrides") or {}
    own = {c["id"]: c for c in eval_cfg.get("criteria") or []}
    by_crit: dict[str, dict[str, Any]] = {}
    for a in sorted(appeals, key=lambda a: a["id"]):
        by_crit[a["criterion_id"]] = {"id": a["id"], "status": a["status"], "decision": a.get("decision")}
    cells = {}
    for c in active_cfg.get("criteria") or []:
        cid = c["id"]
        oc = own.get(cid)
        if oc is not None and oc.get("type") != c.get("type"):
            oc = None  # the criterion changed its type: the old value means something else
        cells[cid] = cell(oc, values.get(cid) if oc else None, sc.get(cid), res.get(cid), cid in overrides, by_crit.get(cid))
    agreements = [r.get("agreement") for r in res.values() if isinstance(r, dict) and r.get("agreement") is not None]
    lost = {cid: c["lost"] for cid, c in cells.items() if c["lost"]}
    weakest = max(lost, key=lambda k: (lost[k], -(cells[k]["f"] or 0))) if lost else None
    flags = [c["id"] for c in active_cfg.get("criteria") or [] if c.get("type") == "flag"]
    weakest = next((cid for cid in flags if cells[cid]["status"] == "fail"), weakest)  # a gross error comes first
    final_total = e.get("final_total") if e.get("final") else e.get("total")
    return {
        "dialog_id": d["id"],
        "evaluation_id": e["id"],
        "checklist_version": eval_version,
        "group_id": d.get("group_id"),
        "language": d.get("language"),
        "channel": d.get("channel"),
        **operators.info(d),
        "total": e.get("total"),
        "final_total": final_total,
        "gross": bool(score.get("gross_error")),
        "open_appeals": sum(1 for a in appeals if a["status"] == "open"),
        "min_agreement": min(agreements) if agreements else None,
        "finished_at": e.get("finished_at"),
        "weakest_cid": weakest,
        "cells": cells,
    }


# --- aggregates ---------------------------------------------------------------------------

def weak_spots(rows: list[dict[str, Any]], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in cfg.get("criteria") or []:
        cid = c["id"]
        cnt = {"fail": 0, "partial": 0, "pass": 0, "na": 0}
        lost: list[float] = []
        worst: list[tuple[float, float, str]] = []
        for r in rows:
            ce = r["cells"].get(cid) or {}
            st = ce.get("status")
            if st in cnt:
                cnt[st] += 1
            if st in ("fail", "partial", "pass"):
                lost.append(ce.get("lost") or 0.0)
            if st in ("fail", "partial"):
                worst.append((-(ce.get("lost") or 0.0), ce.get("f") or 0.0, r["dialog_id"]))
        applicable = cnt["fail"] + cnt["partial"] + cnt["pass"]
        out.append({
            "criterion_id": cid,
            "code": c.get("code") or cid,
            "name": c.get("name") or cid,
            "type": c.get("type"),
            "weight": c.get("weight"),
            "applicable": applicable,
            **cnt,
            "fail_rate": round((cnt["fail"] + cnt["partial"]) / applicable, 4) if applicable else None,
            "avg_points_lost": mean(lost) if c.get("type") != "flag" else None,
            "worst_dialogs": [w[2] for w in sorted(worst)[:5]],
        })
    # Малая выборка (критерий новой версии, оценённый в паре диалогов) не должна возглавлять список:
    # такие строки идут после критериев с достаточной выборкой и помечены low_sample.
    top_n = max((s["applicable"] for s in out), default=0)
    floor = min(WEAK_MIN_SAMPLE, top_n)
    for s in out:
        s["low_sample"] = 0 < s["applicable"] < floor
    out.sort(key=lambda s: (s["low_sample"], -(s["fail_rate"] or 0), -(s["avg_points_lost"] or 0), s["code"]))
    return out


WEAK_MIN_SAMPLE = 5


def crit_rate(rows: list[dict[str, Any]], cid: str) -> dict[str, Any]:
    """Σpoints / Σeffective weight over applicable dialogs (mean f when the weight is 0;
    for the flag: share of dialogs without a gross error)."""
    cnt = {"fail": 0, "partial": 0, "pass": 0, "na": 0}
    pts = w = 0.0
    fs: list[float] = []
    for r in rows:
        ce = r["cells"].get(cid) or {}
        st = ce.get("status")
        if st in cnt:
            cnt[st] += 1
        if st in ("fail", "partial", "pass"):
            fs.append(ce.get("f") or 0.0)
            if ce.get("pts") is not None and ce.get("w"):
                pts += ce["pts"]
                w += ce["w"]
    applicable = cnt["fail"] + cnt["partial"] + cnt["pass"]
    rate = (pts / w) if w > 0 else (sum(fs) / len(fs) if fs else None)
    return {"applicable": applicable, **cnt, "rate": None if rate is None else round(rate, 4)}


def operator_groups(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        groups.setdefault(r["operator_key"], []).append(r)
    return groups


def _weakest(rows: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any] | None:
    best: tuple[float, float, str] | None = None
    for c in cfg.get("criteria") or []:
        cid = c["id"]
        cells = [r["cells"].get(cid) or {} for r in rows]
        app = [ce for ce in cells if ce.get("status") in ("fail", "partial", "pass")]
        if not app:
            continue
        if c.get("type") == "flag":
            lost = 1000.0 * sum(1 for ce in app if ce["status"] == "fail")  # a gross error outranks points
        else:
            lost = sum(ce.get("lost") or 0.0 for ce in app)
        if lost <= 0:
            continue
        avg_f = sum(ce.get("f") or 0.0 for ce in app) / len(app)
        key = (lost, -avg_f, cid)
        if best is None or key[:2] > best[:2]:
            best = key
    if best is None:
        return None
    cid = best[2]
    c = next(x for x in cfg["criteria"] if x["id"] == cid)
    app = [r["cells"][cid] for r in rows if (r["cells"].get(cid) or {}).get("status") in ("fail", "partial", "pass")]
    failed = sum(1 for ce in app if ce["status"] in ("fail", "partial"))
    return {"criterion_id": cid, "code": c.get("code") or cid, "name": c.get("name") or cid,
            "fail_rate": round(failed / len(app), 4) if app else None}


def leaderboard(rows: list[dict[str, Any]], cfg: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Operators sorted weakest first (avg final ascending). The unnamed bucket is returned
    separately and never ranked."""
    groups = operator_groups(rows)
    ranked = []
    unnamed = None
    for key, rs in groups.items():
        entry = {
            "key": key,
            "name": rs[0]["operator"],
            "dialogs": len(rs),
            "avg_final": mean(r["final_total"] for r in rs),
            "gross": sum(1 for r in rs if r["gross"]),
            "open_appeals": sum(r["open_appeals"] for r in rs),
            "weakest": _weakest(rs, cfg),
            "languages": sorted({r["language"] for r in rs if r.get("language")}),
            "dialog_ids": [r["dialog_id"] for r in rs],
            "low_data": len(rs) < LOW_DATA,
        }
        if key == operators.UNKNOWN_KEY:
            unnamed = entry
        else:
            ranked.append(entry)
    ranked.sort(key=lambda o: (o["avg_final"] is None, o["avg_final"] if o["avg_final"] is not None else 0, o["name"]))
    # place: 1 = best average
    by_best = sorted([o for o in ranked if o["avg_final"] is not None], key=lambda o: -o["avg_final"])
    places: dict[str, int] = {}
    for i, o in enumerate(by_best):
        prev = by_best[i - 1] if i else None
        places[o["key"]] = places[prev["key"]] if prev and prev["avg_final"] == o["avg_final"] else i + 1
    for o in ranked:
        o["rank"] = places.get(o["key"])
        o["of"] = len(by_best)
    return ranked, unnamed


def gross_item(row: dict[str, Any], e: dict[str, Any], transcript: list[dict[str, Any]], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Gross-error criteria of one row with the operator's words."""
    res = (e.get("result") or {}).get("criteria") or {}
    out = []
    for cid, ce in row["cells"].items():
        crit = next((c for c in cfg.get("criteria") or [] if c["id"] == cid), None)
        if not crit or crit.get("type") != "flag" or ce["status"] != "fail":
            continue
        r = res.get(cid) or {}
        ev = [i for i in (r.get("evidence_turns") or []) if isinstance(i, int) and 0 <= i < len(transcript)]
        pick = next((i for i in ev if transcript[i].get("speaker") == "operator"), ev[0] if ev else None)
        quote = None
        if pick is not None:
            t = transcript[pick]
            quote = {"idx": pick, "turn": f"T{pick + 1}", "speaker": t.get("speaker"), "text": clip(str(t.get("text") or ""), 280)}
        reasoning = r.get("reasoning") or ""
        out.append({
            "dialog_id": row["dialog_id"],
            "evaluation_id": row["evaluation_id"],
            "operator": row["operator"],
            "operator_key": row["operator_key"],
            "language": row["language"],
            "channel": row["channel"],
            "final_total": row["final_total"],
            "finished_at": row["finished_at"],
            "criterion_id": cid,
            "code": crit.get("code") or cid,
            "violation": violation_of(reasoning),
            "quote": quote,
            "reason": first_sentence(reason_body(reasoning)),
            "overridden": ce["overridden"],
        })
    return out


# --- checklist impact simulation --------------------------------------------------------

def simulate(
    new_cfg: dict[str, Any],
    pairs: list[tuple[dict[str, Any], dict[str, Any]]],
    get_cfg: Callable[[int], dict[str, Any] | None],
) -> dict[str, Any]:
    """Re-score stored final values with an edited checklist. A criterion that an
    evaluation does not have (new, or its type changed) counts as N/A until re-evaluation;
    scale values are snapped to the nearest new step. Values are never invented."""
    before_totals: list[float | None] = []
    after_totals: list[float | None] = []
    gross_before = gross_after = 0
    changed = []
    new_criteria: set[str] = set()
    new_ids = {c["id"] for c in new_cfg.get("criteria") or []}
    removed: set[str] = set()
    for d, e in pairs:
        old_cfg = get_cfg(e["checklist_id"]) or {}
        own = {c["id"]: c for c in old_cfg.get("criteria") or []}
        removed |= set(own) - new_ids
        final = e.get("final") or {}
        old_values = final.get("values") or {}
        values: dict[str, str] = {}
        for c in new_cfg.get("criteria") or []:
            oc = own.get(c["id"])
            v = old_values.get(c["id"])
            if oc is None or v is None or oc.get("type") != c.get("type"):
                new_criteria.add(c["id"])
                continue
            values[c["id"]] = v if v == scoring.NA else scoring.normalize_value(c, v)
        sc = scoring.compute(new_cfg, values)
        before = e.get("final_total") if e.get("final") else e.get("total")
        after = sc["total"]
        gb = bool(e.get("gross"))
        ga = bool(sc["gross_error"])
        gross_before += gb
        gross_after += ga
        before_totals.append(before)
        after_totals.append(after)
        if before != after or gb != ga:
            delta = r2(after - before) if before is not None and after is not None else None
            changed.append({"dialog_id": d["id"], "evaluation_id": e["id"], **operators.info(d),
                            "before": before, "after": after, "delta": delta, "gross_before": gb, "gross_after": ga})
    changed.sort(key=lambda c: (-(abs(c["delta"]) if c["delta"] is not None else 1e9), c["dialog_id"]))
    return {
        "dialogs": len(pairs),
        "before": {"avg_final": mean(before_totals), "gross": gross_before},
        "after": {"avg_final": mean(after_totals), "gross": gross_after},
        "changed_count": len(changed),
        "changed": changed,
        "new_criteria": sorted(new_criteria & new_ids, key=lambda cid: [c["id"] for c in new_cfg["criteria"]].index(cid)),
        "removed_criteria": sorted(removed),
    }
