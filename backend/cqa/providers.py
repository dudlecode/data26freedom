"""LLM providers.

* AnthropicProvider — Claude via the official Anthropic SDK, structured JSON output,
  adaptive thinking, prompt caching (checklist prompt shared across dialogs, dialog shared
  across self-consistency votes) and server-side refusal fallback.
* OpenAICompatProvider — any OpenAI-compatible endpoint: local Ollama / LM Studio / vLLM
  (models stay inside the company perimeter) or a hosted API such as DeepSeek.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import anthropic
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
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise ProviderError("Модель вернула не JSON: " + text[:300])


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, model: str, effort: str = "high"):
        if not config.ANTHROPIC_API_KEY:
            raise ProviderError(
                "Не задан ключ Claude API: добавьте CQA_ANTHROPIC_API_KEY в файл .env и перезапустите сервер."
            )
        self.model = model
        self.effort = effort
        self.use_fallbacks = model in config.FALLBACK_MODELS
        self.client = anthropic.AsyncAnthropic(
            api_key=config.ANTHROPIC_API_KEY,
            base_url=config.ANTHROPIC_BASE_URL,
            max_retries=4,
            timeout=600.0,
        )

    async def complete_json(self, system: str, user: str, schema: dict[str, Any]) -> RunResult:
        kwargs: dict[str, Any] = dict(
            model=self.model,
            max_tokens=16000,
            thinking={"type": "adaptive"},
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
            # Two cache breakpoints: checklist prompt (shared by all dialogs) and the dialog
            # itself (shared by the self-consistency votes of this dialog).
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[
                {
                    "role": "user",
                    "content": [{"type": "text", "text": user, "cache_control": {"type": "ephemeral"}}],
                }
            ],
        )
        t0 = time.perf_counter()
        try:
            resp = await self._create(kwargs)
        except anthropic.AuthenticationError as e:
            raise ProviderError("Ключ Claude API не принят (401). Проверьте CQA_ANTHROPIC_API_KEY.") from e
        except anthropic.PermissionDeniedError as e:
            raise ProviderError(f"Нет доступа к модели {self.model}: {e.message}") from e
        except anthropic.NotFoundError as e:
            raise ProviderError(f"Модель {self.model} не найдена: {e.message}") from e
        except anthropic.RateLimitError as e:
            raise ProviderError("Превышен лимит запросов Claude API (429). Уменьшите параллельность.") from e
        except anthropic.APIStatusError as e:
            raise ProviderError(f"Ошибка Claude API {e.status_code}: {e.message}") from e
        except anthropic.APIConnectionError as e:
            raise ProviderError("Нет соединения с Claude API.") from e
        duration = int((time.perf_counter() - t0) * 1000)

        if resp.stop_reason == "refusal":
            raise ProviderError("Модель отказалась отвечать (refusal).")
        if resp.stop_reason == "max_tokens":
            raise ProviderError("Ответ модели обрезан по max_tokens.")
        text = next((b.text for b in resp.content if getattr(b, "type", "") == "text"), "")
        data = _extract_json(text)
        u = resp.usage
        usage = {
            "input_tokens": u.input_tokens or 0,
            "output_tokens": u.output_tokens or 0,
            "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
            "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
        }
        served_by = getattr(resp, "model", self.model) or self.model
        return RunResult(
            data=data,
            model=served_by,
            usage=usage,
            duration_ms=duration,
            cost_usd=config.cost_usd(served_by, usage) or config.cost_usd(self.model, usage),
            provider=self.name,
        )

    async def _create(self, kwargs: dict[str, Any]):
        if self.use_fallbacks:
            try:
                return await self.client.beta.messages.create(
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
                )
            except anthropic.BadRequestError as e:
                if "fallback" not in str(e.message).lower():
                    raise
                self.use_fallbacks = False  # endpoint/account without fallbacks -> plain request
        return await self.client.beta.messages.create(**kwargs)


_ID_TOKENS: dict[str, tuple[str, float]] = {}
_METADATA_IDENTITY = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"


async def gcp_id_token(audience: str) -> str:
    """Google-signed ID token from the VM metadata server, for a private Cloud Run service."""
    tok, exp = _ID_TOKENS.get(audience, ("", 0.0))
    if tok and exp > time.time() + 60:
        return tok
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(_METADATA_IDENTITY, params={"audience": audience, "format": "full"},
                                 headers={"Metadata-Flavor": "Google"})
            r.raise_for_status()
    except httpx.HTTPError as e:
        raise ProviderError(f"Не удалось получить токен Google Cloud для {audience}: {e}") from e
    tok = r.text.strip()
    _ID_TOKENS[audience] = (tok, time.time() + 50 * 60)
    return tok


def _needs_gcp_auth(base_url: str) -> bool:
    mode = os.getenv("CQA_OPENAI_AUTH", "auto").lower()
    if mode == "gcp":
        return True
    return mode == "auto" and ".run.app" in base_url


class OpenAICompatProvider:
    name = "openai_compat"

    def __init__(self, base_url: str, model: str, api_key: str = "", json_mode: str = "schema"):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key or config.OPENAI_COMPAT_API_KEY
        self.json_mode = json_mode

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
        t0 = time.perf_counter()
        token = self.api_key
        if _needs_gcp_auth(self.base_url):
            parts = httpx.URL(self.base_url)
            token = await gcp_id_token(f"{parts.scheme}://{parts.host}")
        try:
            # Long timeout: a scaled-to-zero GPU service loads the model on the first request.
            async with httpx.AsyncClient(timeout=1200.0) as client:
                r = await client.post(
                    f"{self.base_url}/chat/completions",
                    json=body,
                    headers={"Authorization": f"Bearer {token}"},
                )
        except httpx.HTTPError as e:
            raise ProviderError(f"Нет соединения с {self.base_url}: {e}") from e
        if r.status_code >= 400:
            raise ProviderError(f"{self.base_url} вернул {r.status_code}: {r.text[:300]}")
        payload = r.json()
        try:
            text = payload["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as e:
            raise ProviderError(f"Неожиданный ответ: {str(payload)[:300]}") from e
        u = payload.get("usage") or {}
        return RunResult(
            data=_extract_json(text),
            model=payload.get("model", self.model),
            usage={"input_tokens": u.get("prompt_tokens", 0), "output_tokens": u.get("completion_tokens", 0)},
            duration_ms=int((time.perf_counter() - t0) * 1000),
            cost_usd=None,
            provider=self.name,
        )


def make_provider(settings: dict[str, Any]):
    if settings.get("provider") == "openai_compat":
        return OpenAICompatProvider(
            base_url=settings.get("local_base_url") or config.OPENAI_COMPAT_BASE_URL,
            model=settings.get("local_model") or "qwen3-cqa",
            json_mode=settings.get("local_json_mode", "schema"),
        )
    return AnthropicProvider(model=settings.get("model", "claude-opus-5-5"), effort=settings.get("effort", "high"))
