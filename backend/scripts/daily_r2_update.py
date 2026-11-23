"""Daily R2 upsert for the market archive sltp 0.1.44 reads.

USAGE (from backend/):
  ../.venv/bin/python scripts/daily_r2_update.py   # cron/launchd runs this nightly

Layout, one directory per bundle market:

  MARKET_DATA/symbol_catalog.parquet          every symbol of every market
  MARKET_DATA/fx.parquet                      daily FX to USD (written elsewhere)
  MARKET_DATA/DAILY/US/1998-2002.bin          one bundle per five-year block
  MARKET_DATA/DAILY/US/recent.bin             the open year, rewritten nightly
  MARKET_DATA/DAILY/US/actions.parquet        splits and dividends
  MARKET_DATA/DAILY/INTERNATIONAL/…           the same shape for every foreign listing

A bundle is read for its header, never its name, so the five-year blocks are a
publishing convention rather than a format: 2028-2032 is created by the first
night that sees a 2028 session, and nothing in sltp or the site needs a change
for it.

Why a tail instead of rewriting the block: the open five-year block is ~200MB
per market, and a visitor re-downloads whatever changes. Rewriting 350MB every
night would cost every reader 350MB a night. The tail holds the current year
only (a few tens of MB), so a nightly update changes two small objects and the
browser fetches two small objects. On the first night of a new year the finished
year is folded into its block once and the tail keeps the new one.

A tail never overlaps the block it follows: it starts strictly after that
block's last session, which is the one rule sltp's discovery enforces.

Writes per night: the two tails, the actions sidecars when a payout occurred,
META/manifest.json and META/version.txt.
"""

import io
import json
import sys
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from pandas.tseries.holiday import (
    AbstractHolidayCalendar,
    DateOffset,
    Easter,
    Holiday,
    MO,
    USLaborDay,
    USMartinLutherKingJr,
    USMemorialDay,
    USThanksgivingDay,
    nearest_workday,
)
import yfinance as yf
from sltp.utils.Dates import EPOCH_ORDINAL, register

sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling r2.py / flat_bundle.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # app.notify

from app.notify.mailer import admin_recipient, ops_failure_email
from delist import SUSPECT_MIN_STALE_DAYS, review_and_strip, split_suspects
from flat_bundle import COLUMNS, build_flat_bundle, read_flat_bytes
from r2 import s3 as _s3

# The two bundle markets the archive publishes, in the order they are updated.
MARKETS = ("US", "INTERNATIONAL")
ROOT = "MARKET_DATA/DAILY"
TAIL_NAME = "recent.bin"
ACTIONS_NAME = "actions.parquet"
CATALOG_KEY = "MARKET_DATA/symbol_catalog.parquet"
FX_KEY = "MARKET_DATA/fx.parquet"
MANIFEST_KEY = "META/manifest.json"
VERSION_KEY = "META/version.txt"
# The archive starts here, and every five-year block is anchored to it.
BLOCK_START = 1998
BLOCK_YEARS = 5
BATCH = 400  # server peak-RAM rule: never one call with >500 tickers
# Set by --delist-review: the nightly bars still publish, but a delisting is
# only reported (verdicts, rows it would remove), never written.
DELIST_DRY_RUN = "--delist-review" in sys.argv


def _code_to_date(code: int) -> str:
    return date.fromordinal(int(code) + EPOCH_ORDINAL).isoformat()


def _key(market: str, name: str) -> str:
    return f"{ROOT}/{market}/{name}"


def _tail_key(market: str) -> str:
    return _key(market, TAIL_NAME)


def _actions_key(market: str) -> str:
    return _key(market, ACTIONS_NAME)


def block_bounds(year: int) -> tuple[int, int]:
    """The five-year block a year belongs to, anchored at 1998.

    2027 -> (2023, 2027); 2028 -> (2028, 2032). Anchoring at the archive's
    first year is what keeps the existing file names and makes the next block
    start where the last one ends, instead of at a round decade.
    """
    offset = max(0, int(year) - BLOCK_START) // BLOCK_YEARS
    start = BLOCK_START + offset * BLOCK_YEARS
    return start, start + BLOCK_YEARS - 1


def block_key(market: str, year: int) -> str:
    start, end = block_bounds(year)
    return _key(market, f"{start}-{end}.bin")


def _manifest() -> dict:
    return json.loads(_s3("GET", MANIFEST_KEY).decode())


def _entry(manifest: dict, key: str) -> dict | None:
    return next((entry for entry in manifest["files"] if entry["key"] == key), None)


def _ensure_entry(manifest: dict, key: str) -> dict:
    entry = _entry(manifest, key)
    if entry is None:
        entry = {"key": key, "rows": 0, "row_groups": 0}
        manifest["files"].append(entry)
    return entry


def _stamp(entry: dict, blob: bytes, header: dict) -> None:
    entry["bytes"] = len(blob)
    entry["rows"] = int(header["rows"])
    entry["first_session"] = header["first_session"]
    entry["last_session"] = header["last_session"]
    entry["row_groups"] = 0


def _read(key: str) -> tuple[pd.DataFrame, dict]:
    return read_flat_bytes(_s3("GET", key))


def _write(key: str, frame: pd.DataFrame, entry: dict) -> int:
    blob = build_flat_bundle(frame)
    decoded, header = read_flat_bytes(blob)
    assert len(decoded) == len(frame), (key, len(decoded), len(frame))
    _s3("PUT", key, blob)
    _stamp(entry, blob, header)
    return len(blob)


def _market_symbols(catalog: pd.DataFrame, market: str) -> tuple[list[str], dict[str, str]]:
    """Storage symbols for one bundle market, and their Yahoo download names.

    `Universe` says which directory the bars live in; `YahooSymbol` is the
    spelling Yahoo answers to, which differs for class shares (BRK-B) and for
    foreign listings that carry an exchange suffix. The catalog spelling is
    what gets stored, so a symbol can never fork between two directories.
    """
    wanted = catalog[catalog["Status"].isin(("active", "lagging"))]
    wanted = wanted[wanted["Universe"] == market]
    symbols = wanted["Symbol"].astype(str).tolist()
    if "YahooSymbol" in wanted.columns:
        yahoo = {
            str(symbol): (str(fallback).strip() or str(symbol))
            for symbol, fallback in zip(wanted["Symbol"], wanted["YahooSymbol"])
        }
    else:
        yahoo = {str(symbol): str(symbol).replace(".", "-") for symbol in symbols}
    return symbols, yahoo


def _last_session(manifest: dict, market: str) -> tuple[str, str | None]:
    """Newest session R2 holds for one market, and the tail key when there is one."""
    tail = _entry(manifest, _tail_key(market))
    if tail is not None and tail.get("last_session"):
        return str(tail["last_session"]), _tail_key(market)
    blocks = [
        entry
        for entry in manifest["files"]
        if entry["key"].startswith(f"{ROOT}/{market}/") and entry["key"].endswith(".bin")
    ]
    if not blocks:
        raise RuntimeError(f"the manifest holds no bundles for {market}")
    newest = max(blocks, key=lambda entry: str(entry.get("last_session") or ""))
    return str(newest["last_session"]), None


# -------- Freshness guard --------
# The update can finish cleanly and still learn nothing: yfinance answers
# happily with an empty frame, the merge keeps the old rows, last_session
# stays where it was, and the night looks green while the data ages. The guard
# asks the calendar what session should exist by now and fails when R2 is
# behind it, so an empty night becomes a red run instead of a silent one.
class _NyseClosed(AbstractHolidayCalendar):
    """Days the exchange does not trade, close enough for a freshness check.

    nearest_workday is the rule the exchange itself uses for New Year, July 4
    and Christmas: a Saturday holiday closes the Friday before, a Sunday one
    the Monday after. Unscheduled closures (a hurricane, a funeral) are not
    modelled, and they only ever make this check more forgiving.
    """

    rules = [
        Holiday("New Year's Day", month=1, day=1, observance=nearest_workday),
        USMartinLutherKingJr,
        Holiday("Washington's Birthday", month=2, day=1, offset=DateOffset(weekday=MO(3))),
        Holiday("Good Friday", month=1, day=1, offset=[Easter(), DateOffset(days=-2)]),
        USMemorialDay,
        Holiday("Juneteenth", month=6, day=19, observance=nearest_workday,
                start_date="2022-06-19"),
        Holiday("Independence Day", month=7, day=4, observance=nearest_workday),
        USLaborDay,
        USThanksgivingDay,
        Holiday("Christmas", month=12, day=25, observance=nearest_workday),
    ]


NY = ZoneInfo("America/New_York")


def expected_session(as_of: date | None = None) -> date:
    """The newest session whose closing bar should exist by now."""
    day = as_of or datetime.now(NY).date()
    closed = {
        stamp.date() for stamp in _NyseClosed().holidays(day - timedelta(days=45), day)
    }
    while day.weekday() >= 5 or day in closed:
        day -= timedelta(days=1)
    return day


def check_fresh(tolerance_days: int = 0) -> int:
    """Exit 1 when the bucket's newest US session is older than the calendar's."""
    manifest = _manifest()
    newest, _tail = _last_session(manifest, "US")
    wanted = expected_session()
    behind = (wanted - date.fromisoformat(newest)).days
    print(f"freshness: R2 last_session {newest}, calendar wants {wanted} "
          f"({behind} day(s) behind), version {manifest.get('version')}", flush=True)
    if behind > tolerance_days:
        print(f"STALE: the newest session is {newest} but {wanted} should be in "
              "R2 by now. The update ran without new bars — check whether Yahoo "
              "returned anything for the window before trusting tomorrow's numbers.",
              flush=True)
        return 1
    print("fresh: the bucket carries the session the calendar expects.", flush=True)
    return 0


def completed_years_in_tail(first_session: str, last_session: str) -> list[int]:
    """Finished calendar years a tail still carries, oldest first.

    A year is foldable only once the tail also carries a row from a later year,
    which is exactly the night after New Year's: it keeps the fold from leaving
    an empty tail over the holiday, when there is no new bar to anchor it.
    """
    first, last = date.fromisoformat(first_session), date.fromisoformat(last_session)
    return list(range(first.year, last.year))


# -------- Fold --------
def fold_year(year: int) -> int:
    """Move each market's completed-year rows out of its tail into its block."""
    manifest = _manifest()
    moved_any = False
    for market in MARKETS:
        tail_key = _tail_key(market)
        tail = _entry(manifest, tail_key)
        if tail is None:
            continue
        tail_frame, tail_header = _read(tail_key)
        start_code = int(register(np.array([f"{year}-01-01"]))[0])
        end_code = int(register(np.array([f"{year + 1}-01-01"]))[0])
        mask = (tail_frame["Date"] >= start_code) & (tail_frame["Date"] < end_code)
        moving, stay = tail_frame[mask], tail_frame[~mask]
        if moving.empty:
            continue
        key = block_key(market, year)
        block_entry = _entry(manifest, key)
        if block_entry is None:
            block = moving.iloc[0:0]
            block_entry = _ensure_entry(manifest, key)
            print(f"creating {key} from the tail's {year} rows", flush=True)
        else:
            block, _ = _read(key)
        merged = (pd.concat([block, moving], ignore_index=True)
                  .drop_duplicates(subset=["Symbol", "Date"], keep="last")
                  .sort_values(["Symbol", "Date"], kind="mergesort")
                  .reset_index(drop=True))
        for column in ("Date",):
            merged[column] = merged[column].astype("int32")
        for column in ("Open", "High", "Low", "Close", "Volume"):
            merged[column] = merged[column].astype("float32")
        print(f"{key}: {len(block)} -> {len(merged)} rows ({len(moving)} folded)", flush=True)
        _write(key, merged, block_entry)
        moved_any = True

        if stay.empty:
            # A tail cannot be empty, so the object and its entry go away until
            # the next session creates a new one.
            manifest["files"] = [e for e in manifest["files"] if e["key"] != tail_key]
            try:
                _s3("DELETE", tail_key)
            except Exception as exc:  # noqa: BLE001 - a stale empty object is harmless
                print(f"could not delete the emptied tail {tail_key}: {exc}", flush=True)
        else:
            stay = stay[COLUMNS].reset_index(drop=True)
            stay["Date"] = stay["Date"].astype("int32")
            for column in ("Open", "High", "Low", "Close", "Volume"):
                stay[column] = stay[column].astype("float32")
            _write(tail_key, stay, tail)

    if not moved_any:
        print(f"nothing to fold for {year}.", flush=True)
        return 0
    _publish(manifest, version=max(str(manifest.get("version", "")), date.today().isoformat()))
    return 0


def fold_completed_years() -> int:
    """The once-a-year chore, called by main() before it touches a tail."""
    manifest = _manifest()
    status = 0
    for market in MARKETS:
        tail = _entry(manifest, _tail_key(market))
        if tail is None or not tail.get("first_session") or not tail.get("last_session"):
            continue
        for year in completed_years_in_tail(tail["first_session"], tail["last_session"]):
            print(f"{market}: the tail still carries {year}; folding it into its block",
                  flush=True)
            status = fold_year(year)
            if status != 0:
                return status
            manifest = _manifest()
    return status


def _publish(manifest: dict, version: str) -> None:
    """Write the manifest and its version marker, and prove both took."""
    manifest["version"] = version
    manifest["updated"] = date.today().isoformat()
    manifest["files"].sort(key=lambda entry: entry["key"])
    _s3("PUT", MANIFEST_KEY, json.dumps(manifest, indent=1).encode())
    _s3("PUT", VERSION_KEY, f"{version}\n".encode())
    verify = json.loads(_s3("GET", MANIFEST_KEY).decode())
    text = _s3("GET", VERSION_KEY).decode().strip()
    assert verify["version"] == version == text, (verify["version"], version, text)


# -------- Download --------
def _download(catalog: pd.DataFrame, market: str, start: str, end: str,
              names: dict[str, str]) -> tuple[list[pd.DataFrame], list[pd.DataFrame], set[str]]:
    """New bars and corporate actions for one market's active symbols.

    The third return is the symbols Yahoo actually answered with bars for.
    Anything that asked for data and got none is a suspect, and the delisting
    pass verifies each one before any of its history is touched.
    """
    symbols = list(names)
    frames: list[pd.DataFrame] = []
    action_frames: list[pd.DataFrame] = []
    seen: set[str] = set()
    for offset in range(0, len(symbols), BATCH):
        chunk = symbols[offset:offset + BATCH]
        # Several catalog spellings can share one Yahoo download (BRK.B and
        # BRK-B both answer to BRK-B): fetch each spelling once, fan the bars
        # out to every catalog symbol that maps to it.
        wanted: dict[str, list[str]] = {}
        for symbol in chunk:
            wanted.setdefault(names.get(symbol, symbol), []).append(symbol)
        download = list(wanted)
        df = yf.download(download, start=start, end=end, group_by="column",
                         auto_adjust=False, actions=True, progress=False, threads=True)
        if df is None or df.empty:
            continue
        for download_symbol in download:
            try:
                sub = df.xs(download_symbol, axis=1, level=1)
            except KeyError:
                continue
            sub = sub[sub["Close"].notna()]
            if sub.empty:
                continue
            index = sub.index.tz_localize(None) if sub.index.tz is not None else sub.index
            codes = register(index.strftime("%Y-%m-%d").to_numpy())
            bars = pd.DataFrame({
                "Date": codes,
                "Open": sub["Open"].to_numpy(dtype="float32"),
                "High": sub["High"].to_numpy(dtype="float32"),
                "Low": sub["Low"].to_numpy(dtype="float32"),
                "Close": sub["Close"].to_numpy(dtype="float32"),
                "Volume": sub["Volume"].to_numpy(dtype="float32"),
            })
            for symbol in wanted[download_symbol]:
                frame = bars.copy()
                frame["Symbol"] = symbol
                frames.append(frame[COLUMNS])
                seen.add(symbol)
            # Payouts ride in the same download (actions=True above): ex-date
            # cash (Kind 1) and split ratios (Kind 0).
            for kind, column in ((1, "Dividends"), (0, "Stock Splits")):
                nonzero = sub[column].fillna(0).to_numpy() != 0
                if not nonzero.any():
                    continue
                amounts = sub[column].to_numpy(dtype="float64")[nonzero]
                for symbol in wanted[download_symbol]:
                    action_frames.append(pd.DataFrame({
                        "Symbol": symbol,
                        "Date": codes[nonzero],
                        "Kind": kind,
                        "Amount": amounts,
                    }))
        batch = offset // BATCH + 1
        total = (len(symbols) + BATCH - 1) // BATCH
        unanswered = len(chunk) - sum(1 for symbol in chunk if symbol in seen)
        print(f"  {market} batch {batch}/{total}: {len(frames)} blocks, "
              f"{unanswered} symbol(s) with no bars", flush=True)
    return frames, action_frames, seen


def update_market(manifest: dict, catalog: pd.DataFrame, market: str,
                  unanswered_out: dict[str, list[str]] | None = None) -> bool:
    """One market's nightly upsert. Returns True when it wrote new bars."""
    old_last, tail_key = _last_session(manifest, market)
    tail_key = tail_key or _tail_key(market)
    tail_entry = _entry(manifest, tail_key)
    if tail_entry is not None and tail_key.endswith(f"/{TAIL_NAME}"):
        tail, header = _read(tail_key)
        old_last = str(header["last_session"])
    else:
        tail = None
    print(f"{market}: newest session {old_last}, tail {'present' if tail is not None else 'new'}",
          flush=True)

    symbols, yahoo = _market_symbols(catalog, market)
    if not symbols:
        print(f"{market}: no active symbols in the catalog; nothing to do.", flush=True)
        return False
    start = (date.fromisoformat(old_last) - timedelta(days=4)).isoformat()
    end = (date.today() + timedelta(days=1)).isoformat()
    print(f"{market}: {len(symbols)} symbols, window {start} -> {end}", flush=True)
    frames, action_frames, seen = _download(catalog, market, start, end, yahoo)
    if unanswered_out is not None:
        # A halted name also misses a short window, so this is a list of
        # suspects, not verdicts: delist.review asks about each one and only a
        # confirmed answer, after a grace period, removes anything. A name that
        # traded within the staleness window is not even a suspect — that is
        # how a long weekend or a two-day halt stays out of the ledger.
        # The evidence is the bundle headers, not the catalog: a catalog built
        # weeks ago cannot say whether a line traded this week.
        suspects, recent = split_suspects(catalog, market, sorted(set(symbols) - seen),
                                          manifest=manifest)
        unanswered_out[market] = suspects
        if recent:
            shown = ", ".join(recent[:8]) + ("…" if len(recent) > 8 else "")
            print(f"{market}: {len(recent)} symbol(s) with no bars but a bar within "
                  f"{SUSPECT_MIN_STALE_DAYS} days — not suspects: {shown}", flush=True)
    if not frames:
        print(f"{market}: no new bars — R2 already current.", flush=True)
        return False

    new = pd.concat(frames, ignore_index=True)
    new["Date"] = new["Date"].astype("int32")
    new_max = _code_to_date(int(new["Date"].max()))
    if new_max <= old_last:
        print(f"{market}: no sessions newer than {old_last} — nothing written.", flush=True)
        return False

    if tail is None:
        tail = new.iloc[0:0]
    merged = (pd.concat([tail[COLUMNS], new[COLUMNS]], ignore_index=True)
              .drop_duplicates(subset=["Symbol", "Date"], keep="last")
              .sort_values(["Symbol", "Date"], kind="mergesort")
              .reset_index(drop=True))
    merged["Date"] = merged["Date"].astype("int32")
    for column in ("Open", "High", "Low", "Close", "Volume"):
        merged[column] = merged[column].astype("float32")
    added = [stamp for stamp in sorted(new["Date"].map(_code_to_date).unique())
             if stamp > old_last]
    print(f"{market}: tail {0 if tail.empty else len(tail)} -> {len(merged)} rows; "
          f"new sessions {added}", flush=True)

    tail_entry = _ensure_entry(manifest, tail_key)
    size = _write(tail_key, merged, tail_entry)
    print(f"{market}: wrote {tail_key} ({size} bytes)", flush=True)

    if action_frames:
        anew = pd.concat(action_frames, ignore_index=True)
        anew["Date"] = anew["Date"].astype("int32")
        key = _actions_key(market)
        entry = _ensure_entry(manifest, key)
        try:
            old = pd.read_parquet(io.BytesIO(_s3("GET", key)))
        except Exception:  # noqa: BLE001 - a missing sidecar starts from empty
            old = anew.iloc[0:0]
        for column in ("Kind", "Amount"):
            anew[column] = anew[column].astype(old[column].dtype)
        merged_actions = (pd.concat([old, anew], ignore_index=True)
                          .drop_duplicates(subset=["Symbol", "Date", "Kind"], keep="last")
                          .sort_values(["Symbol", "Date", "Kind"])
                          .reset_index(drop=True))
        buffer = io.BytesIO()
        merged_actions.to_parquet(buffer, engine="pyarrow", compression="snappy", index=False)
        blob = buffer.getvalue()
        _s3("PUT", key, blob)
        entry["bytes"] = len(blob)
        entry["rows"] = len(merged_actions)
        entry["first_session"] = _code_to_date(int(merged_actions["Date"].min()))
        entry["last_session"] = _code_to_date(int(merged_actions["Date"].max()))
        entry["row_groups"] = pq.ParquetFile(io.BytesIO(blob)).num_row_groups
        print(f"{market}: actions {len(old)} -> {len(merged_actions)} rows", flush=True)
    return True


def main() -> int:
    # January's chore first, so the night's bars land in a tail that holds only
    # the new year. A failure here must not cost the night's data: the update
    # still runs and the error is raised at the end, which mails the operator.
    fold_error: str | None = None
    try:
        if fold_completed_years() != 0:
            fold_error = "folding a completed year failed; see the log above"
    except Exception as exc:  # noqa: BLE001 - reported after the update
        fold_error = f"folding a completed year failed: {exc}"

    manifest = _manifest()
    catalog = pd.read_parquet(io.BytesIO(_s3("GET", CATALOG_KEY)))
    print(f"catalog: {len(catalog)} symbols across "
          f"{sorted(catalog['Universe'].dropna().unique())}", flush=True)

    wrote = False
    newest: list[str] = []
    # Symbols Yahoo answered nothing for, per market. The delisting pass below
    # treats each as a suspect and verifies it before any history is touched.
    unanswered: dict[str, list[str]] = {}
    for market in MARKETS:
        if update_market(manifest, catalog, market, unanswered):
            wrote = True
        newest.append(_last_session(manifest, market)[0])

    text = str(manifest.get("version") or "")
    if wrote:
        version = max(max(newest), str(manifest.get("version", "")))
        _publish(manifest, version)
        # Prove the two writes a browser actually reads.
        verify = json.loads(_s3("GET", MANIFEST_KEY).decode())
        text = _s3("GET", VERSION_KEY).decode().strip()
        assert verify["version"] == version == text, (verify["version"], text)
        for market in MARKETS:
            entry = _entry(verify, _tail_key(market))
            if entry is not None:
                print(f"Done: {market} tail {entry['first_session']} -> "
                      f"{entry['last_session']}, {entry['rows']} rows, {entry['bytes']} bytes")
        print(f"Done: version {text}, {len(verify['files'])} manifest entries.")
    else:
        print("nothing written; the manifest already carries tonight's sessions.")

    # The night's bars land first, so a delisting that fails cannot cost the
    # data: the review reads what was just published and only removes symbols
    # that are confirmed and past their grace period.
    delist_error: str | None = None
    try:
        removed = review_and_strip(catalog, unanswered, dry_run=DELIST_DRY_RUN)
        if removed:
            print(f"Done: {removed} rows removed for delisted symbols.")
    except Exception as exc:  # noqa: BLE001 - reported at the end, after the data
        delist_error = f"delisting review failed: {exc}"
        print(delist_error, flush=True)

    if fold_error:
        raise RuntimeError(fold_error)
    if delist_error:
        raise RuntimeError(delist_error)
    return 0


# A nightly cron job fails unseen, so a crash mails the operator through
# mailer (the only module that sends mail). Best-effort: the alert never
# masks the original traceback or exit code.
def _alert_admin() -> None:
    try:
        to = admin_recipient()
        if not to:
            print("no admin address (set ADMIN_EMAIL or SENDER_EMAIL) — no alert sent.")
            return
        ok, err = ops_failure_email(to, "daily_r2_update", traceback.format_exc(limit=8))
        print(f"alert mailed to {to}" if ok else f"alert FAILED: {err}")
    except Exception as exc:  # alerting must not raise
        print(f"alert FAILED: {exc}")


if __name__ == "__main__":
    if "--check-fresh" in sys.argv:
        pos = sys.argv.index("--check-fresh")
        tolerance = 0
        if len(sys.argv) > pos + 1 and sys.argv[pos + 1].isdigit():
            tolerance = int(sys.argv[pos + 1])
        try:
            sys.exit(check_fresh(tolerance))
        except Exception:
            _alert_admin()
            raise
    if "--strip-delisted" in sys.argv:
        # Clear a backlog without another download: the archive already holds
        # the verdicts, so this is just the removal they are owed.
        from delist import strip_due
        try:
            sys.exit(strip_due(dry_run=DELIST_DRY_RUN))
        except Exception:
            _alert_admin()
            raise
    if "--fold-completed" in sys.argv:
        try:
            sys.exit(fold_completed_years())
        except Exception:
            _alert_admin()
            raise
    if "--fold-year" in sys.argv:
        pos = sys.argv.index("--fold-year")
        try:
            fold_target = int(sys.argv[pos + 1])
        except (IndexError, ValueError):
            print("usage: daily_r2_update.py [--fold-year YYYY]")
            sys.exit(2)
        try:
            sys.exit(fold_year(fold_target))
        except Exception:
            _alert_admin()
            raise
    try:
        sys.exit(main())
    except Exception:
        _alert_admin()
        raise
