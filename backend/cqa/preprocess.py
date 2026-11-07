"""Deterministic preprocessing of a dialog before it reaches the LLM.

Everything that can be computed without judgement is computed here and passed to the
model as explicit FACTS: phases (bot / operator / client on hold / after hang-up),
response timings, system events, identity-verification events, who ended the chat,
and per-turn audio offsets for voice calls (recording pauses are excluded).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

FIRST_RESPONSE_LIMIT_S = 180  # "порог первой реакции в 3 минуты"

SPEAKER_LABEL = {
    "client": "КЛИЕНТ",
    "operator": "ОПЕРАТОР",
    "bot": "БОТ",
    "system": "СИСТЕМА",
}

# --- system event patterns (RU / KZ / EN) -------------------------------------------
RX_ESCALATION = re.compile(
    r"эскалаци|transferred to an agent|операторға жіберілді|агент присоединился|agent joined"
    r"|переведен от агента на представителя",
    re.I,
)
RX_AGENT_JOINED = re.compile(r"агент присоединился|agent joined", re.I)
RX_IDENTITY_OK = re.compile(
    r"личность клиента подтверждена|identity verified|жеке басы расталды", re.I
)
RX_CLIENT_LEFT = re.compile(
    r"клиент покинул|соединение с клиентом прервано|connection to customer lost|customer left"
    r"|клиентпен байланыс үзілді|клиент чаттан шықты|клиент завершил разговор|customer ended",
    re.I,
)
RX_OPERATOR_CLOSED = re.compile(r"оператор закрыл чат|agent closed the chat|оператор чатты жапты", re.I)
RX_CALL_ENDED_BY_CLIENT = re.compile(r"клиент завершил разговор|customer ended the call", re.I)
RX_HOLD_START = re.compile(r"клиент находится на удержании|инициирована консультация|началась консультация", re.I)
RX_HOLD_END = re.compile(r"клиент больше не находится на удержании", re.I)
RX_REC_START = re.compile(r"запись и транскрибирование запущены|жазу және транскрипция басталды|recording.*started", re.I)
RX_REC_PAUSE = re.compile(r"запись и транскрибирование приостановлены|recording.*paused", re.I)
RX_REC_RESUME = re.compile(r"запись и транскрибирование возобновлены|recording.*resumed", re.I)

# Long, identical bot boilerplate lines are shortened to save tokens and attention.
RX_BOT_BOILERPLATE = re.compile(
    r"^(Здравствуйте! Я AIM|Hello! I'm AIM|Сәлеметсіз бе! Мен AIM|Продолжая разговор, Вы соглашаетесь"
    r"|By continuing|Әңгімені жалғастыра отырып)",
    re.I,
)
RX_WAIT_WARNING = re.compile(
    r"проверю|уточню|посмотрю|минуту|секунду|подождите|ожидайте|ожидани|ожидать|на линии"
    r"|let me check|one moment|please wait|hold on"
    r"|тексеремін|күте тұрыңыз|бір минут",
    re.I,
)


@dataclass
class Turn:
    idx: int
    timestamp: str
    speaker: str
    text: str
    t: float | None = None  # seconds since dialog start
    phase: str = "main"  # pre_operator | main | hold | after_end
    audio_offset: float | None = None
    boilerplate: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "idx": self.idx,
            "timestamp": self.timestamp,
            "speaker": self.speaker,
            "text": self.text,
            "t": self.t,
            "clock": fmt_clock(self.t),
            "phase": self.phase,
            "audio_offset": self.audio_offset,
            "boilerplate": self.boilerplate,
        }


@dataclass
class Prepared:
    conversation_id: str
    channel: str
    language: str
    turns: list[Turn]
    facts: dict[str, Any] = field(default_factory=dict)

    @property
    def is_call(self) -> bool:
        return "voice" in (self.channel or "").lower() or "call" in (self.channel or "").lower()


def fmt_clock(t: float | None) -> str:
    if t is None:
        return ""
    t = max(0, int(round(t)))
    return f"{t // 60:02d}:{t % 60:02d}"


def _parse_time(ts: str) -> float | datetime | None:
    ts = (ts or "").strip()
    if not ts:
        return None
    m = re.fullmatch(r"(\d{1,3}):(\d{2})(?::(\d{2}))?", ts)
    if m:
        if m.group(3) is not None:  # HH:MM:SS
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        return int(m.group(1)) * 60 + int(m.group(2))
    if re.fullmatch(r"\d+(?:\.\d+)?", ts):  # plain seconds from the start ("12", "12.5")
        return float(ts)
    try:
        # ISO 8601 with up to 7 fractional digits (Dynamics) -> trim to microseconds
        iso = re.sub(r"(\.\d{6})\d+", r"\1", ts.replace("Z", "+00:00"))
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    # One convention for subtraction: naive UTC (naive input is taken as UTC).
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def prepare(record: dict[str, Any]) -> Prepared:
    transcript = record.get("transcript") or []
    raw_times = [_parse_time(str(x.get("timestamp", ""))) for x in transcript]
    base_dt = next((x for x in raw_times if isinstance(x, datetime)), None)

    turns: list[Turn] = []
    for i, item in enumerate(transcript):
        rt = raw_times[i]
        if isinstance(rt, datetime) and base_dt is not None:
            t = (rt - base_dt).total_seconds()
        elif isinstance(rt, (int, float)):
            t = float(rt)
        else:
            t = None
        speaker = str(item.get("speaker", "")).strip().lower() or "system"
        text = str(item.get("text", "")).strip()
        turns.append(
            Turn(
                idx=i,
                timestamp=str(item.get("timestamp", "")),
                speaker=speaker,
                text=text,
                t=t,
                boilerplate=speaker == "bot" and bool(RX_BOT_BOILERPLATE.search(text)),
            )
        )

    prepared = Prepared(
        conversation_id=str(record.get("conversation_id", "")),
        channel=str(record.get("channel", "")),
        language=str(record.get("language", "")),
        turns=turns,
    )
    _mark_phases(prepared)
    _compute_audio_offsets(prepared)
    prepared.facts = _compute_facts(prepared)
    return prepared


def _mark_phases(p: Prepared) -> None:
    turns = p.turns
    first_op = next((t.idx for t in turns if t.speaker == "operator"), None)
    escalation = next(
        (t.idx for t in turns if t.speaker == "system" and RX_ESCALATION.search(t.text)), None
    )
    joined = next(
        (t.idx for t in turns if t.speaker == "system" and RX_AGENT_JOINED.search(t.text)), None
    )
    start = joined if joined is not None else escalation
    if start is None or (first_op is not None and first_op < start):
        start = first_op
    on_hold = False
    ended = False
    for t in turns:
        if start is not None and t.idx < start:
            t.phase = "pre_operator"
            continue
        if ended:
            t.phase = "after_end"
            continue
        if t.speaker == "system" and RX_HOLD_START.search(t.text):
            on_hold = True
        if t.speaker == "system" and RX_HOLD_END.search(t.text):
            on_hold = False
            t.phase = "main"
            continue
        t.phase = "hold" if on_hold else "main"
        if t.speaker == "system" and RX_CALL_ENDED_BY_CLIENT.search(t.text):
            ended = True


def _compute_audio_offsets(p: Prepared) -> None:
    """Map each turn to a second in the recording. Recording may start late and be
    paused during IVR->agent transfer; paused intervals are not in the audio file."""
    if not p.is_call:
        return
    rec_start = None
    paused_at = None
    paused_total = 0.0
    for t in p.turns:
        if t.t is None:
            continue
        if t.speaker == "system" and RX_REC_START.search(t.text) and rec_start is None:
            rec_start = t.t
        if t.speaker == "system" and RX_REC_PAUSE.search(t.text) and paused_at is None:
            paused_at = t.t
        if t.speaker == "system" and RX_REC_RESUME.search(t.text) and paused_at is not None:
            paused_total += t.t - paused_at
            paused_at = None
        if rec_start is None:
            t.audio_offset = 0.0
        elif paused_at is not None:
            t.audio_offset = max(0.0, paused_at - rec_start - paused_total)
        else:
            t.audio_offset = max(0.0, t.t - rec_start - paused_total)


def _compute_facts(p: Prepared) -> dict[str, Any]:
    turns = p.turns
    main = [t for t in turns if t.phase in ("main", "hold")]
    op_turns = [t for t in turns if t.speaker == "operator" and t.phase == "main"]
    first_op = op_turns[0] if op_turns else None
    escalation = next(
        (t for t in turns if t.speaker == "system" and RX_ESCALATION.search(t.text)), None
    )
    joined = next((t for t in turns if t.speaker == "system" and RX_AGENT_JOINED.search(t.text)), None)
    anchor = joined or escalation

    facts: dict[str, Any] = {
        "channel": p.channel,
        "language": p.language,
        "turns_total": len(turns),
        "operator_turns": len(op_turns),
        "client_turns": sum(1 for t in turns if t.speaker == "client"),
        "escalation_turn": escalation.idx if escalation else None,
        "first_operator_turn": first_op.idx if first_op else None,
        "first_response_s": None,
        "first_response_ok": None,
        "client_waits": [],
        "long_waits": [],
        "system_events": [
            {"turn": t.idx, "text": t.text} for t in turns if t.speaker == "system"
        ],
        "identity_verified_turn": next(
            (t.idx for t in turns if t.speaker == "system" and RX_IDENTITY_OK.search(t.text)), None
        ),
        "ended_by": None,
        "end_event_turn": None,
        "last_operator_turn": op_turns[-1].idx if op_turns else None,
        "last_speaker": None,
        "hold_turns": [t.idx for t in turns if t.phase == "hold"],
        "after_end_turns": [t.idx for t in turns if t.phase == "after_end"],
        "duration_s": None,
    }
    timed = [t.t for t in turns if t.t is not None]
    if timed:
        facts["duration_s"] = round(max(timed) - min(timed))

    if first_op and anchor and first_op.t is not None and anchor.t is not None:
        frt = first_op.t - anchor.t
        facts["first_response_s"] = round(frt)
        facts["first_response_ok"] = frt <= FIRST_RESPONSE_LIMIT_S

    # client waiting for an operator reply (only after operator joined, excluding hold)
    if first_op is not None:
        for t in main:
            if t.speaker != "client" or t.idx < first_op.idx or t.t is None:
                continue
            nxt = next(
                (u for u in turns[t.idx + 1 :] if u.speaker == "operator" and u.phase == "main"), None
            )
            if nxt is None or nxt.t is None:
                continue
            # skip if the client wrote again before the operator answered (count from last one)
            later_client = [
                u for u in turns[t.idx + 1 : nxt.idx] if u.speaker == "client"
            ]
            if later_client:
                continue
            wait = nxt.t - t.t
            prev_op = next(
                (u for u in reversed(turns[: t.idx]) if u.speaker == "operator" and u.phase == "main"),
                None,
            )
            warned = bool(prev_op and RX_WAIT_WARNING.search(prev_op.text))
            item = {"client_turn": t.idx, "operator_turn": nxt.idx, "wait_s": round(wait), "warned_before": warned}
            facts["client_waits"].append(item)
            if wait > 90:
                facts["long_waits"].append(item)

    for t in turns:
        if t.speaker != "system":
            continue
        if RX_OPERATOR_CLOSED.search(t.text):
            facts["ended_by"], facts["end_event_turn"] = "operator_closed", t.idx
        elif RX_CLIENT_LEFT.search(t.text) and facts["ended_by"] is None:
            facts["ended_by"], facts["end_event_turn"] = "client_or_connection", t.idx
    speaking = [t for t in turns if t.speaker in ("client", "operator") and t.phase == "main"]
    if speaking:
        facts["last_speaker"] = speaking[-1].speaker
    return facts


# --- rendering for the LLM -------------------------------------------------------------

PHASE_NOTE = {
    "pre_operator": "",
    "main": "",
    "hold": " [КЛИЕНТ НА УДЕРЖАНИИ: внутренняя консультация, клиент не слышит]",
    "after_end": " [ПОСЛЕ ЗАВЕРШЕНИЯ РАЗГОВОРА КЛИЕНТОМ: не оценивается]",
}


def render_facts(p: Prepared) -> str:
    f = p.facts
    lines = [
        f"Канал: {p.channel}. Язык клиента по разметке: {p.language}.",
    ]
    if f["escalation_turn"] is not None:
        lines.append(f"Подключение оператора (системное событие): T{f['escalation_turn'] + 1}.")
    if f["first_operator_turn"] is not None:
        frt = f["first_response_s"]
        if frt is not None:
            ok = "SLA 3 мин соблюдён" if f["first_response_ok"] else "SLA 3 мин ПРЕВЫШЕН"
            lines.append(
                f"Первое сообщение оператора: T{f['first_operator_turn'] + 1}, первая реакция через {frt} с ({ok})."
            )
        else:
            lines.append(f"Первое сообщение оператора: T{f['first_operator_turn'] + 1}.")
    else:
        lines.append("Оператор не написал ни одного сообщения.")
    if f["client_waits"]:
        mx = max(f["client_waits"], key=lambda x: x["wait_s"])
        lines.append(
            f"Максимальное ожидание ответа оператора клиентом: {mx['wait_s']} с (T{mx['client_turn'] + 1}-T{mx['operator_turn'] + 1})."
        )
    for w in f["long_waits"]:
        warn = "оператор перед этим предупредил об ожидании" if w["warned_before"] else "предупреждения об ожидании не было"
        lines.append(f"Долгое ожидание: T{w['client_turn'] + 1}-T{w['operator_turn'] + 1}: {w['wait_s']} с, {warn}.")
    if f["identity_verified_turn"] is not None:
        lines.append(f"Системное подтверждение личности клиента: T{f['identity_verified_turn'] + 1}.")
    else:
        lines.append("Системного события подтверждения личности нет (в звонке проверка может идти голосом).")
    if f["ended_by"] == "operator_closed":
        lines.append(f"Чат закрыт оператором: T{f['end_event_turn'] + 1}.")
    elif f["ended_by"] == "client_or_connection":
        lines.append(f"Разговор прерван клиентом/связью: T{f['end_event_turn'] + 1}.")
    else:
        lines.append("Системного события о закрытии чата нет.")
    if f["last_operator_turn"] is not None:
        lines.append(f"Последнее сообщение оператора: T{f['last_operator_turn'] + 1}. Последним в диалоге писал: {SPEAKER_LABEL.get(f['last_speaker'] or '', '-')}.")
    if f["hold_turns"]:
        lines.append(
            f"Реплики во время удержания клиента (не слышны клиенту): T{f['hold_turns'][0] + 1}-T{f['hold_turns'][-1] + 1}."
        )
    if f["after_end_turns"]:
        lines.append(f"Реплики после завершения разговора клиентом: T{f['after_end_turns'][0] + 1}-T{f['after_end_turns'][-1] + 1}.")
    return "\n".join(f"- {x}" for x in lines)


def render_transcript(p: Prepared) -> str:
    out = []
    for t in p.turns:
        label = SPEAKER_LABEL.get(t.speaker, t.speaker.upper())
        clock = fmt_clock(t.t) if t.t is not None else t.timestamp
        text = t.text
        if t.boilerplate:
            text = "(стандартное приветствие/согласие бота) " + text[:80] + ("…" if len(text) > 80 else "")
        out.append(f"T{t.idx + 1} [{clock}] {label}{PHASE_NOTE.get(t.phase, '')}: {text}")
    return "\n".join(out)


def render_for_llm(p: Prepared) -> str:
    return (
        f"ДИАЛОГ {p.conversation_id}\n\n"
        f"ФАКТЫ (рассчитаны автоматически по меткам времени и системным событиям):\n{render_facts(p)}\n\n"
        f"ТРАНСКРИПТ (T#: номер реплики с 1 по исходному массиву, время от начала диалога):\n{render_transcript(p)}"
    )
