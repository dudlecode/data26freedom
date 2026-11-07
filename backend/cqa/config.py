from __future__ import annotations

import os
from pathlib import Path

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

ANTHROPIC_API_KEY = os.getenv("CQA_ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_API_KEY") or ""
# Explicit base URL so a globally exported ANTHROPIC_BASE_URL (e.g. from other tools) is not inherited.
ANTHROPIC_BASE_URL = os.getenv("CQA_ANTHROPIC_BASE_URL", "https://api.anthropic.com")

OPENAI_COMPAT_BASE_URL = os.getenv("CQA_OPENAI_BASE_URL", "http://localhost:11434/v1")
OPENAI_COMPAT_API_KEY = os.getenv("CQA_OPENAI_API_KEY", "ollama")

DEFAULT_SETTINGS = {
    "provider": "anthropic",  # anthropic | openai_compat
    "model": os.getenv("CQA_MODEL", "claude-opus-5-5"),
    "effort": os.getenv("CQA_EFFORT", "high"),  # low | medium | high | xhigh | max
    "votes": int(os.getenv("CQA_VOTES", "3")),  # self-consistency runs per dialog
    "concurrency": int(os.getenv("CQA_CONCURRENCY", "4")),  # dialogs evaluated in parallel
    "local_base_url": OPENAI_COMPAT_BASE_URL,
    "local_model": os.getenv("CQA_LOCAL_MODEL", "qwen3-cqa"),
    "local_json_mode": "schema",  # schema | object (DeepSeek API supports only "object")
}

ANTHROPIC_MODELS = [
    {"id": "claude-opus-5-5", "label": "Claude Opus 5.5: максимальная точность"},
    {"id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5: быстрее и дешевле"},
    {"id": "claude-haiku-5-5", "label": "Claude Haiku 5.5: самый дешёвый"},
]

# USD per 1M tokens: input, output, cache read. Cache write (5 min) = 1.25 x input.
PRICES = {
    "claude-opus-5-5": (4.00, 20.00, 0.20),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20),
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
}

# Models that accept the server-side refusal fallback ("default" routing).
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"}


def cost_usd(model: str, usage: dict) -> float | None:
    price = PRICES.get(model)
    if not price:
        return None
    pin, pout, pread = price
    return (
        usage.get("input_tokens", 0) * pin
        + usage.get("cache_creation_input_tokens", 0) * pin * 1.25
        + usage.get("cache_read_input_tokens", 0) * pread
        + usage.get("output_tokens", 0) * pout
    ) / 1_000_000
