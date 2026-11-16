// sync.ts — the background download sequence plus where files come from.
//
// First visit: check the manifest and fetch the plan (desktop: all 29 year
// files; phone: the recent tail plus the five-calendar-year window), then on
// desktop keep going backwards one year at a time. Every later boot reconciles
// the plan against the manifest by byte count and fetches only what's missing
// or changed — usually just the `recent` tail after a daily update, never a
// wholesale re-download.
// Progress is published to subscribers, so any page can show
// "downloading…" while charts already paint what has landed.
//
// The plan is why "N of M files" always reads true: totalFiles counts the
// plan's bars, and loadedFiles can only ever hold plan keys (plus nothing
// else — sidecars ride along but are never counted). A phone shows 7 of 7
// (the tail plus six calendar years), a desktop 30 of 30 (29 years plus the
// tail), and neither can drift apart again.
//
// Cost model, measured Nov 2026: the desktop priority pair (tail + current
// year) is ~28MB (~a couple of seconds on a fast link) and the full set
// ~748MB; the phone plan (tail plus the five-year window) is smaller. Reads stay inside the
// bucket's free Class B allowance because every file downloads once per
// version and is read from disk afterwards.
//
// The bucket is private: every byte comes through the gate Worker in
// gateway/, which counts one R2 read per file and closes the month at
// 9.95M. A device with no cache marks its requests `?new=1` so it may spend
// the reserve above 9M; everything else stops at 9M. Nothing else in this
// file knows about that.

import { useSyncExternalStore } from 'react';
import { IS_MOBILE, MOBILE_HISTORY_START } from './device';
import { writeWithSyncAccess } from './opfsWrite';
import {
  deleteFile,
  fileSize,
  removeDir,
  getFile,
  hasFile,
  listFiles,
  opfsSupported,
  putFile,
  putFileInMemory,
  putFileStream,
  readVersion,
  requestPersistentStorage,
  writeVersion,
} from './opfs';
import {
  readStoredUserSettings,
  readUpdateHorizon,
  updateHorizonDays,
  type UpdateHorizon,
} from '../../lib/settings';

export type SyncPhase =
  | 'idle'
  | 'checking'
  | 'priority'
  | 'prefetch'
  | 'ready'
  | 'degraded'
  | 'error';

/** What this browser intends to hold: everything, or the recent pair. */
export type SyncPlan = 'full' | 'recent';

export interface SyncStatus {
  phase: SyncPhase;
  /** Published dataset version (null until the first manifest lands). */
  version: string | null;
  /** The publisher's "last written" date, when the manifest carries one. */
  datasetDate: string | null;
  /** Which plan is running: full history, or the phone-sized recent pair. */
  plan: SyncPlan;
  /** Chunk keys on disk, newest first — always a subset of the plan. */
  loadedFiles: string[];
  /** Planned bar files in the current manifest (what "of M" counts). */
  totalFiles: number;
  bytesLoaded: number;
  bytesTotal: number;
  /** Metered link: priority fetched, older years wait for prefetchOlder(). */
  olderDeferred: boolean;
  error: string | null;
  /** Set when the gate refused a download: the month's allowance is spent. */
  paused: SyncPause | null;
}

/** What the gate said when it closed, in the words the toast and the FAQ share. */
export interface SyncPause {
  message: string;
}

const INITIAL: SyncStatus = {
  phase: 'idle',
  version: null,
  datasetDate: null,
  plan: 'full',
  loadedFiles: [],
  totalFiles: 0,
  bytesLoaded: 0,
  bytesTotal: 0,
  olderDeferred: false,
  error: null,
  paused: null,
};

let status: SyncStatus = { ...INITIAL };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn());
}

export function getSyncStatus(): SyncStatus {
  return status;
}

function subscribeSyncStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React binding for the background sequence. Re-renders on progress. */
export function useMarketSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
}

/** The gate in front of the private sltp-market-data bucket. */
export const GATEWAY_BASE_URL =
  'https://sltp-data.magicaltitan7.workers.dev';

/** Small file naming which chunks exist and what data version they belong to. */
export const MANIFEST_KEY = 'META/manifest.json';

/** True until this device holds a downloaded dataset. A first sync is the one
    kind of request the gate still serves once the month passes 9M reads. */
let firstSync = true;

export interface ManifestFile {
  key: string;
  bytes: number;
  rows: number;
  row_groups: number;
  first_session: string | null;
  last_session: string | null;
}

export interface Manifest {
  version: string;
  /** When the publisher last wrote the dataset, e.g. "2026-11-13". Older
      manifests only carry `version`, which is itself a date. */
  updated?: string;
  files: ManifestFile[];
}

/** This device's random id, so the gate can tell a returning downloader from
    one that just emptied its cache. It lives in localStorage, next to the
    session, not in the OPFS tree a cache clear removes. */
const DEVICE_KEY = 'st_device_id';

function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const created = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return '';
  }
}

/** Query string for a gate call: the first-sync flag plus this device's id. */
function gateQuery(first: boolean): string {
  const params = new URLSearchParams();
  if (first) params.set('new', '1');
  const id = deviceId();
  if (id) params.set('d', id);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** The published dataset version, e.g. "2026-11-11". A few bytes. */
export async function fetchManifest(): Promise<Manifest> {
  const res = await fetch(`${GATEWAY_BASE_URL}/manifest.json${gateQuery(firstSync)}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Manifest fetch failed (${res.status})`);
  const manifest = (await res.json()) as Manifest;
  if (!manifest?.version || !Array.isArray(manifest.files)) {
    throw new Error('Manifest had an unexpected shape');
  }
  return manifest;
}

/** This device's copy of the manifest, so a boot inside the update horizon can
    decide from disk without asking the gate anything. */
const LOCAL_MANIFEST = 'manifest.json';
let localManifest: Manifest | null = null;

/** The manifest this browser last synced, or null on a device with no cache. */
export async function readLocalManifest(): Promise<Manifest | null> {
  if (localManifest) return localManifest;
  try {
    const file = await getFile(LOCAL_MANIFEST);
    if (!file) return null;
    const parsed = JSON.parse(await file.text()) as Manifest;
    if (!parsed?.version || !Array.isArray(parsed.files)) return null;
    localManifest = parsed;
    return parsed;
  } catch {
    return null;
  }
}

async function writeLocalManifest(manifest: Manifest): Promise<void> {
  localManifest = manifest;
  try {
    await putFile(
      LOCAL_MANIFEST,
      new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    );
  } catch {
    // A cache that cannot hold the manifest still works; the next boot just
    // checks the gate again instead of deciding from disk.
  }
}

/** The date the publisher stamped on a dataset, for the horizon comparison. */
export function manifestUpdated(manifest: Manifest): string | null {
  const stamp = manifest.updated ?? manifest.version;
  return /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : null;
}

/** Days between the publisher's stamp and today, or null when unreadable. */
export function manifestAgeDays(manifest: Manifest, today = new Date()): number | null {
  const stamp = manifestUpdated(manifest);
  if (!stamp) return null;
  const then = Date.parse(`${stamp}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.floor((start - then) / 86_400_000));
}

/** True when the local copy is old enough that the next boot should check. */
export function horizonDue(manifest: Manifest, horizon: UpdateHorizon, today = new Date()): boolean {
  const age = manifestAgeDays(manifest, today);
  return age === null || age >= updateHorizonDays(horizon);
}

/**
 * The URL the browser downloads one file from: the gate's versioned path, so
 * a data version is immutable in the edge cache. `?new=1` only rides on a
 * device's first download; it never changes the cached URL, because the gate
 * keys its cache on the path alone.
 */
export async function resolveFileUrl(key: string): Promise<string> {
  const version = manifestCache?.version;
  const base = version ? `${GATEWAY_BASE_URL}/v/${version}` : GATEWAY_BASE_URL;
  return `${base}/${key}${gateQuery(firstSync)}`;
}

/**
 * "market_data_2019.bin" / "market_data_2019.parquet" -> [2019, 2019];
 * the retired six-year parquet shape -> [1998, 2003]; anything else null
 * (the `recent` tail, the actions sidecar). Both bar formats flow through
 * the same logic, so a mixed manifest still plans and queries correctly.
 */
export function chunkRange(key: string): [number, number] | null {
  const single = /market_data_(\d{4})\.(?:bin|parquet)$/.exec(key);
  if (single) return [Number(single[1]), Number(single[1])];
  const range = /market_data_(\d{4})_(\d{4})\.parquet$/.exec(key);
  if (!range) return null;
  return [Number(range[1]), Number(range[2])];
}

/** Bar files only: MARKET_DAILY bars (year files plus the tail), no actions
    sidecar, no catalog. */
function barKeys(files: ManifestFile[]): string[] {
  return files
    .map((f) => f.key)
    .filter(
      (key) =>
        key.startsWith('MARKET_DAILY/') &&
        (key.endsWith('.parquet') || key.endsWith('.bin')) &&
        !key.endsWith('market_actions.parquet'),
    );
}

/** The ticker directory sidecar: small, and watchlist search will want it. */
const CATALOG_KEY = 'SYMBOL_DATA/symbol_catalog.parquet';

/**
 * The chunk keys this browser plans to hold, newest first. Phones keep the
 * recent tail plus every year file that reaches their five-calendar-year
 * floor; desktops keep everything. Filtering by year rather than by a fixed
 * count is what makes the oldest file fall out on New Year's Day without a
 * data-version change.
 * Sidecars are outside the plan — they always download with the priority pair.
 */
export function planKeys(files: ManifestFile[]): string[] {
  const ordered = newestFirst(barKeys(files));
  if (!IS_MOBILE) return ordered;
  const floorYear = Number(MOBILE_HISTORY_START.slice(0, 4));
  return ordered.filter((key) => {
    const range = chunkRange(key);
    if (!range) return true; // the recent tail
    return range[1] >= floorYear;
  });
}

/** The active plan's keys (null until the first manifest lands). Queries
    intersect their chunk choice with this, so a phone never fetches outside
    its five-year plan and a desktop never fetches the actions sidecar as bars. */
let activePlan: string[] | null = null;

export function getActivePlan(): string[] | null {
  return activePlan;
}

/** Adds a key to loadedFiles unless it is already counted. Plan keys only:
    callers pass bars; sidecars are downloaded with track=false. */
function markLoaded(key: string): void {
  if (status.loadedFiles.includes(key)) return;
  setStatus({ loadedFiles: newestFirst([...status.loadedFiles, key]) });
}

/**
 * Which bar files overlap [start, end]. Mirrors the engine's bar_files_for:
 * chunks whose filename years overlap the range, plus the `recent` tail when
 * the range reaches the newest chunk. Undefined start/end means open.
 */
export function keysForRange(
  files: ManifestFile[],
  start?: string,
  end?: string,
): string[] {
  const keys = barKeys(files);
  if (start == null && end == null) return keys;

  const firstYear = start == null ? null : Number(start.slice(0, 4));
  const lastYear = end == null ? null : Number(end.slice(0, 4));

  const chunks: { low: number; high: number; key: string }[] = [];
  const others: string[] = [];
  for (const key of keys) {
    const range = chunkRange(key);
    if (!range) {
      others.push(key);
      continue;
    }
    chunks.push({ low: range[0], high: range[1], key });
  }
  if (chunks.length === 0) return keys;

  const selected = chunks
    .filter(
      ({ low, high }) =>
        (firstYear == null || high >= firstYear) &&
        (lastYear == null || low <= lastYear),
    )
    .map(({ key }) => key);

  const newest = Math.max(...chunks.map(({ high }) => high));
  if (lastYear == null || lastYear >= newest) selected.push(...others);
  return selected;
}

/** Newest chunk first — the paint-as-you-go order for queries and prefetch. */
export function newestFirst(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ra = chunkRange(a);
    const rb = chunkRange(b);
    if (!ra && !rb) return a < b ? -1 : 1;
    if (!ra) return -1;
    if (!rb) return 1;
    return rb[1] - ra[1];
  });
}

function isMetered(): boolean {
  const conn = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; type?: string };
    }
  ).connection;
  if (!conn) return false;
  return conn.saveData === true || conn.type === 'cellular';
}

let manifestCache: Manifest | null = null;
let manifestPromise: Promise<Manifest> | null = null;
let bootPromise: Promise<void> | null = null;
/** Keys already counted in bytesTotal (denominator counts each file once). */
const counted = new Set<string>();
/** Downloads currently in flight, so boot and on-demand queries share one. */
const inflight = new Map<string, Promise<void>>();

/** Adds a file's bytes to the progress denominator exactly once. */
function countBytes(entry: ManifestFile): void {
  if (counted.has(entry.key)) return;
  counted.add(entry.key);
  setStatus({ bytesTotal: status.bytesTotal + entry.bytes });
}

/** Manifest of the current boot (null until the first check completes). */
export function getManifest(): Manifest | null {
  return manifestCache;
}

/**
 * Fetches only the manifest and installs the plan. Search calls this directly:
 * the ticker catalog is 0.4MB, and waiting for the 30MB priority pair before
 * showing suggestions is what made the first search feel frozen.
 */
/**
 * Re-reads the manifest after the gate refused a versioned path. The gate only
 * serves `/v/<version>/` for the version the bucket publishes today, so a tab
 * that booted moments before a daily update holds a manifest whose URLs now
 * 404. Dropping the local copy forces a real fetch; one refresh is enough,
 * because the retry uses the new version's URL.
 */
export async function refreshManifest(): Promise<Manifest> {
  manifestCache = null;
  manifestPromise = null;
  localManifest = null;
  await deleteFile(LOCAL_MANIFEST);
  return ensureManifest();
}

/** The update horizon, read once per call: a setting changed in another tab
    applies on the next boot, not mid-download. */
function currentUpdateHorizon(): UpdateHorizon {
  return readUpdateHorizon(readStoredUserSettings());
}

/**
 * The manifest this boot will work from.
 *
 * Inside the update horizon the device answers from its own copy and sends the
 * gate nothing, which is what keeps the monthly read allowance quiet. Past it
 * the manifest is fetched again; if the version moved, only the files whose
 * byte count changed are downloaded (a daily publish rewrites the recent tail
 * and sometimes the actions sidecar).
 */
export async function ensureManifest(): Promise<Manifest> {
  if (manifestCache) return manifestCache;
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const stored = await readVersion();
      const local = await readLocalManifest();
      // A device with a marker or a local manifest has downloaded before, so
      // its reads no longer come out of the reserve above the 9M line.
      firstSync = stored === null && local === null;
      const horizon = currentUpdateHorizon();
      const fresh = local !== null && stored === local.version && !horizonDue(local, horizon);
      const manifest = fresh ? local : await fetchManifest();
      if (!fresh) await writeLocalManifest(manifest);
      manifestCache = manifest;
      activePlan = planKeys(manifest.files);
      setStatus({
        version: manifest.version,
        datasetDate: manifestUpdated(manifest),
        totalFiles: activePlan.length,
      });
      return manifest;
    })().finally(() => {
      manifestPromise = null;
    });
  }
  return manifestPromise;
}

/** Reads the gate's refusal body once, so the caller can show its words. */
async function readPause(res: Response): Promise<SyncPause | null> {
  try {
    const body = (await res.clone().json()) as { paused?: boolean; message?: string };
    if (!body?.paused) return null;
    return {
      message: body.message || 'Market data is briefly unavailable. Please try again later.',
    };
  } catch {
    return null;
  }
}

/** The files a chart needs first: the tail plus the current year file.
    Always inside the plan — on a phone that pair IS the whole plan. */
function priorityKeys(plan: string[]): string[] {
  const recent = plan.filter((key) => key.includes('recent'));
  const chunks = plan.filter((key) => chunkRange(key) !== null);
  const newest = newestFirst(chunks)[0];
  const priority = [...recent];
  if (newest && !priority.includes(newest)) priority.push(newest);
  return priority.length > 0 ? priority : plan.slice(0, 1);
}

/** Three downloads at a time. The plan used to fetch one file after another,
    which left the link idle while each 28MB chunk was written to OPFS. Each
    stream goes straight to disk, so the lanes cost no extra file memory; the
    third one keeps a fast link busy when one stream is waiting on a disk
    write. Phones use two: their plan is only a handful of files, and a third
    stream buys little on a cellular link. */
const DOWNLOAD_LANES = IS_MOBILE ? 2 : 3;
let activeDownloads = 0;
const downloadWaiters: (() => void)[] = [];

async function withDownloadLane<T>(job: () => Promise<T>): Promise<T> {
  if (activeDownloads >= DOWNLOAD_LANES) {
    await new Promise<void>((resolve) => downloadWaiters.push(resolve));
  }
  activeDownloads += 1;
  try {
    return await job();
  } finally {
    activeDownloads -= 1;
    downloadWaiters.shift()?.();
  }
}

/**
 * Downloads one file into OPFS, streaming progress into the status.
 * Concurrent callers (background prefetch + an open chart) share the same
 * download instead of fetching the same bytes twice, and at most two
 * different files are in flight at once.
 */
async function downloadFile(file: ManifestFile, track = true): Promise<void> {
  const existing = inflight.get(file.key);
  if (existing) {
    await existing;
    return;
  }
  const run = withDownloadLane(() => storeFile(file, track)).finally(() => {
    inflight.delete(file.key);
  });
  inflight.set(file.key, run);
  await run;
}

/**
 * Downloads one file into OPFS. History chunks join loadedFiles (the
 * "N of M files" count); sidecars pass track=false so the count stays
 * about history.
 */
async function storeFile(file: ManifestFile, track = true): Promise<void> {
  let url = await resolveFileUrl(file.key);
  let received = 0;
  const count = (bytes: number): void => {
    received += bytes;
    setStatus({ bytesLoaded: status.bytesLoaded + bytes });
  };

  try {
    let res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) {
      // A daily update landed since this page booted: the pinned version is
      // gone. Refreshing the manifest also refreshes the plan, so re-resolve
      // this key from the new version instead of failing the download.
      const fresh = await refreshManifest();
      const entry = fresh.files.find((f) => f.key === file.key);
      if (entry) file = entry;
      url = await resolveFileUrl(file.key);
      res = await fetch(url, { cache: 'no-store' });
    }
    if (res.status === 503 || res.status === 429) {
      // The gate closed the month (or the day). Its message is the one the
      // toast and the FAQ both carry, so it travels up unchanged.
      const pause = await readPause(res);
      if (pause) {
        setStatus({ paused: pause });
        throw new Error(pause.message);
      }
    }
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${file.key}`);
    // Written straight from the response into OPFS: buffering a 28MB chunk as
    // a Blob is what iOS Safari reports as an out-of-memory `UnknownError`.
    await putFileStream(file.key, res.body, count);
  } catch (error) {
    // A DOMException means the file system refused the write, not the network:
    // Safari's createWritable() gives up on large files with a generic
    // `UnknownError`. Retry once through a worker's synchronous handle, the
    // OPFS path WebKit is reliable about. A 401 or an aborted fetch is real.
    if (!(error instanceof DOMException)) throw error;
    setStatus({ bytesLoaded: Math.max(0, status.bytesLoaded - received) });
    received = 0;
    try {
      await writeWithSyncAccess(file.key, url, count);
    } catch {
      // Disk is full or the WebView refuses OPFS outright. Keep this one
      // file in memory so the chart still opens; the next visit retries.
      const retry = await fetch(url, { cache: 'no-store' });
      if (!retry.ok) throw new Error(`Download failed (${retry.status}): ${file.key}`);
      const blob = await retry.blob();
      await putFileInMemory(file.key, blob);
      received = blob.size;
      setStatus({ bytesLoaded: status.bytesLoaded + blob.size });
    }
  }
  // Streams rarely report the manifest's exact byte count; reconcile so the
  // bar lands on 100% instead of hovering near it.
  setStatus({
    bytesLoaded: status.bytesLoaded + Math.max(0, file.bytes - received),
  });
  if (track) markLoaded(file.key);
}

// -------- Bundles --------
// A new device used to ask the gate for thirty files, which is thirty Worker
// requests. `/bulk` answers all of them in one: a small header naming each
// file's byte count, then the files back to back. The browser writes each file
// as it arrives, so a 750MB bundle never sits in memory.

const BULK_MAGIC_LENGTH = 8;
/** 8-byte magic + u32 header length. */
const BULK_PREAMBLE = 12;
/** The gate's own ceiling is 64 keys and 1.2GB; stay inside both. */
const BULK_MAX_FILES = 60;
const BULK_MAX_BYTES = 1_000_000_000;

/** Bytes already read from the bundle that the next file has not consumed. */
interface ChunkCursor {
  pending: Uint8Array | null;
}

/** Reads exactly `length` bytes, keeping any surplus for the next caller. */
async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cursor: ChunkCursor,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    if (!cursor.pending) {
      const { done, value } = await reader.read();
      if (done) throw new Error('The bundle ended early');
      cursor.pending = value;
    }
    const chunk = cursor.pending;
    const take = Math.min(chunk.length, length - filled);
    out.set(chunk.subarray(0, take), filled);
    filled += take;
    cursor.pending = take === chunk.length ? null : chunk.subarray(take);
  }
  return out;
}

/** One file's slice of the bundle, as a stream `putFileStream` can consume. */
function takeBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cursor: ChunkCursor,
  total: number,
): ReadableStream<Uint8Array> {
  let remaining = total;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      try {
        if (!cursor.pending) {
          const { done, value } = await reader.read();
          if (done) throw new Error('The bundle ended early');
          cursor.pending = value;
        }
        const chunk = cursor.pending;
        const take = Math.min(chunk.length, remaining);
        controller.enqueue(chunk.subarray(0, take));
        remaining -= take;
        cursor.pending = take === chunk.length ? null : chunk.subarray(take);
        if (remaining === 0) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** True when the file on disk already matches the manifest's byte count. */
async function isCurrent(file: ManifestFile): Promise<boolean> {
  const actual = await fileSize(file.key);
  return actual !== null && actual === file.bytes;
}

/** What the given keys actually occupy on disk right now. */
async function sizeOnDisk(keys: string[]): Promise<number> {
  let total = 0;
  for (const key of keys) total += (await fileSize(key)) ?? 0;
  return total;
}

/** A downloaded plan file moves the "N of M" count; a sidecar never does. */
function noteDownloaded(file: ManifestFile): void {
  if (activePlan?.includes(file.key)) markLoaded(file.key);
}

/** One gate request for several files. Throws on any refusal or bad frame. */
async function bulkDownload(files: ManifestFile[], version: string): Promise<void> {
  const res = await fetch(`${GATEWAY_BASE_URL}/bulk${gateQuery(firstSync)}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version, keys: files.map((f) => f.key) }),
  });

  if (res.status === 503 || res.status === 429) {
    const pause = await readPause(res);
    if (pause) {
      setStatus({ paused: pause });
      throw new Error(pause.message);
    }
  }
  if (res.status === 404) {
    // A daily update landed since this page booted and the pinned version is
    // gone; the per-file retry path re-reads the manifest.
    throw new Error('Bundle version is gone');
  }
  if (!res.ok || !res.body) throw new Error(`Bundle failed (${res.status})`);

  const reader = res.body.getReader();
  const cursor: ChunkCursor = { pending: null };
  const head = await readExactly(reader, cursor, BULK_PREAMBLE);
  const magic = new TextDecoder().decode(head.slice(0, BULK_MAGIC_LENGTH));
  if (magic !== 'SLTPBULK') throw new Error('Bundle header was not recognised');
  const headerLength = new DataView(head.buffer).getUint32(BULK_MAGIC_LENGTH, true);
  const header = JSON.parse(
    new TextDecoder().decode(await readExactly(reader, cursor, headerLength)),
  ) as { files?: { key: string; bytes: number }[] };
  if (!Array.isArray(header.files)) throw new Error('Bundle header was malformed');

  for (const entry of header.files) {
    const file = files.find((f) => f.key === entry.key);
    if (!file) throw new Error(`Bundle carried an unrequested file: ${entry.key}`);
    let received = 0;
    const count = (bytes: number): void => {
      received += bytes;
      setStatus({ bytesLoaded: status.bytesLoaded + bytes });
    };
    await putFileStream(entry.key, takeBytes(reader, cursor, entry.bytes), count);
    setStatus({ bytesLoaded: status.bytesLoaded + Math.max(0, entry.bytes - received) });
    noteDownloaded(file);
  }
  await reader.cancel().catch(() => undefined);
}

/**
 * Fetches a list in the fewest gate requests that fit: one bundle per batch,
 * with a per-file request only for whatever a bundle did not deliver. A gate
 * refusal stops the whole pass — asking again would only be refused again.
 */
async function fetchFiles(files: ManifestFile[], version: string): Promise<void> {
  let batch: ManifestFile[] = [];
  let bytes = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const group = batch;
    batch = [];
    bytes = 0;
    if (group.length > 1) {
      try {
        await bulkDownload(group, version);
        return;
      } catch (error) {
        if (status.paused) throw error;
        // A bundle that breaks halfway leaves gaps; the loop below fills them
        // one file at a time, exactly as the old path did.
      }
    }
    for (const file of group) {
      if (await isCurrent(file)) {
        noteDownloaded(file);
        continue;
      }
      try {
        await downloadFile(file);
      } catch (error) {
        if (status.paused) throw error;
        setStatus({ error: error instanceof Error ? error.message : `Could not fetch ${file.key}` });
      }
    }
  };

  for (const file of files) {
    if (batch.length >= BULK_MAX_FILES || (batch.length > 0 && bytes + file.bytes > BULK_MAX_BYTES)) {
      await flush();
    }
    batch.push(file);
    bytes += file.bytes;
  }
  await flush();
}

/**
 * Fetches one file on demand (a chart asked for a range whose chunk never
 * downloaded). Resolves when the bytes are in OPFS.
 */
export async function ensureFile(key: string): Promise<void> {
  if (await hasFile(key)) return;
  const manifest = await ensureManifest();
  const entry = manifest.files.find((f) => f.key === key);
  if (!entry) throw new Error(`Unknown market file: ${key}`);
  countBytes(entry);
  // Sidecars (catalog, actions) share this path but are not history files;
  // only plan keys may move the "N of M" count.
  await downloadFile(entry, activePlan?.includes(key) ?? false);
}

/** Starts the background sequence. Safe to call often; runs once per load. */
export function bootMarketSync(): Promise<void> {
  if (!bootPromise) bootPromise = runBoot().catch(handleBootError);
  return bootPromise;
}

function handleBootError(err: unknown): void {
  setStatus({
    phase: 'error',
    error: err instanceof Error ? err.message : 'Market sync failed',
  });
}

async function runBoot(): Promise<void> {
  const supported = opfsSupported();

  // Storage pressure is the only thing that can silently take the cache:
  // ask to be excluded from automatic eviction before downloading hundreds
  // of megabytes the visitor would otherwise fetch again.
  if (supported) await requestPersistentStorage();

  const mobile = IS_MOBILE;
  const plan: SyncPlan = mobile ? 'recent' : 'full';
  setStatus({ ...INITIAL, phase: 'checking', plan });

  // The manifest is tiny and every path needs it, including browsers with no
  // OPFS. Fetch it before deciding how much this device can hold.
  const manifest = await ensureManifest();
  // Earlier builds wrote the marker as `__version.txt`, a name sltp's own
  // freshness check never read. One line drops the leftover; the marker now
  // lives at `version.txt`, where both readers look.
  if (supported) await deleteFile('__version.txt');
  const stored = supported ? await readVersion() : null;
  const planList = planKeys(manifest.files);
  activePlan = planList;
  // No version on disk means no bytes on disk: this device needs the reserve
  // the gate keeps above its 9M line, so even the manifest is flagged.
  firstSync = stored === null;
  setStatus({ version: manifest.version, totalFiles: planList.length });

  if (!supported) {
    setStatus({
      phase: 'degraded',
      error: 'This browser has no persistent storage; charts fetch one file at a time into memory',
    });
    return;
  }

  counted.clear();
  if (stored !== manifest.version || mobile) {
    // A rollover can strand files the new plan no longer holds: a phone
    // dropping its oldest era on January 1, a renamed chunk. Sweep on-disk
    // bars outside the plan so disk strictly equals plan + sidecars + wheels.
    // Sidecars and the catalog get their own byte checks in the priority
    // pass below; WHEELS/ is version-stamped and self-cleaning. The mobile
    // sweep runs even when the data version is unchanged, because the floor
    // moves with the calendar.
    // Zero download cost, so this runs on metered links too.
    const planSet = new Set(planList);
    const onDisk = await listFiles('MARKET_DAILY');
    const stale = onDisk
      .map((name) => `MARKET_DAILY/${name}`)
      .filter(
        (key) =>
          (key.endsWith('.parquet') || key.endsWith('.bin')) &&
          !key.endsWith('market_actions.parquet') &&
          !planSet.has(key),
      );
    await Promise.all(stale.map((key) => deleteFile(key)));
    if (mobile && stale.length > 0) {
      // The per-ticker chart sidecars are keyed by era. Clearing them is
      // cheaper than walking year directories and guarantees a dropped era
      // cannot answer a chart from stale bytes.
      await removeDir('BARS');
    }
  }
  // One reconciliation path for every boot, version bump or not. Year files
  // are effectively immutable — a daily update rewrites only the tail (and
  // sometimes the actions sidecar) — so a new version usually refreshes one
  // small file instead of the whole plan. A backfill that rewrote every year
  // still heals, because every changed byte count re-downloads. Presence is
  // not freshness (files are rewritten in place), so the manifest's byte
  // count decides. Only plan files count as loaded: a desktop-sized cache
  // opened in a phone emulator keeps its extra files on disk but out of
  // the count.
  const expectedBytes = new Map(manifest.files.map((f) => [f.key, f.bytes]));
  const present: string[] = [];
  for (const key of planList) {
    const actual = await fileSize(key);
    if (actual === null) continue;
    const expected = expectedBytes.get(key);
    if (expected !== undefined && actual !== expected) {
      await deleteFile(key);
      continue;
    }
    present.push(key);
  }
  const presentBytes = manifest.files
    .filter((f) => present.includes(f.key))
    .reduce((sum, f) => sum + f.bytes, 0);
  for (const key of present) counted.add(key);
  setStatus({ loadedFiles: newestFirst(present), bytesLoaded: presentBytes });

  // What is left to fetch, in paint order: the tail and the current era (all a
  // chart needs), then the two sidecars (search and dividends), then the older
  // eras newest first. Sizes were reconciled above, so this list is the work.
  const priority = priorityKeys(planList);
  const sidecars = manifest.files
    .filter((f) => f.key === CATALOG_KEY || f.key.endsWith('market_actions.parquet'))
    .map((f) => f.key);
  const wanted = new Set<string>();
  const needed: ManifestFile[] = [];
  for (const key of [...priority, ...sidecars, ...planList]) {
    if (wanted.has(key)) continue;
    wanted.add(key);
    const entry = manifest.files.find((f) => f.key === key);
    if (!entry) continue;
    const actual = await fileSize(key);
    if (actual === entry.bytes) {
      noteDownloaded(entry);
      continue;
    }
    if (actual !== null) await deleteFile(key);
    countBytes(entry);
    needed.push(entry);
  }

  // A 404 mid-download refreshes the manifest, so the version to stamp is the
  // one the cache holds now, not the one this boot started with.
  const settledVersion = (): string => manifestCache?.version ?? manifest.version;

  if (needed.length === 0) {
    await writeVersion(settledVersion());
    setStatus({ phase: 'ready', olderDeferred: false });
    setStatus({ bytesLoaded: await sizeOnDisk(status.loadedFiles) });
    return;
  }

  // The gate carries the head of the plan in one request; the older eras are
  // one or two more. Cellular still stops after the head and waits for a tap.
  const head = priority.length + sidecars.length;
  const first = needed.slice(0, head);
  const later = needed.slice(head);

  setStatus({ phase: 'priority' });
  await fetchFiles(first, manifest.version);
  await writeVersion(settledVersion());

  if (later.length === 0) {
    setStatus({ phase: 'ready', olderDeferred: false });
    return;
  }
  if (isMetered()) {
    setStatus({ phase: 'ready', olderDeferred: true });
    setStatus({ bytesLoaded: await sizeOnDisk(status.loadedFiles) });
    return;
  }
  setStatus({ phase: 'prefetch' });
  await fetchFiles(later, manifest.version);
  await writeVersion(settledVersion());
  setStatus({ phase: 'ready', olderDeferred: false });
  setStatus({ bytesLoaded: await sizeOnDisk(status.loadedFiles) });
}

/**
 * Downloads older eras sequentially. Called automatically on unmetered
 * links; call it explicitly (a "load full history" tap) on cellular. On a
 * phone this is a no-op: the plan is already complete by construction.
 */
export async function prefetchOlder(): Promise<void> {
  const manifest = manifestCache;
  if (!manifest || status.phase === 'prefetch') return;
  const remaining = planKeys(manifest.files).filter(
    (key) => !status.loadedFiles.includes(key),
  );
  if (remaining.length === 0) {
    setStatus({ phase: 'ready', olderDeferred: false });
    return;
  }
  setStatus({ phase: 'prefetch', olderDeferred: false });
  const entries = remaining
    .map((key) => manifest.files.find((f) => f.key === key))
    .filter((entry): entry is ManifestFile => entry !== undefined);
  for (const entry of entries) countBytes(entry);
  try {
    await fetchFiles(entries, manifest.version);
    setStatus({ phase: 'ready' });
    setStatus({ bytesLoaded: await sizeOnDisk(status.loadedFiles) });
  } catch (err) {
    setStatus({
      phase: 'ready',
      error: err instanceof Error ? err.message : 'Prefetch stopped early',
    });
  }
}

/** For tests and sign-out cleanup: forget the boot so the next call reruns. */
export function resetMarketSyncForTests(): void {
  bootPromise = null;
  manifestCache = null;
  firstSync = true;
  activePlan = null;
  counted.clear();
  inflight.clear();
  setStatus({ ...INITIAL });
}

/** The cached parquet bytes for one chunk (fetches first on a miss). */
export async function getChunkFile(key: string): Promise<File> {
  await ensureFile(key);
  const file = await getFile(key);
  if (!file) throw new Error(`Chunk vanished after download: ${key}`);
  return file;
}
