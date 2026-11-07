"""Operator name from the transcript, deterministic (no model).

The organizers' records carry no operator field, so the name is taken from the first
operator line of the main phase ("Здравствуйте, меня зовут Алина", "Сәлеметсіз бе, мен
Нұрланмын", "Hi, I'm Maya"). Masked names ("[Имя скрыто]") and lines without an
introduction give UNKNOWN. Grouping key: casefold with ё = е; the first spelling seen is
displayed. Variants across languages and nicknames are not merged.
"""

from __future__ import annotations

import re
from typing import Any

from .preprocess import prepare

UNKNOWN = "Не указано"
UNKNOWN_KEY = "_unknown"

_HIDDEN = re.compile(r"\[\s*имя\s+скрыто\s*\]", re.I)
_NAME = r"([^\W\d_][^\W\d_\-]*(?:-[^\W\d_]+)?)"  # one word of letters, optional hyphenated part
_KZ_SUFFIX = re.compile(r"(мын|мін|пын|пін|бын|бін)$", re.I)

# Most specific first. The flag marks Kazakh patterns, where the predicate suffix is cut
# ("Нұрланмын" = "I am Nurlan").
_PATTERNS: list[tuple[re.Pattern[str], bool]] = [
    (re.compile(r"\bменя\s+зовут\s+" + _NAME, re.I), False),
    (re.compile(r"\bменің\s+атым\s+" + _NAME, re.I), True),
    (re.compile(r"\bmy\s+name\s+is\s+" + _NAME, re.I), False),
    (re.compile(r"\bi\s*['’]\s*m\s+" + _NAME, re.I), False),
    (re.compile(r"\bi\s+am\s+" + _NAME, re.I), False),
    (re.compile(r"\bthis\s+is\s+" + _NAME, re.I), False),
    (re.compile(r"(?<![\w])мен\s+" + _NAME, re.I), True),
    (re.compile(r"(?<![\w])я\s+" + _NAME, re.I), False),
    (re.compile(r"(?<![\w])это\s+" + _NAME, re.I), False),
]
_STOP = {"freedom", "фридом", "support", "поддержка", "вы", "вам", "вас", "ваш", "сіз", "сізге", "you"}
_STRIP = ".,!?;:«»\"'()"


def name_from_text(text: str | None) -> str:
    """Operator name from one line of text, or UNKNOWN."""
    if not text or _HIDDEN.search(text):
        return UNKNOWN
    for rx, kz in _PATTERNS:
        for m in rx.finditer(text):
            name = m.group(1).strip(_STRIP)
            if not name or not name[0].isupper():
                continue  # "я сейчас", "мен сізге", "this is about"
            if kz:
                cut = _KZ_SUFFIX.sub("", name)
                if len(cut) >= 2:
                    name = cut
            if name.casefold() in _STOP:
                continue
            return name
    return UNKNOWN


def operator_name(turns: list[Any]) -> str:
    """Name from prepared turns (preprocess.Turn objects or Turn.to_dict() dicts)."""
    for t in turns:
        speaker = t.get("speaker") if isinstance(t, dict) else getattr(t, "speaker", None)
        phase = t.get("phase", "main") if isinstance(t, dict) else getattr(t, "phase", "main")
        if speaker == "operator" and phase == "main":
            return name_from_text(t.get("text") if isinstance(t, dict) else getattr(t, "text", ""))
    return UNKNOWN


def name_key(name: str) -> str:
    if not name or name == UNKNOWN:
        return UNKNOWN_KEY
    return name.casefold().replace("ё", "е")


_cache: dict[tuple[str, str | None], str] = {}


def for_dialog(d: dict[str, Any]) -> str:
    """Operator name of a dialogs row (needs id, transcript; imported_at keys the cache)."""
    key = (d["id"], d.get("imported_at"))
    hit = _cache.get(key)
    if hit is not None:
        return hit
    transcript = d.get("transcript")
    if transcript is None:
        return UNKNOWN
    record = {
        "conversation_id": d["id"],
        "channel": d.get("channel") or "",
        "language": d.get("language") or "",
        "transcript": transcript or [],
    }
    try:
        name = operator_name(prepare(record).turns)
    except Exception:  # noqa: BLE001  a broken transcript must not break a listing
        name = UNKNOWN
    _cache[key] = name
    return name


def info(d: dict[str, Any]) -> dict[str, str]:
    name = for_dialog(d)
    return {"operator": name, "operator_key": name_key(name)}
