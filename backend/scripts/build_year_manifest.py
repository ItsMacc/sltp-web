# build_year_manifest.py — rebuild META/manifest.json from the bucket itself.
#
# The manifest is the only file every reader asks for, and it is derived: each
# bundle's byte count, row count and session span comes from its own header,
# and each sidecar's from its parquet footer. So after an upload, a rename or a
# hand-edited bucket, this rebuilds the manifest from what is actually there
# instead of trusting a local cache of a layout that may have moved on.
#
# USAGE (from backend/):
#   ../.venv/bin/python scripts/build_year_manifest.py            # write /tmp
#   ../.venv/bin/python scripts/build_year_manifest.py --upload   # and publish
#
# Nothing is written to R2 without --upload. A bundle is read as a range GET of
# its header, so a rebuild costs one small request per file, not the archive.
#
# Block names are anchored at 1998 in five-year steps (1998-2002 … 2028-2032),
# plus one `recent.bin` per market for the open year. Any other chunking is
# legal — sltp reads the header, not the name — but this is what the publisher
# writes, so these are the names it checks.

import io
import json
import struct
import sys
from datetime import date
from pathlib import Path

import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling r2.py

from r2 import s3

MANIFEST_KEY = "META/manifest.json"
VERSION_KEY = "META/version.txt"
ROOT = "MARKET_DATA/DAILY"
MARKETS = ("US", "INTERNATIONAL")
BLOCK_START = 1998
BLOCK_YEARS = 5
CATALOG_KEY = "MARKET_DATA/symbol_catalog.parquet"
FX_KEY = "MARKET_DATA/fx.parquet"
ACTIONS_NAME = "actions.parquet"
# A header this large would mean 19,000 symbols with very long names; it is a
# guard against reading a whole bundle by accident, not a real limit.
HEADER_WINDOW = 8 * 1024 * 1024


def _size(key: str) -> int | None:
    """The object's byte count, or None when the key does not exist."""
    try:
        _body, headers = s3("HEAD", key, with_headers=True)
    except RuntimeError:
        return None
    lowered = {name.lower(): value for name, value in headers.items()}
    value = lowered.get("content-length")
    return int(value) if value is not None else None


def _bundle(key: str, size: int) -> dict | None:
    """One bundle's manifest entry, read from its header."""
    blob = s3("GET", key, headers={"range": f"bytes=0-{HEADER_WINDOW - 1}"})
    if len(blob) < 24:
        print(f"  {key}: shorter than a preamble, skipped")
        return None
    magic, fmt, header_len, rows = struct.unpack("<8sIIQ", blob[:24])
    if magic != b"SLTPFLAT" or fmt != 1:
        print(f"  {key}: not a flat bundle, skipped")
        return None
    if 24 + header_len > len(blob):
        raise SystemExit(f"{key}: header is {header_len} bytes, past the read window")
    header = json.loads(blob[24:24 + header_len])
    return {
        "key": key,
        "bytes": size,
        "rows": int(rows),
        "first_session": header["first_session"],
        "last_session": header["last_session"],
        "row_groups": 0,
    }


def _parquet_entry(key: str, size: int, with_sessions: bool) -> dict:
    """A sidecar's entry from its footer: rows always, sessions when dated."""
    blob = s3("GET", key)
    parquet = pq.ParquetFile(io.BytesIO(blob))
    entry = {
        "key": key,
        "bytes": size,
        "rows": parquet.metadata.num_rows,
        "first_session": None,
        "last_session": None,
        "row_groups": parquet.metadata.num_row_groups,
    }
    if not with_sessions:
        return entry
    index = parquet.schema_arrow.get_field_index("Date")
    if index < 0:
        return entry
    lows: list[int] = []
    highs: list[int] = []
    for group in range(parquet.metadata.num_row_groups):
        stats = parquet.metadata.row_group(group).column(index).statistics
        if stats is not None and stats.has_min_max:
            lows.append(int(stats.min))
            highs.append(int(stats.max))
    if lows:
        from sltp.utils.Dates import EPOCH_ORDINAL
        entry["first_session"] = date.fromordinal(min(lows) + EPOCH_ORDINAL).isoformat()
        entry["last_session"] = date.fromordinal(max(highs) + EPOCH_ORDINAL).isoformat()
    return entry


def _block_names() -> list[str]:
    """Every five-year name the archive could have, up to a decade ahead."""
    names: list[str] = []
    last = date.today().year + 10
    for start in range(BLOCK_START, last + 1, BLOCK_YEARS):
        names.append(f"{start}-{start + BLOCK_YEARS - 1}.bin")
    return names


def main() -> int:
    upload = "--upload" in sys.argv
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path("/tmp/r2_manifest")
    out.mkdir(parents=True, exist_ok=True)

    files: list[dict] = []
    for key in (CATALOG_KEY, FX_KEY):
        size = _size(key)
        if size is None:
            print(f"missing {key}")
            return 2
        files.append(_parquet_entry(key, size, with_sessions=False))

    for market in MARKETS:
        for name in [*_block_names(), "recent.bin"]:
            key = f"{ROOT}/{market}/{name}"
            size = _size(key)
            if size is None:
                continue
            entry = _bundle(key, size)
            if entry is not None:
                files.append(entry)
        key = f"{ROOT}/{market}/{ACTIONS_NAME}"
        size = _size(key)
        if size is not None:
            files.append(_parquet_entry(key, size, with_sessions=True))

    if not any("/DAILY/" in entry["key"] for entry in files):
        print("no bar bundles found under MARKET_DATA/DAILY/")
        return 2

    try:
        version = s3("GET", VERSION_KEY).decode().strip()
    except RuntimeError:
        version = ""
    version = version or date.today().isoformat()
    files.sort(key=lambda entry: entry["key"])
    manifest = {"version": version, "updated": date.today().isoformat(), "files": files}
    text = json.dumps(manifest, indent=1) + "\n"

    (out / "manifest.json").write_text(text, encoding="utf-8")
    (out / "version.txt").write_text(version + "\n", encoding="utf-8")
    bundles = [entry for entry in files if entry["key"].endswith(".bin")]
    print(f"{len(bundles)} bundles, {sum(e['rows'] for e in bundles):,} rows total")
    for entry in bundles:
        print(f"  {entry['key']}: {entry['first_session']} -> {entry['last_session']}, "
              f"{entry['bytes']:,} bytes")
    print(f"version: {version}")
    print(f"wrote {out / 'manifest.json'} and {out / 'version.txt'}")

    if upload:
        s3("PUT", MANIFEST_KEY, text.encode())
        s3("PUT", VERSION_KEY, f"{version}\n".encode())
        print("uploaded the manifest and the version marker")
    else:
        print("NOT uploaded. Pass --upload to publish this manifest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
