"""Claude API key entered from the UI: verify (models.list, no token cost), persist to .env
(chmod 600) and update the in-memory config. The key is never logged or returned."""

from __future__ import annotations

import os
import re
from pathlib import Path

import anthropic

from . import config

ENV_PATH: Path = config.ROOT / ".env"
ENV_NAME = "CQA_ANTHROPIC_API_KEY"


class KeyError_(ValueError):
    """Key rejected (message is user-facing, in Russian)."""


def mask(key: str) -> str:
    key = (key or "").strip()
    if not key:
        return ""
    prefix = "sk-ant-" if key.startswith("sk-ant-") else key[:3]
    return f"{prefix}…{key[-4:]}"


def status() -> dict:
    key = config.ANTHROPIC_API_KEY or ""
    return {"configured": bool(key), "masked": mask(key) if key else ""}


async def verify(key: str) -> None:
    client = anthropic.AsyncAnthropic(api_key=key, base_url=config.ANTHROPIC_BASE_URL, max_retries=1, timeout=30.0)
    try:
        await client.models.list(limit=1)
    except anthropic.AuthenticationError as e:
        raise KeyError_("Ключ не принят Claude API (401): проверьте, что он скопирован полностью и не отозван.") from e
    except anthropic.PermissionDeniedError as e:
        raise KeyError_("Ключ принят, но у него нет доступа к API (403).") from e
    except anthropic.APIStatusError as e:
        raise KeyError_(f"Claude API вернул ошибку {e.status_code} при проверке ключа.") from e
    except anthropic.APIConnectionError as e:
        raise KeyError_("Нет соединения с Claude API, ключ не удалось проверить.") from e
    finally:
        await client.close()


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


async def save(key: str) -> dict:
    key = (key or "").strip()
    if not key:
        raise KeyError_("Введите ключ Claude API.")
    if any(ch.isspace() for ch in key) or len(key) < 20:
        raise KeyError_("Похоже, это не ключ Claude API: ключ это одна строка без пробелов, обычно начинается с sk-ant-.")
    await verify(key)
    write_env(key)
    config.ANTHROPIC_API_KEY = key
    os.environ[ENV_NAME] = key
    return status()
