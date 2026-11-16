// index.ts — the only reader of the market bucket.
//
// Once public access is off, every object leaves through this Worker, which is
// what makes a server-side ceiling possible at all: a public r2.dev URL cannot
// be capped from the browser, because nothing of ours sits in the path.
//
//   GET /v/<data-version>/<key>   one object, e.g. MARKET_DAILY/...parquet
//   GET /__gate/status            the counter, for the paused banner
//
// The cache answers first. A cache hit costs no R2 read and is served even when
// the window is closed, because it cannot move the number the ceiling guards.
// A miss asks the Durable Object to reserve one read, and only then touches R2.
//
// `?new=1` marks a device with an empty cache (its very first sync). Those
// requests may spend the reserve above EXISTING_LIMIT; everything else stops
// there. The flag is a hint, not a permission: lying about it only lets a
// client into a reserve that the hard ceiling still closes.
//
// Deploy, once the bucket is private and a domain exists:
//   npx wrangler deploy --config gateway/wrangler.jsonc
// Add a route such as `data.sltp.example/*` to that config and point
// R2_BASE_URL in frontend/src/store/sync.ts at it. Nothing here needs the
// bucket's public URL.

import { Budget } from './budget.ts';
import { pauseMessage, requestPauseMessage } from './policy.ts';

export { Budget };

interface R2ObjectBody {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
}

interface BudgetStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface BudgetNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): BudgetStub;
}

interface Env {
  BUCKET: R2Bucket;
  BUDGET: BudgetNamespace;
}

interface Reservation {
  allowed: boolean;
  reason: 'existing' | 'hard' | 'requests' | null;
  limit: number;
  used: number;
  requests: number;
  resetsAt: string;
}

interface Gate {
  allowed: boolean;
  requests: number;
  limit: number;
  resetsAt: string;
}

/** One counter for the whole account: all versions, all files. */
const BUDGET_ID = 'r2-ops';
// `live` is the unversioned alias the Python engine uses for its small metadata
// files (META/version.txt, the catalog); the web app pins a data version.
const VERSION = /^\d{4}-\d{2}-\d{2}$|^live$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// `caches.default` is Cloudflare's, not part of lib.dom's CacheStorage shape.
const EDGE = (caches as unknown as { default: Cache }).default;

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': 'if-none-match, content-type',
  'access-control-expose-headers': 'etag, x-data-usage',
  // Without this the browser zeroes transferSize for every download, which is
  // what a phone-side audit needs to tell real traffic apart from a stale size.
  'timing-allow-origin': '*',
};

/** One bundle carries the whole plan, but a single response that must survive
    for a gigabyte is a gamble; the browser splits anything larger. */
const BULK_MAX_FILES = 64;
const BULK_MAX_BYTES = 1_200_000_000;
const BULK_MAGIC = 'SLTPBULK';

/** One object resolved for a bulk response: from the edge cache or from R2. */
interface BulkSource {
  key: string;
  size: number;
  body: ReadableStream<Uint8Array>;
}

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function budget(env: Env): BudgetStub {
  return env.BUDGET.get(env.BUDGET.idFromName(BUDGET_ID));
}

async function reserve(env: Env, isNewDevice: boolean, device: string): Promise<Reservation> {
  const res = await budget(env).fetch('https://budget/reserve', {
    method: 'POST',
    body: JSON.stringify({ new: isNewDevice, d: device }),
  });
  if (!res.ok) throw new Error(`budget unavailable (${res.status})`);
  return (await res.json()) as Reservation;
}

/**
 * Counts one inbound request against the daily Workers quota, cache hit or
 * not. Fails open: a Durable Object hiccup must not take the data path down,
 * and the monthly R2 ceiling still applies on the miss path.
 */
async function tick(env: Env): Promise<Gate | null> {
  try {
    const res = await budget(env).fetch('https://budget/tick', { method: 'POST' });
    if (res.status === 429) return (await res.json()) as Gate;
    if (!res.ok) return null;
    return (await res.json()) as Gate;
  } catch {
    return null;
  }
}

/** The current data version, cached at the edge and in this isolate. A
    versioned URL is only valid for the version the manifest names today. */
const VERSION_TTL_MS = 30_000;
let cachedVersion: { value: string; at: number } | null = null;

async function currentVersion(env: Env): Promise<string | null> {
  if (cachedVersion && Date.now() - cachedVersion.at < VERSION_TTL_MS) {
    return cachedVersion.value;
  }
  const manifestCache = new Request('https://bucket.local/v/live/META/manifest.json');
  try {
    const hit = await EDGE.match(manifestCache);
    if (hit) {
      const data = (await hit.json()) as { version?: unknown };
      if (typeof data.version === 'string') {
        cachedVersion = { value: data.version, at: Date.now() };
        return data.version;
      }
    }
  } catch {
    // Fall through to R2.
  }
  try {
    const object = await env.BUCKET.get('META/manifest.json');
    if (!object?.body) return null;
    const data = JSON.parse(await new Response(object.body).text()) as { version?: unknown };
    if (typeof data.version !== 'string') return null;
    cachedVersion = { value: data.version, at: Date.now() };
    return data.version;
  } catch {
    return null;
  }
}

function requestLimited(gate: Gate): Response {
  const retryAfter = Math.max(1, Math.ceil((Date.parse(gate.resetsAt) - Date.now()) / 1000));
  return json(
    {
      paused: true,
      reason: 'requests',
      // The same words the toast uses, so "busy day" searches the FAQ finds it.
      message: requestPauseMessage(gate.resetsAt),
      requests: gate.requests,
      limit: gate.limit,
      resetsAt: gate.resetsAt,
    },
    429,
    { 'retry-after': String(retryAfter) },
  );
}

/** A reserved read that never reached R2 is given back. */
async function release(env: Env): Promise<void> {
  try {
    await budget(env).fetch('https://budget/release', { method: 'POST' });
  } catch {
    // Losing one count is smaller than the reserve between the ceilings.
  }
}

function paused(reservation: Reservation): Response {
  const reason = reservation.reason === 'hard' ? 'hard' : 'existing';
  const retryAfter = Math.max(
    1,
    Math.ceil((Date.parse(reservation.resetsAt) - Date.now()) / 1000),
  );
  return json(
    {
      paused: true,
      reason,
      message: pauseMessage(reason, reservation.resetsAt),
      used: reservation.used,
      limit: reservation.limit,
      resetsAt: reservation.resetsAt,
    },
    503,
    { 'retry-after': String(retryAfter) },
  );
}

/**
 * Resolves one object for a bulk bundle, going through the same gate a
 * single-file request does: edge cache first (no R2 read), then a reserved R2
 * read that also warms the edge for the next device.
 *
 * The request counter is NOT ticked here — a bulk call is one inbound request,
 * which is the whole point of the route — so the caller ticks once.
 */
async function loadObject(
  env: Env,
  version: string,
  key: string,
  isNewDevice: boolean,
  device: string,
): Promise<{ source?: BulkSource; refusal?: Response }> {
  const cacheKey = new Request(`https://bucket.local/v/${version}/${encodeURIComponent(key)}`, {
    method: 'GET',
  });
  const hit = await EDGE.match(cacheKey);
  if (hit?.body) {
    return {
      source: { key, size: Number(hit.headers.get('content-length') ?? 0), body: hit.body },
    };
  }

  const reservation = await reserve(env, isNewDevice, device);
  if (!reservation.allowed) {
    return {
      refusal:
        reservation.reason === 'requests'
          ? requestLimited({
              allowed: false,
              requests: reservation.requests,
              limit: reservation.limit,
              resetsAt: reservation.resetsAt,
            })
          : paused(reservation),
    };
  }

  const object = await env.BUCKET.get(key);
  if (!object?.body) {
    await release(env);
    return { refusal: json({ error: 'not found', key }, 404) };
  }

  // One copy to the visitor, one to the edge cache, so a bundle costs the same
  // R2 reads as the per-file route did.
  const [mine, copy] = object.body.tee();
  try {
    const headers = new Headers();
    headers.set('content-type', object.httpMetadata?.contentType ?? 'application/octet-stream');
    headers.set('content-length', String(object.size));
    headers.set('cache-control', edgeControl(key, version));
    void EDGE.put(cacheKey, new Response(copy, { headers })).catch(() => undefined);
  } catch {
    // A cache write that fails is not a failed download.
  }
  return { source: { key, size: object.size, body: mine } };
}

/**
 * POST /bulk {version, keys} — several objects in one Worker request.
 *
 * Framing: "SLTPBULK" (8 bytes) | u32 header length | JSON header naming each
 * file's key and byte count | the files' bytes back to back in header order.
 * The browser writes each file as it arrives, so nothing is buffered here or
 * there. A refusal on any key returns its JSON before a byte of the bundle, so
 * a half-written body is never mistaken for data.
 */
async function bulk(request: Request, env: Env): Promise<Response> {
  let body: { version?: unknown; keys?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'expected a JSON body' }, 400);
  }

  const version = typeof body.version === 'string' ? body.version : 'live';
  if (!VERSION.test(version)) return json({ error: 'unknown data version' }, 404);
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : [];
  if (keys.length === 0 || keys.length > BULK_MAX_FILES) {
    return json({ error: `send between 1 and ${BULK_MAX_FILES} keys` }, 400);
  }
  for (const key of keys) {
    if (!SAFE_KEY.test(key) || key.includes('..')) return json({ error: 'bad key', key }, 400);
  }

  const url = new URL(request.url);
  const isNewDevice = url.searchParams.get('new') === '1';
  const device = url.searchParams.get('d') ?? '';

  // One request, one tick — thirty files used to be thirty.
  const gate = await tick(env);
  if (gate && !gate.allowed) return requestLimited(gate);

  if (version !== 'live') {
    const current = await currentVersion(env);
    if (current !== null && version !== current) {
      return json({ error: 'unknown data version' }, 404);
    }
  }

  const sources: BulkSource[] = [];
  for (const key of keys) {
    const loaded = await loadObject(env, version, key, isNewDevice, device);
    if (loaded.refusal) return loaded.refusal;
    sources.push(loaded.source!);
  }

  const total = sources.reduce((sum, source) => sum + source.size, 0);
  if (total > BULK_MAX_BYTES) {
    return json({ error: `bundle over ${BULK_MAX_BYTES} bytes; send fewer keys` }, 413);
  }

  const header = new TextEncoder().encode(
    JSON.stringify({ files: sources.map((s) => ({ key: s.key, bytes: s.size })) }),
  );
  const preamble = new Uint8Array(12 + header.length);
  preamble.set(new TextEncoder().encode(BULK_MAGIC), 0);
  new DataView(preamble.buffer).setUint32(8, header.length, true);
  preamble.set(header, 12);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preamble);
      for (const source of sources) {
        const reader = source.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS,
      'content-type': 'application/x-sltp-bulk',
      // A bundle is assembled per call; never stored by anything.
      'cache-control': 'no-store',
    },
  });
}

async function status(env: Env): Promise<Response> {
  const res = await budget(env).fetch('https://budget/status');
  return new Response(res.body, {
    status: res.status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Two audiences, two policies. They used to be one header, which is how a
// browser ended up keeping a year-long copy of every bar file it downloaded.

/** What the EDGE may keep. Bars never change under one data version, so its
    copy can live for a year at zero cost; the manifest and the unversioned
    alias move daily and get short lives. */
function edgeControl(key: string, version: string): string {
  if (version === 'live') return 'public, max-age=60';
  if (key.endsWith('META/manifest.json')) return 'public, max-age=30';
  return 'public, max-age=31536000, immutable';
}

/** What the BROWSER may keep. The app already holds every file it downloaded
    in OPFS, so a second copy under the origin is pure waste: that duplicate is
    the 1.1GB Safari reports for a phone whose OPFS copy is ~280MB. The edge
    copy is written by hand from a separate response, so this costs no reads. */
function clientControl(key: string): string {
  if (key.endsWith('META/manifest.json')) return 'public, max-age=30';
  return 'no-store';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/bulk') {
      if (request.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
      }
      return bulk(request, env);
    }
    if (url.pathname === '/__gate/status') {
      try {
        return await status(env);
      } catch {
        return json({ error: 'gate unavailable' }, 503);
      }
    }

    // The manifest has to be reachable before the client knows a version, so it
    // sits outside /v/; everything it names is versioned from then on.
    let version: string;
    let encodedKey: string;
    const match = /^\/v\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (url.pathname === '/manifest.json') {
      version = 'live';
      encodedKey = 'META/manifest.json';
    } else if (match) {
      version = match[1];
      encodedKey = match[2];
      if (!VERSION.test(version)) return json({ error: 'unknown data version' }, 404);
    } else {
      return json({ error: 'not found' }, 404);
    }

    const key = decodeURIComponent(encodedKey);
    if (!SAFE_KEY.test(key) || key.includes('..')) return json({ error: 'bad key' }, 400);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
    }

    // A date in the path is only valid while it is the version the manifest
    // publishes. Without this, any date worked: `/v/1999-01-01/...` served the
    // current bytes, let a client mint unlimited immutable cache entries and
    // spend one R2 read for each. `live` stays open because the engine reads
    // its metadata through it.
    if (version !== 'live') {
      const current = await currentVersion(env);
      if (current !== null && version !== current) {
        return json({ error: 'unknown data version' }, 404);
      }
    }

    // The cache key drops the `new` flag so a returning device and a first-time
    // device share the same edge copy.
    const cacheKey = new Request(`https://bucket.local/v/${version}/${encodedKey}`, { method: 'GET' });
    if (request.method === 'GET') {
      const hit = await EDGE.match(cacheKey);
      if (hit) {
        // A cache hit costs no R2 read, but it is still a Workers request.
        const gate = await tick(env);
        if (gate && !gate.allowed) return requestLimited(gate);
        // The stored headers are the edge's, not the browser's.
        const hitHeaders = new Headers(hit.headers);
        hitHeaders.set('cache-control', clientControl(key));
        hitHeaders.set('x-data-usage', 'cached');
        return withCors(new Response(hit.body, { status: hit.status, headers: hitHeaders }));
      }
    }

    let reservation: Reservation;
    try {
      reservation = await reserve(
        env,
        url.searchParams.get('new') === '1',
        url.searchParams.get('d') ?? '',
      );
    } catch {
      return json({ paused: true, reason: 'unavailable', message: 'Market data is briefly unavailable.' }, 503);
    }
    if (!reservation.allowed) {
      return reservation.reason === 'requests'
                  ? requestLimited({
            allowed: false,
            requests: reservation.requests,
            limit: reservation.limit,
            resetsAt: reservation.resetsAt,
          })
        : paused(reservation);
    }

    let size = 0;
    let etag = '';
    let body: ReadableStream<Uint8Array> | null = null;
    let contentType = 'application/octet-stream';
    try {
      if (request.method === 'HEAD') {
        const head = await env.BUCKET.head(key);
        if (!head) {
          await release(env);
          return json({ error: 'not found' }, 404);
        }
        size = head.size;
        etag = head.etag;
      } else {
        const object = await env.BUCKET.get(key);
        if (!object) {
          await release(env);
          return json({ error: 'not found' }, 404);
        }
        size = object.size;
        etag = object.etag;
        body = object.body;
        contentType = object.httpMetadata?.contentType ?? contentType;
      }
    } catch (error) {
      await release(env);
      throw error;
    }

    const headers = new Headers(CORS);
    headers.set('content-type', contentType);
    headers.set('content-length', String(size));
    headers.set('etag', etag);
    headers.set('cache-control', clientControl(key));
    headers.set('x-data-usage', String(reservation.used));

    const response = new Response(body, { status: 200, headers });

    if (request.method === 'GET') {
      try {
        // Stored under the edge's own headers: a copy that kept `no-store`
        // would never be written, and every request would pay an R2 read.
        const copy = response.clone();
        const stored = new Headers();
        stored.set('content-type', contentType);
        stored.set('content-length', String(size));
        stored.set('etag', etag);
        stored.set('cache-control', edgeControl(key, version));
        await EDGE.put(cacheKey, new Response(copy.body, { status: 200, headers: stored }));
      } catch {
        // A body too large or a cache hiccup is not a failed download.
      }
    }
    return response;
  },
};
