"""CQA HTTP API (FastAPI). Contract: docs/API.md."""

from __future__ import annotations

import asyncio
import copy
import csv
import io
import json
import logging
import math
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from .text import plain
from . import audio, auth, calibration, results_export, config, db, evaluator, keys, prompting, providers, scoring, sources
from .preprocess import prepare, render_for_llm

VERSION = "1.0.0"
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
PROVIDERS = [
    {"id": "anthropic", "label": "Claude (Anthropic API)"},
    {"id": "openai_compat", "label": "Локальная / OpenAI-совместимая модель"},
]
STALE_ERROR = "прервано перезапуском сервера"

log = logging.getLogger("cqa")


# --- helpers ----------------------------------------------------------------------------

def err(status: int, detail: Any) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


def load_default_checklist() -> dict[str, Any]:
    return json.loads(config.DEFAULT_CHECKLIST_PATH.read_text(encoding="utf-8"))


def sanitize_settings(patch: dict[str, Any] | None) -> dict[str, Any]:
    """Only known keys with valid values; API keys are never accepted here."""
    if not patch:
        return {}
    if not isinstance(patch, dict):
        raise err(400, "Настройки должны быть объектом.")
    out: dict[str, Any] = {}
    for k, v in patch.items():
        if k not in config.DEFAULT_SETTINGS or v is None:
            continue
        if k in ("votes", "concurrency"):
            try:
                n = int(v)
            except (TypeError, ValueError):
                raise err(400, f"Параметр {k} должен быть целым числом.")
            lo, hi = (1, 9) if k == "votes" else (1, 32)
            if not lo <= n <= hi:
                raise err(400, f"Параметр {k} должен быть от {lo} до {hi}.")
            out[k] = n
        elif k == "effort":
            if v not in EFFORTS:
                raise err(400, f"Недопустимый уровень effort: {v}. Допустимо: {', '.join(EFFORTS)}.")
            out[k] = v
        elif k == "provider":
            if v not in {p["id"] for p in PROVIDERS}:
                raise err(400, f"Неизвестный провайдер: {v}.")
            out[k] = v
        elif k == "local_json_mode":
            if v not in ("schema", "object"):
                raise err(400, "local_json_mode: допустимо schema или object.")
            out[k] = v
        else:
            s = str(v).strip()
            if not s:
                raise err(400, f"Параметр {k} не может быть пустым.")
            out[k] = s
    return out


def get_settings() -> dict[str, Any]:
    stored = db.get_setting("settings", {}) or {}
    merged = {**config.DEFAULT_SETTINGS}
    if isinstance(stored, dict):
        merged.update({k: v for k, v in stored.items() if k in config.DEFAULT_SETTINGS})
    return merged


def dialog_row(dialog_id: str) -> dict[str, Any]:
    d = db.one("SELECT * FROM dialogs WHERE id = ?", [dialog_id])
    if not d:
        raise err(404, f"Диалог {dialog_id} не найден.")
    return d


def dialog_record(d: dict[str, Any]) -> dict[str, Any]:
    return {
        "conversation_id": d["id"],
        "channel": d.get("channel") or "",
        "language": d.get("language") or "",
        "transcript": d.get("transcript") or [],
        "audio_url": d.get("audio_url"),
    }


def checklist_row(cl_id: int) -> dict[str, Any]:
    c = db.one("SELECT * FROM checklists WHERE id = ?", [cl_id])
    if not c:
        raise err(404, f"Чек-лист #{cl_id} не найден.")
    return c


def active_checklist() -> dict[str, Any]:
    c = db.one("SELECT * FROM checklists WHERE is_active = 1 ORDER BY id DESC LIMIT 1")
    if not c:
        c = db.one("SELECT * FROM checklists ORDER BY id DESC LIMIT 1")
    if not c:
        raise err(404, "Нет ни одного чек-листа.")
    return c


def checklist_out(c: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": c["id"],
        "name": c["name"],
        "version": c["version"],
        "is_active": bool(c["is_active"]),
        "note": c.get("note") or "",
        "created_at": c.get("created_at"),
        "config": c["config"],
    }


def find_criterion(cfg: dict[str, Any], cid: str) -> dict[str, Any] | None:
    return next((c for c in cfg.get("criteria", []) if c.get("id") == cid), None)


_checklist_cache: dict[int, dict[str, Any]] = {}


def checklist_cached(cl_id: int) -> dict[str, Any] | None:
    """Checklist versions are immutable, so they can be cached by id."""
    if cl_id not in _checklist_cache:
        c = db.one("SELECT * FROM checklists WHERE id = ?", [cl_id])
        if not c:
            return None
        _checklist_cache[cl_id] = c
    return _checklist_cache[cl_id]


def appeal_counts(eval_ids: list[int] | None = None) -> dict[int, dict[str, int]]:
    sql = "SELECT evaluation_id, status, COUNT(*) AS n FROM appeals"
    params: list[Any] = []
    if eval_ids is not None:
        if not eval_ids:
            return {}
        sql += f" WHERE evaluation_id IN ({','.join('?' * len(eval_ids))})"
        params = list(eval_ids)
    sql += " GROUP BY evaluation_id, status"
    out: dict[int, dict[str, int]] = {}
    for r in db.query(sql, params):
        slot = out.setdefault(r["evaluation_id"], {"open": 0, "decided": 0})
        slot[r["status"]] = r["n"]
    return out


def eval_model(e: dict[str, Any]) -> str | None:
    result = e.get("result") if isinstance(e.get("result"), dict) else None
    for run in (result or {}).get("runs", []) or []:
        if not run.get("error") and run.get("model"):
            return run["model"]
    s = e.get("settings") or {}
    if s.get("provider") == "openai_compat":
        return s.get("local_model")
    return s.get("model")


def eval_summary(e: dict[str, Any], counts: dict[int, dict[str, int]] | None = None) -> dict[str, Any]:
    if counts is None:
        counts = appeal_counts([e["id"]])
    cl = checklist_cached(e["checklist_id"]) or {}
    result = e.get("result") if isinstance(e.get("result"), dict) else None
    agreements = [c.get("agreement") for c in ((result or {}).get("criteria") or {}).values() if c.get("agreement") is not None]
    ac = counts.get(e["id"], {"open": 0, "decided": 0})
    return {
        "id": e["id"],
        "dialog_id": e["dialog_id"],
        "status": e["status"],
        "error": e.get("error"),
        "checklist_id": e["checklist_id"],
        "checklist_name": cl.get("name"),
        "checklist_version": cl.get("version"),
        "total": e.get("total"),
        "final_total": e.get("final_total"),
        "gross": None if e.get("gross") is None else bool(e.get("gross")),
        "min_agreement": min(agreements) if agreements else None,
        "open_appeals": ac.get("open", 0),
        "decided_appeals": ac.get("decided", 0),
        "model": eval_model(e),
        "cost_usd": e.get("cost_usd"),
        "duration_ms": e.get("duration_ms"),
        "created_at": e.get("created_at"),
        "finished_at": e.get("finished_at"),
    }


def summaries(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts = appeal_counts([r["id"] for r in rows])
    return [eval_summary(r, counts) for r in rows]


def evaluation_row(eval_id: int) -> dict[str, Any]:
    e = db.one("SELECT * FROM evaluations WHERE id = ?", [eval_id])
    if not e:
        raise err(404, f"Оценка #{eval_id} не найдена.")
    return e


def appeal_out(a: dict[str, Any], e: dict[str, Any] | None = None) -> dict[str, Any]:
    e = e or db.one("SELECT id, dialog_id, checklist_id FROM evaluations WHERE id = ?", [a["evaluation_id"]]) or {}
    cl = checklist_cached(e.get("checklist_id")) if e.get("checklist_id") else None
    crit = find_criterion(cl["config"], a["criterion_id"]) if cl else None
    return {
        "id": a["id"],
        "evaluation_id": a["evaluation_id"],
        "dialog_id": e.get("dialog_id"),
        "criterion_id": a["criterion_id"],
        "criterion_name": (crit or {}).get("name", a["criterion_id"]),
        "comment": a.get("comment") or "",
        "author": a.get("author") or "",
        "status": a["status"],
        "original": a.get("original"),
        "ai_opinion": a.get("ai_opinion"),
        "decision": a.get("decision"),
        "decision_value": a.get("decision_value"),
        "decision_reason": a.get("decision_reason"),
        "reviewer": a.get("reviewer"),
        "created_at": a.get("created_at"),
        "decided_at": a.get("decided_at"),
        "total_before": a.get("total_before"),
        "total_after": a.get("total_after"),
    }


def appeal_row(appeal_id: int) -> dict[str, Any]:
    a = db.one("SELECT * FROM appeals WHERE id = ?", [appeal_id])
    if not a:
        raise err(404, f"Апелляция #{appeal_id} не найдена.")
    return a


def latest_done_by_dialog(group_id: str | None = None) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """[(dialog, latest finished evaluation)] for dialogs that have one."""
    sql = """SELECT e.* FROM evaluations e
             JOIN (SELECT dialog_id, MAX(id) AS mid FROM evaluations WHERE status = 'done' GROUP BY dialog_id) m
               ON e.id = m.mid"""
    evals = {e["dialog_id"]: e for e in db.query(sql)}
    dsql = "SELECT id, group_id, channel, language, audio_url FROM dialogs"
    params: list[Any] = []
    if group_id:
        dsql += " WHERE group_id = ?"
        params.append(group_id)
    dsql += " ORDER BY group_id, id"
    return [(d, evals[d["id"]]) for d in db.query(dsql, params) if d["id"] in evals]


def ensure_schema() -> None:
    cols = {r["name"] for r in db.query("PRAGMA table_info(appeals)")}
    for col in ("total_before", "total_after"):
        if col not in cols:
            db.execute(f"ALTER TABLE appeals ADD COLUMN {col} REAL")


def seed_and_recover() -> None:
    _checklist_cache.clear()
    ensure_schema()
    auth.ensure_users()
    if not db.one("SELECT id FROM checklists LIMIT 1"):
        cfg = load_default_checklist()
        db.insert(
            "checklists",
            {
                "name": cfg.get("name", "Чек-лист"),
                "version": 1,
                "config": cfg,
                "is_active": 1,
                "note": "Исходный чек-лист",
                "created_at": db.now(),
            },
        )
    db.execute(
        "UPDATE evaluations SET status = 'error', error = ?, finished_at = ? WHERE status IN ('queued', 'running')",
        [STALE_ERROR, db.now()],
    )


# --- background evaluation jobs ---------------------------------------------------------

class JobRunner:
    """Runs queued evaluations with at most `settings.concurrency` at a time. The limit is the
    GLOBAL setting, re-read whenever a slot is requested, so changing it while jobs are queued
    takes effect without ever exceeding the new limit (one shared counter, not a new semaphore)."""

    def __init__(self) -> None:
        self._cond: asyncio.Condition | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._active = 0
        self._tasks: set[asyncio.Task] = set()

    def _condition(self) -> asyncio.Condition:
        loop = asyncio.get_running_loop()
        if self._cond is None or self._loop is not loop:
            self._cond, self._loop, self._active = asyncio.Condition(), loop, 0
        return self._cond

    @staticmethod
    def _limit() -> int:
        try:
            return max(1, int(get_settings().get("concurrency", 4) or 4))
        except (TypeError, ValueError):
            return 4

    def submit(self, eval_id: int) -> None:
        task = asyncio.get_running_loop().create_task(self._run(eval_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, eval_id: int) -> None:
        cond = self._condition()
        async with cond:
            await cond.wait_for(lambda: self._active < self._limit())
            self._active += 1
        try:
            await run_evaluation(eval_id)
        finally:
            async with cond:
                self._active -= 1
                cond.notify_all()

    async def wait_idle(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)


runner = JobRunner()


async def run_evaluation(eval_id: int) -> None:
    e = db.one("SELECT * FROM evaluations WHERE id = ?", [eval_id])
    if not e or e["status"] != "queued":
        return
    db.update("evaluations", eval_id, {"status": "running"})
    try:
        d = db.one("SELECT * FROM dialogs WHERE id = ?", [e["dialog_id"]])
        cl = checklist_cached(e["checklist_id"])
        if not d or not cl:
            raise providers.ProviderError("Диалог или чек-лист оценки не найден.")
        settings = e.get("settings") or get_settings()
        provider = providers.make_provider(settings)
        out = await evaluator.evaluate(dialog_record(d), cl["config"], settings, provider)
        db.update(
            "evaluations",
            eval_id,
            {
                "status": "done",
                "error": None,
                "result": out["result"],
                "final": out["final"],
                "total": out["total"],
                "final_total": out["final_total"],
                "gross": int(out["gross"]),
                "cost_usd": out["cost_usd"],
                "usage": out["usage"],
                "duration_ms": out["duration_ms"],
                "finished_at": db.now(),
            },
        )
    except Exception as ex:  # noqa: BLE001
        if isinstance(ex, providers.ProviderError):
            msg = str(ex)
        else:
            log.exception("evaluation %s failed", eval_id)
            msg = f"Внутренняя ошибка оценки: {type(ex).__name__}: {ex}"
        patch: dict[str, Any] = {"status": "error", "error": msg, "finished_at": db.now()}
        runs = getattr(ex, "runs", None)
        if runs is not None:
            patch["result"] = {"client_request": "", "criteria": {}, "score": None, "runs": runs}
            patch["cost_usd"] = getattr(ex, "cost_usd", None)
            patch["usage"] = getattr(ex, "usage", None)
        db.update("evaluations", eval_id, patch)


# --- app --------------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    seed_and_recover()
    yield


app = FastAPI(title="CQA: Conversation Quality Analytics", version=VERSION, lifespan=lifespan)

# Cross-origin embedding (e.g. Dynamics 365 web resource with config.js apiBase on another
# origin): list allowed origins in CQA_CORS_ORIGINS, comma-separated. Empty = same-origin only.
_cors = [o.strip() for o in os.environ.get("CQA_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors:
    app.add_middleware(
        CORSMiddleware, allow_origins=_cors, allow_methods=["*"], allow_headers=["*"], allow_credentials=False
    )


@app.exception_handler(RequestValidationError)
async def _validation_handler(_request: Request, exc: RequestValidationError):
    msgs = []
    for e in exc.errors():
        loc = ".".join(str(x) for x in e.get("loc", []) if x not in ("body", "query", "path"))
        msgs.append(f"{loc}: {e.get('msg')}" if loc else str(e.get("msg")))
    return JSONResponse(status_code=422, content={"detail": "Некорректный запрос: " + "; ".join(msgs)})


def body_dict(body: Any) -> dict[str, Any]:
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise err(400, "Тело запроса должно быть JSON-объектом.")
    return body


# --- auth ---------------------------------------------------------------------------------


def _who(fallback: Any) -> str:
    u = auth.current_user.get()
    return u["display_name"] if u else str(fallback or "").strip()


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    path = request.url.path
    method = request.method.upper()
    if not path.startswith("/api/"):
        resp = await call_next(request)
        resp.headers["Cache-Control"] = "no-cache"  # always revalidate the UI files
        return resp
    if method == "OPTIONS" or (method, path) in auth.PUBLIC_API:
        return await call_next(request)
    user = auth.user_from_token(auth.token_from_request(request.headers, request.cookies))
    if user is None:
        return JSONResponse({"detail": "Требуется вход в систему."}, status_code=401)
    roles = auth.allowed_roles(method, path)
    if user["role"] not in roles:
        need = ", ".join(auth.ROLE_LABEL[r] for r in roles)
        return JSONResponse({"detail": f"Недостаточно прав. Действие доступно ролям: {need}."}, status_code=403)
    token = auth.current_user.set(user)
    try:
        return await call_next(request)
    finally:
        auth.current_user.reset(token)


@app.post("/api/auth/login")
def auth_login(body: Any = Body(default=None)):
    b = body_dict(body)
    res = auth.login(str(b.get("username") or ""), str(b.get("password") or ""))
    if not res:
        raise err(401, "Неверный логин или пароль.")
    user, token = res
    resp = JSONResponse({"user": user, "token": token})
    resp.set_cookie(auth.COOKIE, token, max_age=auth.SESSION_TTL_S, httponly=True, samesite="lax")
    return resp


@app.post("/api/auth/quick")
def auth_quick(body: Any = Body(default=None)):
    """One-click demo sign-in for the roles listed in CQA_QUICK_LOGIN_ROLES."""
    b = body_dict(body)
    res = auth.quick_login(str(b.get("username") or ""))
    if not res:
        raise err(403, "Быстрый вход для этой роли выключен. Введите пароль.")
    user, token = res
    resp = JSONResponse({"user": user, "token": token})
    resp.set_cookie(auth.COOKIE, token, max_age=auth.SESSION_TTL_S, httponly=True, samesite="lax")
    return resp


@app.get("/api/auth/quick")
def auth_quick_roles():
    return {"roles": sorted(auth.quick_roles())}


@app.post("/api/auth/logout")
def auth_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE)
    return resp


@app.get("/api/auth/me")
def auth_me():
    return {"user": auth.current_user.get()}


# --- service ---

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "has_anthropic_key": bool(config.ANTHROPIC_API_KEY),
        "source_configured": bool(config.SOURCE_URL),
        "version": VERSION,
    }


@app.get("/api/settings")
def settings_get():
    return {
        "settings": get_settings(),
        "models": config.ANTHROPIC_MODELS,
        "efforts": EFFORTS,
        "providers": PROVIDERS,
        "has_anthropic_key": bool(config.ANTHROPIC_API_KEY),
    }


@app.put("/api/settings")
def settings_put(body: Any = Body(default=None)):
    patch = sanitize_settings(body_dict(body))
    stored = db.get_setting("settings", {}) or {}
    if not isinstance(stored, dict):
        stored = {}
    stored.update(patch)
    db.set_setting("settings", stored)
    return {"settings": get_settings()}


@app.get("/api/settings/anthropic-key")
def key_get():
    return keys.status()


@app.post("/api/settings/anthropic-key")
async def key_post(body: Any = Body(default=None)):
    key = body_dict(body).get("key")
    try:
        return await keys.save(str(key or ""))
    except keys.KeyError_ as e:
        raise err(400, str(e))


@app.get("/api/gross-errors")
def gross_errors(group_id: str | None = None):
    """Dialogs whose latest finished evaluation (after appeal decisions) has a gross-error flag."""
    items = []
    for d, e in latest_done_by_dialog(group_id):
        final = e.get("final") or {}
        score = final.get("score") or (e.get("result") or {}).get("score") or {}
        flagged = score.get("gross_criteria") or []
        if not flagged:
            continue
        cfg = (checklist_cached(e["checklist_id"]) or {}).get("config") or {}
        res = (e.get("result") or {}).get("criteria") or {}
        rec = db.one("SELECT transcript FROM dialogs WHERE id = ?", [d["id"]]) or {}
        turns = rec.get("transcript") or []
        crits = []
        for cid in flagged:
            c = find_criterion(cfg, cid) or {}
            r = res.get(cid) or {}
            ev = [i for i in (r.get("evidence_turns") or []) if isinstance(i, int) and 0 <= i < len(turns)]
            crits.append({
                "criterion_id": cid,
                "code": c.get("code") or cid,
                "name": c.get("name") or cid,
                "reasoning": r.get("reasoning") or "",
                "evidence_turns": ev,
                "evidence": [{"idx": i, "speaker": turns[i].get("speaker"), "text": turns[i].get("text")} for i in ev[:3]],
                "agreement": r.get("agreement"),
                "votes": r.get("votes") or [],
                "overridden": cid in (final.get("overrides") or {}),
            })
        items.append({
            "dialog_id": d["id"], "group_id": d.get("group_id"), "channel": d.get("channel"),
            "language": d.get("language"), "evaluation_id": e["id"],
            "total": e.get("total"), "final_total": e.get("final_total"), "criteria": crits,
        })
    return {"items": items}


def export_selection(group_id: str | None, checklist_id: int | None = None):
    """Dialogs of a group with the evaluation to export: the latest finished one (optionally of
    a given checklist version), else the latest attempt so failures are reported, not hidden."""
    dsql = "SELECT id, group_id, transcript FROM dialogs"
    params: list[Any] = []
    if group_id:
        dsql += " WHERE group_id = ?"
        params.append(group_id)
    dialogs = db.query(dsql + " ORDER BY id", params)
    chosen: dict[str, dict[str, Any]] = {}
    for d in dialogs:
        rows = db.query("SELECT * FROM evaluations WHERE dialog_id = ? ORDER BY id DESC", [d["id"]])
        done = [r for r in rows if r["status"] == "done" and (checklist_id is None or r["checklist_id"] == checklist_id)]
        pick = done[0] if done else (rows[0] if rows else None)
        if pick:
            chosen[d["id"]] = pick
    configs = {}
    for e in chosen.values():
        if e["checklist_id"] not in configs:
            configs[e["checklist_id"]] = (checklist_cached(e["checklist_id"]) or {}).get("config")
    return dialogs, chosen, configs


@app.get("/api/export/results")
def export_results(group_id: str | None = None, checklist_id: int | None = None, team_name: str | None = None,
                   download: int = 1):
    """Organizers' results format JSON 1.0 (results/<dev|prod>/results.json)."""
    dialogs, chosen, configs = export_selection(group_id, checklist_id)
    doc = results_export.build(dialogs, chosen, configs, team_name or db.get_setting("team_name"))
    errors = results_export.validate(doc, [d["id"] for d in dialogs])
    body = json.dumps(doc, ensure_ascii=False, indent=2)
    headers = {"X-CQA-Validation-Errors": str(len(errors))}
    if download:
        headers["Content-Disposition"] = 'attachment; filename="results.json"'
    return Response(body, media_type="application/json; charset=utf-8", headers=headers)


@app.get("/api/export/results/check")
def export_results_check(group_id: str | None = None, checklist_id: int | None = None):
    dialogs, chosen, configs = export_selection(group_id, checklist_id)
    doc = results_export.build(dialogs, chosen, configs, db.get_setting("team_name"))
    res = doc["results"]
    return {
        "count": len(res),
        "ok": sum(1 for r in res if r["status"] == "ok"),
        "errors_in_results": sum(1 for r in res if r["status"] == "error"),
        "model": doc["model"],
        "team_name": doc["team_name"],
        "validation_errors": results_export.validate(doc, [d["id"] for d in dialogs]),
    }


@app.get("/api/stats")
def stats(group_id: str | None = None):
    dsql, params = "SELECT COUNT(*) AS n FROM dialogs", []
    if group_id:
        dsql += " WHERE group_id = ?"
        params = [group_id]
    n_dialogs = db.one(dsql, params)["n"]
    pairs = latest_done_by_dialog(group_id)
    totals, by_lang, by_crit = [], {}, {}
    gross_count = 0
    for d, e in pairs:
        # final result wins (it can legitimately be null after an appeal makes everything N/A)
        ft = e.get("final_total") if e.get("final") else e.get("total")
        if ft is not None:
            totals.append(ft)
        if e.get("gross"):
            gross_count += 1
        lang = d.get("language") or "-"
        slot = by_lang.setdefault(lang, {"count": 0, "_sum": 0.0, "_n": 0})
        slot["count"] += 1
        if ft is not None:
            slot["_sum"] += ft
            slot["_n"] += 1
        cl = checklist_cached(e["checklist_id"])
        names = {c["id"]: c.get("name", c["id"]) for c in (cl["config"].get("criteria", []) if cl else [])}
        values = (e.get("final") or {}).get("values") or {}
        for cid, v in values.items():
            cslot = by_crit.setdefault(cid, {"name": names.get(cid, cid), "distribution": {}})
            cslot["name"] = names.get(cid, cslot["name"])
            cslot["distribution"][str(v)] = cslot["distribution"].get(str(v), 0) + 1
    for slot in by_lang.values():
        slot["avg"] = round(slot["_sum"] / slot["_n"], 2) if slot["_n"] else None
        slot.pop("_sum")
        slot.pop("_n")
    eval_cost = db.one("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM evaluations")["s"] or 0.0
    appeal_cost = 0.0
    for a in db.query("SELECT ai_opinion FROM appeals WHERE ai_opinion IS NOT NULL"):
        op = a.get("ai_opinion")
        if isinstance(op, dict) and op.get("cost_usd"):
            appeal_cost += float(op["cost_usd"])
    open_appeals = db.one("SELECT COUNT(*) AS n FROM appeals WHERE status = 'open'")["n"]
    return {
        "dialogs": n_dialogs,
        "evaluated": len(pairs),
        "avg_total": round(sum(totals) / len(totals), 2) if totals else None,
        "gross_count": gross_count,
        "open_appeals": open_appeals,
        "total_cost_usd": round(eval_cost + appeal_cost, 6),
        "by_language": by_lang,
        "by_criterion": by_crit,
    }


# --- data ---

def upsert_records(
    records: list[dict[str, Any]], group_id: str, source: str, renamed: dict[str, str] | None = None
) -> list[str]:
    """Upsert dialogs. A record whose ID exists with a DIFFERENT transcript and already has
    evaluations is stored under a new ID (`<id>-2`, ...) so old evaluations, evidence turns
    and appeals keep pointing at the transcript they were made on; `renamed` collects old→new."""
    ids = []
    for rec in records:
        cid = rec["conversation_id"]
        old = db.one("SELECT transcript FROM dialogs WHERE id = ?", [cid])
        if (
            old is not None
            and (old.get("transcript") or []) != (rec.get("transcript") or [])
            and db.one("SELECT id FROM evaluations WHERE dialog_id = ? LIMIT 1", [cid])
        ):
            n = 2
            while True:
                cand = f"{cid}-{n}"
                row = db.one("SELECT transcript FROM dialogs WHERE id = ?", [cand])
                if row is None or (row.get("transcript") or []) == (rec.get("transcript") or []):
                    break
                n += 1
            rec = {**rec, "conversation_id": cand}
            if renamed is not None:
                renamed[cid] = cand
        db.upsert_dialog(rec, group_id, source)
        ids.append(rec["conversation_id"])
    return ids


def payload_group(payload: Any) -> str | None:
    """dataset_group_id from an organizers' response (full response or its `data`)."""
    if isinstance(payload, dict):
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        gid = data.get("dataset_group_id") if isinstance(data, dict) else None
        if gid is not None and str(gid).strip():
            return str(gid).strip()
    return None


@app.post("/api/datasets/fetch")
async def datasets_fetch(body: Any = Body(default=None)):
    b = body_dict(body)
    group_id = str(b.get("group_id") or "").strip()
    try:
        gid, records = await sources.fetch_dataset(group_id, b.get("source_url"))
    except sources.SourceError as e:
        raise err(e.status, str(e))
    renamed: dict[str, str] = {}
    ids = upsert_records(records, gid, "api", renamed)
    return {"group_id": gid, "imported": len(ids), "ids": ids, "renamed": renamed}


@app.post("/api/dialogs/import")
def dialogs_import(body: Any = Body(default=None)):
    b = body_dict(body)
    if "payload" not in b:
        raise err(400, "Передайте поле payload с данными диалогов.")
    # explicit group_id > dataset_group_id of an organizers' response > UPLOAD
    group_id = str(b.get("group_id") or "").strip() or payload_group(b["payload"]) or "UPLOAD"
    try:
        records = sources.extract_records(b["payload"])
    except sources.SourceError as e:
        raise err(400, str(e))
    if not records:
        raise err(400, "Не найдено ни одной записи диалога.")
    renamed: dict[str, str] = {}
    ids = upsert_records(records, group_id, "upload", renamed)
    return {"imported": len(ids), "ids": ids, "group_id": group_id, "renamed": renamed}


@app.get("/api/dialogs")
def dialogs_list(
    group_id: str | None = None, language: str | None = None, channel: str | None = None, q: str | None = None
):
    sql, params = "SELECT * FROM dialogs WHERE 1=1", []
    if group_id:
        sql += " AND group_id = ?"
        params.append(group_id)
    if language:
        sql += " AND language = ?"
        params.append(language)
    if channel:
        sql += " AND channel = ?"
        params.append(channel)
    rows = db.query(sql + " ORDER BY group_id, id", params)
    if q:
        ql = q.strip().lower()
        rows = [
            r
            for r in rows
            if ql in r["id"].lower() or any(ql in str(t.get("text", "")).lower() for t in (r.get("transcript") or []))
        ]
    latest = {
        e["dialog_id"]: e
        for e in db.query(
            """SELECT e.* FROM evaluations e
               JOIN (SELECT dialog_id, MAX(id) AS mid FROM evaluations GROUP BY dialog_id) m ON e.id = m.mid"""
        )
    }
    counts = appeal_counts([e["id"] for e in latest.values()])
    items = [
        {
            "id": r["id"],
            "group_id": r["group_id"],
            "channel": r["channel"],
            "language": r["language"],
            "turns": len(r.get("transcript") or []),
            "imported_at": r.get("imported_at"),
            "latest": eval_summary(latest[r["id"]], counts) if r["id"] in latest else None,
        }
        for r in rows
    ]
    groups = [g["group_id"] for g in db.query("SELECT DISTINCT group_id FROM dialogs ORDER BY group_id")]
    return {"items": items, "groups": groups}


@app.get("/api/dialogs/{dialog_id}")
def dialog_get(dialog_id: str):
    d = dialog_row(dialog_id)
    p = prepare(dialog_record(d))
    evals = db.query("SELECT * FROM evaluations WHERE dialog_id = ? ORDER BY id DESC", [dialog_id])
    return {
        "dialog": {
            "id": d["id"],
            "group_id": d["group_id"],
            "channel": d["channel"],
            "language": d["language"],
            "has_audio": bool(d.get("audio_url")),
        },
        "turns": [t.to_dict() for t in p.turns],
        "facts": p.facts,
        "evaluations": summaries(evals),
    }


# --- checklists ---

def total_weight(cfg: dict[str, Any]) -> float:
    return round(
        sum(float(c.get("weight", 0) or 0) for c in cfg.get("criteria", []) if c.get("type") != "flag"), 4
    )


def checklist_errors(cfg: Any) -> list[str]:
    if not isinstance(cfg, dict):
        return ["Конфигурация чек-листа должна быть объектом."]
    errs: list[str] = []
    if not str(cfg.get("name") or "").strip():
        errs.append("Не задано название чек-листа.")
    crits = cfg.get("criteria")
    if crits is not None and not isinstance(crits, list):
        return errs + ["Поле criteria должно быть массивом."]
    seen_ids: set[str] = set()
    for i, c in enumerate(crits or [], 1):
        if not isinstance(c, dict):
            errs.append(f"Критерий №{i}: должен быть объектом.")
            continue
        cid = str(c.get("id") or "").strip()
        label = c.get("name") or cid or f"Критерий №{i}"
        if not cid:
            errs.append(f"Критерий №{i}: не задан ID.")
        elif cid in seen_ids:
            errs.append(f"ID критерия {cid!r} повторяется (пробелы по краям не учитываются).")
        seen_ids.add(cid)
        try:
            w = float(c.get("weight", 0) or 0)
            if not math.isfinite(w):
                errs.append(f"{label}: вес должен быть конечным числом.")
        except (TypeError, ValueError):
            pass  # reported by scoring.validate_checklist
        if c.get("type") == "scale":
            steps = c.get("scale") or []
            if not isinstance(steps, list):
                errs.append(f"{label}: шкала должна быть массивом ступеней.")
                continue
            nums: list[float] = []
            for st in steps:
                try:
                    v = float(st.get("value"))
                except (TypeError, ValueError, AttributeError):
                    errs.append(f"{label}: значение ступени шкалы должно быть числом.")
                    nums = []
                    break
                if not math.isfinite(v) or not v.is_integer():
                    errs.append(f"{label}: значение ступени шкалы должно быть целым числом (получено {st.get('value')}).")
                    nums = []
                    break
                if v < 0:
                    errs.append(f"{label}: значение ступени шкалы не может быть отрицательным.")
                    nums = []
                    break
                nums.append(v)
            if nums:
                if len(set(nums)) != len(nums):
                    errs.append(f"{label}: значения ступеней шкалы повторяются.")
                elif max(nums) <= 0:
                    errs.append(f"{label}: верхняя ступень шкалы должна быть больше 0.")
    if errs:
        return errs
    try:
        return scoring.validate_checklist(cfg)
    except Exception as e:  # noqa: BLE001
        return [f"Некорректная структура чек-листа: {e}"]


def normalize_checklist(cfg: dict[str, Any]) -> dict[str, Any]:
    cfg = copy.deepcopy(cfg)
    cfg["name"] = str(cfg["name"]).strip()
    cfg.setdefault("rounding", 2)
    cfg.setdefault("sections", [])
    for c in cfg["criteria"]:
        c["id"] = str(c["id"]).strip()
        c["weight"] = float(c.get("weight", 0) or 0)
        if c["weight"].is_integer():
            c["weight"] = int(c["weight"])
        c["na_allowed"] = bool(c.get("na_allowed", False))
        if c.get("type") == "scale":
            c["scale"] = [
                {"value": int(float(s["value"])), "label": str(s.get("label", ""))} for s in c.get("scale") or []
            ]
    return cfg


@app.get("/api/checklists")
def checklists_list():
    rows = db.query("SELECT * FROM checklists ORDER BY version DESC, id DESC")
    return {
        "items": [
            {
                "id": c["id"],
                "name": c["name"],
                "version": c["version"],
                "is_active": bool(c["is_active"]),
                "note": c.get("note") or "",
                "created_at": c.get("created_at"),
                "criteria_count": len(c["config"].get("criteria", [])),
                "total_weight": total_weight(c["config"]),
            }
            for c in rows
        ]
    }


@app.get("/api/checklists/active")
def checklists_active():
    return checklist_out(active_checklist())


@app.get("/api/checklists/default")
def checklists_default():
    return load_default_checklist()


@app.post("/api/checklists/validate")
def checklists_validate(body: Any = Body(default=None)):
    cfg = body_dict(body).get("config")
    errors = checklist_errors(cfg)
    tw = None
    if isinstance(cfg, dict) and isinstance(cfg.get("criteria"), list):
        try:
            tw = total_weight(cfg)
        except (TypeError, ValueError, AttributeError):
            tw = None
    if tw is not None and not math.isfinite(tw):
        tw = None
    return {"errors": errors, "total_weight": tw}


@app.post("/api/checklists")
def checklists_create(body: Any = Body(default=None)):
    b = body_dict(body)
    cfg = b.get("config")
    errors = checklist_errors(cfg)
    if errors:
        raise err(422, {"errors": errors})
    cfg = normalize_checklist(cfg)
    version = (db.one("SELECT MAX(version) AS v FROM checklists")["v"] or 0) + 1
    activate = b.get("activate", True) is not False
    new_id = db.insert(
        "checklists",
        {
            "name": cfg["name"],
            "version": version,
            "config": cfg,
            "is_active": 0,
            "note": str(b.get("note") or ""),
            "created_at": db.now(),
        },
    )
    if activate:
        db.execute("UPDATE checklists SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END", [new_id])
    return checklist_out(checklist_row(new_id))


@app.get("/api/checklists/{cl_id}")
def checklists_get(cl_id: int):
    return checklist_out(checklist_row(cl_id))


@app.post("/api/checklists/{cl_id}/activate")
def checklists_activate(cl_id: int):
    checklist_row(cl_id)
    db.execute("UPDATE checklists SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END", [cl_id])
    return {"ok": True}


# --- evaluations ---

def create_evaluation(dialog_id: str, checklist_id: int, settings: dict[str, Any]) -> int:
    return db.insert(
        "evaluations",
        {
            "dialog_id": dialog_id,
            "checklist_id": checklist_id,
            "status": "queued",
            "settings": settings,
            "created_at": db.now(),
        },
    )


def budget_guard(n_runs: int, settings: dict[str, Any]) -> None:
    """Optional daily spend cap for the public demo server (CQA_DAILY_BUDGET_USD, 0 = off)."""
    try:
        cap = float(os.getenv("CQA_DAILY_BUDGET_USD", "0") or 0)
    except ValueError:
        cap = 0.0
    if cap <= 0 or settings.get("provider") == "openai_compat":
        return
    from datetime import datetime, timedelta, timezone
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
    row = db.one("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM evaluations WHERE created_at >= ?", [since])
    spent = float((row or {}).get("s") or 0)
    estimate = n_runs * 0.08
    if spent + estimate > cap:
        raise err(429, f"Дневной лимит расходов на оценку исчерпан: потрачено ${spent:.2f} из ${cap:.2f}. "
                       "Обратитесь к администратору.")


@app.post("/api/evaluations")
async def evaluations_create(body: Any = Body(default=None)):
    b = body_dict(body)
    ids = b.get("dialog_ids")
    if isinstance(ids, str):
        ids = [ids]
    if not isinstance(ids, list) or not ids:
        raise err(400, "Выберите хотя бы один диалог для оценки.")
    ids = list(dict.fromkeys(str(x) for x in ids))
    existing = {
        r["id"] for r in db.query(f"SELECT id FROM dialogs WHERE id IN ({','.join('?' * len(ids))})", ids)
    }
    missing = [x for x in ids if x not in existing]
    if missing:
        raise err(404, "Диалоги не найдены: " + ", ".join(missing[:10]))
    if b.get("checklist_id") is not None:
        try:
            cl = checklist_row(int(b["checklist_id"]))
        except (TypeError, ValueError):
            raise err(400, "checklist_id должен быть числом.")
    else:
        cl = active_checklist()
    settings = {**get_settings(), **sanitize_settings(b.get("settings"))}
    budget_guard(len(ids) * int(settings.get("votes", 1) or 1), settings)
    eval_ids = [create_evaluation(d, cl["id"], settings) for d in ids]
    for eid in eval_ids:
        runner.submit(eid)
    return {"evaluation_ids": eval_ids}


@app.get("/api/evaluations")
def evaluations_list(ids: str | None = None, status: str | None = None, dialog_id: str | None = None):
    sql, params = "SELECT * FROM evaluations WHERE 1=1", []
    if ids:
        try:
            id_list = [int(x) for x in ids.split(",") if x.strip()]
        except ValueError:
            raise err(400, "ids: ожидается список чисел через запятую.")
        if not id_list:
            return {"items": []}
        sql += f" AND id IN ({','.join('?' * len(id_list))})"
        params += id_list
    if status == "active":
        sql += " AND status IN ('queued', 'running')"
    elif status:
        sql += " AND status = ?"
        params.append(status)
    if dialog_id:
        sql += " AND dialog_id = ?"
        params.append(dialog_id)
    sql += " ORDER BY id DESC"
    if not ids:
        sql += " LIMIT 500"
    return {"items": summaries(db.query(sql, params))}


@app.get("/api/evaluations/{eval_id}")
def evaluations_get(eval_id: int):
    e = evaluation_row(eval_id)
    cl = checklist_cached(e["checklist_id"]) or {}
    out = eval_summary(e)
    appeals = db.query("SELECT * FROM appeals WHERE evaluation_id = ? ORDER BY id", [eval_id])
    out.update(
        {
            "settings": e.get("settings"),
            "usage": e.get("usage"),
            "checklist": {
                "id": cl.get("id"),
                "name": cl.get("name"),
                "version": cl.get("version"),
                "config": cl.get("config"),
            },
            "result": e.get("result"),
            "final": e.get("final"),
            "appeals": [appeal_out(a, e) for a in appeals],
        }
    )
    return out


@app.post("/api/evaluations/{eval_id}/rerun")
async def evaluations_rerun(eval_id: int):
    e = evaluation_row(eval_id)
    dialog_row(e["dialog_id"])
    new_id = create_evaluation(e["dialog_id"], e["checklist_id"], e.get("settings") or get_settings())
    runner.submit(new_id)
    return {"evaluation_id": new_id}


# --- appeals ---

def criterion_original(e: dict[str, Any], cid: str) -> dict[str, Any]:
    res = (e.get("result") or {}).get("criteria", {}).get(cid) or {}
    final = e.get("final") or {}
    value = (final.get("values") or {}).get(cid, res.get("value"))
    points = ((final.get("score") or {}).get("criteria") or {}).get(cid, {}).get("points")
    reasoning = res.get("reasoning", "")
    ov = (final.get("overrides") or {}).get(cid)
    if ov:
        reasoning = f"Изменено по апелляции #{ov['appeal_id']} (было {ov['from']}, стало {ov['to']}): {ov['reason']}"
    return {
        "value": value,
        "reasoning": reasoning,
        "evidence_turns": res.get("evidence_turns", []),
        "checked_range": res.get("checked_range"),
        "points": points,
    }


@app.post("/api/evaluations/{eval_id}/appeals")
def appeals_create(eval_id: int, body: Any = Body(default=None)):
    b = body_dict(body)
    e = evaluation_row(eval_id)
    if e["status"] != "done":
        raise err(409, "Апелляцию можно подать только на завершённую оценку.")
    cid = str(b.get("criterion_id") or "").strip()
    cl = checklist_cached(e["checklist_id"])
    if not cid or not cl or not find_criterion(cl["config"], cid):
        raise err(400, f"Критерий {cid or '(не указан)'} отсутствует в чек-листе этой оценки.")
    if db.one(
        "SELECT id FROM appeals WHERE evaluation_id = ? AND criterion_id = ? AND status = 'open'", [eval_id, cid]
    ):
        raise err(409, "По этому критерию уже есть открытая апелляция.")
    original = criterion_original(e, cid)
    aid = db.insert(
        "appeals",
        {
            "evaluation_id": eval_id,
            "criterion_id": cid,
            "comment": str(b.get("comment") or "").strip(),
            "author": _who(b.get("author")),
            "status": "open",
            "original": original,
            "created_at": db.now(),
            "total_before": e.get("final_total"),
        },
    )
    return appeal_out(appeal_row(aid), e)


@app.get("/api/appeals")
def appeals_list(status: str = Query(default="all")):
    sql, params = "SELECT * FROM appeals", []
    if status in ("open", "decided"):
        sql += " WHERE status = ?"
        params.append(status)
    elif status != "all":
        raise err(400, "status: допустимо open, decided или all.")
    rows = db.query(sql + " ORDER BY id DESC", params)
    evals = {
        e["id"]: e
        for e in db.query(
            "SELECT e.id, e.dialog_id, e.checklist_id, d.channel, d.language FROM evaluations e "
            "LEFT JOIN dialogs d ON d.id = e.dialog_id"
        )
    }
    items = []
    for a in rows:
        e = evals.get(a["evaluation_id"], {})
        item = appeal_out(a, e)
        item["dialog_channel"] = e.get("channel")
        item["dialog_language"] = e.get("language")
        items.append(item)
    return {"items": items}


def appeal_fragment(turns: list[dict[str, Any]], appeal: dict[str, Any]) -> list[dict[str, Any]]:
    n = len(turns)
    orig = appeal.get("original") or {}
    idx: set[int] = set()
    anchors = list(orig.get("evidence_turns") or [])
    rng = orig.get("checked_range")
    if isinstance(appeal.get("ai_opinion"), dict):
        anchors += appeal["ai_opinion"].get("evidence_turns") or []
    for i in anchors:
        if isinstance(i, int) and 0 <= i < n:
            idx.update(range(max(0, i - 2), min(n, i + 3)))
    if isinstance(rng, list) and len(rng) == 2:
        a, b = int(rng[0]), int(rng[1])
        idx.update(range(max(0, a - 2), min(n, b + 3)))
    if not idx:
        frag = [t for t in turns if t["phase"] != "pre_operator"]
        return frag or turns
    return [turns[i] for i in sorted(idx)]


@app.get("/api/appeals/{appeal_id}")
def appeals_get(appeal_id: int):
    a = appeal_row(appeal_id)
    e = evaluation_row(a["evaluation_id"])
    cl = checklist_cached(e["checklist_id"]) or {"config": {}}
    d = db.one("SELECT * FROM dialogs WHERE id = ?", [e["dialog_id"]])
    turns = [t.to_dict() for t in prepare(dialog_record(d)).turns] if d else []
    return {
        "appeal": appeal_out(a, e),
        "evaluation": eval_summary(e),
        "criterion": find_criterion(cl["config"], a["criterion_id"]),
        "fragment": appeal_fragment(turns, a),
        "has_audio": bool(d and d.get("audio_url")),
    }


@app.post("/api/appeals/{appeal_id}/ai-review")
async def appeals_ai_review(appeal_id: int):
    a = appeal_row(appeal_id)
    if a["status"] != "open":
        raise err(409, "Апелляция уже рассмотрена: второе мнение ИИ можно запросить только по открытой апелляции.")
    e = evaluation_row(a["evaluation_id"])
    cl = checklist_cached(e["checklist_id"])
    crit = find_criterion(cl["config"], a["criterion_id"]) if cl else None
    d = db.one("SELECT * FROM dialogs WHERE id = ?", [e["dialog_id"]])
    if not crit or not d:
        raise err(404, "Критерий или диалог апелляции не найден.")
    prepared = prepare(dialog_record(d))
    settings = e.get("settings") or get_settings()
    try:
        provider = providers.make_provider(settings)
        rr = await provider.complete_json(
            prompting.build_appeal_system(cl["config"], crit),
            prompting.build_appeal_user(render_for_llm(prepared), a.get("original") or {}, a.get("comment") or ""),
            prompting.build_appeal_schema(crit),
        )
    except providers.ProviderError as ex:
        raise err(502, str(ex))
    except Exception as ex:  # noqa: BLE001 — malformed JSON etc. must not become a bare 500
        log.exception("ai-review for appeal %s failed", appeal_id)
        raise err(502, f"Не удалось получить второе мнение ИИ: {type(ex).__name__}. Попробуйте ещё раз.")
    data = rr.data if isinstance(rr.data, dict) else {}
    opinion = {
        "value": scoring.normalize_value(crit, data.get("value")),
        "reasoning": plain(str(data.get("reasoning") or "").strip()),
        "evidence_turns": evaluator.clean_turns(data.get("evidence_turns"), len(prepared.turns)),
        "appeal_valid": bool(data.get("appeal_valid")),
        "recommendation": plain(str(data.get("recommendation") or "").strip()),
        "model": rr.model,
        "cost_usd": rr.cost_usd,
    }
    db.execute("UPDATE appeals SET ai_opinion = ? WHERE id = ? AND status = 'open'", [opinion, appeal_id])
    return {"appeal": appeal_out(appeal_row(appeal_id), e)}


@app.post("/api/appeals/{appeal_id}/decide")
def appeals_decide(appeal_id: int, body: Any = Body(default=None)):
    b = body_dict(body)
    # Status check, decision write and `final` recalculation form one critical section, so two
    # concurrent decisions on one evaluation cannot lose an update or decide an appeal twice.
    with db._lock:
        return _appeals_decide_locked(appeal_id, b)


def _appeals_decide_locked(appeal_id: int, b: dict[str, Any]) -> dict[str, Any]:
    a = appeal_row(appeal_id)
    if a["status"] != "open":
        raise err(409, "Апелляция уже рассмотрена.")
    e = evaluation_row(a["evaluation_id"])
    cl = checklist_cached(e["checklist_id"])
    crit = find_criterion(cl["config"], a["criterion_id"]) if cl else None
    if not crit:
        raise err(404, "Критерий апелляции не найден в чек-листе.")
    action = b.get("action")
    if action not in ("confirm", "change"):
        raise err(400, "action: допустимо confirm или change.")
    reason = str(b.get("reason") or "").strip()
    if not reason:
        raise err(400, "Укажите причину решения.")
    allowed = scoring.allowed_values(crit)
    if action == "change":
        raw = b.get("value")
        value = str(raw).strip().upper() if raw is not None else ""
        if value not in allowed:
            raise err(400, f"Недопустимое значение для критерия: {raw!r}. Допустимо: {', '.join(allowed)}.")
        decision = "changed"
    else:
        value = criterion_original(e, a["criterion_id"])["value"]
        decision = "confirmed"
    total_before = e.get("final_total")
    db.update(
        "appeals",
        appeal_id,
        {
            "status": "decided",
            "decision": decision,
            "decision_value": value,
            "decision_reason": reason,
            "reviewer": _who(b.get("reviewer")),
            "decided_at": db.now(),
            "total_before": total_before,
        },
    )
    decided = db.query(
        "SELECT * FROM appeals WHERE evaluation_id = ? AND status = 'decided' ORDER BY decided_at, id",
        [e["id"]],
    )
    final = evaluator.final_from_overrides(cl["config"], e.get("result") or {}, decided)
    final_total = final["score"]["total"]
    db.update(
        "evaluations",
        e["id"],
        {"final": final, "final_total": final_total, "gross": int(bool(final["score"]["gross_error"]))},
    )
    db.update("appeals", appeal_id, {"total_after": final_total})
    return {"appeal": appeal_out(appeal_row(appeal_id), e), "final_total": final_total}


# --- audio ---

@app.get("/api/audio/{dialog_id}")
async def audio_redirect(dialog_id: str):
    d = dialog_row(dialog_id)
    if not d.get("audio_url"):
        raise err(404, "У диалога нет записи звонка.")
    try:
        url = await audio.resolve(dialog_id, d["audio_url"])
    except audio.AudioError as e:
        raise err(502, str(e))
    return RedirectResponse(url, status_code=302)


@app.get("/api/audio/{dialog_id}/info")
async def audio_info(dialog_id: str):
    d = dialog_row(dialog_id)
    if not d.get("audio_url"):
        raise err(404, "У диалога нет записи звонка.")
    try:
        url = await audio.resolve(dialog_id, d["audio_url"])
    except audio.AudioError as e:
        raise err(502, str(e))
    return {"mp3_url": url, "player_url": d["audio_url"]}


# --- export & calibration ---

def _num(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "да" if v else "нет"
    if isinstance(v, float):
        s = f"{v:.2f}".rstrip("0").rstrip(".")
        return s.replace(".", ",")
    return str(v)


@app.get("/api/export")
def export(group_id: str | None = None, format: str = Query(default="csv")):
    pairs = latest_done_by_dialog(group_id)
    crit_order: list[str] = []
    crit_names: dict[str, str] = {}
    rows = []
    for d, e in pairs:
        cl = checklist_cached(e["checklist_id"]) or {"config": {}, "name": "", "version": None}
        for c in cl["config"].get("criteria", []):
            if c["id"] not in crit_names:
                crit_order.append(c["id"])
                crit_names[c["id"]] = c.get("name", c["id"])
        final = e.get("final") or {}
        res = e.get("result") or {}
        fscore = (final.get("score") or {}).get("criteria") or {}
        criteria = {}
        for cid in [c["id"] for c in cl["config"].get("criteria", [])]:
            criteria[cid] = {
                "name": crit_names[cid],
                "value": (final.get("values") or {}).get(cid),
                "original_value": ((res.get("criteria") or {}).get(cid) or {}).get("value"),
                "points": (fscore.get(cid) or {}).get("points"),
            }
        rows.append(
            {
                "dialog_id": d["id"],
                "group_id": d["group_id"],
                "channel": d["channel"],
                "language": d["language"],
                "evaluation_id": e["id"],
                "checklist": cl.get("name"),
                "checklist_version": cl.get("version"),
                "total": e.get("total"),
                "final_total": e.get("final_total"),
                "gross": bool(e.get("gross")),
                "model": eval_model(e),
                "cost_usd": e.get("cost_usd"),
                "criteria": criteria,
            }
        )
    suffix = group_id or "all"
    if format == "json":
        return Response(
            json.dumps(rows, ensure_ascii=False, indent=2),
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="cqa_export_{suffix}.json"'},
        )
    if format != "csv":
        raise err(400, "format: допустимо csv или json.")
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    header = [
        "ID диалога", "Группа", "Канал", "Язык", "ID оценки", "Чек-лист", "Версия",
        "Итог", "Финальный итог", "Грубая ошибка", "Модель", "Стоимость, $",
    ]
    for cid in crit_order:
        header += [f"{cid} {crit_names[cid]}: значение", f"{cid}: баллы"]
    w.writerow(header)
    for r in rows:
        line = [
            r["dialog_id"], r["group_id"], r["channel"], r["language"], r["evaluation_id"], r["checklist"],
            r["checklist_version"], _num(r["total"]), _num(r["final_total"]), _num(r["gross"]), r["model"] or "",
            _num(r["cost_usd"]),
        ]
        for cid in crit_order:
            c = r["criteria"].get(cid)
            line += [c["value"] if c else "", _num(c["points"]) if c else ""]
        w.writerow(line)
    data = "﻿" + buf.getvalue()
    return Response(
        data.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="cqa_export_{suffix}.csv"'},
    )


@app.get("/api/calibration")
def calibration_get(group_id: str | None = None):
    reference = calibration.load_reference()
    items = []
    for d, e in latest_done_by_dialog(group_id):
        cl = checklist_cached(e["checklist_id"])
        if not cl:
            continue
        values = {cid: v.get("value") for cid, v in ((e.get("result") or {}).get("criteria") or {}).items()}
        items.append({"dialog_id": d["id"], "checklist": cl["config"], "values": values, "pred_total": e.get("total")})
    return calibration.compare(items, reference)


# --- static frontend (mounted last so /api/* wins) ---

app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True, check_dir=False), name="frontend")
