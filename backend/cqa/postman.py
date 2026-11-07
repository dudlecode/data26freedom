"""Генерация коллекции Postman (v2.1) из маршрутов API.

    cd backend && python -m cqa.postman          -> docs/CQA.postman_collection.json

Запросы сгруппированы по разделам, у POST/PUT есть рабочие примеры тел, переменная {{baseUrl}}
(по умолчанию http://127.0.0.1:8000) и переменные для ID. Тест tests/test_postman.py проверяет,
что каждый эндпоинт API есть в коллекции.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from . import config

OUT = config.ROOT / "docs" / "CQA.postman_collection.json"

# порядок важен: первое совпадение выигрывает (апелляция к оценке - в «Апелляции»)
FOLDERS = [
    ("Вход", lambda p: p.startswith("/api/auth")),
    ("Апелляции", lambda p: "/appeals" in p),
    ("Служебные", lambda p: p.startswith(("/api/health", "/api/settings", "/api/stats", "/api/nav-counts"))),
    ("Данные", lambda p: p.startswith(("/api/datasets", "/api/dialogs"))),
    ("Чек-листы", lambda p: p.startswith("/api/checklists")),
    ("Оценки", lambda p: p.startswith("/api/evaluations")),
    ("Аналитика", lambda p: p.startswith(("/api/overview", "/api/operators", "/api/gross-errors"))),
    ("Аудио", lambda p: p.startswith("/api/audio")),
    ("Экспорт и калибровка", lambda p: p.startswith(("/api/export", "/api/calibration", "/api/results"))),
    ("Интеграции и аудит", lambda p: p.startswith(("/api/integrations", "/api/audit"))),
]
ORDER = ["Вход", "Служебные", "Данные", "Чек-листы", "Оценки", "Апелляции", "Аналитика", "Аудио", "Экспорт и калибровка",
         "Интеграции и аудит"]

TITLES = {
    ("GET", "/api/health"): "Состояние сервиса",
    ("GET", "/api/settings"): "Настройки оценки",
    ("PUT", "/api/settings"): "Изменить настройки",
    ("POST", "/api/auth/login"): "Вход по логину и паролю",
    ("GET", "/api/auth/quick"): "Роли быстрого входа",
    ("POST", "/api/auth/quick"): "Быстрый вход по роли",
    ("GET", "/api/auth/session"): "Текущая сессия",
    ("GET", "/api/auth/me"): "Текущий пользователь",
    ("POST", "/api/auth/logout"): "Выход",
    ("GET", "/api/settings/anthropic-key"): "Статус ключа Claude API",
    ("POST", "/api/settings/anthropic-key"): "Сохранить ключ Claude API",
    ("GET", "/api/stats"): "Сводка по оценкам",
    ("GET", "/api/nav-counts"): "Счётчики для меню",
    ("GET", "/api/overview"): "Обзор: тепловая карта и слабые места",
    ("GET", "/api/operators"): "Операторы",
    ("GET", "/api/operators/{key}"): "Оператор: оценки и динамика",
    ("GET", "/api/gross-errors"): "Грубые ошибки",
    ("POST", "/api/datasets/fetch"): "Загрузить набор из API организаторов",
    ("POST", "/api/dialogs/import"): "Импорт диалогов (JSON или текст)",
    ("GET", "/api/dialogs"): "Список диалогов",
    ("GET", "/api/dialogs/{dialog_id}"): "Диалог: транскрипт, факты, оценки",
    ("GET", "/api/checklists"): "Версии чек-листов",
    ("GET", "/api/checklists/active"): "Активный чек-лист",
    ("GET", "/api/checklists/default"): "Исходный чек-лист",
    ("POST", "/api/checklists/validate"): "Проверить чек-лист",
    ("POST", "/api/checklists"): "Сохранить новую версию чек-листа",
    ("GET", "/api/checklists/{cl_id}"): "Чек-лист по ID",
    ("POST", "/api/checklists/{cl_id}/activate"): "Активировать версию",
    ("POST", "/api/checklists/simulate"): "Пересчёт итогов по новой версии без модели",
    ("GET", "/api/evaluations/estimate"): "Оценка стоимости перед запуском",
    ("GET", "/api/evaluations/{eval_id}/coaching"): "Разбор диалога для оператора",
    ("POST", "/api/appeals/{appeal_id}/preview"): "Предпросмотр итога после решения",
    ("GET", "/api/export/results"): "results.json (формат JSON 1.0)",
    ("GET", "/api/export/results/check"): "Проверка results.json перед сдачей",
    ("POST", "/api/evaluations"): "Запустить оценку",
    ("GET", "/api/evaluations"): "Статус оценок",
    ("GET", "/api/evaluations/{eval_id}"): "Оценка целиком",
    ("POST", "/api/evaluations/{eval_id}/rerun"): "Повторить оценку",
    ("POST", "/api/evaluations/{eval_id}/appeals"): "Подать апелляцию",
    ("GET", "/api/appeals"): "Список апелляций",
    ("GET", "/api/appeals/{appeal_id}"): "Апелляция с фрагментом диалога",
    ("POST", "/api/appeals/{appeal_id}/ai-review"): "Второе мнение ИИ",
    ("POST", "/api/appeals/{appeal_id}/decide"): "Решение проверяющего",
    ("GET", "/api/audio/{dialog_id}"): "Запись звонка (редирект на mp3)",
    ("GET", "/api/audio/{dialog_id}/info"): "Ссылки на запись звонка",
    ("GET", "/api/export"): "Экспорт CSV / JSON",
    ("GET", "/api/calibration"): "Калибровка с контрольной разметкой",
    ("GET", "/api/audit"): "Журнал действий",
    ("GET", "/api/integrations"): "Статус интеграций",
    ("GET", "/api/integrations/deliveries"): "Журнал доставок вебхуков",
    ("POST", "/api/integrations/webhook/test"): "Тестовое событие вебхука",
}

BODIES: dict[tuple[str, str], Any] = {
    ("POST", "/api/auth/login"): {"username": "supervisor", "password": "{{password}}"},
    ("POST", "/api/auth/quick"): {"username": "supervisor"},
    ("PUT", "/api/settings"): {"votes": 3},
    ("POST", "/api/settings/anthropic-key"): {"key": "{{anthropicApiKey}}"},
    ("POST", "/api/datasets/fetch"): {"group_id": "DEV"},
    ("POST", "/api/dialogs/import"): {
        "group_id": "UPLOAD",
        "payload": {"text": "[00:01] Клиент: Здравствуйте, как пополнить счёт?\n[00:20] Оператор: Здравствуйте! Меня зовут Айгерим. Пополнить можно в приложении: Счёт -> Пополнить.\n[00:40] Клиент: Спасибо!\n[00:45] Оператор: Пожалуйста! Остались ли вопросы? Хорошего дня!", "conversation_id": "postman-001", "language": "RU"},
    },
    ("POST", "/api/checklists/validate"): {"config": {"name": "Пример", "criteria": []}},
    ("POST", "/api/checklists"): {"config": "<<вставьте config из GET /api/checklists/active и измените критерий>>", "note": "замена критерия", "activate": True},
    ("POST", "/api/evaluations"): {"dialog_ids": ["{{dialogId}}"], "settings": {"votes": 1}},
    ("POST", "/api/evaluations/{eval_id}/appeals"): {"criterion_id": "c05", "comment": "Оператор отреагировал на недовольство клиента"},
    ("POST", "/api/appeals/{appeal_id}/decide"): {"action": "change", "value": "YES", "reason": "Эмпатия была в T7"},
    ("POST", "/api/integrations/webhook/test"): {},
}

QUERY: dict[tuple[str, str], list[tuple[str, str]]] = {
    ("GET", "/api/dialogs"): [("group_id", "DEV"), ("language", ""), ("channel", ""), ("q", "")],
    ("GET", "/api/stats"): [("group_id", "DEV")],
    ("GET", "/api/evaluations"): [("ids", "{{evaluationId}}")],
    ("GET", "/api/appeals"): [("status", "open")],
    ("GET", "/api/export"): [("group_id", "DEV"), ("format", "csv")],
    ("GET", "/api/export/results"): [("group_id", "DEV")],
    ("GET", "/api/export/results/check"): [("group_id", "DEV")],
    ("GET", "/api/operators/{key}"): [],
    ("GET", "/api/calibration"): [("group_id", "DEV")],
    ("GET", "/api/audit"): [("entity", "appeal"), ("entity_id", ""), ("limit", "50")],
    ("GET", "/api/integrations/deliveries"): [("limit", "20")],
}

PATH_VARS = {"dialog_id": "dialogId", "cl_id": "checklistId", "eval_id": "evaluationId", "appeal_id": "appealId",
             "key": "operatorKey"}
VARIABLES = [
    ("baseUrl", "http://127.0.0.1:8000"), ("dialogId", "p1-ru-001"), ("checklistId", "1"),
    ("evaluationId", "1"), ("appealId", "1"), ("operatorKey", ""), ("password", ""), ("anthropicApiKey", ""),
]


def api_routes(app) -> list[tuple[str, str]]:
    out = []
    for r in app.routes:
        path = getattr(r, "path", "")
        if not path.startswith("/api/"):
            continue
        for m in sorted(getattr(r, "methods", None) or []):
            if m in ("HEAD", "OPTIONS"):
                continue
            out.append((m, path))
    return out


def folder_of(path: str) -> str:
    return next((name for name, match in FOLDERS if match(path)), "Прочее")


def item(method: str, path: str) -> dict[str, Any]:
    pm_path = re.sub(r"\{(\w+)\}", lambda m: "{{" + PATH_VARS.get(m.group(1), m.group(1)) + "}}", path)
    q = QUERY.get((method, path), [])
    raw = "{{baseUrl}}" + pm_path + ("?" + "&".join(f"{k}={v}" for k, v in q) if q else "")
    req: dict[str, Any] = {
        "method": method,
        "header": [{"key": "Accept", "value": "application/json"}],
        "url": {
            "raw": raw,
            "host": ["{{baseUrl}}"],
            "path": [p for p in pm_path.split("/") if p],
            **({"query": [{"key": k, "value": v, "disabled": v == ""} for k, v in q]} if q else {}),
        },
    }
    if method in ("POST", "PUT"):
        req["header"].append({"key": "Content-Type", "value": "application/json"})
        req["body"] = {"mode": "raw", "raw": json.dumps(BODIES.get((method, path), {}), ensure_ascii=False, indent=2),
                       "options": {"raw": {"language": "json"}}}
    return {"name": TITLES.get((method, path), f"{method} {path}"), "request": req}


def build(app) -> dict[str, Any]:
    folders: dict[str, list] = {name: [] for name in [*ORDER, "Прочее"]}
    for method, path in api_routes(app):
        folders[folder_of(path)].append(item(method, path))
    return {
        "info": {
            "name": "CQA - Conversation Quality Analytics",
            "description": "REST API сервиса оценки качества диалогов. Swagger UI: {{baseUrl}}/docs. Контракт: docs/API.md. Сначала выполните «Вход»: сессия хранится в cookie. "
                           "Сгенерировано: python -m cqa.postman",
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "variable": [{"key": k, "value": v} for k, v in VARIABLES],
        "item": [{"name": n, "item": items} for n, items in folders.items() if items],
    }


def main() -> None:
    from .app import app

    data = build(app)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:  # LF на любой ОС: CI сравнивает с закоммиченным
        f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    n = sum(len(f["item"]) for f in data["item"])
    print(f"{OUT}: {n} запросов")


if __name__ == "__main__":
    main()
