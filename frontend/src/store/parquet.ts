// parquet.ts — era-file reads, dense and sparse.
//
// Two engines, picked per query shape. Dense single-symbol reads (a chart
// series) prune to matching row groups through the footer's Symbol
// statistics, then decode the survivors in Rust (parquet-wasm, big
// batches): the Arrow table crosses to JS through the C data interface
// (arrow-js-ffi, zero copy) instead of an IPC blob, and symbol matching
// hashes raw UTF-8 bytes, so only matching rows ever pay for a string
// decode. Everything between the FFI parse and the copied-out rows runs
// synchronously: no WASM memory growth can detach the views in between.
// Sparse multi-symbol reads (watchlist quotes) stay on hyparquet, which
// fetches only the pages it needs through ranged Blob slices — forcing
// those through the WASM reader would swallow whole files first and run
// ~3x slower (measured Nov 2026).
//
// The same functions serve the worker pool and the main-thread fallback,
// which is why this file never touches worker globals: bytes in, rows out.
//
// Measured Nov 2026 (M-series Mac, in-browser): one pruned row group
// (1M rows x 7 cols) reads in ~1s where the old reader took ~1.7s per
// file, and two files decode side by side in the pool. A symbol missing
// from a file costs only the footer read, because no row group can
// contain it.

import initWasm, { readParquet, wasmMemory } from 'parquet-wasm';
import wasmUrl from 'parquet-wasm/esm/parquet_wasm_bg.wasm?url';
import { parseTable } from 'arrow-js-ffi';
import { parquetMetadataAsync, parquetQuery, parquetReadObjects } from 'hyparquet';
import type { Data, Table, Vector } from 'apache-arrow';
import { isFlatFile, readFlatBars, readFlatQuotes } from './flat';

export interface WorkerRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WorkerQuote {
  price: number;
  changePct: number;
  lastDate: string;
  prevDate: string | null;
  prevClose: number | null;
}

export interface CatalogEntry {
  ticker: string;
  name: string;
  /** "US" or "INTERNATIONAL": which bundle directory holds the bars. */
  universe: string;
  /** Country label the catalogue uses: "US", "India", "Japan", … */
  market: string;
  country: string;
  /** The listing venue, e.g. "NSE", "NYSE", "Tokyo". */
  exchange: string;
  /** ISO code the bars are quoted in, e.g. "INR". */
  currency: string;
}

/** The daily FX table: one row per session, one column per currency. */
export interface FxTable {
  /** Day codes since 1970-01-01, ascending. */
  days: Int32Array;
  /** USD per one unit of the currency, e.g. 1 GBP = 1.31 USD. */
  rates: Record<string, Float64Array>;
}

export interface QueryPerf {
  /** Bytes of the OPFS file. */
  fileBytes: number;
  /** Footer/metadata read. */
  footerMs: number;
  /** Pruned Rust decode plus the FFI handoff. */
  parseMs: number;
  /** Rows the query matched (what the old reader logged too). */
  rowsScanned: number;
}

const DAY_MS = 86_400_000;
/** Batches this size keep per-batch overhead off the charts (see Nov 2026 notes). */
const BATCH_SIZE = 1_048_576;

const BARS_COLUMNS = ['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume'];
/** Everything a search row and a quote header need, in one decode. */
const CATALOG_COLUMNS = [
  'Symbol',
  'Name',
  'Universe',
  'Market',
  'Country',
  'Exchange',
  'CurrencyCode',
  'Status',
];
/** Catalog rows the pipeline has archived: their bars are gone from the bundles,
    so offering one in search could only produce an empty chart. */
const ARCHIVED_STATUS = 'delisted';

let initPromise: Promise<void> | null = null;

/** Loads (once) the WASM decoder. Retries on failure instead of pinning a dead handle. */
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = initWasm({ module_or_path: wasmUrl }).then(
      () => undefined,
      (err: unknown) => {
        initPromise = null;
        throw err;
      },
    );
  }
  return initPromise;
}

/** Adapts a Blob to the AsyncBuffer hyparquet reads the footer through. */
function blobBuffer(blob: Blob): { byteLength: number; slice: (s: number, e?: number) => Promise<ArrayBuffer> } {
  return {
    byteLength: blob.size,
    slice: (start: number, end?: number) => blob.slice(start, end).arrayBuffer(),
  };
}

function dayToISO(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** FNV-1a over raw bytes: symbol matching without decoding every string. */
function hashBytes(values: Uint8Array, start: number, end: number): number {
  let hash = 0x811c9dc5;
  for (let i = start; i < end; i += 1) {
    hash ^= values[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashString(text: string): number {
  const bytes = new TextEncoder().encode(text);
  return hashBytes(bytes, 0, bytes.length);
}

/**
 * Per-row-group [min, max] of the Symbol column from the footer, or null
 * when the file carries no usable statistics (then everything decodes).
 */
async function symbolRanges(file: Blob): Promise<{ ranges: { min: string; max: string }[] | null; count: number }> {
  const metadata = await parquetMetadataAsync(blobBuffer(file));
  const groups = metadata.row_groups;
  if (groups.length === 0) return { ranges: null, count: 0 };
  const symbolIndex = groups[0]!.columns.findIndex(
    (column) => (column.meta_data?.path_in_schema ?? []).join('.') === 'Symbol',
  );
  if (symbolIndex < 0) return { ranges: null, count: groups.length };
  const ranges: { min: string; max: string }[] = [];
  for (const group of groups) {
    const column = group.columns[symbolIndex];
    const stats = column?.meta_data?.statistics;
    if (stats?.min_value == null || stats?.max_value == null) {
      return { ranges: null, count: groups.length };
    }
    ranges.push({ min: String(stats.min_value), max: String(stats.max_value) });
  }
  return { ranges, count: groups.length };
}

/** Row-group indexes whose Symbol range can contain the symbol. */
function groupsFor(ranges: { min: string; max: string }[] | null, symbol: string, count: number): number[] {
  if (!ranges || ranges.length !== count) {
    return Array.from({ length: count }, (_, i) => i);
  }
  const picked: number[] = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i]!;
    if (range.min <= symbol && symbol <= range.max) picked.push(i);
  }
  return picked;
}

/**
 * Decodes columns of the given row groups; the table views WASM memory.
 * No groups means the whole file.
 */
function decodeGroups(bytes: Uint8Array, columns: string[], groups?: number[]): Table {
  const wasmTable =
    groups === undefined
      ? readParquet(bytes, { columns, batchSize: BATCH_SIZE })
      : readParquet(bytes, { columns, rowGroups: groups, batchSize: BATCH_SIZE });
  // intoFFI consumes the WASM table, so only the FFI handle needs freeing.
  const ffi = wasmTable.intoFFI();
  try {
    // copy:false keeps zero-copy views; extraction below copies out
    // synchronously, before any later decode could grow WASM memory.
    return parseTable(wasmMemory().buffer, ffi.arrayAddrs(), ffi.schemaAddr(), false);
  } finally {
    ffi.free();
  }
}

function childVector(table: Table, name: string): Vector {
  const vector = table.getChild(name);
  if (!vector) throw new Error(`Parquet file has no ${name} column`);
  return vector;
}

interface StringChunk {
  offsets: ArrayLike<number>;
  values: Uint8Array;
  length: number;
}

/** The Symbol column as raw byte slices, chunk by chunk. */
function stringChunks(vector: Vector): StringChunk[] {
  return vector.data.map((chunk: Data) => ({
    offsets: chunk.valueOffsets as unknown as ArrayLike<number>,
    values: chunk.values as unknown as Uint8Array,
    length: chunk.length,
  }));
}

interface NumberChunk {
  values: Float32Array | Int32Array;
  offset: number;
  length: number;
}

/** One batch of a numeric column, read through its own typed array. */
function numberChunks(vector: Vector): NumberChunk[] {
  return vector.data.map((chunk: Data) => ({
    values: chunk.values as unknown as Float32Array | Int32Array,
    offset: chunk.offset,
    length: chunk.length,
  }));
}

/**
 * Full series for one symbol. The caller caches it whole and slices per
 * timeframe, so a timeframe switch never re-decodes. Rows come out in file
 * order, which is date order inside one symbol's run.
 */
export async function readBars(file: Blob, symbol: string): Promise<{ rows: WorkerRow[]; perf: QueryPerf }> {
  if (await isFlatFile(file)) return readFlatBars(file, symbol);
  const t0 = performance.now();
  const { ranges, count } = await symbolRanges(file);
  const footerMs = performance.now() - t0;
  const groups = groupsFor(ranges, symbol, count);
  const perf = { fileBytes: file.size, footerMs: Math.round(footerMs), parseMs: 0, rowsScanned: 0 };
  // No group can hold this symbol (a dead name in an old era): the footer
  // alone proves it, and skipping the decode saves ~a second per file.
  if (groups.length === 0) return { rows: [], perf };
  await ensureInit();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const t1 = performance.now();
  const table = decodeGroups(bytes, BARS_COLUMNS, groups);
  try {
    const wanted = hashString(symbol);
    const decoder = new TextDecoder();
    const symbols = stringChunks(childVector(table, 'Symbol'));
    const dates = numberChunks(childVector(table, 'Date'));
    const opens = numberChunks(childVector(table, 'Open'));
    const highs = numberChunks(childVector(table, 'High'));
    const lows = numberChunks(childVector(table, 'Low'));
    const closes = numberChunks(childVector(table, 'Close'));
    const volumes = numberChunks(childVector(table, 'Volume'));
    const rows: WorkerRow[] = [];
    for (let c = 0; c < symbols.length; c += 1) {
      const sym = symbols[c]!;
      const date = dates[c]!;
      const open = opens[c]!;
      const high = highs[c]!;
      const low = lows[c]!;
      const close = closes[c]!;
      const volume = volumes[c]!;
      for (let i = 0; i < sym.length; i += 1) {
        const start = Number(sym.offsets[i]);
        const end = Number(sym.offsets[i + 1]);
        if (hashBytes(sym.values, start, end) !== wanted) continue;
        if (decoder.decode(sym.values.subarray(start, end)) !== symbol) continue;
        const day = date.values[date.offset + i] as number;
        if (!Number.isFinite(day)) continue;
        const at = (chunk: NumberChunk): number => chunk.values[chunk.offset + i] as number;
        rows.push({
          date: dayToISO(day),
          open: at(open),
          high: at(high),
          low: at(low),
          close: at(close),
          volume: at(volume),
        });
      }
    }
    perf.parseMs = Math.round(performance.now() - t1);
    perf.rowsScanned = rows.length;
    return { rows, perf };
  } finally {
    // The table views WASM memory; later decodes may reuse it, so no view
    // escapes this block — rows above are plain JS values.
  }
}

/**
 * Latest two sessions per symbol out of one file. One pass over the
 * decoded groups: every wanted symbol's hash is checked per row, so the
 * scan costs one hash per row no matter how many tickers the strip asks
 * about. Symbols with no row group are absent from this file and skip the
 * decode entirely.
 */
/**
 * Latest two sessions per symbol out of one file. This stays on hyparquet
 * on purpose: a watchlist query touches a few dozen symbols scattered over
 * every row group, and hyparquet fetches only the pages it needs through
 * ranged reads. The WASM reader would have to swallow the whole file first
 * (measured 4.5s on the big era file vs ~1.5s here). Dense single-symbol
 * reads go the other way — see readBars.
 */
export async function readQuotes(
  file: Blob,
  symbols: string[],
): Promise<{ quotes: Record<string, WorkerQuote>; perf: QueryPerf }> {
  if (await isFlatFile(file)) return readFlatQuotes(file, symbols);
  const out: Record<string, WorkerQuote> = {};
  const perf = { fileBytes: file.size, footerMs: 0, parseMs: 0, rowsScanned: 0 };
  if (symbols.length === 0) return { quotes: out, perf };
  const wanted = new Set(symbols);
  const t0 = performance.now();
  const rows = await parquetQuery({
    file: blobBuffer(file),
    columns: ['Symbol', 'Date', 'Close'],
    filter: { Symbol: { $in: symbols } },
  });
  perf.parseMs = Math.round(performance.now() - t0);
  perf.rowsScanned = rows.length;
  // Latest two sessions per symbol: last close and the move since the bar
  // before it. One pass — the file is read once no matter how many tickers
  // the watchlist strip asks about.
  const latest = new Map<string, { day: number; close: number }>();
  const previous = new Map<string, { day: number; close: number }>();
  for (const row of rows as { Symbol: unknown; Date: unknown; Close: unknown }[]) {
    const symbol = String(row.Symbol);
    if (!wanted.has(symbol)) continue;
    const day = Number(row.Date);
    const close = Number(row.Close);
    if (!Number.isFinite(day) || !Number.isFinite(close)) continue;
    const cur = latest.get(symbol);
    if (!cur || day > cur.day) {
      if (cur) {
        const prev = previous.get(symbol);
        if (!prev || cur.day > prev.day) previous.set(symbol, cur);
      }
      latest.set(symbol, { day, close });
    } else {
      const prev = previous.get(symbol);
      if (!prev || day > prev.day) previous.set(symbol, { day, close });
    }
  }
  for (const symbol of symbols) {
    const last = latest.get(symbol);
    if (!last) continue;
    const prev = previous.get(symbol);
    out[symbol] = {
      price: last.close,
      changePct:
        prev && prev.close !== 0 ? ((last.close - prev.close) / prev.close) * 100 : 0,
      lastDate: dayToISO(last.day),
      prevDate: prev ? dayToISO(prev.day) : null,
      prevClose: prev ? prev.close : null,
    };
  }
  return { quotes: out, perf };
}

/**
 * The ticker directory: the search row plus the market facts a quote header
 * needs (exchange, currency). Decoded whole — 19k short strings, once.
 */
export async function readCatalog(file: Blob): Promise<CatalogEntry[]> {
  await ensureInit();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let table: Table;
  let hasStatus = true;
  try {
    table = decodeGroups(bytes, CATALOG_COLUMNS);
  } catch {
    // A catalog published before the status column existed: nothing in it is
    // archived, so the directory is the whole file.
    hasStatus = false;
    table = decodeGroups(bytes, CATALOG_COLUMNS.filter((name) => name !== 'Status'));
  }
  const decoder = new TextDecoder();
  const decode = (chunk: StringChunk, i: number): string => {
    const start = Number(chunk.offsets[i]);
    const end = Number(chunk.offsets[i + 1]);
    return decoder.decode(chunk.values.subarray(start, end)).trim();
  };
  const columns = CATALOG_COLUMNS.filter((name) => hasStatus || name !== 'Status').map((name) =>
    stringChunks(childVector(table, name)),
  );
  const [tickers, names, universes, markets, countries, exchanges, currencies, statuses] = columns;
  const out: CatalogEntry[] = [];
  for (let c = 0; c < (tickers?.length ?? 0); c += 1) {
    const tick = tickers![c]!;
    for (let i = 0; i < tick.length; i += 1) {
      const ticker = decode(tick, i);
      const label = decode(names![c]!, i);
      if (!ticker || !label) continue;
      if (hasStatus && decode(statuses![c]!, i).toLowerCase() === ARCHIVED_STATUS) continue;
      out.push({
        ticker,
        name: label,
        universe: decode(universes![c]!, i) || 'US',
        market: decode(markets![c]!, i),
        country: decode(countries![c]!, i),
        exchange: decode(exchanges![c]!, i),
        currency: decode(currencies![c]!, i) || 'USD',
      });
    }
  }
  out.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  return out;
}

/**
 * The daily FX table, whole. It is ~310KB and one row per session, so a
 * ranged read would cost more bookkeeping than it saves.
 */
export async function readFx(file: Blob): Promise<FxTable> {
  const rows = (await parquetReadObjects({
    file: blobBuffer(file),
  })) as Record<string, unknown>[];
  const days = new Int32Array(rows.length);
  const rates: Record<string, Float64Array> = {};
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    days[i] = Number(row.Date);
    for (const name of Object.keys(row)) {
      if (name === 'Date') continue;
      const column = (rates[name] ??= new Float64Array(rows.length));
      column[i] = Number(row[name]);
    }
  }
  return { days, rates };
}
