# flat_bundle.py — the self-contained MARKET_DAILY .bin container.
#
# One file holds every symbol's bars for a period, sorted by symbol then date:
#
#   preamble   8s magic "SLTPFLAT" | I format 1 | I header_len | Q rows
#   header     JSON: symbols, per-symbol starts/counts, dtypes, sessions, offsets
#   payload    sym u16 | date u16 | open f32 | high f32 | low f32 | close f32 | vol f32
#
# The payload is column-major and the header's `offsets` name each column's byte
# position inside it, so a reader can pull one symbol's run without touching the
# rest. `sym` is an index into `symbols`, and `date` is days since the sltp
# epoch, exactly like every other stored bar.
#
#   from flat_bundle import COLUMNS, build_flat_bundle, read_flat_bytes

# -------- Imports --------
import json
import struct
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sltp.utils.Dates import EPOCH_ORDINAL

# -------- Constants --------
MAGIC = b"SLTPFLAT"
FORMAT = 1
PREAMBLE = 24
# Column order in the payload; `offsets` is derived from it, never hard-coded.
LAYOUT = (
    ("sym", "<u2"),
    ("date", "<u2"),
    ("open", "<f4"),
    ("high", "<f4"),
    ("low", "<f4"),
    ("close", "<f4"),
    ("vol", "<f4"),
)
DTYPES = {name: np.dtype(code).name for name, code in LAYOUT}
PRICE_COLUMNS = ["Open", "High", "Low", "Close", "Volume"]
COLUMNS = ["Symbol", "Date", *PRICE_COLUMNS]


def _code_to_date(code: int) -> str:
    return date.fromordinal(int(code) + EPOCH_ORDINAL).isoformat()


# Pack one frame into the container: preamble, header, then the column blocks.
def build_flat_bundle(frame: pd.DataFrame) -> bytes:
    missing = [column for column in COLUMNS if column not in frame.columns]
    if missing:
        raise ValueError(f"frame is missing {missing}")

    ordered = frame[COLUMNS].sort_values(["Symbol", "Date"], kind="mergesort")
    symbols = sorted(ordered["Symbol"].astype(str).unique().tolist())
    index = {symbol: position for position, symbol in enumerate(symbols)}
    sym = ordered["Symbol"].astype(str).map(index).to_numpy(dtype=np.uint16)
    rows = int(len(ordered))
    if rows == 0:
        raise ValueError("refusing to write an empty bundle")
    if len(symbols) > 0xFFFF:
        raise ValueError(f"{len(symbols)} symbols do not fit the u16 symbol index")

    counts = np.bincount(sym, minlength=len(symbols)).astype(np.int64)
    starts = np.concatenate(([0], np.cumsum(counts)[:-1])).astype(np.int64)
    dates = ordered["Date"].to_numpy(dtype=np.int32).astype(np.uint16)

    blocks: list[bytes] = []
    offsets: dict[str, int] = {}
    cursor = 0
    for name, code in LAYOUT:
        offsets[name] = cursor
        if name == "sym":
            block = sym.tobytes()
        elif name == "date":
            block = dates.tobytes()
        else:
            column = PRICE_COLUMNS[list(DTYPES).index(name) - 2]
            block = ordered[column].to_numpy(dtype=np.float32).tobytes()
        blocks.append(block)
        cursor += len(block)

    header = {
        "symbols": symbols,
        "starts": starts.tolist(),
        "counts": counts.tolist(),
        "dtypes": DTYPES,
        "first_session": _code_to_date(int(dates.min())),
        "last_session": _code_to_date(int(dates.max())),
        "offsets": offsets,
    }
    encoded = json.dumps(header).encode("utf-8")
    preamble = MAGIC + struct.pack("<IIQ", FORMAT, len(encoded), rows)
    return b"".join([preamble, encoded, *blocks])


# A valid container with no rows: the empty slot a retained block starts as.
# A live write never produces one (an emptied bundle is deleted instead), but
# DELISTED/<market>/<block>.bin exists before its first strip so every block
# has somewhere to land, and a reader can open it like any other bundle.
def build_empty_bundle() -> bytes:
    header = {
        "symbols": [],
        "starts": [],
        "counts": [],
        "dtypes": DTYPES,
        "first_session": None,
        "last_session": None,
        "offsets": {name: 0 for name, _code in LAYOUT},
    }
    encoded = json.dumps(header).encode("utf-8")
    return MAGIC + struct.pack("<IIQ", FORMAT, len(encoded), 0) + encoded


# The frame plus its header back out of the container.
def read_flat_bytes(blob: bytes) -> tuple[pd.DataFrame, dict]:
    if len(blob) < PREAMBLE:
        raise ValueError("bundle is shorter than its preamble")
    if blob[:8] != MAGIC:
        raise ValueError(f"not a flat bundle: {blob[:8]!r}")
    fmt, header_len, rows = struct.unpack("<IIQ", blob[8:PREAMBLE])
    if fmt != FORMAT:
        raise ValueError(f"unsupported flat bundle format {fmt}")
    header = json.loads(blob[PREAMBLE:PREAMBLE + header_len])
    # The row count lives in the preamble, not in the JSON, and every caller
    # that stamps a manifest entry reads it from here. Exposing it keeps
    # `entry["rows"]` correct after a rewrite instead of raising KeyError.
    header["rows"] = int(rows)
    payload = PREAMBLE + header_len
    offsets = header["offsets"]
    columns = {
        name: np.frombuffer(blob, dtype=code, count=int(rows), offset=payload + offsets[name])
        for name, code in LAYOUT
    }

    symbols = np.asarray(header["symbols"], dtype=object)
    names = symbols[columns["sym"]]
    frame = pd.DataFrame(
        {
            "Symbol": names,
            "Date": columns["date"].astype(np.int32),
            "Open": columns["open"].astype(np.float32),
            "High": columns["high"].astype(np.float32),
            "Low": columns["low"].astype(np.float32),
            "Close": columns["close"].astype(np.float32),
            "Volume": columns["vol"].astype(np.float32),
        }
    )
    return frame, header
