"""Интеграции с корпоративным контуром: журнал аудита и исходящие вебхуки.

Журнал аудита (таблица audit_log) фиксирует, кто, когда и что изменил: апелляции и решения по ним,
версии чек-листов, запуск оценок, загрузку данных, настройки. Его видно в интерфейсе (Настройки ->
Журнал действий) и через GET /api/audit.

Вебхуки - события CQA уходят POST-запросом в JSON на адреса из CQA_WEBHOOK_URLS (через запятую).
Типичный приёмник - поток Power Automate с триггером «When an HTTP request is received», дальше
запись в Dataverse / Dynamics 365, письмо руководителю, задача в Teams. Если задан CQA_WEBHOOK_SECRET,
тело подписывается HMAC-SHA256 (заголовок X-CQA-Signature: sha256=<hex>). Каждая доставка пишется в
webhook_deliveries с кодом ответа и ошибкой, до 3 попыток с паузой. Отправка идёт в фоне и никогда
не ломает основной запрос.

Формат события (стабильный контракт, см. dynamics/webhook-schema.json):
    {"id": "<uuid>", "event": "evaluation.completed", "occurred_at": "<ISO 8601 UTC>",
     "source": "cqa", "version": 1, "url": "<ссылка на карточку в CQA или null>", "data": {...}}
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import uuid
from typing import Any

import httpx

from . import db

log = logging.getLogger("cqa.integrations")

EVENTS = {
    "evaluation.completed": "Оценка диалога завершена",
    "evaluation.failed": "Оценка диалога завершилась ошибкой",
    "appeal.created": "Подана апелляция",
    "appeal.decided": "Принято решение по апелляции",
    "checklist.created": "Сохранена новая версия чек-листа",
    "checklist.activated": "Активирован чек-лист",
    "webhook.test": "Тестовое событие",
}
RETRIES = 3
TIMEOUT_S = 10.0

_tasks: set[Any] = set()
_main_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Главный цикл сервера: синхронные эндпоинты (пул потоков) отправляют вебхуки через него, не блокируясь."""
    global _main_loop
    _main_loop = loop


def webhook_urls() -> list[str]:
    raw = os.getenv("CQA_WEBHOOK_URLS", "") or os.getenv("CQA_WEBHOOK_URL", "")
    return [u.strip() for u in raw.split(",") if u.strip()]


def public_url() -> str:
    """Адрес CQA для ссылок в событиях (например, https://cqa.company.kz). Пусто - ссылки не строятся."""
    return os.getenv("CQA_PUBLIC_URL", "").strip().rstrip("/")


def card_url(path: str) -> str | None:
    base = public_url()
    return f"{base}/#{path}" if base else None


# --- audit ------------------------------------------------------------------------------

def audit(event: str, entity: str, entity_id: Any, summary: str, actor: str = "", data: dict[str, Any] | None = None) -> int:
    try:
        return db.insert(
            "audit_log",
            {
                "at": db.now(),
                "event": event,
                "entity": entity,
                "entity_id": None if entity_id is None else str(entity_id),
                "actor": (actor or "").strip() or None,
                "summary": summary,
                "data": data or {},
            },
        )
    except Exception:  # noqa: BLE001 - аудит не должен ронять основную операцию
        log.exception("audit write failed: %s", event)
        return 0


def audit_list(entity: str | None = None, entity_id: str | None = None, event: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    sql, params = "SELECT * FROM audit_log WHERE 1=1", []
    if entity:
        sql += " AND entity = ?"
        params.append(entity)
    if entity_id:
        sql += " AND entity_id = ?"
        params.append(str(entity_id))
    if event:
        sql += " AND event = ?"
        params.append(event)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(max(1, min(int(limit), 1000)))
    return db.query(sql, params)


# --- webhooks ---------------------------------------------------------------------------

def make_event(event: str, data: dict[str, Any], url: str | None = None) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "event": event,
        "occurred_at": db.now(),
        "source": "cqa",
        "version": 1,
        "url": url,
        "data": data,
    }


def sign(body: bytes) -> str | None:
    secret = os.getenv("CQA_WEBHOOK_SECRET", "")
    if not secret:
        return None
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _deliver(delivery_id: int, url: str, ev: dict[str, Any]) -> None:
    body = json.dumps(ev, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8", "X-CQA-Event": ev["event"], "X-CQA-Delivery": ev["id"]}
    sig = sign(body)
    if sig:
        headers["X-CQA-Signature"] = sig
    last_err, code = None, None
    for attempt in range(1, RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
                r = await client.post(url, content=body, headers=headers)
            code = r.status_code
            if 200 <= r.status_code < 300:
                db.update("webhook_deliveries", delivery_id,
                          {"status": "ok", "http_status": code, "error": None, "attempts": attempt, "delivered_at": db.now()})
                return
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as ex:  # noqa: BLE001
            last_err = f"{type(ex).__name__}: {ex}"
        db.update("webhook_deliveries", delivery_id, {"status": "pending", "http_status": code, "error": last_err, "attempts": attempt})
        if attempt < RETRIES:
            await asyncio.sleep(2 ** attempt)
    db.update("webhook_deliveries", delivery_id, {"status": "error", "error": last_err})


def emit(event: str, data: dict[str, Any], url: str | None = None, urls: list[str] | None = None) -> dict[str, Any]:
    """Поставить событие в отправку на все адреса. Без адресов - ничего не делает. Возвращает событие."""
    ev = make_event(event, data, url)
    targets = webhook_urls() if urls is None else urls
    if not targets:
        return ev
    try:
        _queue(ev, targets)
    except Exception:  # noqa: BLE001 - интеграции не ломают основную операцию
        log.exception("webhook enqueue failed: %s", event)
    return ev


def _queue(ev: dict[str, Any], targets: list[str]) -> None:
    event = ev["event"]
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    for target in targets:
        did = db.insert(
            "webhook_deliveries",
            {"event_id": ev["id"], "event": event, "url": target, "status": "pending", "attempts": 0,
             "payload": ev, "created_at": db.now()},
        )
        if loop is not None:
            task: Any = loop.create_task(_deliver(did, target, ev))
        elif _main_loop is not None and _main_loop.is_running():
            task = asyncio.run_coroutine_threadsafe(_deliver(did, target, ev), _main_loop)
        else:  # CLI или скрипт без сервера - отправляем сразу
            asyncio.run(_deliver(did, target, ev))
            continue
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)


async def wait_idle() -> None:
    while _tasks:
        await asyncio.gather(*[asyncio.wrap_future(t) if not isinstance(t, asyncio.Future) else t for t in list(_tasks)],
                             return_exceptions=True)


def deliveries(limit: int = 50) -> list[dict[str, Any]]:
    rows = db.query("SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT ?", [max(1, min(int(limit), 500))])
    for r in rows:
        r["url"] = mask_url(r["url"])
    return rows


def mask_url(url: str) -> str:
    """Не показываем в интерфейсе подписи и токены из query (у Power Automate это sig=...)."""
    base, _, query = url.partition("?")
    if not query:
        return url
    parts = []
    for p in query.split("&"):
        k, _, v = p.partition("=")
        parts.append(f"{k}=***" if k.lower() in {"sig", "signature", "token", "key", "code", "secret"} else p)
    return base + "?" + "&".join(parts)


def status() -> dict[str, Any]:
    urls = webhook_urls()
    last = db.one("SELECT status, http_status, error, delivered_at, created_at, event FROM webhook_deliveries ORDER BY id DESC LIMIT 1")
    return {
        "webhooks": {
            "configured": bool(urls),
            "urls": [mask_url(u) for u in urls],
            "signed": bool(os.getenv("CQA_WEBHOOK_SECRET")),
            "events": EVENTS,
            "last": last,
        },
        "public_url": public_url() or None,
        "cors_origins": [o.strip() for o in os.getenv("CQA_CORS_ORIGINS", "").split(",") if o.strip()],
        "openapi": "/openapi.json",
        "swagger": "/docs",
        "postman": "docs/CQA.postman_collection.json",
    }


# --- event payloads ---------------------------------------------------------------------

def evaluation_payload(e: dict[str, Any], dialog: dict[str, Any] | None, checklist: dict[str, Any] | None) -> dict[str, Any]:
    cfg = (checklist or {}).get("config") or {}
    names = {c["id"]: c.get("name", c["id"]) for c in cfg.get("criteria", [])}
    final = e.get("final") or {}
    score = final.get("score") or {}
    res = e.get("result") or {}
    criteria = []
    for cid, sc in (score.get("criteria") or {}).items():
        rc = (res.get("criteria") or {}).get(cid) or {}
        criteria.append({
            "id": cid,
            "name": names.get(cid, cid),
            "value": (final.get("values") or {}).get(cid),
            "points": sc.get("points"),
            "weight": sc.get("weight"),
            "agreement": rc.get("agreement"),
            "reasoning": rc.get("reasoning"),
        })
    return {
        "evaluation_id": e["id"],
        "conversation_id": e["dialog_id"],
        "group_id": (dialog or {}).get("group_id"),
        "channel": (dialog or {}).get("channel"),
        "language": (dialog or {}).get("language"),
        "checklist": {"id": (checklist or {}).get("id"), "name": (checklist or {}).get("name"), "version": (checklist or {}).get("version")},
        "status": e.get("status"),
        "total": e.get("total"),
        "final_total": e.get("final_total"),
        "gross_error": bool(e.get("gross")),
        "gross_criteria": score.get("gross_criteria") or [],
        "needs_review": [c["id"] for c in criteria if c["agreement"] is not None and c["agreement"] < 1],
        "criteria": criteria,
        "error": e.get("error"),
        "cost_usd": e.get("cost_usd"),
        "duration_ms": e.get("duration_ms"),
    }
