"""delist.py — what happens when a ticker stops answering.

The nightly job is built to run clean: yfinance answers, bars merge, the tail
is rewritten. A symbol that is delisted, taken over or renamed breaks that
shape quietly — it simply stops appearing in the download, and the archive
keeps carrying years of bars for a company that no longer trades.

This module turns that silence into a decision, and the decision into a clean
archive:

  1. NOTICE   every catalog symbol that produced no bars in the window the
              nightly job just downloaded is a suspect — unless its own last
              session in the newest bundles is only a few days behind the
              market, which is a holiday or a halt, not a delisting.
  2. VERIFY   a suspect is asked about twice: once directly (one month of
              Yahoo history, then the quote info) and once against
              FinanceDatabase, the same source the catalog is built from. That
              second opinion is what separates "delisted" from "Yahoo had a
              bad night", and what finds a renamed ticker by ISIN or name.
  3. WAIT     nothing is destroyed on one night's evidence. A confirmed
              delisting waits three nights, an unconfirmed miss ten. A live
              listing that Yahoo stops answering for is only flagged, never
              stripped.
  4. STRIP    a due symbol's bars are removed from every bundle that holds
              them (and its splits and dividends), each bundle's manifest
              entry is recomputed from the bytes actually written, and the
              catalog row is kept but marked, so the archive can still say
              what the ticker was.
  5. ARCHIVE  the full record — name, exchange, country, currency, first and
              last session, bar count, verdict and the evidence behind it —
              lives in META/delisted.json. Both markets land in the same
              object, one entry each.

The archive is why the site can offer the stripped names to a paid tier later
without keeping them in the data every reader downloads. Nothing in the site
or in sltp reads META/delisted.json, so it can grow without touching a client.

Why this matters for results: a dataset of listings that still exist today
cannot contain the companies that failed. Removing the dead names completely
is the honest version of that — the run never trades a symbol whose listing
ended, and the survivorship bias is stated where readers look instead of being
implied by the data. See the note on the data guide and in the Lab.

USAGE (from backend/):
  ../.venv/bin/python scripts/daily_r2_update.py                    # nightly: notice + verify
  ../.venv/bin/python scripts/daily_r2_update.py --delist-review    # dry run: verdicts, no writes
  ../.venv/bin/python scripts/daily_r2_update.py --strip-delisted   # strip what is already due
  ../.venv/bin/python scripts/delist.py --report                    # print META/delisted.json
"""

# -------- Imports --------
import io
import json
import struct
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling r2.py / flat_bundle.py

from flat_bundle import COLUMNS, build_flat_bundle, read_flat_bytes
from r2 import s3
from sltp.utils.Dates import EPOCH_ORDINAL, register

# -------- Layout --------
ROOT = "MARKET_DATA/DAILY"
MARKETS = ("US", "INTERNATIONAL")
TAIL_NAME = "recent.bin"
ACTIONS_NAME = "actions.parquet"
CATALOG_KEY = "MARKET_DATA/symbol_catalog.parquet"
MANIFEST_KEY = "META/manifest.json"
VERSION_KEY = "META/version.txt"
DELISTED_KEY = "META/delisted.json"
# A bundle's header names every symbol it holds; 8MB is far past the largest
# (19k symbols, ~2.6MB), and it is a guard against reading a whole file.
HEADER_WINDOW = 8 * 1024 * 1024

# Nights a verdict waits before the bars go. Confirmed means FinanceDatabase
# agrees the listing is gone (delisted flag, or the ISIN now trading under a
# different ticker); unconfirmed means only Yahoo said nothing.
GRACE_CONFIRMED = 3
GRACE_UNCONFIRMED = 10
# How many suspects one night may probe. Each probe is a network round trip and
# a delisting wave (an index reconstitution, say) should not run for hours.
MAX_PROBES = 40

# Verdicts that are allowed to remove history, and the ones that only speak.
STRIPPABLE = ("delisted", "renamed")
# A symbol missing from one short window is usually a holiday, a suspension or
# a halt, not a delisting. Only a name whose last known bar is already this old
# is worth asking Yahoo about, so a long weekend cannot start a clock that ends
# in deleted history ten nights later.
SUSPECT_MIN_STALE_DAYS = 10


# -------- Ledger (META/delisted.json) --------
def read_ledger() -> dict:
    """The archive of every symbol that stopped trading, both markets in one."""
    try:
        data = json.loads(s3("GET", DELISTED_KEY).decode())
    except Exception:  # noqa: BLE001 - a missing object is an empty archive
        return {"version": 1, "updated": None, "symbols": []}
    if not isinstance(data, dict) or not isinstance(data.get("symbols"), list):
        return {"version": 1, "updated": None, "symbols": []}
    return data


def write_ledger(entries: list[dict], dry_run: bool = False) -> None:
    """Writes the archive, newest verdict first."""
    entries.sort(key=lambda e: (str(e.get("detected") or ""), e.get("market", ""), e.get("symbol", "")),
                 reverse=True)
    body = {
        "version": 1,
        "updated": date.today().isoformat(),
        "counts": {
            "total": len(entries),
            "us": sum(1 for e in entries if e.get("market") == "US"),
            "international": sum(1 for e in entries if e.get("market") == "INTERNATIONAL"),
            "stripped": sum(1 for e in entries if e.get("stripped")),
        },
        "symbols": entries,
    }
    if dry_run:
        print(f"[dry run] ledger would hold {len(entries)} entries")
        return
    s3("PUT", DELISTED_KEY, json.dumps(body, indent=1).encode())
    print(f"ledger: {DELISTED_KEY} now holds {len(entries)} entries "
          f"({body['counts']['us']} US, {body['counts']['international']} international)",
          flush=True)


def _ledger_index(entries: list[dict]) -> dict[tuple[str, str], dict]:
    return {(str(entry.get("market")), str(entry.get("symbol"))): entry for entry in entries}


# -------- Second opinion: FinanceDatabase --------
# The catalog this pipeline publishes is built from FinanceDatabase, so asking
# it the same question the catalog was built from is a fair second opinion. The
# package is optional at runtime: without it a verdict is recorded unconfirmed
# and no history is removed.
_FD: pd.DataFrame | None = None
_FD_ERROR: str | None = None


def fd_equities() -> pd.DataFrame:
    """Every equity FinanceDatabase knows, delisted ones included, loaded once."""
    global _FD, _FD_ERROR
    if _FD is not None:
        return _FD
    if _FD_ERROR is not None:
        return pd.DataFrame()
    try:
        import financedatabase as fd  # imported here: the nightly run must not need it
        frame = fd.Equities().select()
        frame = frame.reset_index().rename(columns={"index": "symbol"})
        frame.columns = [str(column).strip().lower() for column in frame.columns]
        if "symbol" not in frame.columns:
            frame = frame.rename(columns={frame.columns[0]: "symbol"})
        _FD = frame
        print(f"financedatabase: {len(frame)} equities loaded", flush=True)
    except Exception as exc:  # noqa: BLE001 - the job continues without a second opinion
        _FD_ERROR = f"{type(exc).__name__}: {exc}"
        print(f"financedatabase unavailable ({_FD_ERROR}); verdicts stay unconfirmed", flush=True)
        _FD = pd.DataFrame()
    return _FD


def _cell(row: pd.Series | dict, name: str) -> str:
    value = row.get(name) if hasattr(row, "get") else None
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    return str(value).strip()


def fd_row(symbol: str, yahoo_symbol: str) -> pd.Series | None:
    """The database's own record for this ticker, or None when it does not know it.

    Matched on the ticker only. The same ISIN under a different ticker is a
    rename, not this listing, so that lookup belongs in fd_rename — matching it
    here would report a renamed company as an existing but unresponsive one.
    """
    frame = fd_equities()
    if frame.empty:
        return None
    keys = {symbol.upper(), (yahoo_symbol or "").upper(), symbol.upper().replace(".", "-")}
    upper = frame["symbol"].astype(str).str.upper()
    hit = frame[upper.isin(keys)]
    if hit.empty:
        return None
    return hit.iloc[0]


def fd_rename(row: pd.Series, symbol: str, isin: str, name: str) -> pd.Series | None:
    """A live listing that is the same company under a different ticker.

    ISIN is the strong key: a share keeps it across a ticker change. The name
    is the fallback, exact and case-insensitive, and only accepted when the
    candidate trades in the same currency — a same-named company on another
    exchange is a different listing, not a rename.
    """
    frame = fd_equities()
    if frame.empty:
        return None
    live = frame
    if "delisted" in frame.columns:
        live = frame[~frame["delisted"].astype(bool)]
    currency = _cell(row, "currency").upper()

    # One share can carry the same ISIN on several exchanges (a US listing and
    # its London line, say), so an ISIN match is narrowed to the same quote
    # currency before it is trusted.
    if isin and "isin" in live.columns:
        hits = live[live["isin"].astype(str).str.upper() == isin.upper()]
        hits = hits[hits["symbol"].astype(str).str.upper() != symbol.upper()]
        if currency and "currency" in hits.columns:
            same_currency = hits[hits["currency"].astype(str).str.upper() == currency]
            if not same_currency.empty:
                hits = same_currency
        if not hits.empty:
            return _closest_listing(hits, row)
    if not name:
        return None
    hits = live[live["name"].astype(str).str.strip().str.casefold() == name.strip().casefold()]
    hits = hits[hits["symbol"].astype(str).str.upper() != symbol.upper()]
    if currency and "currency" in hits.columns:
        hits = hits[hits["currency"].astype(str).str.upper() == currency]
    if hits.empty:
        return None
    return _closest_listing(hits, row)


def _closest_listing(hits: pd.DataFrame, row: pd.Series) -> pd.Series:
    """The candidate on the original's own exchange and country, when there is one."""
    country = _cell(row, "country").upper()
    exchange = _cell(row, "exchange").upper()
    if "country" in hits.columns and country:
        same = hits[hits["country"].astype(str).str.upper() == country]
        if not same.empty:
            hits = same
    if "exchange" in hits.columns and exchange:
        same = hits[hits["exchange"].astype(str).str.upper() == exchange]
        if not same.empty:
            hits = same
    return hits.iloc[0]


# -------- First opinion: Yahoo --------
def yahoo_probe(yahoo_symbol: str) -> dict:
    """One month of history from Yahoo, then its quote info when that is empty.

    An empty history is the signal. The month is deliberately short: a long
    window costs bandwidth per suspect, and any row at all proves the ticker
    still answers.
    """
    try:
        import yfinance as yf
        ticker = yf.Ticker(yahoo_symbol)
        frame = ticker.history(period="1mo", auto_adjust=False)
        if frame is not None and not frame.empty:
            return {"alive": True, "rows": int(len(frame))}
        info: dict = {}
        try:
            info = ticker.get_info() or {}
        except Exception:  # noqa: BLE001 - the quote info is the second question, not the first
            info = {}
        return {
            "alive": False,
            "rows": 0,
            "quoted_symbol": str(info.get("symbol") or ""),
            "quoted_name": str(info.get("longName") or info.get("shortName") or ""),
            "exchange": str(info.get("exchange") or info.get("fullExchangeName") or ""),
            "currency": str(info.get("currency") or ""),
            "quote_type": str(info.get("quoteType") or ""),
        }
    except Exception as exc:  # noqa: BLE001 - a probe that throws is a probe that answered nothing
        return {"alive": False, "rows": 0, "error": f"{type(exc).__name__}: {exc}"[:200]}


# -------- The verdict --------
def classify(row: pd.Series) -> dict:
    """What happened to one catalog symbol: alive, delisted, renamed or unknown."""
    symbol = _cell(row, "Symbol")
    yahoo_symbol = _cell(row, "YahooSymbol") or symbol
    isin = _cell(row, "ISIN")
    name = _cell(row, "Name")

    probe = yahoo_probe(yahoo_symbol)
    if probe.get("alive"):
        return {"status": "alive", "evidence": {"yahoo": probe}}

    database = fd_row(symbol, yahoo_symbol)
    evidence: dict = {"yahoo": probe, "financedatabase": None}
    if database is not None:
        evidence["financedatabase"] = {
            "symbol": _cell(database, "symbol"),
            "name": _cell(database, "name"),
            "delisted": _cell(database, "delisted").lower() == "true",
            "exchange": _cell(database, "exchange"),
        }
        if _cell(database, "delisted").lower() == "true":
            return {"status": "delisted", "confirmed": True,
                    "reason": "FinanceDatabase marks the listing delisted", "evidence": evidence}
        return {"status": "dead-ticker", "confirmed": False,
                "reason": "the listing exists upstream but Yahoo returned nothing",
                "evidence": evidence}

    # Not in the database under this ticker. Either it was renamed, or it is
    # gone from both sources — the two cases the archive has to tell apart.
    quoted = probe.get("quoted_symbol", "")
    if quoted and quoted.upper() != symbol.upper():
        evidence["yahoo"]["renamed_to"] = quoted
        return {"status": "renamed", "confirmed": True,
                "reason": f"Yahoo answers to {quoted} for this listing",
                "replacement": quoted, "evidence": evidence}
    renamed = fd_rename(row, symbol, isin, name)
    if renamed is not None:
        replacement = _cell(renamed, "symbol")
        evidence["financedatabase"] = {
            "symbol": replacement,
            "name": _cell(renamed, "name"),
            "matched_by": "isin" if isin else "name",
        }
        return {"status": "renamed", "confirmed": True,
                "reason": f"the same company now trades as {replacement}",
                "replacement": replacement, "evidence": evidence}
    confirmed = not fd_equities().empty
    return {"status": "delisted", "confirmed": confirmed,
            "reason": "absent from Yahoo and from FinanceDatabase", "evidence": evidence}


# -------- Notice: one night's suspects --------
def last_bar_of(row: pd.Series | None) -> str | None:
    """The catalog's newest session for a symbol, or None when it cannot say.

    `LastBar` is written when the catalog is built, so it is a lower bound on
    the true last session: a stale catalog can make a name look older than it
    is, which only means it gets asked about — never that it is stripped.
    """
    if row is None:
        return None
    stamp = _cell(row, "LastBar")
    return stamp[:10] if len(stamp) >= 10 and stamp[:4].isdigit() else None


def holds_recent_session(last: str | None, newest: str | None,
                         today: date | None = None,
                         min_days: int = SUSPECT_MIN_STALE_DAYS) -> bool:
    """True when a last session is too close to the market's newest to judge.

    The reference is the archive's own newest session, not today's date: a
    publisher that skipped a week should not make every line in the file look
    stale. Only when the archive cannot say does the calendar stand in.
    """
    if last is None:
        return False
    try:
        then = date.fromisoformat(last[:10])
        reference = date.fromisoformat(newest[:10]) if newest else (today or date.today())
    except ValueError:
        return False
    return reference - then < timedelta(days=min_days)


def split_suspects(catalog: pd.DataFrame, market: str, missing: list[str],
                   manifest: dict | None = None,
                   today: date | None = None) -> tuple[list[str], list[str]]:
    """Splits a market's unanswered symbols into suspects and names to ignore.

    The ignored list is the point: a holiday, a one-day halt or a suspended
    line leaves a symbol out of a four-day window without anything being wrong
    with the listing. Those names keep their bars and drop out of the notice
    entirely, instead of accumulating nights toward a strip.

    The evidence is the symbol's own last session in the newest bundles, read
    with ranged requests. The catalog's LastBar is only a fallback, because it
    is stamped when the catalog is built: a catalog a month old would otherwise
    make every line look stale and flag the first halt of the week on day one.
    """
    rows = {str(row["Symbol"]): row for _, row in catalog[catalog["Universe"] == market].iterrows()}
    newest = market_newest_session(manifest, market) if manifest is not None else None
    from_archive = symbol_last_sessions(manifest, market, missing) if manifest is not None else {}
    suspects: list[str] = []
    recent: list[str] = []
    for symbol in missing:
        last = from_archive.get(symbol) or last_bar_of(rows.get(symbol))
        if holds_recent_session(last, newest, today):
            recent.append(symbol)
        else:
            suspects.append(symbol)
    return sorted(suspects), sorted(recent)


def _due(entry: dict) -> bool:
    """True when a verdict has waited long enough for its history to go.

    A confirmed verdict waits three nights, an unconfirmed one ten. The wait
    is the whole safety margin: a delisting is permanent, and one night's
    silence from Yahoo is not.
    """
    if entry.get("status") not in STRIPPABLE:
        return False
    grace = GRACE_CONFIRMED if entry.get("confirmed") else GRACE_UNCONFIRMED
    return int(entry.get("misses") or 0) >= grace


def review(catalog: pd.DataFrame, market: str, missing: list[str],
           dry_run: bool = False) -> list[dict]:
    """Records tonight's suspects, verifies them, and returns the ones due.

    Called once per market by the nightly job. The archive is written at the
    end, and the caller strips only what is due — so a bad night can add a
    note but cannot remove any history.
    """
    if not missing:
        return []
    today = date.today().isoformat()
    ledger = read_ledger()
    entries: list[dict] = ledger["symbols"]
    index = _ledger_index(entries)
    rows = {str(row["Symbol"]): row for _, row in catalog.iterrows()}
    print(f"{market}: {len(missing)} suspect(s) with no bars in the window:"
          f" {', '.join(missing[:12])}{'…' if len(missing) > 12 else ''}", flush=True)

    probed = 0
    for symbol in missing:
        row = rows.get(symbol)
        if row is None:
            continue
        key = (market, symbol)
        entry = index.get(key)
        if entry is None:
            entry = {
                "symbol": symbol,
                "market": market,
                "yahoo_symbol": _cell(row, "YahooSymbol") or symbol,
                "name": _cell(row, "Name"),
                "exchange": _cell(row, "Exchange"),
                "country": _cell(row, "Country"),
                "currency": _cell(row, "CurrencyCode") or _cell(row, "Currency"),
                "first_session": _cell(row, "FirstBar") or None,
                "last_session": _cell(row, "LastBar") or None,
                "bars": int(row["Bars"]) if "Bars" in row and pd.notna(row["Bars"]) else None,
                "first_missing": today,
                "misses": 0,
                "status": "suspect",
                "stripped": False,
            }
            entries.append(entry)
            index[key] = entry
        entry["misses"] = int(entry.get("misses") or 0) + 1
        entry["last_checked"] = today

        if probed >= MAX_PROBES:
            # A wave of them (an index reconstitution) is spread over nights
            # instead of holding the job open. Nothing is stripped until its
            # own verdict lands, so the queue only delays accuracy.
            entry["status"] = "queued"
            continue
        verdict = classify(row)
        probed += 1
        entry["status"] = verdict["status"]
        entry["confirmed"] = bool(verdict.get("confirmed"))
        entry["reason"] = verdict.get("reason", "")
        entry["evidence"] = verdict.get("evidence")
        entry["detected"] = entry.get("detected") or today
        if verdict.get("replacement"):
            entry["replacement"] = verdict["replacement"]
        print(f"  {market} {symbol}: {verdict['status']}"
              f"{'' if verdict.get('confirmed') else ' (unconfirmed)'} — "
              f"{verdict.get('reason', '')}", flush=True)

    # A ticker that answered again was a bad night, not a delisting: drop the
    # note unless its history is already archived (then the note is history).
    entries[:] = [e for e in entries
                  if not (e.get("status") == "alive" and not e.get("stripped"))]
    write_ledger(entries, dry_run=dry_run)
    return [entry for entry in entries
            if entry.get("market") == market and not entry.get("stripped") and _due(entry)]


# -------- Stripping --------
def _manifest() -> dict:
    return json.loads(s3("GET", MANIFEST_KEY).decode())


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


def _bundle_head(key: str) -> tuple[dict, int] | None:
    """One bundle's header and payload offset, from a range read."""
    try:
        blob = s3("GET", key, headers={"range": f"bytes=0-{HEADER_WINDOW - 1}"})
    except RuntimeError:
        return None
    if len(blob) < 24 or blob[:8] != b"SLTPFLAT":
        return None
    _magic, _fmt, header_len, _rows = struct.unpack("<8sIIQ", blob[:24])
    if 24 + header_len > len(blob):
        raise RuntimeError(f"{key}: header is larger than the read window")
    return json.loads(blob[24:24 + header_len]), 24 + header_len


def _bundle_header(key: str) -> dict | None:
    """One bundle's header, from a range read — never the whole file."""
    head = _bundle_head(key)
    return head[0] if head is not None else None


def _market_bundles(manifest: dict, market: str) -> list[dict]:
    """One market's bundles, newest session first."""
    entries = [entry for entry in manifest.get("files", [])
               if entry["key"].startswith(f"{ROOT}/{market}/") and entry["key"].endswith(".bin")]
    return sorted(entries, key=lambda entry: str(entry.get("last_session") or ""), reverse=True)


def market_newest_session(manifest: dict, market: str) -> str | None:
    """The newest session the archive holds for one market."""
    newest = [str(entry.get("last_session") or "") for entry in _market_bundles(manifest, market)]
    return max(newest) if newest and max(newest) else None


def symbol_last_sessions(manifest: dict, market: str, symbols: list[str]) -> dict[str, str]:
    """Each symbol's newest session in the archive, read from the files.

    The catalog's LastBar is written when the catalog is built, which can be
    weeks before tonight, so it cannot answer "did this name trade this week".
    The bundles can: their headers say where a symbol's run sits, and two bytes
    of its last date cost one tiny ranged read. Newest bundle first, and the
    walk stops as soon as every wanted name has been found.
    """
    found: dict[str, str] = {}
    remaining = {symbol for symbol in symbols if symbol}
    if not remaining:
        return found
    for entry in _market_bundles(manifest, market):
        if not remaining:
            break
        head = _bundle_head(entry["key"])
        if head is None:
            continue
        header, payload = head
        positions = {str(symbol): index for index, symbol in enumerate(header.get("symbols", []))}
        offsets = header.get("offsets") or {}
        if "date" not in offsets:
            continue
        for symbol in [name for name in remaining if name in positions]:
            position = positions[symbol]
            count = int(header["counts"][position])
            if count <= 0:
                continue
            at = payload + int(offsets["date"]) + (int(header["starts"][position]) + count - 1) * 2
            try:
                raw = s3("GET", entry["key"], headers={"range": f"bytes={at}-{at + 1}"})
            except RuntimeError:
                continue
            if len(raw) < 2:
                continue
            day = int(struct.unpack("<H", raw)[0])
            found[symbol] = date.fromordinal(day + EPOCH_ORDINAL).isoformat()
            remaining.discard(symbol)
    return found


def strip(markets: dict[str, list[str]], entries: list[dict],
          dry_run: bool = False) -> tuple[dict[str, int], dict, pd.DataFrame | None]:
    """Removes the named symbols from every file that holds their bars.

    Returns the rows removed per file, the manifest this pass built, and the
    catalog it wrote. Each touched file is rewritten from its own rows and its
    manifest entry restamped from the bytes actually written, so the
    manifest's size, row count and session span stay true. A bundle that held
    nothing but the stripped names is deleted, and its entry goes with it.
    """
    manifest = _manifest()
    removed: dict[str, int] = {}
    for market, symbols in markets.items():
        targets = {symbol for symbol in symbols if symbol}
        if not targets:
            continue
        keys = [entry["key"] for entry in manifest["files"]
                if entry["key"].startswith(f"{ROOT}/{market}/") and entry["key"].endswith(".bin")]
        for key in keys:
            header = _bundle_header(key)
            if header is None:
                continue
            hit = targets.intersection(str(symbol) for symbol in header.get("symbols", []))
            if not hit:
                continue
            frame, _ = read_flat_bytes(s3("GET", key))
            before = len(frame)
            kept = frame[~frame["Symbol"].isin(hit)].reset_index(drop=True)
            dropped = before - len(kept)
            print(f"  {key}: {before} -> {len(kept)} rows ({dropped} removed for "
                  f"{', '.join(sorted(hit))})", flush=True)
            removed[key] = dropped
            if dry_run:
                continue
            if kept.empty:
                # The bundle existed only for these names.
                s3("DELETE", key)
                manifest["files"] = [entry for entry in manifest["files"]
                                     if entry["key"] != key]
                continue
            blob = build_flat_bundle(kept)
            _decoded, stamp = read_flat_bytes(blob)
            assert len(_decoded) == len(kept), (key, len(_decoded), len(kept))
            s3("PUT", key, blob)
            _stamp(_ensure_entry(manifest, key), blob, stamp)

        actions_key = f"{ROOT}/{market}/{ACTIONS_NAME}"
        actions_entry = _entry(manifest, actions_key)
        if actions_entry is not None:
            try:
                actions = pd.read_parquet(io.BytesIO(s3("GET", actions_key)))
            except Exception:  # noqa: BLE001 - a missing sidecar has nothing to strip
                actions = None
            if actions is not None and not actions.empty:
                kept = actions[~actions["Symbol"].isin(targets)].reset_index(drop=True)
                dropped = len(actions) - len(kept)
                if dropped:
                    print(f"  {actions_key}: {len(actions)} -> {len(kept)} rows", flush=True)
                    removed[actions_key] = dropped
                    if not dry_run:
                        buffer = io.BytesIO()
                        kept.to_parquet(buffer, engine="pyarrow", compression="snappy",
                                        index=False)
                        blob = buffer.getvalue()
                        s3("PUT", actions_key, blob)
                        actions_entry["bytes"] = len(blob)
                        actions_entry["rows"] = len(kept)
                        actions_entry["row_groups"] = pq.ParquetFile(io.BytesIO(blob)).num_row_groups
                        if len(kept) == 0:
                            actions_entry["first_session"] = None
                            actions_entry["last_session"] = None

    catalog = None if dry_run else update_catalog(manifest, entries)
    return removed, manifest, catalog


def update_catalog(manifest: dict, entries: list[dict]) -> pd.DataFrame:
    """Marks the archived rows and adds the tickers renames moved them to.

    Rows are kept on purpose: the catalog is the site's memory of what a
    symbol was, and a rebuild from FinanceDatabase would otherwise reintroduce
    a stripped name as `active` and start downloading it again. `Status` is
    what the downloader filters on; `Delisted` is what the site filters on.
    """
    catalog = pd.read_parquet(io.BytesIO(s3("GET", CATALOG_KEY)))
    dtypes = catalog.dtypes.copy()
    by_key = {(str(entry.get("market")), str(entry.get("symbol"))): entry for entry in entries}
    index = {(str(row["Universe"]), str(row["Symbol"])): position
             for position, row in catalog.iterrows()}
    today = date.today().isoformat()
    marked = 0
    for (market, symbol), entry in by_key.items():
        position = index.get((market, symbol))
        if position is None:
            continue
        catalog.at[position, "Status"] = "delisted"
        if "Delisted" in catalog.columns:
            catalog.at[position, "Delisted"] = True
        if "Bars" in catalog.columns:
            catalog.at[position, "Bars"] = 0
        if "InfoAsOf" in catalog.columns:
            catalog.at[position, "InfoAsOf"] = today
        marked += 1

    added = 0
    for entry in entries:
        replacement = str(entry.get("replacement") or "").strip()
        if not replacement:
            continue
        if (str(entry.get("market")), replacement) in index:
            continue
        source = index.get((str(entry.get("market")), str(entry.get("symbol"))))
        if source is None:
            continue
        row = catalog.loc[source].copy()
        row["Symbol"] = replacement
        row["YahooSymbol"] = replacement
        row["Status"] = "active"
        if "Delisted" in catalog.columns:
            row["Delisted"] = False
        if "Bars" in catalog.columns:
            row["Bars"] = 0
        if "FirstBar" in catalog.columns:
            row["FirstBar"] = ""
        if "LastBar" in catalog.columns:
            row["LastBar"] = ""
        if "InfoAsOf" in catalog.columns:
            row["InfoAsOf"] = today
        catalog = pd.concat([catalog, pd.DataFrame([row])], ignore_index=True)
        index[(str(entry.get("market")), replacement)] = len(catalog) - 1
        added += 1

    # A concat with a mixed-dtype row can widen a column to object; put the
    # original types back so a reader of the parquet sees the same schema.
    for column, dtype in dtypes.items():
        if column not in catalog.columns:
            continue
        try:
            catalog[column] = catalog[column].astype(dtype)
        except (TypeError, ValueError):
            pass

    buffer = io.BytesIO()
    catalog.to_parquet(buffer, engine="pyarrow", compression="snappy", index=False)
    blob = buffer.getvalue()
    s3("PUT", CATALOG_KEY, blob)
    entry = _ensure_entry(manifest, CATALOG_KEY)
    entry["bytes"] = len(blob)
    entry["rows"] = len(catalog)
    entry["row_groups"] = pq.ParquetFile(io.BytesIO(blob)).num_row_groups
    print(f"catalog: {marked} row(s) marked delisted, {added} replacement ticker(s) added, "
          f"{len(catalog)} rows total", flush=True)
    return catalog


def publish(manifest: dict, version: str) -> None:
    """Writes the manifest and its version marker (one implementation)."""
    from daily_r2_update import _publish  # deferred: it imports this module
    _publish(manifest, version)


# -------- Backfill a replacement ticker --------
def backfill(market: str, symbol: str, yahoo_symbol: str,
             dry_run: bool = False) -> int:
    """Pulls a newly named ticker's whole history into the blocks it belongs in.

    A renamed listing arrives with its old data gone and nothing in the tail,
    so without this its chart would start on the day the rename was noticed.
    Every block whose year span the download covers is read, merged and
    rewritten; blocks outside the span are never touched.
    """
    import yfinance as yf
    start = "1998-01-01"
    end = (date.today() + timedelta(days=1)).isoformat()
    frame = yf.download(yahoo_symbol, start=start, end=end, auto_adjust=False,
                        actions=False, progress=False, threads=False)
    if frame is None or len(frame) == 0:
        print(f"  backfill {market} {symbol}: Yahoo returned nothing; the next night retries",
              flush=True)
        return 0
    if isinstance(frame.columns, pd.MultiIndex):
        frame.columns = frame.columns.get_level_values(0)
    frame = frame[frame["Close"].notna()]
    if frame.empty:
        return 0
    index = frame.index.tz_localize(None) if frame.index.tz is not None else frame.index
    codes = register(index.strftime("%Y-%m-%d").to_numpy())
    bars = pd.DataFrame({
        "Symbol": symbol,
        "Date": codes.astype("int32"),
        "Open": frame["Open"].to_numpy(dtype="float32"),
        "High": frame["High"].to_numpy(dtype="float32"),
        "Low": frame["Low"].to_numpy(dtype="float32"),
        "Close": frame["Close"].to_numpy(dtype="float32"),
        "Volume": frame["Volume"].to_numpy(dtype="float32"),
    })
    years = sorted({int(str(day)[:4]) for day in index.strftime("%Y-%m-%d")})
    manifest = _manifest()
    written = 0
    for key in [entry["key"] for entry in manifest["files"]
                if entry["key"].startswith(f"{ROOT}/{market}/") and entry["key"].endswith(".bin")]:
        span = key.rsplit("/", 1)[-1].replace(".bin", "")
        if "-" in span:
            low, high = (int(part) for part in span.split("-", 1))
        elif span.isdigit():
            low = high = int(span)
        else:
            low, high = min(years), max(years)
        if high < min(years) or low > max(years):
            continue
        block, _header = read_flat_bytes(s3("GET", key))
        merged = (pd.concat([block[COLUMNS], bars[COLUMNS]], ignore_index=True)
                  .drop_duplicates(subset=["Symbol", "Date"], keep="last")
                  .sort_values(["Symbol", "Date"], kind="mergesort")
                  .reset_index(drop=True))
        if len(merged) == len(block):
            continue
        merged["Date"] = merged["Date"].astype("int32")
        for column in ("Open", "High", "Low", "Close", "Volume"):
            merged[column] = merged[column].astype("float32")
        if dry_run:
            print(f"  [dry run] {key}: would add {len(merged) - len(block)} rows for {symbol}",
                  flush=True)
            continue
        blob = build_flat_bundle(merged)
        _decoded, stamp = read_flat_bytes(blob)
        s3("PUT", key, blob)
        _stamp(_ensure_entry(manifest, key), blob, stamp)
        print(f"  {key}: {len(block)} -> {len(merged)} rows for {symbol}", flush=True)
        written += len(merged) - len(block)
    if written and not dry_run:
        publish(manifest, max(str(manifest.get("version", "")), date.today().isoformat()))
    return written


# -------- Stripping what is due, with its bookkeeping --------
def _strip_entries(due: list[dict], dry_run: bool = False) -> int:
    """Strips due entries, marks them in the archive, and backfills renames."""
    if not due:
        return 0
    names = ", ".join(f"{entry['market']}:{entry['symbol']}" for entry in due)
    print(f"delisting: {len(due)} symbol(s) due for stripping — {names}", flush=True)
    markets: dict[str, list[str]] = {}
    for entry in due:
        markets.setdefault(str(entry["market"]), []).append(str(entry["symbol"]))
    removed, manifest, _catalog = strip(markets, due, dry_run=dry_run)
    total = sum(removed.values())
    if dry_run:
        print(f"delisting: [dry run] {total} rows across {len(removed)} file(s) would go")
        return total

    today = date.today().isoformat()
    ledger = read_ledger()
    index = _ledger_index(ledger["symbols"])
    for entry in due:
        record = index.get((str(entry.get("market")), str(entry.get("symbol"))))
        if record is None:
            continue
        record["stripped"] = True
        record["stripped_on"] = today
        record["rows_removed"] = sum(
            count for key, count in removed.items()
            if f"/{record['market']}/" in key
        )
    write_ledger(ledger["symbols"])
    publish(manifest, max(str(manifest.get("version", "")), today))
    print(f"delisting: {total} rows removed across {len(removed)} file(s); "
          f"archive {DELISTED_KEY} updated", flush=True)

    # A renamed ticker's new spelling starts with no history in the archive.
    for entry in due:
        replacement = str(entry.get("replacement") or "").strip()
        if not replacement:
            continue
        market = str(entry.get("market"))
        try:
            added = backfill(market, replacement, replacement)
            print(f"  backfill {market} {replacement}: {added} rows", flush=True)
        except Exception as exc:  # noqa: BLE001 - a rename is not worth a failed night
            print(f"  backfill {market} {replacement} failed: {exc}", flush=True)
    return total


# -------- The job the nightly run calls --------
def review_and_strip(catalog: pd.DataFrame, missing_by_market: dict[str, list[str]],
                     dry_run: bool = False) -> int:
    """Notice, verify, then strip and archive whatever is due. Returns rows removed."""
    due: list[dict] = []
    for market, missing in missing_by_market.items():
        if not missing:
            continue
        due.extend(review(catalog, market, sorted(set(missing)), dry_run=dry_run))
    return _strip_entries(due, dry_run=dry_run)


def strip_due(dry_run: bool = False) -> int:
    """Strips whatever the archive already holds a due verdict for.

    The nightly run does this itself; this is the operator's lever for a night
    that was skipped, or for clearing a backlog without another download.
    """
    ledger = read_ledger()
    due = [entry for entry in ledger["symbols"]
           if not entry.get("stripped") and _due(entry)]
    if not due:
        print("delisting: nothing due in the archive.")
        return 0
    return _strip_entries(due, dry_run=dry_run)


# -------- Readout --------
def report() -> int:
    ledger = read_ledger()
    counts = ledger.get("counts") or {}
    print(f"Delisted archive — {DELISTED_KEY} (updated {ledger.get('updated')})")
    print(f"  total: {counts.get('total', len(ledger['symbols']))} "
          f"(US {counts.get('us', 0)}, international {counts.get('international', 0)})")
    print(f"  stripped: {counts.get('stripped', 0)}")
    for entry in ledger["symbols"][:40]:
        print(f"  {entry.get('market'):<13} {entry.get('symbol'):<10} "
              f"{str(entry.get('status')):<12} "
              f"{str(entry.get('last_session') or '-'):<11} "
              f"{entry.get('name', '')[:40]}")
        if entry.get("replacement"):
            print(f"      renamed to {entry['replacement']}")
        if entry.get("reason"):
            print(f"      {entry['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(report())
