"""Daily R2 upsert: newest Yahoo sessions straight into the flat recent bundle.

USAGE (from backend/):
  ../.venv/bin/python scripts/daily_r2_update.py   # cron/launchd runs this nightly

Reads the manifest + catalog + MARKET_DAILY/market_data_recent.bin, downloads
only the missing window (plus a 2-session buffer) for active/lagging tickers,
merges with dedup keep-last, tops up the actions sidecar with the window's
dividends/splits when the window held any, and makes these writes:

  1. MARKET_DAILY/market_data_recent.bin (self-contained flat bundle)
  2. MARKET_DAILY/market_actions.parquet (only when payouts occurred)
  3. META/manifest.json (entry bytes/rows/last_session + version + updated)
  4. META/version.txt (same version string)

The .bin format is: 24-byte preamble (magic SLTPFLAT, format 1, header_len,
rows), embedded JSON header, then sym u16 / date u16 / OHLCV f32 arrays.
There is no separate index.json.

After the nightly run, add this to fail the night that learned nothing:
  ../.venv/bin/python scripts/daily_r2_update.py --check-fresh

Yearly chore (run each January after the year settles):
  ../.venv/bin/python scripts/daily_r2_update.py --fold-year 2026
moves the tail's rows from that completed calendar year into
MARKET_DAILY/market_data_2026.bin, rewrites the tail with the remaining
rows, and updates both manifest entries plus the version.

Stdlib SigV4 for R2; yfinance + pandas + pyarrow for data. Idempotent.
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
from flat_bundle import COLUMNS, build_flat_bundle, read_flat_bytes
from r2 import s3 as _s3

TAIL_KEY = "MARKET_DAILY/market_data_recent.bin"
TAIL_PARQUET = "MARKET_DAILY/market_data_recent.parquet"
ACTIONS_KEY = "MARKET_DAILY/market_actions.parquet"
CATALOG_KEY = "SYMBOL_DATA/symbol_catalog.parquet"
MANIFEST_KEY = "META/manifest.json"
VERSION_KEY = "META/version.txt"
BATCH = 400  # server peak-RAM rule: never one call with >500 tickers


def _code_to_date(code: int) -> str:
    return date.fromordinal(int(code) + EPOCH_ORDINAL).isoformat()


def _yahoo_symbol(symbol: str) -> str:
    """Download spelling for one catalog symbol.

    Yahoo wants US class shares hyphenated (BRK-A) but Canadian listings
    keep the dot suffix (XEQT.TO). Storage always uses the catalog
    spelling — this mapping lives at the download boundary only, because
    renaming stored tickers would fork twenty years of bars."""
    if symbol.endswith(".TO"):
        return symbol
    return symbol.replace(".", "-")


def _read_tail(manifest: dict) -> tuple[pd.DataFrame, dict, dict | None]:
    """Read the current tail, preferring the flat .bin and falling back to the
    retired parquet tail for one transition run."""
    entry = next((e for e in manifest["files"] if e["key"] == TAIL_KEY), None)
    if entry is not None:
        frame, header = read_flat_bytes(_s3("GET", TAIL_KEY))
        return frame, entry, header
    old_entry = next((e for e in manifest["files"] if e["key"] == TAIL_PARQUET), None)
    if old_entry is None:
        raise RuntimeError(f"manifest has neither {TAIL_KEY} nor {TAIL_PARQUET}")
    frame = pd.read_parquet(io.BytesIO(_s3("GET", TAIL_PARQUET)))
    frame["Date"] = frame["Date"].astype("int32")
    return frame[COLUMNS].copy(), old_entry, None


def _tail_entry(manifest: dict) -> dict:
    entry = next((e for e in manifest["files"] if e["key"] == TAIL_KEY), None)
    if entry is None:
        entry = {"key": TAIL_KEY, "row_groups": 0}
        manifest["files"].append(entry)
    # The retired parquet tail must not keep a duplicate manifest entry.
    manifest["files"] = [e for e in manifest["files"] if e["key"] != TAIL_PARQUET]
    return entry


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
    """Exit 1 when the bucket's newest session is older than the calendar's."""
    manifest = json.loads(_s3("GET", MANIFEST_KEY).decode())
    entry = next((e for e in manifest["files"] if e["key"] == TAIL_KEY), None)
    if entry is None:
        print(f"STALE: the manifest has no {TAIL_KEY} entry.")
        return 1
    newest = date.fromisoformat(entry["last_session"])
    wanted = expected_session()
    behind = (wanted - newest).days
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


def main() -> int:
    manifest = json.loads(_s3("GET", MANIFEST_KEY).decode())
    old, entry, header = _read_tail(manifest)
    old_last = (header or {}).get("last_session") or entry["last_session"]
    print(f"tail on R2: {entry['first_session']} -> {old_last}, {len(old)} rows", flush=True)

    catalog = pd.read_parquet("/tmp/catalog.parquet") if Path("/tmp/catalog.parquet").is_file() \
        else pd.read_parquet(io.BytesIO(_s3("GET", CATALOG_KEY)))
    tradable = catalog[catalog["Status"].isin(("active", "lagging"))]
    symbols: list[str] = tradable["Symbol"].tolist()
    names = dict(zip(tradable["Symbol"], tradable["Name"]))
    print(f"universe: {len(symbols)} symbols (active+lagging)", flush=True)

    # Missing window with a 2-session buffer so a partial day heals itself.
    start = (date.fromisoformat(old_last) - timedelta(days=4)).isoformat()
    end = (date.today() + timedelta(days=1)).isoformat()
    print(f"window: {start} -> {end}", flush=True)

    frames: list[pd.DataFrame] = []
    action_frames: list[pd.DataFrame] = []
    for i in range(0, len(symbols), BATCH):
        chunk = symbols[i:i + BATCH]
        # Several catalog spellings can share one Yahoo download (the catalog
        # holds both BRK.B and BRK-B): fetch each spelling once, fan the bars
        # out to every catalog symbol that maps to it. Storage keeps the
        # catalog spelling, so no series ever forks or merges.
        want: dict[str, list[str]] = {}
        for s in chunk:
            want.setdefault(_yahoo_symbol(s), []).append(s)
        dl = list(want)
        df = yf.download(dl, start=start, end=end, group_by="column",
                         auto_adjust=False, actions=True, progress=False, threads=True)
        if df is None or df.empty:
            continue
        for dl_sym in dl:
            try:
                sub = df.xs(dl_sym, axis=1, level=1)
            except KeyError:
                continue
            sub = sub[sub["Close"].notna()]
            if sub.empty:
                continue
            idx = sub.index.tz_localize(None) if sub.index.tz is not None else sub.index
            bars = pd.DataFrame({
                "Date": register(idx.strftime("%Y-%m-%d").to_numpy()),
                "Open": sub["Open"].to_numpy(dtype="float32"),
                "High": sub["High"].to_numpy(dtype="float32"),
                "Low": sub["Low"].to_numpy(dtype="float32"),
                "Close": sub["Close"].to_numpy(dtype="float32"),
                "Volume": sub["Volume"].to_numpy(dtype="float32"),
            })
            for ticker in want[dl_sym]:
                frame = bars.copy()
                frame["Symbol"] = ticker
                frame["Name"] = names.get(ticker, ticker)
                frames.append(frame[["Symbol", "Name", "Date", "Open",
                                      "High", "Low", "Close", "Volume"]])
            # Payouts ride in the same download (actions=True above): ex-date
            # cash (Kind 1) and split ratios (Kind 0), stored under the
            # catalog spelling like the bars.
            adates = register(idx.strftime("%Y-%m-%d").to_numpy())
            for kind, col in ((1, "Dividends"), (0, "Stock Splits")):
                nz = sub[col].fillna(0).to_numpy() != 0
                if not nz.any():
                    continue
                amounts = sub[col].to_numpy(dtype="float64")[nz]
                for ticker in want[dl_sym]:
                    action_frames.append(pd.DataFrame({
                        "Symbol": ticker,
                        "Date": adates[nz],
                        "Kind": kind,
                        "Amount": amounts,
                    }))
        print(f"  batch {i // BATCH + 1}/{(len(symbols) + BATCH - 1) // BATCH}: {len(frames)} blocks", flush=True)

    if not frames:
        print("no new bars — R2 already current, nothing written.")
        return 0
    new = pd.concat(frames, ignore_index=True)
    new["Date"] = new["Date"].astype("int32")
    new_max = _code_to_date(int(new["Date"].max()))
    if new_max <= old_last:
        print(f"no sessions newer than {old_last} — nothing written.")
        return 0
    print(f"downloaded sessions through {new_max}", flush=True)

    merged = (pd.concat([old[COLUMNS], new[COLUMNS]], ignore_index=True)
              .drop_duplicates(subset=["Symbol", "Date"], keep="last")
              .sort_values(["Symbol", "Date"], kind="mergesort")
              .reset_index(drop=True))
    merged["Date"] = merged["Date"].astype("int32")
    for col in ("Open", "High", "Low", "Close", "Volume"):
        merged[col] = merged[col].astype("float32")
    added = [s for s in sorted(new["Date"].map(_code_to_date).unique()) if s > old_last]
    print(f"tail {len(old)} -> {len(merged)} rows; new sessions: {added}", flush=True)
    print("spot check:\n" + merged[merged["Symbol"] == "AAPL"].tail(3).to_string(), flush=True)

    blob = build_flat_bundle(merged)
    decoded, decoded_header = read_flat_bytes(blob)
    assert len(decoded) == len(merged)
    assert decoded_header["last_session"] == new_max
    print(f"write check: {len(blob)} bytes, {len(merged)} rows, "
          f"{decoded_header['first_session']} -> {decoded_header['last_session']}", flush=True)

    entry = _tail_entry(manifest)
    _s3("PUT", TAIL_KEY, blob)  # write 1: the flat tail
    entry["bytes"] = len(blob)
    entry["rows"] = len(merged)
    entry["first_session"] = decoded_header["first_session"]
    entry["last_session"] = new_max
    entry["row_groups"] = 0
    if action_frames:
        anew = pd.concat(action_frames, ignore_index=True)
        anew["Date"] = anew["Date"].astype("int32")
        aold = pd.read_parquet(io.BytesIO(_s3("GET", ACTIONS_KEY)))
        for col in ("Kind", "Amount"):
            anew[col] = anew[col].astype(aold[col].dtype)
        amerged = (pd.concat([aold, anew], ignore_index=True)
                   .drop_duplicates(subset=["Symbol", "Date", "Kind"], keep="last")
                   .sort_values(["Symbol", "Date", "Kind"])
                   .reset_index(drop=True))
        abuf = io.BytesIO()
        amerged.to_parquet(abuf, engine="pyarrow", compression="snappy", index=False)
        ablob = abuf.getvalue()
        _s3("PUT", ACTIONS_KEY, ablob)  # write 2: the sidecar, when changed
        aentry = next(e for e in manifest["files"] if e["key"] == ACTIONS_KEY)
        aentry["bytes"] = len(ablob)
        aentry["rows"] = len(amerged)
        aentry["first_session"] = _code_to_date(int(amerged["Date"].min()))
        aentry["last_session"] = _code_to_date(int(amerged["Date"].max()))
        aentry["row_groups"] = pq.ParquetFile(io.BytesIO(ablob)).num_row_groups
        print(f"actions: {len(aold)} -> {len(amerged)} rows", flush=True)
    # Keep the published version monotonic: a release date can be ahead of
    # the newest bar session after a backfill.
    version = max(new_max, str(manifest.get("version", "")))
    manifest["version"] = version
    # When the publisher last wrote: the browsers compare this date against the
    # user's update horizon, so it has to move on every run that changes bytes.
    manifest["updated"] = date.today().isoformat()
    _s3("PUT", MANIFEST_KEY, json.dumps(manifest, indent=1).encode())  # write 3: manifest
    _s3("PUT", VERSION_KEY, f"{version}\n".encode())  # write 4: version

    verify = json.loads(_s3("GET", MANIFEST_KEY).decode())
    ventry = next(e for e in verify["files"] if e["key"] == TAIL_KEY)
    vtext = _s3("GET", VERSION_KEY).decode().strip()
    assert verify["version"] == version == vtext, (verify["version"], vtext)
    assert ventry["bytes"] == len(blob) and ventry["last_session"] == new_max
    print(f"Done: version {vtext}, tail {ventry['first_session']} -> {ventry['last_session']}, "
          f"{ventry['rows']} rows, {ventry['bytes']} bytes. 3 writes total.", flush=True)
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


def fold_year(year: int) -> int:
    """Move the tail's rows from one completed year into its flat year file."""
    manifest = json.loads(_s3("GET", MANIFEST_KEY).decode())
    year_key = f"MARKET_DAILY/market_data_{year}.bin"
    yentry = next((e for e in manifest["files"] if e["key"] == year_key), None)
    if yentry is None:
        print(f"no {year_key} in the manifest — the bucket has not flipped to year files yet.")
        return 2
    tentry = next(e for e in manifest["files"] if e["key"] == TAIL_KEY)

    ydf, _ = read_flat_bytes(_s3("GET", year_key))
    tdf, _ = read_flat_bytes(_s3("GET", TAIL_KEY))
    print(f"year file: {len(ydf)} rows; tail: {len(tdf)} rows", flush=True)

    start_code = int(register(np.array([f"{year}-01-01"]))[0])
    end_code = int(register(np.array([f"{year + 1}-01-01"]))[0])
    mask = (tdf["Date"] >= start_code) & (tdf["Date"] < end_code)
    moving, stay = tdf[mask], tdf[~mask]
    print(f"moving {len(moving)} rows from {year} out of the tail; {len(stay)} stay", flush=True)
    if moving.empty:
        print("nothing to fold.")
        return 0
    if stay.empty:
        raise RuntimeError("fold would leave an empty flat tail; run after new-year data lands")

    merged = (pd.concat([ydf, moving], ignore_index=True)
              .drop_duplicates(subset=["Symbol", "Date"], keep="last")
              .sort_values(["Symbol", "Date"], kind="mergesort")
              .reset_index(drop=True))
    for col in ("Date",):
        merged[col] = merged[col].astype("int32")
    for col in ("Open", "High", "Low", "Close", "Volume"):
        merged[col] = merged[col].astype("float32")
    yblob = build_flat_bundle(merged)
    _, yheader = read_flat_bytes(yblob)
    assert yheader["first_session"][:4] == str(year) and yheader["last_session"][:4] == str(year), yheader
    print(f"year file {len(ydf)} -> {len(merged)} rows, {len(yblob)} bytes, "
          f"{yheader['first_session']} -> {yheader['last_session']}", flush=True)

    stay = stay[COLUMNS].reset_index(drop=True)
    tdf = stay[COLUMNS].copy()
    tdf["Date"] = tdf["Date"].astype("int32")
    for col in ("Open", "High", "Low", "Close", "Volume"):
        tdf[col] = tdf[col].astype("float32")
    tblob = build_flat_bundle(tdf)
    _, theader = read_flat_bytes(tblob)

    _s3("PUT", year_key, yblob)
    _s3("PUT", TAIL_KEY, tblob)
    yentry.update(bytes=len(yblob), rows=len(merged),
                  first_session=yheader["first_session"], last_session=yheader["last_session"],
                  row_groups=0)
    tentry.update(bytes=len(tblob), rows=len(stay),
                  first_session=theader["first_session"], last_session=theader["last_session"],
                  row_groups=0)
    today = max(date.today().isoformat(), str(manifest.get("version", "")))
    manifest["version"] = today
    manifest["updated"] = date.today().isoformat()
    _s3("PUT", MANIFEST_KEY, json.dumps(manifest, indent=1).encode())
    _s3("PUT", VERSION_KEY, f"{today}\n".encode())

    verify = json.loads(_s3("GET", MANIFEST_KEY).decode())
    vyentry = next(e for e in verify["files"] if e["key"] == year_key)
    ventry = next(e for e in verify["files"] if e["key"] == TAIL_KEY)
    vtext = _s3("GET", VERSION_KEY).decode().strip()
    assert verify["version"] == today == vtext, (verify["version"], vtext)
    assert vyentry["bytes"] == len(yblob) and ventry["bytes"] == len(tblob)
    print(f"Done: version {vtext}, {year_key} {len(merged)} rows, tail {len(stay)} rows.", flush=True)
    return 0


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
