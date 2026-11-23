// flat.ts — reads the self-contained MARKET_DAILY .bin bundles.
//
// Each file is 24-byte preamble + embedded JSON header + raw columns:
//   sym u16, date u16, open/high/low/close/vol f32.
// The header carries the symbol table, per-symbol starts/counts and the
// payload offsets, so a single-symbol chart reads only that symbol's run.
//
// The reads are ranged on purpose. A bundle is 50–210MB, and handing the whole
// of one to arrayBuffer() — what this file used to do — costs a 200MB
// allocation and hundreds of milliseconds per era (measured 414ms on the
// 177MB 2018-2022 US block). The header says where a symbol's bars sit, so
// two or three small Blob slices (149KB for a 1,259-bar AAPL run, 17ms) give
// the same rows. On a phone the difference is the whole chart: the old path
// allocated past what iOS Safari will hand a tab.

import type { QueryPerf, WorkerQuote, WorkerRow } from './parquet';

const MAGIC = 'SLTPFLAT';
const DAY_MS = 86_400_000;
const PREAMBLE = 24;

interface FlatHeader {
  symbols: string[];
  starts: number[];
  counts: number[];
  offsets: {
    sym: number;
    date: number;
    open: number;
    high: number;
    low: number;
    close: number;
    vol: number;
  };
  first_session: string;
  last_session: string;
}

interface ParsedFlat {
  header: FlatHeader;
  payload: number;
  rows: number;
}

/** Headers parsed this session, so a range switch does not re-read one. */
const headerCache = new WeakMap<Blob, Promise<ParsedFlat>>();

function dayToISO(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

async function parseFlat(file: Blob): Promise<ParsedFlat> {
  const cached = headerCache.get(file);
  if (cached) return cached;
  const run = (async (): Promise<ParsedFlat> => {
    if (file.size < PREAMBLE) throw new Error('Flat bundle is missing its preamble');
    const preamble = await file.slice(0, PREAMBLE).arrayBuffer();
    const view = new DataView(preamble);
    const magic = new TextDecoder().decode(new Uint8Array(preamble, 0, 8));
    if (magic !== MAGIC) throw new Error(`Not a flat bundle: ${magic}`);
    if (view.getUint32(8, true) !== 1) throw new Error('Unsupported flat bundle format');
    const headerLen = view.getUint32(12, true);
    // The row count is a u64 across the last two preamble fields.
    const rows = view.getUint32(16, true) + view.getUint32(20, true) * 0x1_0000_0000;
    // A header cut short means the file is truncated: fail here rather than
    // reading a symbol's run out of bytes that are not on disk.
    if (PREAMBLE + headerLen > file.size) throw new Error('Flat bundle header is truncated');
    const header = JSON.parse(
      new TextDecoder().decode(
        await file.slice(PREAMBLE, PREAMBLE + headerLen).arrayBuffer(),
      ),
    ) as FlatHeader;
    if (!Array.isArray(header.symbols) || header.starts.length !== header.symbols.length) {
      throw new Error('Flat bundle header is malformed');
    }
    return { header, payload: PREAMBLE + headerLen, rows };
  })();
  headerCache.set(file, run);
  // A failed parse must not stay cached: the next retry re-reads the file.
  run.catch(() => headerCache.delete(file));
  return run;
}

/** One column's run for `count` rows starting at the symbol's first row. */
async function readRun(
  file: Blob,
  at: number,
  count: number,
  Ctor: typeof Uint16Array | typeof Float32Array,
): Promise<Uint16Array | Float32Array> {
  const bytes = Ctor.BYTES_PER_ELEMENT;
  const buffer = await file.slice(at, at + count * bytes).arrayBuffer();
  return new Ctor(buffer);
}

/** True when the file's first eight bytes are the flat magic. */
export async function isFlatFile(file: Blob): Promise<boolean> {
  if (file.size < 8) return false;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return new TextDecoder().decode(head) === MAGIC;
}

/** Full series for one symbol, straight out of its run in the flat file. */
export async function readFlatBars(
  file: Blob,
  symbol: string,
): Promise<{ rows: WorkerRow[]; perf: QueryPerf }> {
  const t0 = performance.now();
  const { header, payload } = await parseFlat(file);
  const footerMs = performance.now() - t0;
  const perf: QueryPerf = {
    fileBytes: file.size,
    footerMs: Math.round(footerMs),
    parseMs: 0,
    rowsScanned: 0,
  };
  const index = header.symbols.indexOf(symbol);
  if (index < 0) return { rows: [], perf };
  const start = header.starts[index]!;
  const count = header.counts[index]!;
  if (count <= 0) return { rows: [], perf };

  const t1 = performance.now();
  const offsets = header.offsets;
  const [dates, opens, highs, lows, closes, volumes] = await Promise.all([
    readRun(file, payload + offsets.date + start * 2, count, Uint16Array),
    readRun(file, payload + offsets.open + start * 4, count, Float32Array),
    readRun(file, payload + offsets.high + start * 4, count, Float32Array),
    readRun(file, payload + offsets.low + start * 4, count, Float32Array),
    readRun(file, payload + offsets.close + start * 4, count, Float32Array),
    readRun(file, payload + offsets.vol + start * 4, count, Float32Array),
  ]);
  const out: WorkerRow[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = {
      date: dayToISO((dates as Uint16Array)[i]!),
      open: (opens as Float32Array)[i]!,
      high: (highs as Float32Array)[i]!,
      low: (lows as Float32Array)[i]!,
      close: (closes as Float32Array)[i]!,
      volume: (volumes as Float32Array)[i]!,
    };
  }
  perf.parseMs = Math.round(performance.now() - t1);
  perf.rowsScanned = out.length;
  return { rows: out, perf };
}

/** Last two sessions for the requested symbols, from each symbol's run. */
export async function readFlatQuotes(
  file: Blob,
  symbols: string[],
): Promise<{ quotes: Record<string, WorkerQuote>; perf: QueryPerf }> {
  const out: Record<string, WorkerQuote> = {};
  const perf: QueryPerf = { fileBytes: file.size, footerMs: 0, parseMs: 0, rowsScanned: 0 };
  if (symbols.length === 0) return { quotes: out, perf };
  const t0 = performance.now();
  const { header, payload } = await parseFlat(file);
  perf.footerMs = Math.round(performance.now() - t0);

  // Only the last two rows of each wanted symbol are needed, so the read is
  // two sessions per symbol instead of the whole date and close columns
  // (which cost ~85MB of a 210MB file before this was ranged).
  const t1 = performance.now();
  const offsets = header.offsets;
  const index = new Map(header.symbols.map((symbol, position) => [symbol, position]));
  await Promise.all(
    symbols.map(async (symbol) => {
      const position = index.get(symbol);
      if (position === undefined) return;
      const count = header.counts[position]!;
      if (count <= 0) return;
      const take = Math.min(count, 2);
      const first = header.starts[position]! + count - take;
      const [dates, closes] = await Promise.all([
        readRun(file, payload + offsets.date + first * 2, take, Uint16Array),
        readRun(file, payload + offsets.close + first * 4, take, Float32Array),
      ]);
      const dayCodes = dates as Uint16Array;
      const prices = closes as Float32Array;
      const lastAt = take - 1;
      out[symbol] = {
        price: prices[lastAt]!,
        changePct:
          take >= 2 && prices[0] !== 0
            ? ((prices[lastAt]! - prices[0]!) / prices[0]!) * 100
            : 0,
        lastDate: dayToISO(dayCodes[lastAt]!),
        prevDate: take >= 2 ? dayToISO(dayCodes[0]!) : null,
        prevClose: take >= 2 ? prices[0]! : null,
      };
      perf.rowsScanned += take;
    }),
  );
  perf.parseMs = Math.round(performance.now() - t1);
  return { quotes: out, perf };
}
