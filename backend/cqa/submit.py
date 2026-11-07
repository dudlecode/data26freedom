"""One command for the control hour: fetch -> evaluate -> export -> validate -> (push).

    cd backend
    ../.venv/bin/python -m cqa.submit --group <GROUP_ID> --set prod --push
    ../.venv/bin/python -m cqa.submit --group DEV --set dev

Talks to the running server (so progress is visible in the UI as it happens).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

from . import config, results_export

ACTIVE = ("queued", "running")


def main() -> int:
    ap = argparse.ArgumentParser(description="Оценить набор и выгрузить results/<set>/results.json")
    ap.add_argument("--group", required=True, help="group_id набора у организаторов (DEV или выданный)")
    ap.add_argument("--set", required=True, choices=["dev", "prod"], help="папка results/dev или results/prod")
    ap.add_argument("--base", default="http://127.0.0.1:8000", help="адрес запущенного сервера CQA")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default=None, help="по умолчанию CQA_DEMO_PASSWORD или freedom2026")
    ap.add_argument("--team", default=os.getenv("CQA_TEAM_NAME"), help="название команды для team_name (по умолчанию CQA_TEAM_NAME из .env)")
    ap.add_argument("--force", action="store_true", help="переоценить даже уже оценённые диалоги")
    ap.add_argument("--no-fetch", action="store_true", help="не загружать набор заново, взять из базы")
    ap.add_argument("--expect", type=int, default=None, help="ожидаемое число диалогов (prod: 10)")
    ap.add_argument("--push", action="store_true", help="git add + commit + push файла результатов")
    a = ap.parse_args()

    password = a.password or os.getenv("CQA_DEMO_PASSWORD", "freedom2026")
    expect = a.expect if a.expect is not None else (10 if a.set == "prod" else None)
    c = httpx.Client(base_url=a.base, timeout=120.0)

    def call(method: str, path: str, **kw):
        r = c.request(method, path, **kw)
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = r.text[:300]
            raise SystemExit(f"{method} {path}: {r.status_code} {detail}")
        return r

    try:
        call("POST", "/api/auth/login", json={"username": a.user, "password": password})
    except httpx.ConnectError:
        print(f"Сервер не отвечает на {a.base}. Запустите: cd backend && ../.venv/bin/python -m cqa", file=sys.stderr)
        return 2

    if not a.no_fetch:
        r = call("POST", "/api/datasets/fetch", json={"group_id": a.group}).json()
        print(f"Загружено из API организаторов: {r.get('imported')} диалогов (группа {a.group})")
    items = call("GET", "/api/dialogs", params={"group_id": a.group}).json()["items"]
    ids = [d["id"] for d in items]
    if not ids:
        print("В группе нет диалогов.", file=sys.stderr)
        return 1
    if expect is not None and len(ids) != expect:
        print(f"ВНИМАНИЕ: в группе {len(ids)} диалогов, ожидалось {expect}.")

    active_cl = call("GET", "/api/checklists/active").json()
    todo = ids if a.force else [
        d["id"] for d in items
        if not (d.get("latest") and d["latest"].get("status") == "done" and d["latest"].get("checklist_id") == active_cl["id"])
    ]

    def run(dialog_ids: list[str]) -> list[dict]:
        if not dialog_ids:
            return []
        ev_ids = call("POST", "/api/evaluations", json={"dialog_ids": dialog_ids, "checklist_id": active_cl["id"]}).json()["evaluation_ids"]
        t0 = time.time()
        while True:
            rows = call("GET", "/api/evaluations", params={"ids": ",".join(map(str, ev_ids))}).json()["items"]
            done = sum(1 for e in rows if e["status"] not in ACTIVE)
            print(f"\r  оценено {done} из {len(ev_ids)} ({time.time() - t0:.0f} с)", end="", flush=True)
            if done == len(ev_ids):
                print()
                return rows
            time.sleep(3)

    print(f"Чек-лист: {active_cl['name']}, версия {active_cl['version']}. К оценке: {len(todo)} из {len(ids)}")
    rows = run(todo)
    failed = [e["dialog_id"] for e in rows if e["status"] == "error"]
    if failed:
        print(f"Повторная попытка для {len(failed)}: {', '.join(failed)}")
        run(failed)

    r = call("GET", "/api/export/results", params={"group_id": a.group, "checklist_id": active_cl["id"], "download": 0,
                                                    **({"team_name": a.team} if a.team else {})})
    doc = r.json()
    errors = results_export.validate(doc, ids)
    out = config.ROOT / "results" / a.set / "results.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = sum(1 for x in doc["results"] if x["status"] == "ok")
    print(f"Записано: {out.relative_to(config.ROOT)}: {len(doc['results'])} записей, ok {ok}, error {len(doc['results']) - ok}, "
          f"модель {doc['model']['name']} ({doc['model']['mode']}), команда «{doc['team_name']}»")
    if errors:
        print("ПРОВЕРКА ФОРМАТА НЕ ПРОЙДЕНА:")
        for e in errors[:20]:
            print("  -", e)
        return 3
    print("Проверка формата пройдена.")

    if a.push:
        rel = str(out.relative_to(config.ROOT))
        for cmd in (["git", "add", rel], ["git", "commit", "-m", f"Results: {a.set} ({a.group}), {len(doc['results'])} dialogs\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"],
                    ["git", "push"]):
            p = subprocess.run(cmd, cwd=config.ROOT, capture_output=True, text=True)
            print("$", " ".join(cmd))
            if p.stdout.strip():
                print(p.stdout.strip())
            if p.returncode != 0:
                print(p.stderr.strip(), file=sys.stderr)
                return 4
        print("Запушено.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
