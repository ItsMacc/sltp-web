// sync.ts — the background download sequence plus where files come from.
//
// Files come straight from the public bucket (data.sltp-app.com), the same
// host sltp reads: no gate Worker sits in front of the bytes. Every request
// is one GET for one object, with the published version in the query string
// so R2 and the browser can cache a version immutably, and a new version is a
// new URL.
//
// First visit: check the manifest and fetch the plan — every bar bundle of
// every market on a desktop, the newest bundles inside the phone's window on
// a phone. Every later boot reconciles the plan against the manifest by byte
// count and fetches only what is missing or changed; a daily update rewrites
// the open bundle, so a second visit is cheaper than the first.
// Progress is published to subscribers, so any page can show
// "downloading…" while charts already paint what has landed.
//
// The plan is why "N of M files" always reads true: totalFiles counts the
// plan's bars, and loadedFiles can only ever hold plan keys (plus nothing
// else — sidecars ride along but are never counted).
//
// Layout (sltp 0.1.44):
//   META/manifest.json
//   MARKET_DATA/symbol_catalog.parquet      every market, one table
//   MARKET_DATA/fx.parquet                  daily FX to USD, one column per currency
//   MARKET_DATA/DAILY/US/1998-2002.bin      one bundle per five-year block
//   MARKET_DATA/DAILY/INTERNATIONAL/….bin   all international markets, one bundle per block
//   MARKET_DATA/DAILY/<market>/actions.parquet
//
// A bundle carries its own header, so the file name is only a label: the
// chunk plan reads the span out of the name and never depends on a fixed
// chunk size. That is what lets 2028-2032 arrive without a code change.
//
// Cost model, measured Nov 2026: the full archive is ~1.4GB; the two newest
// bundles plus the sidecars (what a chart needs first) are ~373MB. Every file
// downloads once per data version and is read from disk afterwards.

import { useSyncExternalStore } from 'react';
import {
  IS_MOBILE,
  mobileHistoryStartFor,
  readDataPlanYears,
  writeDataPlanYears,
  type DataPlanYears,
} from './device';
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

/** The bucket's public custom domain. R2 serves these keys directly. */
export const DATA_BASE_URL = 'https://data.sltp-app.com';

/** Small file naming which chunks exist and what data version they belong to. */
export const MANIFEST_KEY = 'META/manifest.json';

/** Every bar bundle lives under this prefix, one directory per market. */
export const DAILY_PREFIX = 'MARKET_DATA/DAILY/';

/** One table of every symbol in every market, and the daily FX table. */
export const CATALOG_KEY = 'MARKET_DATA/symbol_catalog.parquet';
export const FX_KEY = 'MARKET_DATA/fx.parquet';

/** Corporate actions sit beside each market's bundles. */
const ACTIONS_NAME = 'actions.parquet';

/** The two bundle markets the archive publishes. */
export type BarMarket = 'US' | 'INTERNATIONAL';

/** Which market a bundle belongs to: `MARKET_DATA/DAILY/US/x.bin` -> US. */
export function marketOf(key: string): BarMarket | null {
  if (!key.startsWith(DAILY_PREFIX)) return null;
  const market = key.slice(DAILY_PREFIX.length).split('/')[0];
  return market === 'US' || market === 'INTERNATIONAL' ? market : null;
}

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

/** The published dataset version, e.g. "2026-11-11". A few bytes. */
export async function fetchManifest(): Promise<Manifest> {
  // `no-cache` revalidates against the bucket's ETag: an unchanged manifest
  // costs a 304, and a changed one is read in full. The object is tiny.
  const res = await fetch(`${DATA_BASE_URL}/${MANIFEST_KEY}`, {
    cache: 'no-cache',
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
 * The URL the browser downloads one file from: the bucket key plus the
 * published version as a query string. R2 keys its cache on the whole URL,
 * so a version is immutable at the edge and in the browser while the same
 * key can be rewritten in place by the nightly job.
 */
export async function resolveFileUrl(key: string): Promise<string> {
  const version = manifestCache?.version;
  const suffix = version ? `?v=${encodeURIComponent(version)}` : '';
  return `${DATA_BASE_URL}/${key}${suffix}`;
}

/**
 * "1998-2002.bin" -> [1998, 2002]; a single-year "2019.bin" -> [2019, 2019];
 * anything else null (the actions sidecar, the catalog, the FX table). The
 * span is read from the name only for planning; the bundle's own header is
 * the authority on which sessions it holds.
 */
export function chunkRange(key: string): [number, number] | null {
  const range = /(\d{4})-(\d{4})\.bin$/.exec(key);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = /(\d{4})\.bin$/.exec(key);
  if (single) return [Number(single[1]), Number(single[1])];
  return null;
}

/** Bar bundles only: one .bin per market per block, never a sidecar. */
function barKeys(files: ManifestFile[]): string[] {
  return files
    .map((f) => f.key)
    .filter((key) => key.startsWith(DAILY_PREFIX) && key.endsWith('.bin'));
}

/** True when a manifest key is a bar bundle the plan may hold. */
function isBarKey(key: string): boolean {
  return key.startsWith(DAILY_PREFIX) && key.endsWith('.bin');
}

/** True for the small metadata files that ride along with the plan. */
function isSidecarKey(key: string): boolean {
  return key === CATALOG_KEY || key === FX_KEY || key.endsWith(`/${ACTIONS_NAME}`);
}

/**
 * The chunk keys this browser plans to hold, newest first. Phones keep the
 * recent tail plus every year file that reaches their five-calendar-year
 * floor; desktops keep everything. Filtering by year rather than by a fixed
 * count is what makes the oldest file fall out on New Year's Day without a
 * data-version change.
 * Sidecars are outside the plan — they always download with the priority pair.
 */
export function planKeys(files: ManifestFile[]): string[] {
  // Read the live choice, not the load-time constant: changing the plan
  // re-plans this session without needing a reload first.
  return planKeysFor(files, readDataPlanYears());
}

/** The same selection for any window, so a plan change can be shown and
    applied without writing the new choice first. */
export function planKeysFor(files: ManifestFile[], years: number): string[] {
  const ordered = newestFirst(barKeys(files));
  if (!IS_MOBILE) return ordered;
  const floorYear = Number(mobileHistoryStartFor(years).slice(0, 4));
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
    a sidecar (catalog, FX, actions) rides along with the download but is not
    history, so counting it pushed "N of M" past M — 12 bundles plus the four
    sidecars read as "16 of 12". The plan is the only authority here, so a
    lookup is cheaper than trusting every caller to pass the right flag. */
function markLoaded(key: string): void {
  if (activePlan && !activePlan.includes(key)) return;
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
    if (rb[1] !== ra[1]) return rb[1] - ra[1];
    // The same block in both markets: US first, then alphabetically, so the
    // paint order is stable across boots.
    const ma = marketOf(a) === 'US' ? 0 : 1;
    const mb = marketOf(b) === 'US' ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return a < b ? -1 : 1;
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

/**
 * True when a manifest describes the five-year, multi-market archive this
 * build reads (`MARKET_DATA/DAILY/<market>/YYYY-YYYY.bin`).
 *
 * A cache written before the layout change still has a `version.txt` that
 * matches its own manifest, so freshness alone would trust per-year keys this
 * reader never opens and plan zero downloads. The shape is the check.
 */
function manifestIsCurrentLayout(manifest: Manifest): boolean {
  const markets = new Set<BarMarket>();
  let bars = 0;
  for (const file of manifest.files) {
    const market = marketOf(file.key);
    if (market === null) continue;
    if (chunkRange(file.key) === null) continue;
    markets.add(market);
    bars += 1;
  }
  return bars > 0 && markets.has('US') && markets.has('INTERNATIONAL');
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
      const horizon = currentUpdateHorizon();
      const fresh =
        local !== null &&
        stored === local.version &&
        !horizonDue(local, horizon) &&
        manifestIsCurrentLayout(local);
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

/** The files a chart needs first: the newest bundle of each market, so an
    international name paints as soon as a US one does. Always inside the
    plan — on a phone those bundles ARE the whole plan. */
function priorityKeys(plan: string[]): string[] {
  const ordered = newestFirst(plan.filter((key) => chunkRange(key) !== null));
  const priority: string[] = [];
  for (const market of ['US', 'INTERNATIONAL'] as BarMarket[]) {
    const newest = ordered.find((key) => marketOf(key) === market);
    if (newest) priority.push(newest);
  }
  if (priority.length === 0) return plan.slice(0, 1);
  return priority;
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

/** True when the file on disk already matches the manifest's byte count. */
async function isCurrent(file: ManifestFile): Promise<boolean> {
  const actual = await fileSize(file.key);
  return actual !== null && actual === file.bytes;
}

/** A downloaded plan file moves the "N of M" count; a sidecar never does. */
function noteDownloaded(file: ManifestFile): void {
  if (activePlan?.includes(file.key)) markLoaded(file.key);
}

/**
 * Fetches a list of files, one GET each. Already-current files are skipped by
 * byte count, and the lane limiter inside downloadFile keeps the number of
 * concurrent streams bounded. One failure does not stop the rest: the first
 * message is reported and the boot continues with what it could fetch.
 */
async function fetchFiles(files: ManifestFile[]): Promise<void> {
  const failures: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      if (await isCurrent(file)) {
        noteDownloaded(file);
        return;
      }
      try {
        await downloadFile(file);
      } catch (error) {
        failures.push(
          error instanceof Error ? error.message : `Could not fetch ${file.key}`,
        );
      }
    }),
  );
  if (failures.length > 0) setStatus({ error: failures[0]! });
}

/**
 * Fetches one file on demand (a chart asked for a range whose chunk never
 * downloaded). Resolves when the bytes are in OPFS.
 *
 * Presence is not enough. A write the browser abandoned halfway leaves the
 * file at 0 bytes (or short of the manifest's count) and a `.crswap` beside
 * it, and answering "the file is there" from that poisoned a phone's cache:
 * every chart failed until a sign-in happened to re-run the byte-count
 * reconciliation. The manifest's size is the only proof the file is whole, so
 * a mismatch deletes it and downloads it again.
 */
export async function ensureFile(key: string): Promise<void> {
  const manifest = await ensureManifest();
  const entry = manifest.files.find((f) => f.key === key);
  const onDisk = await fileSize(key);
  if (entry && onDisk === entry.bytes) return;
  if (onDisk !== null && entry) await deleteFile(key);
  if (!entry) {
    // A key the manifest does not name is not ours to fetch; if bytes exist
    // for it they are from an older layout, which the sweep removes.
    if (onDisk !== null) return;
    throw new Error(`Unknown market file: ${key}`);
  }
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
  if (supported) {
    await deleteFile('__version.txt');
    await sweepLegacyLayout();
    await sweepInterruptedWrites();
  }
  const stored = supported ? await readVersion() : null;
  const planList = planKeys(manifest.files);
  activePlan = planList;
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
    // listFiles walks the tree, so these read "US/1998-2002.bin" and
    // "INTERNATIONAL/2023-2027.bin", one per bundle.
    const onDisk = await listFiles('MARKET_DATA/DAILY');
    const stale = onDisk
      .map((name) => `${DAILY_PREFIX}${name}`)
      .filter((key) => isBarKey(key) && !planSet.has(key));
    await Promise.all(
      stale.map(async (key) => {
        const bytes = await fileSize(key);
        if (bytes !== null) rememberPruned([{ key, bytes }]);
        await deleteFile(key);
      }),
    );
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
  const sidecars = manifest.files.filter((f) => isSidecarKey(f.key)).map((f) => f.key);
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
    return;
  }

  // The head of the plan is the newest bundle of each market plus the
  // sidecars, so a chart paints on the first visit. Cellular still stops
  // after the head and waits for a tap.
  const head = priority.length + sidecars.length;
  const first = needed.slice(0, head);
  const later = needed.slice(head);

  setStatus({ phase: 'priority' });
  await fetchFiles(first);
  await writeVersion(settledVersion());

  if (later.length === 0) {
    setStatus({ phase: 'ready', olderDeferred: false });
    return;
  }
  if (isMetered()) {
    setStatus({ phase: 'ready', olderDeferred: true });
    return;
  }
  setStatus({ phase: 'prefetch' });
  await fetchFiles(later);
  await writeVersion(settledVersion());
  setStatus({ phase: 'ready', olderDeferred: false });
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
    await fetchFiles(entries);
    setStatus({ phase: 'ready' });
  } catch (err) {
    setStatus({
      phase: 'ready',
      error: err instanceof Error ? err.message : 'Prefetch stopped early',
    });
  }
}

/** What a plan change would add or free, before anything is touched. */
export interface DataPlanPreview {
  years: DataPlanYears;
  remove: { key: string; bytes: number }[];
  add: { key: string; bytes: number }[];
  removeBytes: number;
  addBytes: number;
  keepBytes: number;
}

/** Sizes of bar files this device freed, so a later preview can quote what
    coming back would cost even when the manifest fetch is skipped. Bars are
    immutable for a published year, so a remembered size stays true. */
const PRUNED_SIZES_KEY = 'st_market_pruned_sizes';

function readPrunedSizes(): Record<string, number> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PRUNED_SIZES_KEY) || '{}');
    return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function rememberPruned(entries: { key: string; bytes: number }[]): void {
  if (entries.length === 0) return;
  try {
    const sizes = { ...readPrunedSizes() };
    for (const entry of entries) sizes[entry.key] = entry.bytes;
    window.localStorage.setItem(PRUNED_SIZES_KEY, JSON.stringify(sizes));
  } catch {
    // A full quota only costs a slightly worse estimate in the dialog.
  }
}

/** Reads disk and manifest to say exactly what switching would do. */
export async function previewDataPlan(years: DataPlanYears): Promise<DataPlanPreview> {
  const manifest = await ensureManifest();
  const next = new Set(planKeysFor(manifest.files, years));
  const bytesByKey = new Map(manifest.files.map((f) => [f.key, f.bytes]));
  const onDisk = (await listFiles('MARKET_DATA/DAILY').catch(() => [])).map(
    (name) => `${DAILY_PREFIX}${name}`,
  );
  const remove: { key: string; bytes: number }[] = [];
  for (const key of onDisk) {
    if (!isBarKey(key) || next.has(key)) continue;
    const actual = await fileSize(key);
    remove.push({ key, bytes: actual ?? bytesByKey.get(key) ?? 0 });
  }
  const add: { key: string; bytes: number }[] = [];
  let keepBytes = 0;
  for (const key of next) {
    const expected = bytesByKey.get(key) ?? 0;
    const actual = await fileSize(key);
    if (actual === expected && expected > 0) keepBytes += actual ?? 0;
    else add.push({ key, bytes: expected });
  }
  return {
    years,
    remove,
    add,
    removeBytes: remove.reduce((sum, entry) => sum + entry.bytes, 0),
    addBytes: add.reduce((sum, entry) => sum + entry.bytes, 0),
    keepBytes,
  };
}

/**
 * Switches this device's market plan and makes the disk match it: bars outside
 * the new window are deleted (their sizes are remembered), bars inside it that
 * are missing are fetched, and the plan count in the UI follows. The boot
 * sequence already does exactly this, so the change is a boot with the new
 * choice written first rather than a second implementation of the sweep.
 */
export async function applyDataPlan(years: DataPlanYears): Promise<void> {
  writeDataPlanYears(years);
  await resyncMarketData();
  if (status.phase === 'error') {
    throw new Error(status.error ?? 'Market data could not be prepared.');
  }
}

/** Whether this page has already run the boot once. */
export function marketSyncBooted(): boolean {
  return bootPromise !== null;
}

/**
 * Re-runs the boot after a choice that decides what this device holds: the plan
 * window, or the update horizon that decides when the manifest is re-read.
 *
 * The horizon is read once per boot, so a setting that arrives after the first
 * boot (signing in, when the account keeps a tighter horizon than a visitor's
 * default) would otherwise wait for a reload. Reset the boot's memory and run
 * the same reconciliation again; nothing is downloaded twice, because only the
 * files whose byte count changed are fetched.
 */
export async function resyncMarketData(): Promise<void> {
  resetMarketSyncForTests();
  await bootMarketSync();
}

/** For tests and sign-out cleanup: forget the boot so the next call reruns. */
export function resetMarketSyncForTests(): void {
  bootPromise = null;
  manifestCache = null;
  activePlan = null;
  counted.clear();
  inflight.clear();
  setStatus({ ...INITIAL });
}

/** Marker: the old per-year layout has been swept from this browser. */
const LEGACY_SWEPT = 'layout-2026.done';

/**
 * Deletes the cache layout sltp 0.1.44 never opens.
 *
 * Builds before the five-year bundles wrote `MARKET_DAILY/market_data_<year>.bin`,
 * `SYMBOL_DATA/symbol_catalog.parquet` and a `BARS/` chart cache. None of it is
 * read now, and together it is most of a gigabyte, so the first boot on the new
 * layout removes it once and drops a marker. A browser that never had the old
 * cache pays three failed directory lookups, which cost nothing.
 */
async function sweepLegacyLayout(): Promise<void> {
  if (await hasFile(LEGACY_SWEPT)) return;
  await removeDir('MARKET_DAILY');
  await removeDir('SYMBOL_DATA');
  await removeDir('BARS');
  try {
    await putFile(LEGACY_SWEPT, new Blob(['2'], { type: 'text/plain' }));
  } catch {
    // Without the marker the sweep simply runs again on the next boot.
  }
}

/** The cache directory, one level up from the per-market bundle folders. */
async function sweepInterruptedWrites(): Promise<void> {
  // A write the browser abandoned (tab closed, disk full, iOS killing the
  // page mid-stream) leaves `<name>.crswap` behind, and those files are as
  // large as the bundle they were writing — 166MB of the quota spent on
  // nothing. The file they belonged to is either absent or the wrong size,
  // which the reconciliation below already re-downloads, so the swap files
  // are safe to delete. Only done at boot, when nothing is in flight.
  const onDisk = await listFiles('MARKET_DATA/DAILY').catch(() => []);
  const swaps = onDisk.filter((name) => name.endsWith('.crswap'));
  await Promise.all(swaps.map((name) => deleteFile(`${DAILY_PREFIX}${name}`)));
}

/** The cached parquet bytes for one chunk (fetches first on a miss). */
export async function getChunkFile(key: string): Promise<File> {
  await ensureFile(key);
  const file = await getFile(key);
  if (!file) throw new Error(`Chunk vanished after download: ${key}`);
  return file;
}
