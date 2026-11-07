from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

DATA_DIR = Path(os.getenv("CQA_DATA_DIR", ROOT / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.getenv("CQA_DB_PATH", DATA_DIR / "cqa.sqlite3"))
FRONTEND_DIR = ROOT / "frontend"
DEFAULT_CHECKLIST_PATH = Path(__file__).with_name("default_checklist.json")

# Organizers' dataset API: full GET URL; the group_id query parameter is substituted.
SOURCE_URL = os.getenv("CQA_SOURCE_URL", "").strip()

# Модель оценки: любой OpenAI-совместимый endpoint (/chat/completions). Основная модель - Qwen3 30B:
# свой сервер (vLLM, Ollama) или провайдер. Ключ нужен только провайдерам; локальной Ollama - нет.
MODEL_BASE_URL = os.getenv("CQA_MODEL_BASE_URL", "http://localhost:11434/v1").strip()
MODEL_API_KEY = os.getenv("CQA_MODEL_API_KEY", "").strip()
MODEL_TIMEOUT_S = float(os.getenv("CQA_MODEL_TIMEOUT", "900"))


def _num(name: str, default: str = "0") -> float:
    try:
        return float(os.getenv(name, default) or 0)
    except ValueError:
        return 0.0


DEFAULT_SETTINGS = {
    "base_url": MODEL_BASE_URL,
    "model": os.getenv("CQA_MODEL", "qwen3:30b"),
    "json_mode": os.getenv("CQA_JSON_MODE", "schema"),  # schema (строгая JSON Schema) | object
    "votes": int(os.getenv("CQA_VOTES", "3")),  # self-consistency runs per dialog
    "concurrency": int(os.getenv("CQA_CONCURRENCY", "4")),  # dialogs evaluated in parallel
    # USD за 1 млн токенов - для расчёта стоимости оценки (ТЗ: для платной модели указать цену). 0 - бесплатно.
    "price_input_per_mtok": _num("CQA_PRICE_INPUT_PER_MTOK"),
    "price_output_per_mtok": _num("CQA_PRICE_OUTPUT_PER_MTOK"),
}


def normalize_settings(s: dict | None) -> dict:
    """Настройки старого формата (ключ provider, local_*) -> текущие. Модель прежнего облачного провайдера
    не переносится: берётся текущая модель по умолчанию."""
    s = dict(s or {})
    if "provider" not in s:
        return s
    legacy = s.pop("provider")
    local = {"base_url": s.pop("local_base_url", None), "model": s.pop("local_model", None),
             "json_mode": s.pop("local_json_mode", None)}
    s.pop("effort", None)
    if legacy == "openai_compat":
        s.update({k: v for k, v in local.items() if v})
    else:
        s.pop("model", None)
    return s


def is_local(base_url: str | None) -> bool:
    """Модель в нашем контуре: localhost / частная сеть. Иначе - внешний API."""
    host = (urlparse(base_url or "").hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1", "host.docker.internal"} or host.endswith(".local") \
        or host.startswith(("10.", "192.168.")) or any(host.startswith(f"172.{n}.") for n in range(16, 32))


def cost_usd(settings: dict, usage: dict) -> float | None:
    """Стоимость прогона по ценам из настроек. None - цена не задана (например, своя модель)."""
    pin = float(settings.get("price_input_per_mtok") or 0)
    pout = float(settings.get("price_output_per_mtok") or 0)
    if not pin and not pout:
        return None
    return (usage.get("input_tokens", 0) * pin + usage.get("output_tokens", 0) * pout) / 1_000_000
