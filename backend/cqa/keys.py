"""Ключ API сервера модели, введённый в интерфейсе (нужен провайдерам; своей Ollama / vLLM - нет).

Проверка - GET {base_url}/models без затрат токенов, затем запись CQA_MODEL_API_KEY в .env (chmod 600 там,
где он поддерживается) и обновление конфигурации в памяти. Ключ не логируется и не возвращается в браузер.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import httpx

from . import config

ENV_PATH: Path = config.ROOT / ".env"
ENV_NAME = "CQA_MODEL_API_KEY"


class KeyError_(ValueError):
    """Key rejected (message is user-facing, in Russian)."""


def mask(key: str) -> str:
    key = (key or "").strip()
    if not key:
        return ""
    return f"{key[:4]}…{key[-4:]}" if len(key) >= 12 else f"…{key[-2:]}"


def status() -> dict:
    key = config.MODEL_API_KEY or ""
    return {"configured": bool(key), "masked": mask(key) if key else ""}


async def verify(key: str, base_url: str | None = None) -> None:
    url = (base_url or config.MODEL_BASE_URL).rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(url, headers={"Authorization": f"Bearer {key}"})
    except httpx.HTTPError as e:
        raise KeyError_(f"Нет соединения с сервером модели ({url}) - ключ не удалось проверить.") from e
    if r.status_code in (401, 403):
        raise KeyError_(f"Сервер модели не принял ключ ({r.status_code}): проверьте, что он скопирован полностью и не отозван.")
    if r.status_code >= 400 and r.status_code != 404:  # 404: endpoint без /models - ключ проверим при оценке
        raise KeyError_(f"Сервер модели вернул ошибку {r.status_code} при проверке ключа.")


def write_env(key: str, path: Path | None = None) -> None:
    path = path or ENV_PATH
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    rx = re.compile(rf"^\s*(?:export\s+)?{ENV_NAME}\s*=")
    out, done = [], False
    for line in lines:
        if rx.match(line):
            if not done:
                out.append(f"{ENV_NAME}={key}")
                done = True
            continue
        out.append(line)
    if not done:
        out.append(f"{ENV_NAME}={key}")
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


async def save(key: str, base_url: str | None = None) -> dict:
    key = (key or "").strip()
    if not key:
        raise KeyError_("Введите ключ API сервера модели.")
    if any(ch.isspace() for ch in key) or len(key) < 8:
        raise KeyError_("Похоже, это не ключ API: ключ - одна строка без пробелов.")
    await verify(key, base_url)
    write_env(key)
    config.MODEL_API_KEY = key
    os.environ[ENV_NAME] = key
    return status()
