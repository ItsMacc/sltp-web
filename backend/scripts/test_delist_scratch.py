"""test_delist_scratch.py — the strip path and the holiday guard, on a scratch slice.

The nightly job can delete years of bars, so the one thing worth proving before
it runs for real is that deletion is correct: the right rows go, the survivors
do not, every manifest entry matches the bytes actually written, the catalog
and the archive agree, and a renamed ticker's replacement is backfilled.

The suspect rule is checked here too, in both directions: a line whose own last
bar is in the newest bundles is ignored even when the catalog is a month stale,
and a line that really stopped stays a suspect even when the catalog claims it
traded today.

Nothing here can touch the live archive. Every key the test writes goes under
SCRATCH_TEST_DELIST/, the objects are built from scratch inside the test, and
the live manifest is hashed before and after to prove it did not move. The
scratch objects are deleted at the end unless --keep is passed.

USAGE (from backend/):
  ../.venv/bin/python scripts/test_delist_scratch.py           # run, then clean up
  ../.venv/bin/python scripts/test_delist_scratch.py --keep    # leave the objects
"""

# -------- Imports --------
import hashlib
import io
import json
import sys
import types
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daily_r2_update as daily
import delist
from flat_bundle import COLUMNS, build_flat_bundle, read_flat_bytes
from r2 import s3
from sltp.utils.Dates import EPOCH_ORDINAL, register

# -------- The scratch slice --------
PREFIX = "SCRATCH_TEST_DELIST"
LIVE_MANIFEST = "META/manifest.json"

# Point every constant the writing code reads at the scratch prefix. Both
# modules, because delist.publish() goes through daily._publish().
delist.ROOT = f"{PREFIX}/MARKET_DATA/DAILY"
delist.CATALOG_KEY = f"{PREFIX}/MARKET_DATA/symbol_catalog.parquet"
delist.MANIFEST_KEY = f"{PREFIX}/META/manifest.json"
delist.VERSION_KEY = f"{PREFIX}/META/version.txt"
delist.DELISTED_KEY = f"{PREFIX}/META/delisted.json"
delist.DELISTED_ROOT = f"{PREFIX}/DELISTED"
daily.MANIFEST_KEY = delist.MANIFEST_KEY
daily.VERSION_KEY = delist.VERSION_KEY

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{'' if ok else f' — {detail}'}")
    if not ok:
        FAILURES.append(label)


def key_for(market: str, name: str) -> str:
    key = f"{delist.ROOT}/{market}/{name}"
    assert key.startswith(PREFIX + "/"), f"refusing to touch a live key: {key}"
    return key


def day_code(stamp: str) -> int:
    return int(register(np.array([stamp]))[0])


def iso(code: int) -> str:
    return date.fromordinal(int(code) + EPOCH_ORDINAL).isoformat()


def bars(symbol: str, stamps: list[str], start: float = 10.0) -> pd.DataFrame:
    codes = [day_code(stamp) for stamp in stamps]
    return pd.DataFrame({
        "Symbol": [symbol] * len(codes),
        "Date": codes,
        "Open": [start + i for i in range(len(codes))],
        "High": [start + i + 1 for i in range(len(codes))],
        "Low": [start + i - 1 for i in range(len(codes))],
        "Close": [start + i + 0.5 for i in range(len(codes))],
        "Volume": [1_000 + i for i in range(len(codes))],
    })


def bundle_entry(key: str, blob: bytes) -> dict:
    _frame, header = read_flat_bytes(blob)
    return {
        "key": key,
        "bytes": len(blob),
        "rows": int(header["rows"]),
        "first_session": header["first_session"],
        "last_session": header["last_session"],
        "row_groups": 0,
    }


def parquet_entry(key: str, blob: bytes, frame: pd.DataFrame | None = None) -> dict:
    parquet = pq.ParquetFile(io.BytesIO(blob))
    entry = {
        "key": key,
        "bytes": len(blob),
        "rows": parquet.metadata.num_rows,
        "first_session": None,
        "last_session": None,
        "row_groups": parquet.metadata.num_row_groups,
    }
    if frame is not None and len(frame):
        entry["first_session"] = iso(int(frame["Date"].min()))
        entry["last_session"] = iso(int(frame["Date"].max()))
    return entry


def put_bundle(market: str, name: str, frame: pd.DataFrame,
               manifest_files: list[dict]) -> str:
    key = key_for(market, name)
    blob = build_flat_bundle(frame)
    s3("PUT", key, blob)
    manifest_files.append(bundle_entry(key, blob))
    return key


def write_actions(market: str, frame: pd.DataFrame, manifest_files: list[dict]) -> None:
    for column in ("Kind", "Amount"):
        frame[column] = frame[column].astype("int64" if column == "Kind" else "float64")
    frame["Date"] = frame["Date"].astype("int32")
    key = key_for(market, "actions.parquet")
    blob = parquet_blob(frame)
    s3("PUT", key, blob)
    manifest_files.append(parquet_entry(key, blob, frame))


def parquet_blob(frame: pd.DataFrame) -> bytes:
    buffer = io.BytesIO()
    frame.to_parquet(buffer, engine="pyarrow", compression="snappy", index=False)
    return buffer.getvalue()


# -------- Fixtures --------
WEEK = [f"2019-01-{day:02d}" for day in range(2, 31) if date(2019, 1, day).weekday() < 5]
TAIL_DAYS = ["2026-11-19", "2026-11-20"]
# What the strip has to account for, computed from the fixtures rather than
# typed in: DOOM's two 1999 bars, its 2019 bars, its two tail bars and its two
# action rows; GONE.NS's 2019 bars and its one action row.
DOOM_ROWS = 2 + len(WEEK) + len(TAIL_DAYS) + 2
GONE_ROWS = len(WEEK) + 1
EXPECTED_REMOVED = DOOM_ROWS + GONE_ROWS


def catalog_frame() -> pd.DataFrame:
    rows = [
        # symbol, name, universe, exchange, isin, bars, first, last
        ("DOOM", "Doomed Holdings", "US", "NYSE", "US0000000001", 27, "1999-01-04", TAIL_DAYS[-1]),
        ("KEEP", "Kept Industries", "US", "NASDAQ", "US0000000002", 22, WEEK[0], TAIL_DAYS[-1]),
        ("SURVIVOR", "Old But Listed", "US", "NYSE", "US0000000003", 10, WEEK[0], WEEK[9]),
        ("HALTED", "Halted This Week", "US", "NYSE", "US0000000004", 1, TAIL_DAYS[0], TAIL_DAYS[0]),
        ("STALEOLD", "Stopped Long Ago", "US", "NYSE", "US0000000005", 1, "2026-10-01", "2026-10-01"),
        ("NOTINARCHIVE", "Never Had Bars", "US", "NYSE", "US0000000006", 0, "", "2026-10-01"),
        ("GONE.NS", "Departed Ltd", "INTERNATIONAL", "NSE", "INE000A01001", 20, WEEK[0], WEEK[-1]),
        ("KEEP.NS", "Kept Overseas", "INTERNATIONAL", "NSE", "INE000A01002", 20, WEEK[0], WEEK[-1]),
    ]
    frame = pd.DataFrame({
        "Symbol": [row[0] for row in rows],
        "YahooSymbol": [row[0] for row in rows],
        "Name": [row[1] for row in rows],
        "Universe": [row[2] for row in rows],
        "Market": [row[2] for row in rows],
        "Country": ["United States" if row[2] == "US" else "India" for row in rows],
        "Exchange": [row[3] for row in rows],
        "MIC": ["XNYS" if row[3] == "NYSE" else "XNAS" if row[3] == "NASDAQ" else "XNSE"
                for row in rows],
        "Currency": ["USD" if row[2] == "US" else "INR" for row in rows],
        "CurrencyCode": ["USD" if row[2] == "US" else "INR" for row in rows],
        "PriceDivisor": [1] * len(rows),
        "Category": ["stock"] * len(rows),
        "Status": ["active"] * len(rows),
        "Bars": [row[5] for row in rows],
        "FirstBar": [row[6] for row in rows],
        "LastBar": [row[7] for row in rows],
        "InfoAsOf": [TAIL_DAYS[-1]] * len(rows),
        "ISIN": [row[4] for row in rows],
        "Delisted": [False] * len(rows),
    })
    frame["Bars"] = frame["Bars"].astype("int64")
    frame["Status"] = frame["Status"].astype("string")
    # The staleness cases, in the two directions that matter:
    #   HALTED     — the catalog is a month stale (says 2026-09-01) but the
    #                archive has a bar two days old: must be ignored.
    #   STALEOLD   — the catalog was rebuilt today and claims a bar today, but
    #                the archive's newest row is 2026-10-01: must stay a suspect.
    frame.loc[frame["Symbol"] == "HALTED", "LastBar"] = "2026-09-01"
    frame.loc[frame["Symbol"] == "STALEOLD", "LastBar"] = date.today().isoformat()
    return frame


def write_scratch() -> dict:
    """Builds a miniature archive and returns what was written, to check against."""
    manifest_files: list[dict] = []

    # A US block that holds nothing but the doomed symbol: stripping it must
    # delete the object and drop its manifest entry.
    put_bundle("US", "1998-2002.bin", bars("DOOM", ["1999-01-04", "1999-01-05"], 5.0),
               manifest_files)
    put_bundle(
        "US", "2018-2022.bin",
        pd.concat([bars("KEEP", WEEK, 20.0), bars("DOOM", WEEK, 30.0),
                   bars("SURVIVOR", WEEK[:10], 40.0)], ignore_index=True),
        manifest_files,
    )
    # The tail carries the staleness fixtures: one bar two days old (a halt),
    # one bar seven weeks old (a real stop) — both missing from tonight's
    # download window.
    put_bundle("US", "recent.bin",
               pd.concat([bars("KEEP", TAIL_DAYS, 50.0), bars("DOOM", TAIL_DAYS, 60.0),
                          bars("HALTED", [TAIL_DAYS[0]], 90.0),
                          bars("STALEOLD", ["2026-10-01"], 95.0)], ignore_index=True),
               manifest_files)
    put_bundle(
        "INTERNATIONAL", "2018-2022.bin",
        pd.concat([bars("GONE.NS", WEEK, 70.0), bars("KEEP.NS", WEEK, 80.0)], ignore_index=True),
        manifest_files,
    )

    # Each market's sidecar holds only its own names: a strip is scoped to one
    # market, and the US file must never be rewritten because of an Indian row.
    write_actions("US", pd.DataFrame({
        "Symbol": ["DOOM", "DOOM", "KEEP"],
        "Date": [day_code(WEEK[0]), day_code(WEEK[3]), day_code(WEEK[2])],
        "Kind": [1, 0, 1],
        "Amount": [0.25, 2.0, 0.4],
    }), manifest_files)
    write_actions("INTERNATIONAL", pd.DataFrame({
        "Symbol": ["GONE.NS", "KEEP.NS"],
        "Date": [day_code(WEEK[1]), day_code(WEEK[4])],
        "Kind": [1, 1],
        "Amount": [5.0, 1.5],
    }), manifest_files)

    catalog = catalog_frame()
    blob = parquet_blob(catalog)
    s3("PUT", delist.CATALOG_KEY, blob)
    manifest_files.append(parquet_entry(delist.CATALOG_KEY, blob))

    # The archive as review() would have left it: two due verdicts, neither
    # stripped yet.
    ledger = {
        "version": 1,
        "updated": (date.today() - timedelta(days=1)).isoformat(),
        "counts": {"total": 2, "us": 1, "international": 1, "stripped": 0},
        "symbols": [
            {
                "symbol": "DOOM", "market": "US", "yahoo_symbol": "DOOM",
                "name": "Doomed Holdings", "exchange": "NYSE", "country": "United States",
                "currency": "USD", "first_session": "1999-01-04",
                "last_session": TAIL_DAYS[-1], "bars": 27, "first_missing": "2026-11-01",
                "misses": 4, "status": "delisted", "confirmed": True,
                "reason": "FinanceDatabase marks the listing delisted",
                "detected": "2026-11-01", "stripped": False,
            },
            {
                "symbol": "GONE.NS", "market": "INTERNATIONAL", "yahoo_symbol": "GONE.NS",
                "name": "Departed Ltd", "exchange": "NSE", "country": "India",
                "currency": "INR", "first_session": WEEK[0], "last_session": WEEK[-1],
                "bars": 20, "first_missing": "2026-11-01", "misses": 4,
                "status": "renamed", "confirmed": True, "replacement": "NEWCO.NS",
                "reason": "the same company now trades as NEWCO.NS",
                "detected": "2026-11-01", "stripped": False,
            },
        ],
    }
    s3("PUT", delist.DELISTED_KEY, json.dumps(ledger, indent=1).encode())

    version = (date.today() - timedelta(days=1)).isoformat()
    manifest = {"version": version, "updated": version,
                "files": sorted(manifest_files, key=lambda entry: entry["key"])}
    s3("PUT", delist.MANIFEST_KEY, json.dumps(manifest, indent=1).encode())
    s3("PUT", delist.VERSION_KEY, f"{version}\n".encode())
    return {"manifest": manifest, "catalog": catalog}


def fake_yfinance() -> None:
    """Stands in for Yahoo so the backfill path is exercised without a network."""
    module = types.ModuleType("yfinance")

    def download(symbol, start=None, end=None, **kwargs):  # noqa: ANN001, ARG001
        stamp = pd.date_range("2021-01-04", periods=5, freq="B")
        return pd.DataFrame({
            "Open": np.arange(5, dtype="float64") + 100,
            "High": np.arange(5, dtype="float64") + 101,
            "Low": np.arange(5, dtype="float64") + 99,
            "Close": np.arange(5, dtype="float64") + 100.5,
            "Volume": np.full(5, 500.0),
        }, index=stamp)

    module.download = download
    sys.modules["yfinance"] = module


# -------- The check itself --------
def verify(state: dict) -> None:
    manifest = json.loads(s3("GET", delist.MANIFEST_KEY).decode())
    entries = {entry["key"]: entry for entry in manifest["files"]}

    print("\n-- bundles --")
    for key, entry in entries.items():
        if not key.endswith(".bin"):
            continue
        blob = s3("GET", key)
        frame, header = read_flat_bytes(blob)
        check(f"{key}: manifest bytes match the object", entry["bytes"] == len(blob),
              f"{entry['bytes']} vs {len(blob)}")
        check(f"{key}: manifest rows match the header", entry["rows"] == int(header["rows"]))
        check(f"{key}: manifest sessions match the header",
              entry["first_session"] == header["first_session"]
              and entry["last_session"] == header["last_session"])
        check(f"{key}: header symbols match the rows",
              len(frame) == sum(header["counts"]))

    us_block = entries.get(key_for("US", "2018-2022.bin"))
    check("US 2018-2022 survived", us_block is not None)
    frame, header = read_flat_bytes(s3("GET", key_for("US", "2018-2022.bin")))
    symbols = set(header["symbols"])
    check("DOOM removed from US 2018-2022", "DOOM" not in symbols, str(sorted(symbols)))
    check("KEEP untouched in US 2018-2022", "KEEP" in symbols and len(frame[frame["Symbol"] == "KEEP"]) == len(WEEK))
    check("SURVIVOR untouched in US 2018-2022",
          "SURVIVOR" in symbols and len(frame[frame["Symbol"] == "SURVIVOR"]) == 10)

    tail_frame, tail_header = read_flat_bytes(s3("GET", key_for("US", "recent.bin")))
    check("DOOM removed from the tail", "DOOM" not in set(tail_header["symbols"]))
    check("tail still holds KEEP's two sessions",
          len(tail_frame[tail_frame["Symbol"] == "KEEP"]) == len(TAIL_DAYS))
    check("the halted and stale fixtures kept their rows",
          len(tail_frame[tail_frame["Symbol"] == "HALTED"]) == 1
          and len(tail_frame[tail_frame["Symbol"] == "STALEOLD"]) == 1)

    print("\n-- retained bars (DELISTED/<market>/<block>) --")
    kept, kept_header = read_flat_bytes(s3("GET", delist.retained_key("US", "1998-2002.bin")))
    check("the block that held only the doomed name keeps its bars",
          set(kept_header["symbols"]) == {"DOOM"} and len(kept) == 2,
          f"{sorted(kept_header['symbols'])} {len(kept)} rows")
    kept, kept_header = read_flat_bytes(s3("GET", delist.retained_key("US", "2018-2022.bin")))
    check("the shared block keeps only the rows it removed",
          set(kept_header["symbols"]) == {"DOOM"} and len(kept) == len(WEEK),
          f"{sorted(kept_header['symbols'])} {len(kept)} rows")
    kept, kept_header = read_flat_bytes(s3("GET", delist.retained_key("US", "recent.bin")))
    check("the tail's doomed rows are kept",
          set(kept_header["symbols"]) == {"DOOM"} and len(kept) == len(TAIL_DAYS),
          f"{sorted(kept_header['symbols'])} {len(kept)} rows")
    kept, kept_header = read_flat_bytes(s3("GET", delist.retained_key("INTERNATIONAL", "2018-2022.bin")))
    check("the international block keeps GONE.NS",
          set(kept_header["symbols"]) == {"GONE.NS"} and len(kept) == len(WEEK),
          f"{sorted(kept_header['symbols'])} {len(kept)} rows")
    kept_total = 0
    for market in delist.MARKETS:
        for name in ("1998-2002.bin", "2018-2022.bin", "recent.bin"):
            try:
                kept_total += len(read_flat_bytes(s3("GET", delist.retained_key(market, name)))[0])
            except RuntimeError:  # a market with no such live block keeps nothing
                continue
    check("every removed bar is retained somewhere",
          kept_total == EXPECTED_REMOVED - 3, f"kept {kept_total}, removed {EXPECTED_REMOVED}")
    kept_actions = pd.read_parquet(io.BytesIO(s3("GET", f"{delist.DELISTED_ROOT}/US/actions.parquet")))
    check("the US sidecar's doomed rows are kept",
          set(kept_actions["Symbol"]) == {"DOOM"} and len(kept_actions) == 2,
          f"{sorted(set(kept_actions['Symbol']))} {len(kept_actions)} rows")
    kept_actions = pd.read_parquet(
        io.BytesIO(s3("GET", f"{delist.DELISTED_ROOT}/INTERNATIONAL/actions.parquet")))
    check("the international sidecar keeps GONE.NS's row",
          set(kept_actions["Symbol"]) == {"GONE.NS"} and len(kept_actions) == 1)
    ledger = delist.read_ledger()
    record = next(entry for entry in ledger["symbols"] if entry.get("symbol") == "DOOM")
    check("the ledger points at the kept bars",
          delist.retained_key("US", "1998-2002.bin") in (record.get("retained") or []),
          str(record.get("retained")))

    print("\n-- empty bundle --")
    check("US 1998-2002 (only DOOM) deleted from the bucket",
          key_for("US", "1998-2002.bin") not in entries)
    deleted = True
    try:
        s3("GET", key_for("US", "1998-2002.bin"))
        deleted = False
    except RuntimeError:
        deleted = True
    check("US 1998-2002 object is gone", deleted)

    print("\n-- actions --")
    for market in delist.MARKETS:
        key = key_for(market, "actions.parquet")
        actions = pd.read_parquet(io.BytesIO(s3("GET", key)))
        entry = entries.get(key)
        check(f"{key}: no stripped symbols left",
              not set(actions["Symbol"]) & {"DOOM", "GONE.NS"}, str(sorted(set(actions["Symbol"]))))
        check(f"{key}: manifest rows match the sidecar",
              entry is not None and entry["rows"] == len(actions))
        survivor = "KEEP" if market == "US" else "KEEP.NS"
        check(f"{key}: {survivor} kept its event",
              set(actions["Symbol"]) == {survivor}, str(sorted(set(actions["Symbol"]))))

    print("\n-- catalog --")
    catalog = pd.read_parquet(io.BytesIO(s3("GET", delist.CATALOG_KEY)))
    by_symbol = {str(row["Symbol"]): row for _, row in catalog.iterrows()}
    check("catalog keeps the delisted row", "DOOM" in by_symbol and "GONE.NS" in by_symbol)
    check("DOOM marked delisted",
          str(by_symbol["DOOM"]["Status"]) == "delisted" and bool(by_symbol["DOOM"]["Delisted"]))
    check("GONE.NS marked delisted",
          str(by_symbol["GONE.NS"]["Status"]) == "delisted" and bool(by_symbol["GONE.NS"]["Delisted"]))
    check("Bars reset to zero on the archived rows",
          int(by_symbol["DOOM"]["Bars"]) == 0 and int(by_symbol["GONE.NS"]["Bars"]) == 0)
    check("survivors still active",
          str(by_symbol["KEEP"]["Status"]) == "active" and str(by_symbol["KEEP.NS"]["Status"]) == "active")
    check("replacement ticker added", "NEWCO.NS" in by_symbol)
    if "NEWCO.NS" in by_symbol:
        replacement = by_symbol["NEWCO.NS"]
        check("replacement is active and not delisted",
              str(replacement["Status"]) == "active" and not bool(replacement["Delisted"]))
        check("replacement keeps its market", str(replacement["Universe"]) == "INTERNATIONAL")
    check("catalog dtypes survived the concat",
          str(catalog["Status"].dtype) in {"string", "str", "object"}
          and str(catalog["Delisted"].dtype) == "bool",
          f"Status={catalog['Status'].dtype} Delisted={catalog['Delisted'].dtype}")

    print("\n-- archive --")
    ledger = json.loads(s3("GET", delist.DELISTED_KEY).decode())
    archived = {entry["symbol"]: entry for entry in ledger["symbols"]}
    check("both entries archived", {"DOOM", "GONE.NS"} <= set(archived))
    check("DOOM stripped and counted",
          bool(archived["DOOM"]["stripped"]) and archived["DOOM"]["rows_removed"] == DOOM_ROWS,
          str(archived["DOOM"].get("rows_removed")))
    check("GONE.NS stripped and counted",
          bool(archived["GONE.NS"]["stripped"]) and archived["GONE.NS"]["rows_removed"] == GONE_ROWS,
          str(archived["GONE.NS"].get("rows_removed")))
    check("GONE.NS stripped with its rename kept",
          archived["GONE.NS"]["stripped"] and archived["GONE.NS"].get("replacement") == "NEWCO.NS")
    check("archive counts agree", ledger["counts"]["stripped"] == 2
          and ledger["counts"]["us"] == 1 and ledger["counts"]["international"] == 1,
          str(ledger["counts"]))

    print("\n-- backfill --")
    intl_frame, intl_header = read_flat_bytes(s3("GET", key_for("INTERNATIONAL", "2018-2022.bin")))
    newco = intl_frame[intl_frame["Symbol"] == "NEWCO.NS"]
    check("replacement history landed in its block", len(newco) == 5, f"{len(newco)} rows")
    check("replacement is in the header", "NEWCO.NS" in set(intl_header["symbols"]))
    check("KEEP.NS untouched by the backfill",
          len(intl_frame[intl_frame["Symbol"] == "KEEP.NS"]) == len(WEEK))

    print("\n-- version --")
    marker = s3("GET", delist.VERSION_KEY).decode().strip()
    check("version marker matches the manifest", marker == manifest["version"] == state["version"],
          f"marker={marker} manifest={manifest['version']} expected={state['version']}")


def cleanup() -> None:
    keys = [
        delist.MANIFEST_KEY, delist.VERSION_KEY, delist.DELISTED_KEY, delist.CATALOG_KEY,
        key_for("US", "1998-2002.bin"), key_for("US", "2018-2022.bin"),
        key_for("US", "recent.bin"), key_for("US", "actions.parquet"),
        key_for("INTERNATIONAL", "2018-2022.bin"), key_for("INTERNATIONAL", "actions.parquet"),
        *[delist.retained_key(market, name) for market in delist.MARKETS
          for name in ("1998-2002.bin", "2018-2022.bin", "recent.bin", "actions.parquet")],
    ]
    for key in keys:
        assert key.startswith(PREFIX + "/"), f"refusing to delete a live key: {key}"
        try:
            s3("DELETE", key)
        except RuntimeError as exc:
            print(f"  could not delete {key}: {exc}")
    remaining = []
    for key in keys:
        try:
            s3("GET", key)
            remaining.append(key)
        except RuntimeError:
            continue
    check("scratch objects cleaned up", not remaining, str(remaining))


def main() -> int:
    keep = "--keep" in sys.argv
    before = hashlib.sha256(s3("GET", LIVE_MANIFEST)).hexdigest()
    print(f"live manifest hash before: {before[:16]}")
    print(f"scratch prefix: {PREFIX}/\n")
    # A run that died before its own cleanup leaves objects that would make the
    # seed look like it created nothing; start from an empty prefix.
    cleanup()

    state = write_scratch()
    fake_yfinance()

    # The holiday guard: the bundle headers are the evidence, so a catalog that
    # has not been rebuilt cannot make a live line look dead — and a rebuilt
    # catalog cannot hide a line that actually stopped.
    print("\n-- suspect staleness (the bundles decide, not the catalog) --")
    manifest = delist._manifest()
    missing = ["HALTED", "STALEOLD", "NOTINARCHIVE"]
    archive_last = delist.symbol_last_sessions(manifest, "US", missing)
    check("last sessions read out of the bundles",
          archive_last.get("HALTED") == TAIL_DAYS[0]
          and archive_last.get("STALEOLD") == "2026-10-01"
          and "NOTINARCHIVE" not in archive_last, str(archive_last))
    check("market newest session comes from the manifest",
          delist.market_newest_session(manifest, "US") == TAIL_DAYS[-1],
          str(delist.market_newest_session(manifest, "US")))
    suspects, recent = delist.split_suspects(state["catalog"], "US", missing,
                                             manifest=manifest)
    check("a halt is ignored even when the catalog LastBar is a month old",
          "HALTED" in recent, f"recent={recent}")
    check("a name with no bar for seven weeks stays a suspect",
          "STALEOLD" in suspects, f"suspects={suspects}")
    check("a name with no bars at all stays a suspect",
          "NOTINARCHIVE" in suspects, f"suspects={suspects}")
    check("the guard produced no false suspects",
          suspects == ["NOTINARCHIVE", "STALEOLD"], str(suspects))

    due = [
        entry for entry in delist.read_ledger()["symbols"]
        if entry.get("status") in delist.STRIPPABLE and not entry.get("stripped")
    ]
    check("two verdicts are due", len(due) == 2, str(len(due)))

    # A dry run first: it must decide the same thing and write nothing.
    before_dry = hashlib.sha256(s3("GET", delist.MANIFEST_KEY)).hexdigest()
    dry = delist._strip_entries(due, dry_run=True)
    after_dry = hashlib.sha256(s3("GET", delist.MANIFEST_KEY)).hexdigest()
    check("dry run wrote no manifest", before_dry == after_dry)
    check("dry run counted the same rows", dry == EXPECTED_REMOVED, f"{dry} rows")
    _still, still_header = read_flat_bytes(s3("GET", key_for("US", "2018-2022.bin")))
    check("dry run left DOOM in place", "DOOM" in set(still_header["symbols"]))
    check("dry run left the archive untouched",
          not any(entry.get("stripped") for entry in delist.read_ledger()["symbols"]))

    print("\n-- retained tree --")
    created = delist.seed_archive()
    check("seed made one empty block per live block", created == 4, f"{created} created")
    empty, empty_header = read_flat_bytes(s3("GET", delist.retained_key("US", "1998-2002.bin")))
    check("a seeded block is a readable empty bundle",
          len(empty) == 0 and empty_header["symbols"] == [], f"{len(empty)} rows")
    check("seeding again writes nothing", delist.seed_archive() == 0)

    removed = delist._strip_entries(due, dry_run=False)
    check("strip removed every doomed row", removed == EXPECTED_REMOVED, f"{removed} rows")

    state["version"] = max(str(state["manifest"]["version"]), date.today().isoformat())
    verify(state)

    after = hashlib.sha256(s3("GET", LIVE_MANIFEST)).hexdigest()
    print(f"\nlive manifest hash after:  {after[:16]}")
    check("live bucket untouched", before == after)

    if keep:
        print(f"\n--keep: leaving {PREFIX}/ in place")
    else:
        print()
        cleanup()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED: {', '.join(FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
