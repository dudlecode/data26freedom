from __future__ import annotations

import os

import pytest

from cqa import audio, calibration, keys, sources


# --- free-text import ---------------------------------------------------------------------

def test_parse_text_formats():
    text = """[00:00] client: Здравствуйте, не могу вывести деньги
[00:05] Бот: Соединяю с оператором
00:40 Оператор: Добрый день! Меня зовут Алина.
Подскажите, пожалуйста, номер счёта.
Клиент: 12345
Система: Оператор закрыл чат
ОПЕРАТОР [КЛИЕНТ НА УДЕРЖАНИИ — внутренняя консультация]: уточняю
"""
    rec = sources.parse_text(text, conversation_id="manual-1")
    t = rec["transcript"]
    assert rec["conversation_id"] == "manual-1" and rec["language"] == "RU" and rec["channel"] == "agent chat"
    assert [x["speaker"] for x in t] == ["client", "bot", "operator", "client", "system", "operator"]
    assert t[0]["timestamp"] == "00:00" and t[2]["timestamp"] == "00:40" and t[3]["timestamp"] == ""
    assert t[2]["text"] == "Добрый день! Меня зовут Алина.\nПодскажите, пожалуйста, номер счёта."


def test_parse_text_languages_and_errors():
    en = sources.parse_text("customer: hi, I need help\nagent: Hello! How can I help?")
    assert en["language"] == "EN" and en["conversation_id"].startswith("txt-")
    kz = sources.parse_text("Клиент: Сәлеметсіз бе, шотқа ақша түспеді\nОператор: Сәлеметсіз бе! Қазір тексеремін")
    assert kz["language"] == "KZ"
    with pytest.raises(sources.SourceError):
        sources.parse_text("просто текст без ролей")


def test_extract_records_variants(dev_records):
    full = {"error": "", "isSuccess": True, "data": {"dataset_group_id": "DEV", "records": dev_records[:3]}}
    assert len(sources.extract_records(full)) == 3
    assert len(sources.extract_records(full["data"])) == 3
    assert len(sources.extract_records(dev_records[:2])) == 2
    one = sources.extract_records(dev_records[0])
    assert one[0]["conversation_id"] == dev_records[0]["conversation_id"]
    txt = sources.extract_records({"text": "Оператор: Здравствуйте", "conversation_id": "x1", "channel": "voice call"})
    assert txt[0]["conversation_id"] == "x1" and txt[0]["channel"] == "voice call"
    with pytest.raises(sources.SourceError):
        sources.extract_records({"isSuccess": False, "error": "bad group"})
    with pytest.raises(sources.SourceError):
        sources.extract_records({"foo": 1})


def test_build_source_url():
    u = "https://x.test/api/data?group_id=OLD&sig=a%2Fb%3D"
    assert sources.build_source_url(u, "DEV") == "https://x.test/api/data?group_id=DEV&sig=a%2Fb%3D"
    assert sources.build_source_url("https://x.test/a?sig=1", "T 1") == "https://x.test/a?sig=1&group_id=T%201"
    assert sources.build_source_url("https://x.test/a", "DEV") == "https://x.test/a?group_id=DEV"


# --- audio --------------------------------------------------------------------------------

def test_extract_media_url():
    page = """<html><body><audio controls>
      <source src="https://blob.example.net/rec/call.mp3?sv=2024&amp;se=2026-11-07T15%3A00Z&amp;sig=abc%3D" type="audio/mpeg">
    </audio></body></html>"""
    assert audio.extract_media_url(page) == "https://blob.example.net/rec/call.mp3?sv=2024&se=2026-11-07T15%3A00Z&sig=abc%3D"
    assert audio.extract_media_url("<audio src='/files/a.mp3'></audio>", "https://h.test/player") == "https://h.test/files/a.mp3"
    assert audio.extract_media_url("<p>no media</p>") is None


def test_audio_cache(monkeypatch):
    audio._cache.clear()
    audio._cache["d1"] = ("https://a.test/1.mp3", 1_000_000.0)
    monkeypatch.setattr(audio.time, "time", lambda: 1_000_000.0 + 49 * 60)
    assert audio.cached("d1") == "https://a.test/1.mp3"
    monkeypatch.setattr(audio.time, "time", lambda: 1_000_000.0 + 51 * 60)
    assert audio.cached("d1") is None


# --- calibration --------------------------------------------------------------------------

def test_calibration_math(checklist):
    ref = {
        "d1": {"labels": {"c01": "YES", "c02": "NA", "c03": "NA", "c04": 20, "c05": "YES", "c06": 10, "c07": "NO", "c08": "NO"}},
        "d2": {"labels": {"c01": "NO", "c02": "YES", "c03": "YES", "c04": 15, "c05": "YES", "c06": 7, "c07": "YES", "c08": "NO"}},
    }
    p1 = {"c01": "YES", "c02": "NA", "c03": "NA", "c04": "20", "c05": "YES", "c06": "10", "c07": "YES", "c08": "NO"}
    p2 = {"c01": "NO", "c02": "YES", "c03": "YES", "c04": "15", "c05": "YES", "c06": "7", "c07": "YES", "c08": "NO"}
    from cqa import scoring

    items = [
        {"dialog_id": "d1", "checklist": checklist, "values": p1, "pred_total": scoring.compute(checklist, p1)["total"]},
        {"dialog_id": "d2", "checklist": checklist, "values": p2, "pred_total": scoring.compute(checklist, p2)["total"]},
        {"dialog_id": "unknown", "checklist": checklist, "values": p2, "pred_total": 1.0},
    ]
    out = calibration.compare(items, ref)
    assert out["available"] and out["n_dialogs"] == 2
    assert out["overall_exact"] == pytest.approx(15 / 16, abs=1e-4)
    d1 = out["dialogs"][0]
    assert d1["ref_total"] == 92.31 and d1["pred_total"] == 100.0
    assert d1["diffs"] == [{"cid": "c07", "ref": "NO", "pred": "YES"}]
    assert out["total_mae"] == pytest.approx((100 - 92.31) / 2, abs=0.01)
    assert out["by_criterion"]["c07"]["exact"] == 0.5
    assert out["by_criterion"]["c07"]["confusion"] == {"NO→YES": 1, "YES→YES": 1}
    assert calibration.compare(items, None)["available"] is False


# --- key handling (no network) ------------------------------------------------------------

def test_key_mask_and_env_write(tmp_path, monkeypatch):
    assert keys.mask("sk-or-v1-XXXXXXXXXXXXabcd") == "sk-o…abcd"
    env = tmp_path / ".env"
    env.write_text("A=1\nCQA_MODEL_API_KEY=old\nB=2\n", encoding="utf-8")
    monkeypatch.setattr(keys, "ENV_PATH", env)
    monkeypatch.setattr(keys.config, "MODEL_API_KEY", "")
    monkeypatch.setenv("CQA_MODEL_API_KEY", "")

    async def ok(_key, _base=None):
        return None

    monkeypatch.setattr(keys, "verify", ok)
    import asyncio

    st = asyncio.run(keys.save("sk-or-test-0123456789-wxyz"))
    assert st == {"configured": True, "masked": "sk-o…wxyz"}
    assert env.read_text(encoding="utf-8") == "A=1\nCQA_MODEL_API_KEY=sk-or-test-0123456789-wxyz\nB=2\n"
    if os.name != "nt":  # на Windows POSIX-права chmod не выставляет: доступ к .env ограничивается ACL профиля
        assert (env.stat().st_mode & 0o777) == 0o600
    with pytest.raises(keys.KeyError_):
        asyncio.run(keys.save("short"))


def test_build_source_url_repairs_sed_corruption():
    broken = "https://x.test/a?api-version=1CQA_SOURCE_URL=sp=%2FrunCQA_SOURCE_URL=sig=abcCQA_SOURCE_URL=group_id=DEV"
    assert sources.build_source_url(broken, "TEST") == "https://x.test/a?api-version=1&sp=%2Frun&sig=abc&group_id=TEST"
