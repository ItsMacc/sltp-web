# alpaca.py — Alpaca's news endpoint over plain HTTP.
#
# One endpoint, GET /v1beta1/news, at most fifty articles a page, no SDK. The
# raw call is deliberate: it keeps the rate-limit headers visible, and those are
# the only honest way to know how much of the account's two hundred calls a
# minute is left instead of trusting a constant in a config file.
#
# The endpoint's own defaults are unhelpful for a once-a-day pull — start is the
# beginning of the current day, end is now minus fifteen minutes on the free
# plan — so every window here is passed explicitly and the caller owns it.
#
# Nothing in this file stores anything. Normalization stops at the columns the
# database wants; the script decides what to keep.

# -------- Imports --------
import time

from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from app.config import (
    ALPACA_DATA_URL,
    ALPACA_KEY_ID,
    ALPACA_SECRET,
    NEWS_TIMEOUT,
)

PAGE_LIMIT: int = 50          # the endpoint's hard maximum, enforced server-side
MIN_INTERVAL: float = 0.4     # between calls: about 150 a minute, under the 200 cap
MAX_RETRIES: int = 2
NEWS_PATH: str = "/v1beta1/news"


# -------- Errors --------
# A non-200 gets its own type so the runner can tell "Alpaca said no" apart from
# a bug in our own code, and print the body Alpaca sent instead of a bare 400.
class NewsError(RuntimeError):
    """Alpaca answered the news request with something other than 200."""


# -------- Auth --------
def _headers() -> dict[str, str]:
    return {
        "APCA-API-KEY-ID": ALPACA_KEY_ID,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
        "Accept": "application/json",
    }


# -------- Window --------
# Default: a day plus slack. The slack is what makes a Monday run cover a
# weekend, and it costs nothing because the endpoint returns the newest first.
def window(hours: int = 26) -> tuple[str, str]:
    """The RFC3339 start and end of the pull, UTC."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    stamp = "%Y-%m-%dT%H:%M:%SZ"
    return start.strftime(stamp), end.strftime(stamp)


# -------- One Page --------
def fetch_page(
    *,
    start: str,
    end: str,
    symbols: list[str] | None = None,
    page_token: str | None = None,
    limit: int = PAGE_LIMIT,
    timeout: int = NEWS_TIMEOUT,
) -> dict[str, Any]:
    """One request as {"news": [...], "next_page_token": str | None, "ratelimit": {...}}.

    Retries a 429 once it knows when the window resets, and any 5xx twice with a
    growing pause. Anything else raises immediately: a 401 is a key problem and
    another attempt cannot fix it.
    """
    params: dict[str, Any] = {
        "start": start,
        "end": end,
        "limit": min(limit, PAGE_LIMIT),
        "sort": "desc",
    }
    if symbols:
        params["symbols"] = ",".join(symbols)
    if page_token:
        params["page_token"] = page_token

    pause = MIN_INTERVAL
    last_error: str = ""
    for attempt in range(MAX_RETRIES + 1):
        time.sleep(pause)
        try:
            response = requests.get(
                f"{ALPACA_DATA_URL}{NEWS_PATH}",
                params=params,
                headers=_headers(),
                timeout=timeout,
            )
        except Exception as e:  # noqa: BLE001 - network failure reads as a retryable miss
            last_error = f"network: {e}"
            pause = MIN_INTERVAL * (attempt + 2)
            continue

        limits = _ratelimit(response)
        if response.status_code == 200:
            body = response.json() or {}
            return {
                "news": body.get("news") or [],
                "next_page_token": body.get("next_page_token") or None,
                "ratelimit": limits,
            }

        body = (response.text or "")[:300]
        if response.status_code == 429:
            # Spend exactly as long as Alpaca asked for, then try again once.
            last_error = f"429 {body}"
            pause = min(_reset_seconds(response), 30.0)
            continue
        if response.status_code >= 500:
            last_error = f"{response.status_code} {body}"
            pause = MIN_INTERVAL * (attempt + 2)
            continue
        raise NewsError(f"Alpaca news {response.status_code}: {body}")

    raise NewsError(f"Alpaca news failed after {MAX_RETRIES + 1} attempts: {last_error}")


# -------- Rate-Limit Headers --------
# Alpaca spells them X-RateLimit-* (the docs' OpenAPI calls them ratelimit_*),
# so both spellings are read rather than betting on one.
def _ratelimit(response: requests.Response) -> dict[str, int | None]:
    def number(name: str) -> int | None:
        raw = response.headers.get(f"X-RateLimit-{name}") or response.headers.get(f"ratelimit_{name.lower()}")
        try:
            return int(raw) if raw is not None else None
        except ValueError:
            return None

    return {"limit": number("Limit"), "remaining": number("Remaining"), "reset": number("Reset")}


def _reset_seconds(response: requests.Response) -> float:
    """How long the rate-limit window still has to run, in seconds."""
    raw = response.headers.get("X-RateLimit-Reset") or response.headers.get("ratelimit_reset")
    try:
        reset = int(raw) if raw is not None else 0
    except ValueError:
        return MIN_INTERVAL * 2
    remaining = reset - int(time.time())
    return float(min(max(remaining, 1), 30))


# -------- Normalization --------
# The stored shape, one article. `content` is dropped on purpose: it is HTML,
# often truncated, and nothing in the app reads it — the url is the way to it.
def normalize(article: dict[str, Any]) -> dict[str, Any] | None:
    """One API article as our columns, or None when it has no id or headline."""
    identifier = article.get("id")
    headline = (article.get("headline") or "").strip()
    if identifier is None or not headline:
        return None

    symbols = [
        str(symbol).strip().upper()
        for symbol in (article.get("symbols") or [])
        if str(symbol).strip()
    ]
    return {
        "id": str(identifier),
        "headline": headline,
        "summary": (article.get("summary") or "").strip(),
        "author": (article.get("author") or "").strip(),
        "source": (article.get("source") or "").strip(),
        "url": (article.get("url") or "").strip() or None,
        "image": _first_image(article.get("images")),
        "symbols": symbols,
        "created_at": _stamp(article.get("created_at")),
        "updated_at": _stamp(article.get("updated_at") or article.get("created_at")),
    }


def _first_image(images: Any) -> str | None:
    if not isinstance(images, list):
        return None
    for image in images:
        url = ((image or {}).get("url") or "").strip()
        if url:
            return url
    return None


# One timestamp spelling for the whole table, so ORDER BY is a string compare.
# Alpaca sends "...Z"; anything else is rewritten to it, and an unparseable
# stamp is kept verbatim rather than silently becoming "now".
def _stamp(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text[:-6] + "Z" if text.endswith("+00:00") else text
