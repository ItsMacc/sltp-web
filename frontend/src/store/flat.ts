// flat.ts — reads the self-contained MARKET_DAILY .bin bundles.
//
// Each file is 24-byte preamble + embedded JSON header + raw columns:
//   sym u16, date u16, open/high/low/close/vol f32.
// The header carries the symbol table, per-symbol starts/counts and the
// payload offsets, so a single-symbol chart reads only that symbol's run.

import type { QueryPerf, WorkerQuote, WorkerRow } from './parquet';

const MAGIC = 'SLTPFLAT';
const DAY_MS = 86_400_000;

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

function dayToISO(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function parseFlat(buffer: ArrayBuffer): ParsedFlat {
  if (buffer.byteLength < 24) throw new Error('Flat bundle is missing its preamble');
  const view = new DataView(buffer);
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
  if (magic !== MAGIC) throw new Error(`Not a flat bundle: ${magic}`);
  if (view.getUint32(8, true) !== 1) throw new Error('Unsupported flat bundle format');
  const headerLen = view.getUint32(12, true);
  const rows = view.getUint32(16, true) + view.getUint32(20, true) * 0x1_0000_0000;
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 24, headerLen)),
  ) as FlatHeader;
  if (!Array.isArray(header.symbols) || header.starts.length !== header.symbols.length) {
    throw new Error('Flat bundle header is malformed');
  }
  return { header, payload: 24 + headerLen, rows };
}

function f32(buffer: ArrayBuffer, offset: number, count: number): Float32Array {
  return new Float32Array(buffer.slice(offset, offset + count * 4));
}

function u16(buffer: ArrayBuffer, offset: number, count: number): Uint16Array {
  return new Uint16Array(buffer.slice(offset, offset + count * 2));
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
  const buffer = await file.arrayBuffer();
  const { header, payload } = parseFlat(buffer);
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
  const dates = u16(buffer, payload + header.offsets.date + start * 2, count);
  const opens = f32(buffer, payload + header.offsets.open + start * 4, count);
  const highs = f32(buffer, payload + header.offsets.high + start * 4, count);
  const lows = f32(buffer, payload + header.offsets.low + start * 4, count);
  const closes = f32(buffer, payload + header.offsets.close + start * 4, count);
  const volumes = f32(buffer, payload + header.offsets.vol + start * 4, count);
  const out: WorkerRow[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      date: dayToISO(dates[i]!),
      open: opens[i]!,
      high: highs[i]!,
      low: lows[i]!,
      close: closes[i]!,
      volume: volumes[i]!,
    });
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
  const buffer = await file.arrayBuffer();
  const { header, payload, rows } = parseFlat(buffer);
  perf.footerMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const dates = u16(buffer, payload + header.offsets.date, rows);
  const closes = f32(buffer, payload + header.offsets.close, rows);
  const wanted = new Set(symbols);
  for (let index = 0; index < header.symbols.length; index += 1) {
    const symbol = header.symbols[index]!;
    if (!wanted.has(symbol)) continue;
    const count = header.counts[index]!;
    if (count <= 0) continue;
    const at = header.starts[index]! + count - 1;
    const lastDay = dates[at]!;
    const lastClose = closes[at]!;
    const prevAt = at - 1;
    const hasPrev = count >= 2;
    const prevDay = hasPrev ? dates[prevAt]! : null;
    const prevClose = hasPrev ? closes[prevAt]! : null;
    out[symbol] = {
      price: lastClose,
      changePct:
        prevClose != null && prevClose !== 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0,
      lastDate: dayToISO(lastDay),
      prevDate: prevDay != null ? dayToISO(prevDay) : null,
      prevClose,
    };
    perf.rowsScanned += Math.min(count, 2);
  }
  perf.parseMs = Math.round(performance.now() - t1);
  return { quotes: out, perf };
}
