#!/usr/bin/env python3
# news_daily.py — the once-a-day headline pull behind the watchlist.
#
# USAGE (from backend/):
#   ../.venv/bin/python scripts/news_daily.py                     full pull, 180 calls at most
#   ../.venv/bin/python scripts/news_daily.py --max-calls 5        a cheap probe
#   ../.venv/bin/python scripts/news_daily.py --symbols SPY,QQQ    one list only, no market-wide pass
#   ../.venv/bin/python scripts/news_daily.py --no-store           fetch and print, write nothing
#
# Two passes, cheapest first. Pass one asks for the symbols that are on
# somebody's watchlist, twenty to a request, so the news the app actually shows
# is always there however noisy the rest of the market was. Pass two walks the
# market-wide feed until the call budget runs out, which keeps symbols nobody
# watches yet warm for the day they get added.
#
# Every article is stored once in news_articles and inverted per symbol in
# news_symbols; the snapshot the app reads keeps only the newest --per-symbol
# headlines per ticker. Rows older than --days are pruned on the way out, so the
# window is five days of news rather than five days of growth.
#
# The keys come from ALPACA_API_KEY / ALPACA_SECRET_KEY. The free Basic plan
# allows 200 calls a minute for the whole account, which is why the default
# budget stops short of it and why the client paces its calls.

# -------- Imports --------
import argparse
import sys

from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import now_iso, require_alpaca
from app.news import alpaca
from app.turso import userdata

# The endpoint's per-page ceiling and our own sensible batching.
PAGE: int = alpaca.PAGE_LIMIT
BATCH: int = 20          # symbols per request in pass one
MAX_CALLS: int = 180     # of the account's 200 a minute, leaving room for everything else
PER_SYMBOL: int = 2      # headlines the app shows for one ticker
DAYS: int = 5            # rolling window kept in Turso
HOURS: int = 26          # pulled window: a day plus slack for a weekend gap


# -------- One Pass --------
# Both passes produce the same thing — normalized articles in, call count out —
# so the merging below never has to care which pass found what.
def collect(
    *,
    start: str,
    end: str,
    symbols: list[str] | None,
    label: str,
    max_calls: int,
    stop_when_empty: bool = False,
) -> tuple[list[dict[str, Any]], int, dict[str, int | None]]:
    """Fetch pages until the token or the budget runs out; returns (articles, calls, limits)."""
    found: list[dict[str, Any]] = []
    calls = 0
    limits: dict[str, int | None] = {}
    token: str | None = None

    while calls < max_calls:
        page = alpaca.fetch_page(
            start=start,
            end=end,
            symbols=symbols,
            page_token=token,
            limit=PAGE,
        )
        calls += 1
        limits = page.get("ratelimit") or limits
        for raw in page["news"]:
            article = alpaca.normalize(raw)
            if article is not None:
                found.append(article)
        token = page.get("next_page_token")
        print(f"  {label} page {calls}: {len(page['news'])} articles", flush=True)
        if not token:
            break
        # A short page means Alpaca had nothing else in this window for the set.
        if stop_when_empty and len(page["news"]) < PAGE:
            break

    return found, calls, limits


# -------- Summary --------
# The numbers that answer "did it work" without opening the database: how many
# calls went out, how many distinct tickers came back, and whether the symbols
# the app shows actually got covered.
def summarize(articles: list[dict[str, Any]], watch: list[str]) -> dict[str, Any]:
    by_id = {article["id"]: article for article in articles}
    symbols: set[str] = set()
    for article in by_id.values():
        symbols.update(article["symbols"])
    covered = watch and sum(1 for symbol in watch if symbol in symbols)
    return {
        "articles": len(by_id),
        "symbols": len(symbols),
        "watched": len(watch),
        "watched_covered": covered or 0,
    }


# -------- CLI --------
def main() -> int:
    parser = argparse.ArgumentParser(description="Pull Alpaca news into the watchlist tables.")
    parser.add_argument("--max-calls", type=int, default=MAX_CALLS,
                        help=f"cap on API calls for the whole run (default {MAX_CALLS})")
    parser.add_argument("--batch", type=int, default=BATCH,
                        help=f"watchlist symbols per request (default {BATCH})")
    parser.add_argument("--per-symbol", type=int, default=PER_SYMBOL,
                        help=f"headlines kept per ticker in the snapshot (default {PER_SYMBOL})")
    parser.add_argument("--days", type=int, default=DAYS,
                        help=f"days of news kept in Turso (default {DAYS})")
    parser.add_argument("--hours", type=int, default=HOURS,
                        help=f"hours of news pulled each run (default {HOURS})")
    parser.add_argument("--symbols", default="",
                        help="comma-separated symbols to pull instead of the watchlists")
    parser.add_argument("--no-store", action="store_true", help="fetch and print, write nothing")
    parser.add_argument("--no-prune", action="store_true", help="skip the rolling-window delete")
    args = parser.parse_args()

    require_alpaca()

    start, end = alpaca.window(args.hours)
    print(f"news window: {start} -> {end} ({args.hours}h)", flush=True)

    explicit = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    watch = explicit or userdata.watchlist_symbols()
    print(f"watchlists: {len(watch)} symbols", flush=True)

    budget = max(1, args.max_calls)
    articles: list[dict[str, Any]] = []
    calls = 0
    limits: dict[str, int | None] = {}

    # Pass one: the symbols the app renders, in batches, one page each. Fifty
    # newest articles across twenty tickers is more than enough for two each.
    for index in range(0, len(watch), args.batch):
        if calls >= budget:
            print(f"  budget spent ({budget} calls) before the watchlist was covered", flush=True)
            break
        group = watch[index:index + args.batch]
        found, used, seen = collect(
            start=start, end=end, symbols=group,
            label=f"watchlist {index // args.batch + 1}", max_calls=1,
        )
        articles.extend(found)
        calls += used
        limits = seen or limits

    # Pass two: the whole market, until the budget is gone. Skipped when the
    # caller named its own symbols, because then it asked a narrow question.
    if not explicit and calls < budget:
        try:
            found, used, seen = collect(
                start=start, end=end, symbols=None, label="market-wide",
                max_calls=budget - calls, stop_when_empty=True,
            )
            articles.extend(found)
            calls += used
            limits = seen or limits
        except alpaca.NewsError as err:
            # A dead market-wide pass must not lose the watchlist news already
            # fetched, so it is reported and the stored part still goes in.
            print(f"market-wide pass stopped early: {err}", flush=True)

    totals = summarize(articles, watch)
    print()
    print(f"calls: {calls} of {budget}")
    print(f"articles: {totals['articles']} across {totals['symbols']} symbols")
    if watch:
        print(f"watchlist coverage: {totals['watched_covered']}/{totals['watched']} symbols have news")
    if limits:
        # Alpaca's remaining counter is coarse and often still reads one less than
        # the limit after a short run, so it is reported rather than trusted.
        print(f"rate limit, as the last response reported it: "
              f"{limits.get('remaining')} of {limits.get('limit')} left")

    if not articles:
        print("nothing to store — Alpaca returned no articles for this window.")
        return 0

    if args.no_store:
        print("--no-store: nothing written.")
        return 0

    stored = userdata.upsert_news(articles, now_iso())
    userdata.record_news_run(
        window_start=start,
        window_end=end,
        calls=calls,
        articles=totals["articles"],
        symbols=totals["symbols"],
        watchlist_hits=totals["watched_covered"],
        note=f"store={stored} budget={budget}",
    )
    print(f"stored {stored} articles")

    if not args.no_prune:
        cutoff = userdata.prune_news(args.days)
        print(f"pruned everything older than {cutoff}")

    snapshot = userdata.news_snapshot(watch or None, per_symbol=args.per_symbol)
    rows = sum(len(items) for items in snapshot.values())
    print(f"snapshot: {len(snapshot)} symbols, {rows} headlines at {args.per_symbol} per symbol")
    stats = userdata.news_stats()
    print(f"window now holds {stats['articles']} articles over {stats['symbols']} symbols, "
          f"{stats['oldest']} -> {stats['newest']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except alpaca.NewsError as error:
        print(f"Alpaca refused the pull: {error}", file=sys.stderr)
        sys.exit(1)
