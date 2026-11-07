"""Plain typography for generated text: no em/en dashes, no decorative arrows."""

import re

_DASH = re.compile(r"\s*[\u2014\u2013]\s*")
_ARROW = re.compile(r"\s*[\u2192\u21d2\u27f6]\s*")


def plain(text: str) -> str:
    """Replace long dashes with a colon-or-comma style and arrows with plain words.

    Number ranges like "T9\u2013T15" become "T9-T15"; a dash between words becomes ": " after
    a short label at sentence start ("Завершение \u2014 Нет.") and ", " elsewhere.
    """
    if not text:
        return text or ""
    s = re.sub(r"(T\d+)\s*[\u2013\u2014-]\s*(T\d+)", r"\1-\2", text)
    s = re.sub(r"(\d)\s*[\u2013\u2014]\s*(\d)", r"\1-\2", s)
    # label at the start of a sentence: "Завершение \u2014 Нет."
    s = re.sub(r"(^|[.!?]\s+)([^.!?\u2014\u2013]{1,60}?)\s+[\u2014\u2013]\s+", r"\1\2: ", s)
    s = _DASH.sub(", ", s)
    s = _ARROW.sub(" > ", s)
    return s
