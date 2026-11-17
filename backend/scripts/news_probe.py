# news_probe.py — every headline Alpaca will give us, page by page.
#
# USAGE (from backend/, run the file, not -m):
#   ../.venv/bin/python scripts/news_probe.py
#   ../.venv/bin/python scripts/news_probe.py --calls 200 --days 30
#   ../.venv/bin/python scripts/news_probe.py --hours 72
#
# Note that the budget and the count are the same number: every call is fifty
# articles, so N calls can never return more than N*50 no matter how far back
# `start` reaches. A wider window does not buy more articles, it only decides
# whether the loop stops because Alpaca ran out or because you did.
#
# One endpoint, 50 articles a page, the page token from the last response passed
# into the next request. That is the whole loop: it stops when the token runs out
# or when the call budget does, and it prints each page as it arrives.
#
# ALPACA_API_KEY and ALPACA_SECRET_KEY come from the repo-root .env like every
# other script here.

# -------- Imports --------
import argparse
import os
import time

from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

# Repo-root .env, walking up so this survives being moved.
for parent in Path(__file__).resolve().parents:
    if (parent / ".env").is_file():
        load_dotenv(parent / ".env")
        break

URL = "https://data.alpaca.markets/v1beta1/news"
PAGE = 50  # Alpaca's hard maximum per call


# -------- One Call --------
def fetch(calls: int, hours: int, pause: float) -> None:
    key = os.environ.get("ALPACA_API_KEY") or ""
    secret = os.environ.get("ALPACA_SECRET_KEY") or ""
    if not key or not secret:
        raise SystemExit("Missing ALPACA_API_KEY / ALPACA_SECRET_KEY in .env")

    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    print(f"window {start.strftime('%Y-%m-%d %H:%M')} -> {end.strftime('%Y-%m-%d %H:%M')}Z, "
          f"{calls} calls of {PAGE} = {calls * PAGE} articles at most", flush=True)
    params = {
        "limit": PAGE,
        "sort": "desc",
        "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    seen = 0
    token = None
    for call in range(1, calls + 1):
        if token:
            params["page_token"] = token
        else:
            params.pop("page_token", None)

        response = requests.get(
            URL,
            params=params,
            headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
            timeout=20,
        )
        if response.status_code != 200:
            raise SystemExit(f"HTTP {response.status_code}: {response.text[:300]}")

        body = response.json() or {}
        news = body.get("news") or []
        seen += len(news)
        for article in news:
            symbols = ",".join(article.get("symbols") or []) or "-"
            print(f"{call:03d} {article['created_at'][:16]} {symbols:<28} {article['headline']}")

        token = body.get("next_page_token")
        print(f"--- call {call}: {len(news)} articles, {seen} so far, "
              f"more={'yes' if token else 'no'}")
        if not token:
            print("Alpaca has nothing older in this window. Stopping.")
            break
        time.sleep(pause)


# -------- CLI --------
def main() -> None:
    parser = argparse.ArgumentParser(description="Print Alpaca news, page by page.")
    parser.add_argument("--calls", type=int, default=35, help="how many calls to make at most")
    parser.add_argument("--hours", type=int, default=26, help="how far back to ask for")
    parser.add_argument("--days", type=int, default=0, help="same thing in days; wins when given")
    parser.add_argument("--pause", type=float, default=0.35, help="seconds between calls")
    args = parser.parse_args()
    hours = args.days * 24 if args.days else args.hours
    fetch(args.calls, hours, args.pause)


if __name__ == "__main__":
    main()
