"""Выгрузка результатов в формате организаторов (CQA Student Guide Appendix, JSON 1.0).

    results/dev/results.json   - DEV (60 чатов + 5 звонков)
    results/prod/results.json  - контрольный набор (ровно 10 записей, включая ошибки)

Из готовой базы (сервер может работать параллельно):
    cd backend && python -m cqa.results --group DEV --out ../results/dev/results.json

Контрольный час - всё одной командой через работающий сервер (http://127.0.0.1:8000):
    python -m cqa.results --group <group_id> --fetch --evaluate --expect 10 --out ../results/prod/results.json

Правила формата:
- коды критериев: contact, discovery, identification, consultation, empathy, dialogue, closure, critical
  (поле export_id критерия чек-листа; для исходных c01..c08 есть соответствие по умолчанию);
- value: true = «Да», false = «Нет», null = N/A, число - ступень шкалы до учёта веса;
- evidence_turns: номера реплик с 1 по исходному массиву транскрипта (у нас индексы с 0 -> +1);
- final_score: итог 0-100, два знака, N/A исключаются с перераспределением веса; critical_flag = value critical
  и итог не обнуляет;
- не оценённый диалог: status = "error", criteria = [], score = null, причина в error.
По умолчанию выгружается автоматическая оценка системы (до апелляций); --final - с решениями проверяющих.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from . import config, db, scoring

SCHEMA_VERSION = "1.0"
DEFAULT_EXPORT_IDS = {
    "c01": "contact", "c02": "discovery", "c03": "identification", "c04": "consultation",
    "c05": "empathy", "c06": "dialogue", "c07": "closure", "c08": "critical",
}
REQUIRED_CODES = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"]
ALLOWED = {
    "contact": {True, False}, "discovery": {True, False, None}, "identification": {True, False, None},
    "consultation": {0, 5, 10, 15, 20, None}, "empathy": {True, False}, "dialogue": {0, 4, 7, 10},
    "closure": {True, False, None}, "critical": {True, False},
}


def value_ok(code: str, v: Any) -> bool:
    """В Python False == 0 и True == 1, поэтому типы проверяем явно, а не через `in`."""
    allowed = ALLOWED[code]
    if v is None:
        return None in allowed
    if any(isinstance(x, bool) for x in allowed):
        return isinstance(v, bool)
    return isinstance(v, int) and not isinstance(v, bool) and v in allowed


def export_id(c: dict[str, Any]) -> str:
    return str(c.get("export_id") or DEFAULT_EXPORT_IDS.get(c["id"]) or c["id"]).strip()


def to_value(c: dict[str, Any], v: Any) -> Any:
    """Наше значение (YES/NO/NA/ступень) -> значение формата организаторов."""
    if v is None:
        return None
    s = str(v).strip().upper()
    if s == scoring.NA:
        return None
    if c.get("type") == "scale":
        try:
            f = float(s)
        except ValueError:
            return None
        return int(f) if f.is_integer() else f
    return s == "YES"


def model_info(evals: list[dict[str, Any]]) -> dict[str, str]:
    names: list[str] = []
    modes: set[str] = set()
    for e in evals:
        s = {**config.DEFAULT_SETTINGS, **config.normalize_settings(e.get("settings"))}
        # local - модель в нашем контуре (localhost / частная сеть), иначе external_api
        modes.add("local" if config.is_local(s.get("base_url")) else "external_api")
        for run in ((e.get("result") or {}).get("runs") or []):
            m = run.get("model")
            if m and not run.get("error") and m not in names:
                names.append(m)
        if not (e.get("result") or {}).get("runs"):
            m = s.get("model")
            if m and m not in names:
                names.append(m)
    mode = "hybrid" if len(modes) > 1 else (modes.pop() if modes else "external_api")
    return {"mode": mode, "name": ", ".join(names) or "не указана"}


def dialog_result(d: dict[str, Any], e: dict[str, Any] | None, cl: dict[str, Any] | None, use_final: bool) -> dict[str, Any]:
    if e is None or e.get("status") != "done" or not cl:
        reason = (e or {}).get("error") or ("Оценка ещё не завершена." if e and e.get("status") in ("queued", "running")
                                             else "Диалог не оценён.")
        return {"conversation_id": d["id"], "status": "error", "criteria": [], "score": None, "error": reason}
    cfg = copy.deepcopy(cl["config"])
    cfg["gross_error_zeroes_total"] = False  # по правилам сдачи грубая ошибка итог не обнуляет
    res = e.get("result") or {}
    rc = res.get("criteria") or {}
    values = {cid: (v or {}).get("value") for cid, v in rc.items()}
    if use_final and (e.get("final") or {}).get("values"):
        values.update(e["final"]["values"])
    n_turns = len(d.get("transcript") or [])
    criteria = []
    critical = None
    for c in cfg.get("criteria", []):
        info = rc.get(c["id"]) or {}
        val = to_value(c, values.get(c["id"]))
        code = export_id(c)
        reasoning = str(info.get("reasoning") or info.get("na_reason") or "").strip()
        ov = ((e.get("final") or {}).get("overrides") or {}).get(c["id"]) if use_final else None
        if ov:
            reasoning = f"Изменено проверяющим по апелляции: {ov.get('reason', '')}".strip()
        turns = sorted({int(t) + 1 for t in (info.get("evidence_turns") or []) if isinstance(t, int) and 0 <= t < n_turns})
        criteria.append({"criterion_id": code, "value": val, "rationale": reasoning, "evidence_turns": turns})
        if c.get("type") == "flag" and code == "critical":
            critical = val
    if critical is None:
        flags = [c for c in criteria if c["criterion_id"] == "critical"]
        critical = flags[0]["value"] if flags else False
    score = scoring.compute(cfg, values)
    total = score.get("total")
    return {
        "conversation_id": d["id"],
        "status": "ok",
        "criteria": criteria,
        "score": {"final_score": None if total is None else round(float(total), 2), "critical_flag": bool(critical)},
    }


def build(group_id: str, team_name: str = "", use_final: bool = False, ids: list[str] | None = None) -> dict[str, Any]:
    """results.json для группы. ids - точный список conversation_id (например, из ответа API); иначе все диалоги группы."""
    if ids is None:
        dialogs = db.query("SELECT * FROM dialogs WHERE group_id = ? ORDER BY id", [group_id])
    else:
        found = {r["id"]: r for r in db.query(
            f"SELECT * FROM dialogs WHERE id IN ({','.join('?' * len(ids))})", list(ids))} if ids else {}
        dialogs = [found.get(i) or {"id": i, "transcript": []} for i in ids]
    latest = {e["dialog_id"]: e for e in db.query(
        """SELECT e.* FROM evaluations e JOIN (
               SELECT dialog_id, COALESCE(MAX(CASE WHEN status = 'done' THEN id END), MAX(id)) AS mid
               FROM evaluations GROUP BY dialog_id) m ON e.id = m.mid""")}
    cl_cache: dict[int, Any] = {}

    def cl_of(e):
        if not e:
            return None
        if e["checklist_id"] not in cl_cache:
            cl_cache[e["checklist_id"]] = db.one("SELECT * FROM checklists WHERE id = ?", [e["checklist_id"]])
        return cl_cache[e["checklist_id"]]

    items = [dialog_result(d, latest.get(d["id"]), cl_of(latest.get(d["id"])), use_final) for d in dialogs]
    used = [latest[d["id"]] for d in dialogs if latest.get(d["id"]) and latest[d["id"]].get("status") == "done"]
    return {
        "schema_version": SCHEMA_VERSION,
        "team_name": team_name or os.getenv("CQA_TEAM_NAME", "").strip() or "CQA",
        "model": model_info(used),
        "results": items,
    }


def validate(doc: dict[str, Any], expect: int | None = None, expected_ids: list[str] | None = None) -> list[str]:
    """Проверки из «Правил заполнения». Пустой список - файл можно сдавать."""
    errs: list[str] = []
    for k in ("schema_version", "team_name", "model", "results"):
        if k not in doc:
            errs.append(f"нет поля {k}")
    if errs:
        return errs
    if doc["schema_version"] != SCHEMA_VERSION:
        errs.append(f"schema_version должен быть {SCHEMA_VERSION}")
    m = doc["model"]
    if not isinstance(m, dict) or m.get("mode") not in ("local", "external_api", "hybrid") or not m.get("name"):
        errs.append("model: нужны mode (local | external_api | hybrid) и name")
    res = doc["results"]
    ids = [r.get("conversation_id") for r in res]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        errs.append(f"повторяются conversation_id: {', '.join(map(str, dup))}")
    if expect is not None and len(res) != expect:
        errs.append(f"записей {len(res)}, ожидается ровно {expect}")
    if expected_ids is not None and set(ids) != set(expected_ids):
        miss = sorted(set(expected_ids) - set(ids))
        extra = sorted(set(ids) - set(expected_ids))
        errs.append(f"ID не совпадают с API: нет {miss[:10]}, лишние {extra[:10]}")
    for r in res:
        cid = r.get("conversation_id")
        if r.get("status") == "error":
            if r.get("criteria") != [] or r.get("score") is not None or not r.get("error"):
                errs.append(f"{cid}: для status=error нужны criteria=[], score=null и причина в error")
            continue
        if r.get("status") != "ok":
            errs.append(f"{cid}: status должен быть ok или error")
            continue
        codes = [c.get("criterion_id") for c in r.get("criteria", [])]
        if sorted(codes) != sorted(REQUIRED_CODES):
            errs.append(f"{cid}: нужны все 8 критериев ровно по разу, сейчас {codes}")
        for c in r.get("criteria", []):
            code = c.get("criterion_id")
            v = c.get("value")
            if code in ALLOWED and not value_ok(code, v):
                errs.append(f"{cid}/{code}: недопустимое значение {v!r}")
            if not isinstance(c.get("rationale"), str):
                errs.append(f"{cid}/{code}: rationale должен быть строкой")
            ev = c.get("evidence_turns")
            if not isinstance(ev, list) or any(not isinstance(t, int) or isinstance(t, bool) or t < 1 for t in ev):
                errs.append(f"{cid}/{code}: evidence_turns - список номеров реплик с 1")
        sc = r.get("score") or {}
        fs = sc.get("final_score")
        if fs is not None and (not isinstance(fs, (int, float)) or not 0 <= fs <= 100 or round(fs, 2) != fs):
            errs.append(f"{cid}: final_score должен быть от 0 до 100 с двумя знаками")
        crit = next((c.get("value") for c in r.get("criteria", []) if c.get("criterion_id") == "critical"), None)
        if sc.get("critical_flag") is not crit:
            errs.append(f"{cid}: critical_flag должен совпадать с value критерия critical")
    return errs


def write(doc: dict[str, Any], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")


# --- CLI ----------------------------------------------------------------------------------

def _http(server: str, method: str, path: str, body: Any = None, timeout: float = 120) -> Any:
    import httpx

    r = httpx.request(method, server.rstrip("/") + path, json=body, timeout=timeout, headers={"X-CQA-Role": "cli"})
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail")
        except Exception:  # noqa: BLE001
            detail = r.text[:300]
        raise SystemExit(f"{method} {path}: HTTP {r.status_code}: {detail}")
    return r.json()


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description="Выгрузка results.json в формате организаторов")
    p.add_argument("--group", required=True, help="group_id набора: DEV или выданный для контроля")
    p.add_argument("--out", required=True, type=Path, help="куда записать, например ../results/prod/results.json")
    p.add_argument("--team", default="", help="название команды (иначе CQA_TEAM_NAME)")
    p.add_argument("--fetch", action="store_true", help="сначала загрузить набор из API организаторов (через сервер)")
    p.add_argument("--evaluate", action="store_true", help="оценить неоценённые диалоги и дождаться (через сервер)")
    p.add_argument("--reevaluate", action="store_true", help="оценить заново все диалоги группы (новый чек-лист)")
    p.add_argument("--expect", type=int, default=None, help="ожидаемое число записей (для prod - 10)")
    p.add_argument("--final", action="store_true", help="с учётом решений по апелляциям")
    p.add_argument("--server", default=os.getenv("CQA_SERVER", "http://127.0.0.1:8000"))
    p.add_argument("--timeout", type=int, default=2400, help="сколько ждать оценки, секунд")
    a = p.parse_args(argv)

    ids = None
    if a.fetch:
        r = _http(a.server, "POST", "/api/datasets/fetch", {"group_id": a.group})
        ids = r["ids"]
        print(f"загружено {r['imported']} диалогов, группа {r['group_id']}" + (f", переименованы {r['renamed']}" if r["renamed"] else ""))
        a.group = r["group_id"]
    if a.evaluate or a.reevaluate:
        rows = _http(a.server, "GET", f"/api/dialogs?group_id={a.group}")["items"]
        todo = [x["id"] for x in rows if a.reevaluate or not x.get("latest") or x["latest"]["status"] != "done"]
        if todo:
            eids = _http(a.server, "POST", "/api/evaluations", {"dialog_ids": todo})["evaluation_ids"]
            print(f"оценка запущена: {len(eids)} диалогов")
            t0 = time.time()
            while True:
                items = _http(a.server, "GET", "/api/evaluations?ids=" + ",".join(map(str, eids)))["items"]
                done = sum(1 for i in items if i["status"] in ("done", "error"))
                print(f"\r  готово {done}/{len(eids)}, ошибок {sum(1 for i in items if i['status'] == 'error')}", end="", flush=True)
                if done == len(eids):
                    print()
                    break
                if time.time() - t0 > a.timeout:
                    print("\nвремя ожидания вышло: неоценённые диалоги попадут в файл со status=error")
                    break
                time.sleep(5)
        else:
            print("все диалоги группы уже оценены")

    doc = build(a.group, a.team, a.final, ids)
    errs = validate(doc, a.expect, ids)
    write(doc, a.out)
    ok = sum(1 for r in doc["results"] if r["status"] == "ok")
    print(f"{a.out}: {len(doc['results'])} записей, ok {ok}, error {len(doc['results']) - ok}, модель {doc['model']}")
    if errs:
        print("ПРОВЕРКА НЕ ПРОЙДЕНА:")
        for e in errs[:50]:
            print("  - " + e)
        return 1
    print("проверка формата пройдена. Дальше: git add results && git commit && git push")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
