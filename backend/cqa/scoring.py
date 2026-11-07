"""Deterministic score calculation, exactly as described in the checklist:

1. N/A only where allowed.
2. YES = full weight, NO = 0; scale criterion = chosen step.
3. Scale steps are converted to points proportionally to the weight (top step = full weight).
4. N/A criteria are excluded and their weight is redistributed proportionally between the
   applicable weighted criteria, so the maximum stays 100.
5. Total is rounded to two decimals; if no weighted criterion is applicable the total is not
   computed. Gross errors (flag criteria) are reported separately.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from typing import Any

YES, NO, NA = "YES", "NO", "NA"


def allowed_values(criterion: dict[str, Any]) -> list[str]:
    """Values the model may return for a criterion (strings)."""
    ctype = criterion.get("type", "binary")
    if ctype == "scale":
        vals = [str(int(s["value"])) for s in sorted(criterion.get("scale", []), key=lambda s: -s["value"])]
    else:  # binary / flag
        vals = [YES, NO]
    if criterion.get("na_allowed") and ctype != "flag":
        vals.append(NA)
    return vals


def normalize_value(criterion: dict[str, Any], value: Any) -> str:
    """Coerce any model/user value to one of allowed_values (snap scales to nearest step)."""
    allowed = allowed_values(criterion)
    v = str(value).strip().upper() if value is not None else ""
    synonyms = {"ДА": YES, "TRUE": YES, "Y": YES, "НЕТ": NO, "FALSE": NO, "N": NO, "N/A": NA, "НЕПРИМЕНИМО": NA}
    v = synonyms.get(v, v)
    if v in allowed:
        return v
    if criterion.get("type") == "scale":
        try:
            num = float(v)
        except ValueError:
            return allowed[-1] if allowed[-1] != NA else allowed[-2]
        steps = [int(s["value"]) for s in criterion.get("scale", [])]
        return str(min(steps, key=lambda s: (abs(s - num), s)))
    if v == NA:  # N/A not allowed for this criterion
        return NO
    return NO


def _scale_max(criterion: dict[str, Any]) -> float:
    steps = [float(s["value"]) for s in criterion.get("scale", [])]
    return max(steps) if steps else 1.0


def fraction(criterion: dict[str, Any], value: str) -> float | None:
    """Share of the criterion weight earned; None for N/A."""
    if value == NA:
        return None
    if criterion.get("type") == "scale":
        mx = _scale_max(criterion)
        return float(value) / mx if mx else 0.0
    return 1.0 if value == YES else 0.0


def _r(x: float | Fraction, nd: int = 2) -> float:
    q = Decimal(1).scaleb(-nd)
    if isinstance(x, Fraction):  # exact value -> half-up without binary float drift
        d = Decimal(x.numerator) / Decimal(x.denominator)
    else:
        d = Decimal(str(x))
    return float(d.quantize(q, rounding=ROUND_HALF_UP))


def _q(x: Any) -> Fraction:
    """Exact rational of a weight / scale step as written (12.5 -> 25/2)."""
    return Fraction(str(x))


def _exact_fraction(criterion: dict[str, Any], value: str) -> Fraction:
    if criterion.get("type") == "scale":
        steps = [_q(s["value"]) for s in criterion.get("scale", [])]
        mx = max(steps) if steps else Fraction(1)
        return _q(value) / mx if mx else Fraction(0)
    return Fraction(1) if value == YES else Fraction(0)


def compute(checklist: dict[str, Any], values: dict[str, str]) -> dict[str, Any]:
    criteria = checklist.get("criteria", [])
    nd = int(checklist.get("rounding", 2))
    weighted = [c for c in criteria if c.get("type") != "flag" and float(c.get("weight", 0)) > 0]
    applicable = [c for c in weighted if values.get(c["id"]) not in (None, NA)]
    applicable_weight = sum(float(c["weight"]) for c in applicable)
    exact_aw = sum((_q(c["weight"]) for c in applicable), Fraction(0))
    factor = 100.0 / applicable_weight if applicable_weight > 0 else 0.0
    exact_factor = Fraction(100) / exact_aw if exact_aw > 0 else Fraction(0)

    per: dict[str, Any] = {}
    total = Fraction(0)
    for c in criteria:
        cid = c["id"]
        v = values.get(cid)
        entry: dict[str, Any] = {
            "value": v,
            "weight": float(c.get("weight", 0)),
            "applicable": v not in (None, NA),
            "effective_weight": 0.0,
            "points": None,
        }
        if c.get("type") == "flag":
            entry["is_flag"] = True
        elif c in applicable:
            eff = _q(c["weight"]) * exact_factor
            pts = eff * _exact_fraction(c, v)
            entry["effective_weight"] = _r(eff, nd)
            entry["points"] = _r(pts, nd)
            entry["_raw"] = pts
            total += pts
        per[cid] = entry

    sections = []
    for s in checklist.get("sections", []):
        crits = [c for c in criteria if c.get("section") == s["id"] and c.get("type") != "flag"]
        if not crits:
            continue
        got = sum((per[c["id"]].get("_raw", Fraction(0)) for c in crits if per[c["id"]]["applicable"]), Fraction(0))
        mx = sum((_q(c["weight"]) * exact_factor for c in crits if per[c["id"]]["applicable"]), Fraction(0))
        sections.append(
            {
                "id": s["id"],
                "name": s["name"],
                "points": _r(got, nd),
                "max_points": _r(mx, nd),
                "percent": _r(100 * got / mx, nd) if mx > 0 else None,
            }
        )

    for entry in per.values():
        entry.pop("_raw", None)
    gross = [c["id"] for c in criteria if c.get("type") == "flag" and values.get(c["id"]) == YES]
    total_value: float | None = _r(total, nd) if applicable_weight > 0 else None
    if gross and checklist.get("gross_error_zeroes_total") and total_value is not None:
        total_value = 0.0
    return {
        "total": total_value,
        "max_total": 100.0 if applicable_weight > 0 else None,
        "applicable_weight": applicable_weight,
        "redistribution_factor": _r(factor, 4) if factor else None,
        "criteria": per,
        "sections": sections,
        "gross_error": bool(gross),
        "gross_criteria": gross,
    }


def validate_checklist(checklist: dict[str, Any]) -> list[str]:
    """Human-readable problems with a checklist config (empty list = OK)."""
    errs: list[str] = []
    crits = checklist.get("criteria") or []
    if not crits:
        errs.append("В чек-листе нет критериев.")
    ids = [c.get("id") for c in crits]
    if len(set(ids)) != len(ids):
        errs.append("ID критериев должны быть уникальны.")
    section_ids = {s.get("id") for s in checklist.get("sections", [])}
    for c in crits:
        name = c.get("name") or c.get("id")
        if not c.get("name"):
            errs.append(f"Критерий {c.get('id')}: не задано название.")
        if c.get("type") not in ("binary", "scale", "flag"):
            errs.append(f"{name}: неизвестный тип ответа {c.get('type')!r}.")
        try:
            w = float(c.get("weight", 0))
            if w < 0:
                errs.append(f"{name}: вес не может быть отрицательным.")
        except (TypeError, ValueError):
            errs.append(f"{name}: вес должен быть числом.")
        if c.get("type") == "scale":
            steps = c.get("scale") or []
            if len(steps) < 2:
                errs.append(f"{name}: у шкального критерия должно быть минимум 2 ступени.")
            vals = [s.get("value") for s in steps]
            if len(set(vals)) != len(vals):
                errs.append(f"{name}: значения ступеней шкалы повторяются.")
        if c.get("section") and section_ids and c.get("section") not in section_ids:
            errs.append(f"{name}: секция {c.get('section')!r} не найдена.")
    if not any(c.get("type") != "flag" and float(c.get("weight", 0) or 0) > 0 for c in crits):
        errs.append("Нужен хотя бы один критерий с весом больше 0.")
    return errs
