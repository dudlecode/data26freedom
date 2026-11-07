"""Модель оценки - любой OpenAI-совместимый endpoint (POST {base_url}/chat/completions).

Основная модель - Qwen3 30B: на своём сервере (vLLM, Ollama, LM Studio - модель остаётся в контуре компании)
или у провайдера с OpenAI-совместимым API. Ответ - строго JSON по схеме, сгенерированной из чек-листа
(response_format json_schema; для endpoint без поддержки схем - json_object + схема в промпте).
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from . import config


class ProviderError(RuntimeError):
    pass


@dataclass
class RunResult:
    data: dict[str, Any]
    model: str
    usage: dict[str, int] = field(default_factory=dict)
    duration_ms: int = 0
    cost_usd: float | None = None
    provider: str = ""


def _extract_json(text: str) -> dict[str, Any]:
    # Qwen3 в режиме рассуждений может вернуть <think>...</think> перед ответом
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise ProviderError("Модель вернула не JSON: " + text[:300])


class OpenAICompatProvider:
    name = "openai_compat"

    def __init__(self, base_url: str, model: str, api_key: str = "", json_mode: str = "schema",
                 settings: dict[str, Any] | None = None, timeout_s: float | None = None):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.json_mode = json_mode
        self.settings = settings or {}
        self.timeout_s = timeout_s or config.MODEL_TIMEOUT_S

    async def complete_json(self, system: str, user: str, schema: dict[str, Any]) -> RunResult:
        sys_text = (
            system
            + "\n\nJSON-схема ответа (верните только JSON-объект без пояснений):\n"
            + json.dumps(schema, ensure_ascii=False)
        )
        if self.json_mode == "schema":
            response_format: dict[str, Any] = {
                "type": "json_schema",
                "json_schema": {"name": "evaluation", "schema": schema, "strict": True},
            }
        else:
            response_format = {"type": "json_object"}
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": sys_text}, {"role": "user", "content": user}],
            "temperature": 0.2,
            "response_format": response_format,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                r = await client.post(f"{self.base_url}/chat/completions", json=body, headers=headers)
        except httpx.TimeoutException as e:
            raise ProviderError(
                f"Модель {self.model} не ответила за {int(self.timeout_s)} с ({self.base_url}). "
                "Сервер модели перегружен или слишком медленный: уменьшите параллельность или увеличьте CQA_MODEL_TIMEOUT."
            ) from e
        except httpx.HTTPError as e:
            raise ProviderError(f"Нет соединения с сервером модели {self.base_url}: {type(e).__name__} {e}".strip()) from e
        if r.status_code in (401, 403):
            raise ProviderError(f"Сервер модели {self.base_url} не принял ключ API ({r.status_code}). Проверьте ключ в настройках.")
        if r.status_code == 404:
            raise ProviderError(f"Модель {self.model} не найдена на {self.base_url} (404): {r.text[:200]}")
        if r.status_code == 429:
            raise ProviderError("Превышен лимит запросов к модели (429). Уменьшите параллельность.")
        if r.status_code >= 400:
            raise ProviderError(f"{self.base_url} вернул {r.status_code}: {r.text[:300]}")
        payload = r.json()
        try:
            choice = payload["choices"][0]
            text = choice["message"]["content"] or ""
        except (KeyError, IndexError) as e:
            raise ProviderError(f"Неожиданный ответ сервера модели: {str(payload)[:300]}") from e
        if choice.get("finish_reason") == "length":
            raise ProviderError("Ответ модели обрезан по длине: увеличьте окно контекста или лимит ответа на сервере модели.")
        u = payload.get("usage") or {}
        usage = {"input_tokens": u.get("prompt_tokens", 0) or 0, "output_tokens": u.get("completion_tokens", 0) or 0}
        return RunResult(
            data=_extract_json(text),
            model=payload.get("model") or self.model,
            usage=usage,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            cost_usd=config.cost_usd(self.settings, usage),
            provider=self.name,
        )


def make_provider(settings: dict[str, Any]) -> OpenAICompatProvider:
    settings = {**config.DEFAULT_SETTINGS, **config.normalize_settings(settings)}
    return OpenAICompatProvider(
        base_url=settings.get("base_url") or config.MODEL_BASE_URL,
        model=settings.get("model") or config.DEFAULT_SETTINGS["model"],
        api_key=config.MODEL_API_KEY,
        json_mode=settings.get("json_mode", "schema"),
        settings=settings,
    )
