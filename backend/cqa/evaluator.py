"""Evaluation of one dialog against a checklist: N self-consistency runs of the LLM,
per-criterion aggregation, deterministic scoring."""

from __future__ import annotations

import asyncio
import copy
import statistics
import time
from collections import Counter
from typing import Any

from .text import plain
from . import prompting, scoring
from .preprocess import prepare, render_for_llm
from .providers import ProviderError, RunResult

USAGE_KEYS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")


def _criteria(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    return list(cfg.get("criteria", []))


def clean_turns(turns: Any, n_turns: int) -> list[int]:
    """Model output uses 1-based turn numbers (T1 = first transcript item, as in the
    organizers' format); stored evidence is 0-based indices into the transcript."""
    out: list[int] = []
    for t in turns or []:
        try:
            i = int(t) - 1
        except (TypeError, ValueError):
            continue
        if 0 <= i < n_turns and i not in out:
            out.append(i)
    return out


def checked_range(c_from: Any, c_to: Any, n_turns: int) -> list[int] | None:
    try:
        a, b = int(c_from) - 1, int(c_to) - 1  # 1-based from the model
    except (TypeError, ValueError):
        return None
    if a < 0 or b < 0 or a >= n_turns or b >= n_turns:
        return None
    return [min(a, b), max(a, b)]


def run_values(cfg: dict[str, Any], data: dict[str, Any]) -> dict[str, str]:
    """Normalized value per criterion from one model run (missing criteria are skipped)."""
    crit = prompting.criteria_map(data) or {}
    out: dict[str, str] = {}
    for c in _criteria(cfg):
        item = crit.get(c["id"])
        if isinstance(item, dict) and item.get("value") is not None:
            out[c["id"]] = scoring.normalize_value(c, item.get("value"))
    return out


def pick_value(c: dict[str, Any], votes: list[str]) -> str:
    """Majority vote; scale tie -> median snapped to a step; binary tie -> first run's value."""
    counts = Counter(votes)
    top = max(counts.values())
    leaders = [v for v, n in counts.items() if n == top]
    if len(leaders) == 1:
        return leaders[0]
    if c.get("type") == "scale":
        nums = [float(v) for v in votes if v != scoring.NA]
        if not nums:
            return scoring.NA
        return scoring.normalize_value(c, statistics.median(nums))
    return votes[0]


def aggregate(cfg: dict[str, Any], runs_data: list[dict[str, Any]], n_turns: int) -> dict[str, Any]:
    """runs_data: successful run outputs, first run first."""
    per_run_values = [run_values(cfg, d) for d in runs_data]
    criteria: dict[str, Any] = {}
    for c in _criteria(cfg):
        cid = c["id"]
        votes = [vals[cid] for vals in per_run_values if cid in vals]
        if not votes:
            value = scoring.normalize_value(c, None)
            criteria[cid] = {
                "value": value,
                "reasoning": "Модель не вернула оценку по этому критерию; выставлено значение по умолчанию.",
                "evidence_turns": [],
                "checked_range": None,
                "na_reason": "",
                "votes": [],
                "agreement": 0.0,
            }
            continue
        value = pick_value(c, votes)
        src_idx = next((i for i, vals in enumerate(per_run_values) if vals.get(cid) == value), None)
        note = ""
        if src_idx is None:
            # scale tie resolved by median: no run voted for the final step -> take the run whose
            # vote is closest to it and say so, so the text does not silently argue for another value
            def _dist(i: int) -> float:
                try:
                    return abs(float(per_run_values[i][cid]) - float(value))
                except (TypeError, ValueError):
                    return float("inf")

            cand = [i for i, vals in enumerate(per_run_values) if cid in vals]
            src_idx = min(cand, key=lambda i: (_dist(i), i))
            note = f"Итог: медиана голосов ({', '.join(votes)}). Обоснование прогона с оценкой {per_run_values[src_idx][cid]}: "
        item = (prompting.criteria_map(runs_data[src_idx]) or {}).get(cid) or {}
        criteria[cid] = {
            "value": value,
            "reasoning": plain(note + str(item.get("reasoning") or "").strip()),
            "evidence_turns": clean_turns(item.get("evidence_turns"), n_turns),
            "checked_range": checked_range(item.get("checked_from"), item.get("checked_to"), n_turns),
            "na_reason": plain(str(item.get("na_reason") or "").strip()) if value == scoring.NA else "",
            "votes": votes,
            "agreement": round(sum(1 for v in votes if v == value) / len(votes), 4),
        }
    return criteria


def _sum_usage(usages: list[dict[str, int]]) -> dict[str, int]:
    total = {k: 0 for k in USAGE_KEYS}
    for u in usages:
        for k, v in (u or {}).items():
            total[k] = total.get(k, 0) + int(v or 0)
    return total


async def _one(provider: Any, system: str, user: str, schema: dict[str, Any]) -> RunResult | Exception:
    try:
        return await provider.complete_json(system, user, schema)
    except Exception as e:  # noqa: BLE001 — a failed vote must not kill the evaluation
        return e


def _err_text(e: Exception) -> str:
    if isinstance(e, ProviderError):
        return str(e)
    return f"{type(e).__name__}: {e}"


async def evaluate(
    record: dict[str, Any], checklist_cfg: dict[str, Any], settings: dict[str, Any], provider: Any
) -> dict[str, Any]:
    """Returns {result, final, total, final_total, gross, cost_usd, usage, duration_ms, model}.
    Raises ProviderError if every run failed."""
    t0 = time.perf_counter()
    prepared = prepare(record)
    n_turns = len(prepared.turns)
    system = prompting.build_system(checklist_cfg)
    schema = prompting.build_schema(checklist_cfg)
    user = prompting.build_user(render_for_llm(prepared))
    votes = max(1, min(9, int(settings.get("votes", 1) or 1)))

    # First run alone (writes the prompt cache), then the rest in parallel (cache reads).
    outcomes: list[RunResult | Exception] = [await _one(provider, system, user, schema)]
    if votes > 1:
        outcomes += await asyncio.gather(*(_one(provider, system, user, schema) for _ in range(votes - 1)))

    runs: list[dict[str, Any]] = []
    ok: list[RunResult] = []
    default_model = getattr(provider, "model", None) or settings.get("model")
    for o in outcomes:
        if isinstance(o, Exception):
            runs.append(
                {
                    "model": default_model,
                    "provider": getattr(provider, "name", settings.get("provider")),
                    "usage": {},
                    "duration_ms": 0,
                    "cost_usd": None,
                    "values": {},
                    "error": _err_text(o),
                }
            )
            continue
        if isinstance(o.data, dict) and isinstance(o.data.get("criteria"), list):
            o.data["criteria"] = prompting.criteria_map(o.data)  # compact schema: array -> {id: item}
        if not isinstance(o.data, dict) or not isinstance(o.data.get("criteria"), dict):
            runs.append(
                {
                    "model": o.model,
                    "provider": o.provider,
                    "usage": o.usage,
                    "duration_ms": o.duration_ms,
                    "cost_usd": o.cost_usd,
                    "values": {},
                    "error": "Ответ модели не соответствует схеме (нет поля criteria).",
                }
            )
            continue
        ok.append(o)
        runs.append(
            {
                "model": o.model,
                "provider": o.provider,
                "usage": o.usage,
                "duration_ms": o.duration_ms,
                "cost_usd": o.cost_usd,
                "values": run_values(checklist_cfg, o.data),
            }
        )

    costs = [r["cost_usd"] for r in runs if r.get("cost_usd") is not None]
    cost = round(sum(costs), 6) if costs else None
    usage = _sum_usage([r.get("usage") or {} for r in runs])
    if not ok:
        errors = [r["error"] for r in runs if r.get("error")]
        err = ProviderError(errors[0] if errors else "Все прогоны модели завершились ошибкой.")
        err.runs = runs  # type: ignore[attr-defined]
        err.cost_usd = cost  # type: ignore[attr-defined]
        err.usage = usage  # type: ignore[attr-defined]
        raise err

    criteria = aggregate(checklist_cfg, [o.data for o in ok], n_turns)
    values = {cid: v["value"] for cid, v in criteria.items()}
    score = scoring.compute(checklist_cfg, values)
    result = {
        "client_request": plain(str(ok[0].data.get("client_request") or "").strip()),
        "criteria": criteria,
        "score": score,
        "runs": runs,
    }
    final = {"values": dict(values), "score": copy.deepcopy(score), "overrides": {}}
    return {
        "result": result,
        "final": final,
        "total": score["total"],
        "final_total": score["total"],
        "gross": bool(score["gross_error"]),
        "cost_usd": cost,
        "usage": usage,
        "duration_ms": int((time.perf_counter() - t0) * 1000),
        "model": ok[0].model,
    }


def final_from_overrides(
    checklist_cfg: dict[str, Any], result: dict[str, Any], decided: list[dict[str, Any]]
) -> dict[str, Any]:
    """Recompute `final` from the original values plus 'changed' appeal decisions
    (in decision order; a later decision on the same criterion wins)."""
    values = {cid: v["value"] for cid, v in (result.get("criteria") or {}).items()}
    overrides: dict[str, Any] = {}
    for a in decided:
        if a.get("decision") != "changed":
            continue
        cid = a["criterion_id"]
        if cid not in values:
            continue
        overrides[cid] = {
            "appeal_id": a["id"],
            "from": result["criteria"][cid]["value"],
            "to": a["decision_value"],
            "reason": a.get("decision_reason") or "",
        }
        values[cid] = a["decision_value"]
    original = {cid: v["value"] for cid, v in (result.get("criteria") or {}).items()}
    for cid in [k for k, ov in overrides.items() if values.get(k) == original.get(k)]:
        del overrides[cid]  # changed back to the AI value: no effective override
    return {"values": values, "score": scoring.compute(checklist_cfg, values), "overrides": overrides}
