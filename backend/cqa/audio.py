"""Voice-call recordings: the dialog's audio_url returns an HTML player page whose
<source src="..."> is a signed mp3 link (valid ~1 hour). We resolve and cache it."""

from __future__ import annotations

import html as html_lib
import re
import time
from urllib.parse import urljoin

import httpx

CACHE_TTL_S = 50 * 60
_cache: dict[str, tuple[str, float]] = {}


class AudioError(RuntimeError):
    pass


RX_SOURCE = re.compile(r"<source\b[^>]*?\bsrc\s*=\s*([\"'])(?P<src>.+?)\1", re.I | re.S)
RX_AUDIO = re.compile(r"<audio\b[^>]*?\bsrc\s*=\s*([\"'])(?P<src>.+?)\1", re.I | re.S)
RX_MP3 = re.compile(r"https?://[^\s\"'<>]+?\.(?:mp3|wav|m4a|ogg)(?:\?[^\s\"'<>]*)?", re.I)


def extract_media_url(page: str, base_url: str = "") -> str | None:
    for rx in (RX_SOURCE, RX_AUDIO):
        m = rx.search(page or "")
        if m:
            src = html_lib.unescape(m.group("src").strip())
            return urljoin(base_url, src) if base_url else src
    m = RX_MP3.search(page or "")
    if m:
        return html_lib.unescape(m.group(0))
    return None


def cached(dialog_id: str) -> str | None:
    hit = _cache.get(dialog_id)
    if hit and time.time() - hit[1] < CACHE_TTL_S:
        return hit[0]
    return None


async def resolve(dialog_id: str, player_url: str) -> str:
    hit = cached(dialog_id)
    if hit:
        return hit
    if not player_url:
        raise AudioError("У диалога нет записи звонка.")
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            r = await client.get(player_url)
    except httpx.HTTPError as e:
        raise AudioError(f"Не удалось открыть страницу плеера: {type(e).__name__}.") from e
    if r.status_code >= 400:
        raise AudioError(f"Страница плеера вернула HTTP {r.status_code}.")
    ctype = r.headers.get("content-type", "").lower()
    if ctype.startswith("audio/") or ctype == "application/octet-stream":
        url = str(r.url)  # the link already points to the media file
    else:
        url = extract_media_url(r.text, str(r.url))
    if not url:
        raise AudioError("На странице плеера не найдена ссылка на аудиофайл.")
    _cache[dialog_id] = (url, time.time())
    return url
