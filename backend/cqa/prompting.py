"""Builds the LLM prompt and JSON schema from a checklist config.

Nothing about the criteria is hard-coded: replacing/adding a criterion in the UI changes
the prompt and the output schema automatically.
"""

from __future__ import annotations

import json
from typing import Any

from .scoring import allowed_values

TYPE_LABEL = {"binary": "ДА / НЕТ", "scale": "шкала", "flag": "ДА / НЕТ, без баллов"}


def _criterion_block(c: dict[str, Any], sections: dict[str, str]) -> str:
    vals = allowed_values(c)
    lines = [f"### {c['id']} · {c.get('code') or ''} {c['name']}".rstrip()]
    meta = [TYPE_LABEL.get(c.get("type", "binary"), c.get("type"))]
    if c.get("type") != "flag":
        meta.append(f"вес {c.get('weight', 0)}")
    meta.append("N/A разрешён" if c.get("na_allowed") and c.get("type") != "flag" else "N/A запрещён")
    if c.get("section") in sections:
        meta.append(f"секция «{sections[c['section']]}»")
    lines.append("Тип: " + ", ".join(meta) + ".")
    if c.get("description"):
        lines.append(f"Правило: {c['description']}")
    if c.get("type") == "scale":
        lines.append("Ступени шкалы (выберите ровно одну):")
        for s in sorted(c.get("scale", []), key=lambda s: -s["value"]):
            lines.append(f"  {int(s['value'])}: {s.get('label', '')}")
    if c.get("na_allowed") and c.get("type") != "flag" and c.get("na_condition"):
        lines.append(f"Условие N/A: {c['na_condition']}")
    if c.get("guidance"):
        lines.append(f"Как применять: {c['guidance']}")
    lines.append("Допустимые значения поля value: " + ", ".join(vals) + ".")
    return "\n".join(lines)


def build_system(checklist: dict[str, Any]) -> str:
    sections = {s["id"]: s["name"] for s in checklist.get("sections", [])}
    crit_text = "\n\n".join(_criterion_block(c, sections) for c in checklist.get("criteria", []))
    return f"""Вы старший специалист отдела контроля качества (QA) брокерской компании Freedom Broker. Вы проверяете работу оператора поддержки по одному диалогу (чат или расшифровка звонка) строго по чек-листу и выставляете оценку, которую затем сверят с эталонной оценкой опытного аудитора.

## Общие правила
{checklist.get('general_guidance', '').strip()}

## Чек-лист «{checklist.get('name', '')}»
{crit_text}

## Порядок работы
1. Прочитайте весь диалог. Определите, что клиент хотел (все вопросы, включая заданные боту до подключения оператора), что уже было известно оператору и что произошло после подключения оператора.
2. Опирайтесь только на то, что есть в транскрипте и блоке ФАКТЫ. Не придумывайте факты, намерения или события, которых нет в тексте. Если для уверенного вывода данных не хватает (обрыв, неразборчивая речь, скрытые данные), так и напишите в reasoning и примените правило чек-листа к тому, что известно: N/A только по условию неприменимости, иначе выбирайте значение, которое прямо подтверждается текстом.
3. Оценивайте каждый критерий независимо, буквально по его правилу и условию N/A. Не смешивайте критерии: ошибка в одном не должна автоматически снижать другой, если правило другого выполнено.
4. Для каждого критерия:
   - reasoning: 1-3 предложения по-русски: какое правило применено и почему (с номерами реплик, например «T11»). Формат как у аудитора: «Завершение: Нет. После ответа на вопрос оператор закрыл чат без прощания (T12)». Пишите простым деловым языком, без длинных тире и стрелок: вместо тире ставьте двоеточие, запятую или точку, диапазон реплик пишите как T9-T15.
   - value: ровно одно из допустимых значений.
   - evidence_turns: номера реплик, подтверждающих вывод (реплики оператора/клиента/системы). Для N/A: реплики, из которых видно условие неприменимости (или пустой список).
   - checked_from / checked_to: если действие оператора ПРОПУЩЕНО (оценка «Нет» / снижение балла за отсутствие действия), укажите участок разговора, где действие ожидалось (номера реплик). Иначе -1 и -1.
   - na_reason: если value = NA, какое условие неприменимости выполнено; иначе пустая строка.
5. client_request: одной-двумя фразами по-русски: суть запроса клиента и чем закончился диалог.

Номера реплик берите только из транскрипта (T#, нумерация с 1). Ответ: строго JSON по заданной схеме.{_compact_note(checklist)}"""


def _compact_note(checklist: dict[str, Any]) -> str:
    if not compact_mode(checklist):
        return ""
    ids = ", ".join(c["id"] for c in checklist.get("criteria", []))
    return (
        "\nПоле criteria: массив, ровно один элемент на каждый критерий чек-листа, в порядке чек-листа "
        f"({ids}). В criterion_id укажите идентификатор критерия, в value только значение, допустимое для этого критерия."
    )


# Strict structured output compiles the schema into a grammar. One nested object per
# criterion (with its own enum) grows that grammar with every criterion, and from about
# nine criteria the API refuses it ("The compiled grammar is too large"). Up to
# STRICT_PER_CRITERION criteria the per-criterion schema is kept (it is what the prompt was
# calibrated on); above that a compact schema of constant size is used: criteria as an
# array of items with criterion_id from an enum. Values are normalized server-side
# (scoring.normalize_value), so the looser value enum is safe.
STRICT_PER_CRITERION = 8


def compact_mode(checklist: dict[str, Any]) -> bool:
    return len(checklist.get("criteria", [])) > STRICT_PER_CRITERION


def build_schema(checklist: dict[str, Any], compact: bool | None = None) -> dict[str, Any]:
    if compact is None:
        compact = compact_mode(checklist)
    if compact:
        return build_compact_schema(checklist)
    props: dict[str, Any] = {}
    for c in checklist.get("criteria", []):
        props[c["id"]] = {
            "type": "object",
            "properties": {
                "reasoning": {"type": "string"},
                "value": {"type": "string", "enum": allowed_values(c)},
                "evidence_turns": {"type": "array", "items": {"type": "integer"}},
                "checked_from": {"type": "integer"},
                "checked_to": {"type": "integer"},
                "na_reason": {"type": "string"},
            },
            "required": ["reasoning", "value", "evidence_turns", "checked_from", "checked_to", "na_reason"],
            "additionalProperties": False,
        }
    return {
        "type": "object",
        "properties": {
            "client_request": {"type": "string"},
            "criteria": {
                "type": "object",
                "properties": props,
                "required": list(props.keys()),
                "additionalProperties": False,
            },
        },
        "required": ["client_request", "criteria"],
        "additionalProperties": False,
    }


def build_compact_schema(checklist: dict[str, Any]) -> dict[str, Any]:
    """Grammar size does not depend on the number of criteria."""
    ids = [c["id"] for c in checklist.get("criteria", [])]
    values: list[str] = []
    for c in checklist.get("criteria", []):
        for v in allowed_values(c):
            if v not in values:
                values.append(v)
    return {
        "type": "object",
        "properties": {
            "client_request": {"type": "string"},
            "criteria": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "criterion_id": {"type": "string", "enum": ids},
                        "reasoning": {"type": "string"},
                        "value": {"type": "string", "enum": values},
                        "evidence_turns": {"type": "array", "items": {"type": "integer"}},
                        "checked_from": {"type": "integer"},
                        "checked_to": {"type": "integer"},
                        "na_reason": {"type": "string"},
                    },
                    "required": ["criterion_id", "reasoning", "value", "evidence_turns", "checked_from",
                                 "checked_to", "na_reason"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["client_request", "criteria"],
        "additionalProperties": False,
    }


def criteria_map(data: Any) -> dict[str, Any] | None:
    """Model output criteria as {criterion_id: item} for both schemas (object or array).
    The first item wins when the array repeats a criterion. None if the field is missing."""
    crit = (data or {}).get("criteria") if isinstance(data, dict) else None
    if isinstance(crit, dict):
        return crit
    if isinstance(crit, list):
        out: dict[str, Any] = {}
        for item in crit:
            if isinstance(item, dict) and item.get("criterion_id") and str(item["criterion_id"]) not in out:
                out[str(item["criterion_id"])] = item
        return out
    return None


def build_user(dialog_text: str) -> str:
    return f"{dialog_text}\n\nОцените работу оператора в этом диалоге по всем критериям чек-листа."


# --- appeal: focused second opinion on one criterion ---------------------------------

def build_appeal_system(checklist: dict[str, Any], criterion: dict[str, Any]) -> str:
    sections = {s["id"]: s["name"] for s in checklist.get("sections", [])}
    return f"""Вы независимый проверяющий (арбитр) отдела контроля качества Freedom Broker. Оператор или руководитель оспорил оценку одного критерия. Ваша задача: заново и беспристрастно оценить ТОЛЬКО этот критерий по правилу чек-листа, учитывая аргументы апелляции, но не принимая их на веру: проверьте их по тексту диалога.

## Общие правила
{checklist.get('general_guidance', '').strip()}

## Оспариваемый критерий
{_criterion_block(criterion, sections)}

Ответ: строго JSON: value (допустимое значение), reasoning (2-4 предложения по-русски с номерами реплик T#), evidence_turns, appeal_valid (true, если аргументы апелляции обоснованы и исходную оценку следует изменить), recommendation (одно предложение для проверяющего)."""


def build_appeal_schema(criterion: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "value": {"type": "string", "enum": allowed_values(criterion)},
            "reasoning": {"type": "string"},
            "evidence_turns": {"type": "array", "items": {"type": "integer"}},
            "appeal_valid": {"type": "boolean"},
            "recommendation": {"type": "string"},
        },
        "required": ["value", "reasoning", "evidence_turns", "appeal_valid", "recommendation"],
        "additionalProperties": False,
    }


def build_appeal_user(dialog_text: str, original: dict[str, Any], comment: str) -> str:
    shown = {k: original.get(k) for k in ("value", "reasoning")}
    shown["evidence_turns"] = [int(i) + 1 for i in (original.get("evidence_turns") or []) if isinstance(i, int)]
    orig = json.dumps(shown, ensure_ascii=False)
    return (
        f"{dialog_text}\n\nИСХОДНАЯ ОЦЕНКА КРИТЕРИЯ (автоматическая):\n{orig}\n\n"
        f"КОММЕНТАРИЙ АПЕЛЛЯЦИИ:\n{comment.strip() or '(без комментария)'}\n\n"
        "Оцените критерий заново."
    )
