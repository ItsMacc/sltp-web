# news_probe.py — five days of headlines, one line per tradable ticker.
#
# USAGE (from backend/):
#   ../.venv/bin/python scripts/news_probe.py
#
# pull_news() walks Alpaca's news pages from five days ago to now, at fifty
# articles a page, and stops at CALL_CAP calls or when the feed runs dry. Every
# article is expanded into its symbols; a line is emitted only for symbols that
# exist in MARKET_DATA/symbol_catalog.parquet as active or lagging, and only
# when the article actually has content. Nothing is stored: the function returns
# the lines and __main__ prints them.
#
# Fields are separated by ";", so the content is flattened onto one line first.
# Alpaca's free news feed leaves `content` empty on every article and fills only
# `summary`, so the body line falls back to the summary; without that fallback
# the empty-content rule skips the entire feed.

# -------- Imports --------
import io
import os
import sys
import time

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

from r2 import s3  # noqa: E402 - loads the repo-root .env on import

# -------- Constants --------
URL = "https://data.alpaca.markets/v1beta1/news"
CATALOG_KEY = "MARKET_DATA/symbol_catalog.parquet"
PAGE = 50                  # Alpaca's hard maximum per call
CALL_CAP = 190             # five days has never needed more
DAYS = 5
PAUSE = 0.35               # seconds between calls, well inside 200/minute
TRADABLE = ("active", "lagging")


# -------- Catalogue --------
def catalogue() -> set[str]:
    """The tickers we have bars for, from the same catalogue the nightly job reads."""
    frame = pd.read_parquet(io.BytesIO(s3("GET", CATALOG_KEY)))
    return {str(row.Symbol).upper() for row in frame.itertuples()
            if str(row.Status).lower() in TRADABLE}


# -------- The Pull --------
def pull_news(days: int = DAYS, cap: int = CALL_CAP) -> list[str]:
    """Returns `TICKER;DATE;HEADLINE;CONTENT` lines for the last `days` days."""
    key = os.environ.get("ALPACA_API_KEY") or ""
    secret = os.environ.get("ALPACA_SECRET_KEY") or ""
    if not key or not secret:
        raise RuntimeError("Missing ALPACA_API_KEY / ALPACA_SECRET_KEY in .env")

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    params = {
        "limit": PAGE,
        "sort": "desc",
        "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
    known = catalogue()

    lines: list[str] = []
    token = None
    for call in range(1, cap + 1):
        if token:
            params["page_token"] = token
        else:
            params.pop("page_token", None)

        response = requests.get(URL, params=params, headers=headers, timeout=30)
        if response.status_code != 200:
            raise RuntimeError(f"Alpaca HTTP {response.status_code}: {response.text[:300]}")

        body = response.json() or {}
        for article in body.get("news") or []:
            content = " ".join((article.get("content") or article.get("summary") or "").split())
            if not content:
                continue
            headline = " ".join((article.get("headline") or "").split())
            day = (article.get("created_at") or "")[:10]
            for symbol in article.get("symbols") or []:
                if symbol.upper() in known:
                    lines.append(f"{symbol};{day};{headline};{content}")

        token = body.get("next_page_token")
        if not token:
            break
        time.sleep(PAUSE)

    return lines


# -------- Entry --------
if __name__ == "__main__":
    print("\n".join(pull_news()))
