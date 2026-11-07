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
    ("Апелляции", lambda p: "/appeals" in p),
    ("Служебные", lambda p: p.startswith(("/api/health", "/api/settings", "/api/stats"))),
    ("Данные", lambda p: p.startswith(("/api/datasets", "/api/dialogs"))),
    ("Чек-листы", lambda p: p.startswith("/api/checklists")),
    ("Оценки", lambda p: p.startswith("/api/evaluations")),
    ("Аудио", lambda p: p.startswith("/api/audio")),
    ("Экспорт и калибровка", lambda p: p.startswith(("/api/export", "/api/calibration", "/api/results"))),
    ("Интеграции и аудит", lambda p: p.startswith(("/api/integrations", "/api/audit"))),
]
ORDER = ["Служебные", "Данные", "Чек-листы", "Оценки", "Апелляции", "Аудио", "Экспорт и калибровка", "Интеграции и аудит"]

TITLES = {
    ("GET", "/api/health"): "Состояние сервиса",
    ("GET", "/api/settings"): "Настройки оценки",
    ("PUT", "/api/settings"): "Изменить настройки",
    ("GET", "/api/settings/model-key"): "Статус ключа API сервера модели",
    ("POST", "/api/settings/model-key"): "Сохранить ключ API сервера модели",
    ("GET", "/api/stats"): "Сводка по оценкам",
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
    ("GET", "/api/export"): "Экспорт CSV / JSON / results.json",
    ("GET", "/api/results"): "results.json для сдачи + проверка формата",
    ("GET", "/api/calibration"): "Калибровка с контрольной разметкой",
    ("GET", "/api/audit"): "Журнал действий",
    ("GET", "/api/integrations"): "Статус интеграций",
    ("GET", "/api/integrations/deliveries"): "Журнал доставок вебхуков",
    ("POST", "/api/integrations/webhook/test"): "Тестовое событие вебхука",
}

BODIES: dict[tuple[str, str], Any] = {
    ("PUT", "/api/settings"): {"base_url": "http://localhost:11434/v1", "model": "qwen3:30b", "votes": 3},
    ("POST", "/api/settings/model-key"): {"key": "{{modelApiKey}}"},
    ("POST", "/api/datasets/fetch"): {"group_id": "DEV"},
    ("POST", "/api/dialogs/import"): {
        "group_id": "UPLOAD",
        "payload": {"text": "[00:01] Клиент: Здравствуйте, как пополнить счёт?\n[00:20] Оператор: Здравствуйте! Меня зовут Айгерим. Пополнить можно в приложении: Счёт -> Пополнить.\n[00:40] Клиент: Спасибо!\n[00:45] Оператор: Пожалуйста! Остались ли вопросы? Хорошего дня!", "conversation_id": "postman-001", "language": "RU"},
    },
    ("POST", "/api/checklists/validate"): {"config": {"name": "Пример", "criteria": []}},
    ("POST", "/api/checklists"): {"config": "<<вставьте config из GET /api/checklists/active и измените критерий>>", "note": "замена критерия", "activate": True},
    ("POST", "/api/evaluations"): {"dialog_ids": ["{{dialogId}}"], "settings": {"votes": 1}},
    ("POST", "/api/evaluations/{eval_id}/appeals"): {"criterion_id": "c05", "comment": "Оператор отреагировал на недовольство клиента", "author": "Супервайзер"},
    ("POST", "/api/appeals/{appeal_id}/decide"): {"action": "change", "value": "YES", "reason": "Эмпатия была в T7", "reviewer": "Проверяющий"},
    ("POST", "/api/integrations/webhook/test"): {},
}

QUERY: dict[tuple[str, str], list[tuple[str, str]]] = {
    ("GET", "/api/dialogs"): [("group_id", "DEV"), ("language", ""), ("channel", ""), ("q", "")],
    ("GET", "/api/stats"): [("group_id", "DEV")],
    ("GET", "/api/evaluations"): [("ids", "{{evaluationId}}")],
    ("GET", "/api/appeals"): [("status", "open")],
    ("GET", "/api/export"): [("group_id", "DEV"), ("format", "csv")],
    ("GET", "/api/results"): [("group_id", "DEV"), ("expect", ""), ("final", "false")],
    ("GET", "/api/calibration"): [("group_id", "DEV")],
    ("GET", "/api/audit"): [("entity", "appeal"), ("entity_id", ""), ("limit", "50")],
    ("GET", "/api/integrations/deliveries"): [("limit", "20")],
}

PATH_VARS = {"dialog_id": "dialogId", "cl_id": "checklistId", "eval_id": "evaluationId", "appeal_id": "appealId"}
VARIABLES = [
    ("baseUrl", "http://127.0.0.1:8000"), ("dialogId", "p1-ru-001"), ("checklistId", "1"),
    ("evaluationId", "1"), ("appealId", "1"), ("modelApiKey", ""),
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
        "header": [{"key": "Accept", "value": "application/json"}, {"key": "X-CQA-Role", "value": "supervisor"}],
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
            "description": "REST API сервиса оценки качества диалогов. Swagger UI: {{baseUrl}}/docs. Контракт: docs/API.md. "
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
