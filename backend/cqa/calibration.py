"""Comparison of automatic evaluations with reference (ground-truth-like) labels."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import config, scoring

REFERENCE_PATH: Path = config.ROOT / "eval" / "reference_dev.json"


def load_reference(path: Path | None = None) -> dict[str, Any] | None:
    path = path or REFERENCE_PATH
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _r(x: float | None, nd: int = 4) -> float | None:
    return None if x is None else round(x, nd)


def compare(items: list[dict[str, Any]], reference: dict[str, Any] | None) -> dict[str, Any]:
    """items: [{dialog_id, checklist (config), values: {cid: value}, pred_total}]."""
    if reference is None:
        return {
            "available": False,
            "n_dialogs": 0,
            "overall_exact": None,
            "total_mae": None,
            "by_criterion": {},
            "dialogs": [],
        }
    by_crit: dict[str, dict[str, Any]] = {}
    dialogs = []
    matches = comparisons = 0
    abs_errs: list[float] = []
    for it in items:
        ref = reference.get(it["dialog_id"])
        if not ref:
            continue
        labels = ref.get("labels") or {}
        cfg = it["checklist"]
        crits = {c["id"]: c for c in cfg.get("criteria", [])}
        ref_values = {cid: scoring.normalize_value(crits[cid], v) for cid, v in labels.items() if cid in crits}
        diffs = []
        for cid, c in crits.items():
            if cid not in ref_values or cid not in it["values"]:
                continue
            rv = ref_values[cid]
            pv = scoring.normalize_value(c, it["values"][cid])
            slot = by_crit.setdefault(cid, {"name": c.get("name", cid), "exact": 0, "n": 0, "confusion": {}})
            slot["n"] += 1
            comparisons += 1
            if rv == pv:
                slot["exact"] += 1
                matches += 1
            else:
                diffs.append({"cid": cid, "ref": rv, "pred": pv})
            key = f"{rv}→{pv}"
            slot["confusion"][key] = slot["confusion"].get(key, 0) + 1
        # reference total: reference values over the same checklist (criteria without a
        # reference label take the predicted value so that totals stay comparable)
        full_ref = {cid: ref_values.get(cid, it["values"].get(cid)) for cid in crits}
        ref_total = scoring.compute(cfg, {k: v for k, v in full_ref.items() if v is not None})["total"]
        pred_total = it.get("pred_total")
        if ref_total is not None and pred_total is not None:
            abs_errs.append(abs(ref_total - pred_total))
        dialogs.append({"id": it["dialog_id"], "ref_total": ref_total, "pred_total": pred_total, "diffs": diffs})
    for slot in by_crit.values():
        slot["exact"] = _r(slot["exact"] / slot["n"]) if slot["n"] else None
    return {
        "available": True,
        "n_dialogs": len(dialogs),
        "overall_exact": _r(matches / comparisons) if comparisons else None,
        "total_mae": _r(sum(abs_errs) / len(abs_errs), 2) if abs_errs else None,
        "by_criterion": by_crit,
        "dialogs": dialogs,
    }
