"""Dialog sources: the organizers' dataset API and manual import (JSON or free text)."""

from __future__ import annotations

import hashlib
import re
from typing import Any
from urllib.parse import quote

import httpx

from . import config


class SourceError(ValueError):
    """User-facing problem with a data source (message is in Russian)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --- organizers' API --------------------------------------------------------------------

def build_source_url(base_url: str, group_id: str) -> str:
    """Substitute the group_id query parameter, keeping the rest of the URL byte-for-byte
    (signed URLs break if other parameters are re-encoded)."""
    base_url = (base_url or "").strip().strip("'\"")
    # Repair a common .env corruption: writing the URL with `sed s|...|...&...|` turns every
    # "&" into the matched text ("CQA_SOURCE_URL="), which the API rejects.
    if "?" in base_url and "CQA_SOURCE_URL=" in base_url.split("?", 1)[1]:
        head, tail = base_url.split("?", 1)
        base_url = head + "?" + tail.replace("CQA_SOURCE_URL=", "&")
    gid = quote(str(group_id), safe="")
    if re.search(r"([?&])group_id=[^&#]*", base_url):
        return re.sub(r"([?&])group_id=[^&#]*", lambda m: f"{m.group(1)}group_id={gid}", base_url, count=1)
    sep = "&" if "?" in base_url else "?"
    return f"{base_url}{sep}group_id={gid}"


async def fetch_dataset(group_id: str, source_url: str | None = None) -> tuple[str, list[dict[str, Any]]]:
    base = (source_url or config.SOURCE_URL or "").strip()
    if not base:
        raise SourceError(
            "Не задан адрес API организаторов: укажите CQA_SOURCE_URL в файле .env или передайте source_url."
        )
    if not group_id or not str(group_id).strip():
        raise SourceError("Укажите group_id набора данных (например, DEV).")
    url = build_source_url(base, str(group_id).strip())
    try:
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            r = await client.get(url)
    except httpx.HTTPError as e:
        raise SourceError(f"Не удалось подключиться к API организаторов: {type(e).__name__}.", 502) from e
    if r.status_code >= 400:
        raise SourceError(f"API организаторов вернул HTTP {r.status_code}: {r.text[:200]}", 502)
    try:
        payload = r.json()
    except ValueError as e:
        raise SourceError("API организаторов вернул не JSON.", 502) from e
    if isinstance(payload, dict) and payload.get("isSuccess") is False:
        raise SourceError(f"API организаторов сообщил об ошибке: {payload.get('error') or 'без описания'}", 502)
    records = extract_records(payload)
    gid = str(group_id).strip()
    return gid, records


# --- payload parsing --------------------------------------------------------------------

def _is_record(x: Any) -> bool:
    return isinstance(x, dict) and "transcript" in x


def extract_records(payload: Any) -> list[dict[str, Any]]:
    """Accepts the full organizers' response, its `data`, a list of records, one record,
    or {"text": ...} with a free-text transcript."""
    if isinstance(payload, str):
        return [parse_text(payload)]
    if isinstance(payload, dict):
        if isinstance(payload.get("text"), str) and "transcript" not in payload:
            return [
                parse_text(
                    payload["text"],
                    conversation_id=payload.get("conversation_id"),
                    channel=payload.get("channel"),
                    language=payload.get("language"),
                )
            ]
        if payload.get("isSuccess") is False:
            raise SourceError(f"Ответ API содержит ошибку: {payload.get('error') or 'без описания'}")
        if "data" in payload:
            return extract_records(payload["data"])
        if "records" in payload:
            return extract_records(payload["records"])
        if _is_record(payload):
            return [normalize_record(payload)]
        raise SourceError("Не удалось найти записи диалогов: ожидается ответ API, data, records, массив записей или text.")
    if isinstance(payload, list):
        out = [normalize_record(x) for x in payload if _is_record(x)]
        if not out and payload:
            raise SourceError("В массиве нет записей с полем transcript.")
        return out
    raise SourceError("Неподдерживаемый формат данных.")


def normalize_record(rec: dict[str, Any]) -> dict[str, Any]:
    transcript = rec.get("transcript")
    if isinstance(transcript, str):
        parsed = parse_text(transcript, rec.get("conversation_id"), rec.get("channel"), rec.get("language"))
        transcript = parsed["transcript"]
    if not isinstance(transcript, list):
        raise SourceError(f"Запись {rec.get('conversation_id')}: поле transcript должно быть массивом.")
    turns = []
    for item in transcript:
        if not isinstance(item, dict):
            continue
        sp = str(item.get("speaker", "") or "").strip()
        turns.append(
            {
                "timestamp": str(item.get("timestamp", "") or ""),
                # RU/KZ/EN role names (Оператор, agent, customer...) -> operator/client/bot/system
                "speaker": _role(sp) or sp.lower() or "system",
                "text": str(item.get("text", "") or ""),
            }
        )
    if not turns:
        raise SourceError(f"Запись {rec.get('conversation_id') or '(без ID)'}: в transcript нет ни одной реплики.")
    cid = clean_id(rec.get("conversation_id")) or _auto_id(str(turns))
    return {
        "conversation_id": cid,
        "channel": str(rec.get("channel") or "agent chat"),
        "language": str(rec.get("language") or detect_language(" ".join(t["text"] for t in turns))),
        "transcript": turns,
        "audio_url": rec.get("audio_url") or None,
    }


# --- free text --------------------------------------------------------------------------

ROLE_PREFIXES: list[tuple[str, str]] = [
    # system first so that "системное событие" does not hit other roles
    ("системное событие", "system"),
    ("система", "system"),
    ("system", "system"),
    ("жүйе", "system"),
    ("клиент", "client"),
    ("клиентка", "client"),
    ("client", "client"),
    ("customer", "client"),
    ("user", "client"),
    ("пользователь", "client"),
    ("покупатель", "client"),
    ("тұтынушы", "client"),
    ("оператор", "operator"),
    ("operator", "operator"),
    ("agent", "operator"),
    ("агент", "operator"),
    ("менеджер", "operator"),
    ("manager", "operator"),
    ("специалист", "operator"),
    ("сотрудник", "operator"),
    ("support", "operator"),
    ("поддержка", "operator"),
    ("маман", "operator"),
    ("бот", "bot"),
    ("bot", "bot"),
    ("aim", "bot"),
    ("ассистент", "bot"),
    ("assistant", "bot"),
    ("ivr", "bot"),
]

RX_LINE = re.compile(
    r"^\s*(?:T\d+\s*)?"  # optional turn number from our own rendering (T12)
    r"(?:\[(?P<ts>[^\]]{1,40})\]|\(?(?P<ts2>\d{1,2}:\d{2}(?::\d{2})?)\)?)?"  # [00:02] or 00:02
    r"\s*[-–—]?\s*"
    r"(?P<role>[^:：\n]{1,60}?)\s*[:：]\s?(?P<text>.*)$"
)


def _role(label: str) -> str | None:
    lab = re.sub(r"\[.*?\]|\(.*?\)", " ", label).strip().lower().strip("*_-–—. ")
    if not lab:
        return None
    for prefix, role in ROLE_PREFIXES:
        if lab == prefix or lab.startswith(prefix + " ") or lab.startswith(prefix + ","):
            return role
    return None


def detect_language(text: str) -> str:
    if len(re.findall(r"[әғқңөұүһі]", text.lower())) >= 3:
        return "KZ"
    latin = len(re.findall(r"[a-zA-Z]", text))
    cyr = len(re.findall(r"[а-яА-ЯёЁ]", text))
    if latin > cyr:
        return "EN"
    return "RU"


def clean_id(raw: Any) -> str:
    """Dialog IDs are used in URL paths: replace '/', '\\', '?', '#', '%' and whitespace with '-'."""
    s = str(raw or "").strip()
    s = re.sub(r"[/\\?#%\s]+", "-", s).strip("-")
    return s[:200]


def _auto_id(text: str) -> str:
    return "txt-" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]


def parse_text(
    text: str,
    conversation_id: str | None = None,
    channel: str | None = None,
    language: str | None = None,
) -> dict[str, Any]:
    """Parse lines like `[00:02] operator: текст`, `00:02 Клиент: текст`, `Оператор: текст`.
    Lines without a recognised role continue the previous turn."""
    turns: list[dict[str, str]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = RX_LINE.match(line)
        role = _role(m.group("role")) if m else None
        if m and role:
            turns.append(
                {
                    "timestamp": (m.group("ts") or m.group("ts2") or "").strip(),
                    "speaker": role,
                    "text": m.group("text").strip(),
                }
            )
        elif turns:
            turns[-1]["text"] = (turns[-1]["text"] + "\n" + line).strip()
    if not turns:
        raise SourceError(
            "Не удалось распознать реплики. Ожидается формат строк «[00:02] Оператор: текст» или «Клиент: текст»."
        )
    joined = " ".join(t["text"] for t in turns)
    return {
        "conversation_id": clean_id(conversation_id) or _auto_id(text),
        "channel": channel or "agent chat",
        "language": language or detect_language(joined),
        "transcript": turns,
        "audio_url": None,
    }
