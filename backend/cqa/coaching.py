"""Coaching sheet for the operator ("Разбор для оператора"): what to improve, with the
operator's own words. Pure assembly from a stored evaluation, no model calls. Also usable by
Power Automate to send the sheet to the operator (`plain_text`)."""

from __future__ import annotations

import re
from typing import Any

from .analytics import cell, clip, reason_body, step_label, value_label, violation_of

MAX_QUOTES = 3
MAX_IMPROVE = 4


def _after(text: str, start: str, stops: tuple[str, ...]) -> str | None:
    m = re.search(re.escape(start), text, re.I)
    if not m:
        return None
    rest = text[m.end():]
    cut = min([i for i in (re.search(re.escape(s), rest, re.I) for s in stops) if i] or [None],
              key=lambda x: x.start() if x else 10**9)
    if cut:
        rest = rest[: cut.start()]
    rest = rest.strip().rstrip(".").strip()
    return rest or None


def _sentence(s: str) -> str:
    s = s.strip().rstrip(".").strip()
    if len(s) > 1 and s[0].isupper() and s[1].islower():
        s = s[0].lower() + s[1:]  # it follows a colon
    return s + "." if s else s


def improve_text(crit: dict[str, Any], value: str, reasoning: str = "") -> str:
    """Advice for one criterion: the checklist's own `coaching` text, else derived from the rule."""
    own = str(crit.get("coaching") or "").strip()
    if own:
        return own
    desc = str(crit.get("description") or "").strip()
    ctype = crit.get("type")
    if ctype == "scale":
        steps = sorted(crit.get("scale") or [], key=lambda s: -float(s.get("value", 0)))
        top = str(steps[0].get("label") or "").strip() if steps else ""
        now = step_label(crit, value)
        if top and now:
            return f"Сейчас: {_sentence(now)} Ожидается: {_sentence(top)}"
        if top:
            return f"Ожидается: {_sentence(top)}"
    elif ctype == "flag":
        kind = violation_of(reasoning)
        if kind["id"] != "other":
            return f"Недопустимо: {_sentence(kind['label'])}"
        clause = _after(desc, "Да: выявлено", ("Нет:",)) or _after(desc, "Да:", ("Нет:",))
        if clause:
            return f"Недопустимо: {_sentence(clause)}"
    else:
        clause = _after(desc, "Да:", ("N/A:", "Н/П:", "Нет:"))
        if clause:
            return f"Ожидается: {_sentence(clause)}"
    return desc


def build(
    dialog: dict[str, Any],
    turns: list[dict[str, Any]],
    e: dict[str, Any],
    cfg: dict[str, Any],
    version: int | None,
    appeals: list[dict[str, Any]],
    now: str,
) -> dict[str, Any]:
    final = e.get("final") or {}
    result = e.get("result") or {}
    values = final.get("values") or {}
    sc = (final.get("score") or {}).get("criteria") or {}
    res = result.get("criteria") or {}
    overrides = final.get("overrides") or {}
    by_crit: dict[str, dict[str, Any]] = {}
    for a in sorted(appeals, key=lambda a: a["id"]):
        by_crit[a["criterion_id"]] = {"id": a["id"], "status": a["status"], "decision": a.get("decision")}
    items = []
    applicable = passed = 0
    for order, c in enumerate(cfg.get("criteria") or []):
        cid = c["id"]
        v = values.get(cid)
        ce = cell(c, v, sc.get(cid), res.get(cid), cid in overrides, by_crit.get(cid))
        if ce["status"] in ("pass", "partial", "fail"):
            applicable += 1
        if ce["status"] == "pass":
            passed += 1
        if ce["status"] not in ("partial", "fail"):
            continue
        r = res.get(cid) or {}
        ev = [i for i in (r.get("evidence_turns") or []) if isinstance(i, int) and 0 <= i < len(turns)]
        quotes = [
            {"idx": i, "turn": f"T{i + 1}", "speaker": turns[i].get("speaker"), "clock": turns[i].get("clock") or "",
             "audio_offset": turns[i].get("audio_offset"), "text": clip(str(turns[i].get("text") or ""), 280)}
            for i in ev[:MAX_QUOTES]
        ]
        rng = r.get("checked_range")
        ov = overrides.get(cid)
        is_flag = c.get("type") == "flag"
        mx = None if is_flag else ce["w"]
        items.append({
            "criterion_id": cid,
            "code": c.get("code") or cid,
            "name": c.get("name") or cid,
            "type": c.get("type"),
            "value": v,
            "value_label": value_label(c, v),
            "step_label": step_label(c, v) if c.get("type") == "scale" else None,
            "points": ce["pts"],
            "max_points": mx,
            "lost": ce["lost"],
            "status": "gross" if is_flag else ce["status"],
            "reasoning": r.get("reasoning") or "",
            "reason": reason_body(r.get("reasoning")),
            "violation": violation_of(r.get("reasoning")) if is_flag else None,
            "quotes": quotes,
            "checked_range": rng if isinstance(rng, list) and len(rng) == 2 and not quotes else None,
            "override": {
                "appeal_id": ov.get("appeal_id"), "from": ov.get("from"), "from_label": value_label(c, ov.get("from")),
                "to": ov.get("to"), "to_label": value_label(c, ov.get("to")), "reason": ov.get("reason") or "",
            } if ov else None,
            "appeal": by_crit.get(cid),
            "_order": order,
        })
    items.sort(key=lambda it: (it["status"] != "gross", -(it["lost"] or 0), it["_order"]))
    for it in items:
        it.pop("_order")
    by_id = {c["id"]: c for c in cfg.get("criteria") or []}
    improve = [
        {"criterion_id": it["criterion_id"], "code": it["code"], "name": it["name"],
         "text": improve_text(by_id[it["criterion_id"]], it["value"], it["reasoning"])}
        for it in items[:MAX_IMPROVE]
    ]
    score = final.get("score") or result.get("score") or {}
    final_total = e.get("final_total") if e.get("final") else e.get("total")
    out = {
        "dialog": {"id": dialog["id"], "channel": dialog.get("channel"), "language": dialog.get("language"),
                   "operator": dialog.get("operator"), "operator_key": dialog.get("operator_key")},
        "evaluation": {"id": e["id"], "checklist_id": e.get("checklist_id"), "checklist_name": cfg.get("name"),
                       "checklist_version": version, "finished_at": e.get("finished_at"),
                       "total": e.get("total"), "final_total": final_total, "gross": bool(score.get("gross_error"))},
        "items": items,
        "improve": improve,
        "passed_count": passed,
        "applicable_count": applicable,
        "generated_at": now,
    }
    out["plain_text"] = plain_text(out)
    return out


def _num(x: Any) -> str:
    if x is None:
        return "Н/П"
    s = f"{float(x):.2f}"
    return s.replace(".", ",")


def plain_text(sheet: dict[str, Any]) -> str:
    """The sheet as plain text for a messenger or an e-mail (no dashes, no arrows)."""
    d, ev = sheet["dialog"], sheet["evaluation"]
    lines = [f"Разбор диалога {d['id']}"]
    meta = [f"Оператор: {d.get('operator') or 'не указан'}", f"Итог: {_num(ev['final_total'])} из 100"]
    if ev.get("checklist_version"):
        meta.append(f"Чек-лист v{ev['checklist_version']}")
    lines.append(" · ".join(meta))
    if ev.get("gross"):
        lines.append("Есть грубая ошибка.")
    if not sheet["items"]:
        lines += ["", "Замечаний нет. Все критерии выполнены."]
        return "\n".join(lines)
    if sheet["improve"]:
        lines += ["", "Что улучшить:"]
        lines += [f"{i}. {x['name']}. {x['text']}" for i, x in enumerate(sheet["improve"], 1)]
    lines += ["", "Замечания по критериям:"]
    for it in sheet["items"]:
        pts = "" if it["max_points"] is None else f", {_num(it['points'])} из {_num(it['max_points'])}"
        lines.append(f"{it['code']} {it['name']}: {it['value_label']}{pts}")
        if it["override"]:
            lines.append(f"  Изменено по апелляции №{it['override']['appeal_id']}: {it['override']['reason']}")
        elif it["reason"]:
            lines.append(f"  {it['reason']}")
        for q in it["quotes"]:
            lines.append(f"  {q['turn']} {q['clock']} «{q['text']}»".replace("  «", " «"))
    lines += ["", f"Выполнено: {sheet['passed_count']} из {sheet['applicable_count']} критериев."]
    return "\n".join(lines)

