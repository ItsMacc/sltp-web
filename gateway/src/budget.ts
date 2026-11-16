// budget.ts — the one counter every market read passes through.
//
// A Durable Object is single-threaded per instance, and `reserve` is the whole
// check-and-increment in one turn, so two people pulling at the same instant
// cannot both slip under a ceiling: the second reservation sees the first.
//
// Two things are counted, for two different ceilings:
//
//   reads     one per R2 GET/HEAD (one Class B operation). This is what the
//             monthly R2 allowance protects, so every reservation is flushed
//             to storage before it is acknowledged — an eviction must not be
//             able to hand back reads that already happened.
//   requests  one per inbound call, cache hits included. This protects the
//             Workers Free daily request quota (100k/day), which a scraper
//             can exhaust without touching R2 at all. Losing a handful of
//             these to an eviction is harmless, so they flush in batches.

import {
  EXISTING_LIMIT,
  HARD_LIMIT,
  REQUEST_LIMIT,
  decide,
  nextReset,
  windowId,
  type Decision,
} from './policy.ts';

/** Persist the request count every Nth tick: cheap, and at most this many at risk. */
const FLUSH_TICKS = 20;

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface State {
  storage: Storage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

interface Stored {
  window: string;
  used: number;
  day: string;
  requests: number;
  /** Bytes handed to clients this window: what a device actually downloaded. */
  bytes?: number;
  refused?: Refused;
  devices?: string[];
}

/**
 * Refusals, split the way the operator brief reads them:
 *
 *   freshNew     a device with no reading history asked for its first files
 *                after the month's allowance was already spent;
 *   cacheCleared a device that had already downloaded this window came back
 *                claiming to be new — it emptied its browser storage;
 *   returning    a device that still holds files was stopped by the ceiling
 *                that keeps the reserve for people with no cache;
 *   requests     the daily Workers request line, which a scraper can trip
 *                without touching R2 at all.
 */
export interface Refused {
  freshNew: number;
  cacheCleared: number;
  returning: number;
  requests: number;
}

const EMPTY_REFUSED: Refused = { freshNew: 0, cacheCleared: 0, returning: 0, requests: 0 };

/** Bounded, so the object's storage value stays well under its per-key limit. */
const DEVICE_CAP = 4000;

export interface Reservation extends Omit<Decision, 'reason'> {
  reason: Decision['reason'] | 'requests';
  used: number;
  requests: number;
  resetsAt: string;
}

/** Next midnight UTC, when the daily request counter opens again. */
function midnight(now: Date): string {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

export interface Gate {
  allowed: boolean;
  requests: number;
  limit: number;
  resetsAt: string;
}

export class Budget {
  private state: State;
  private window = '';
  private used = 0;
  private day = '';
  private requests = 0;
  private bytes = 0;
  private unflushed = 0;
  private refused: Refused = { ...EMPTY_REFUSED };
  /** Short hashes of devices that downloaded at least one file this window. */
  private devices = new Set<string>();

  constructor(state: State) {
    this.state = state;
    // Load before the first request is delivered, so no reservation is
    // decided against an empty counter.
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<Stored>('window');
      if (stored) {
        this.window = stored.window;
        this.used = stored.used;
        this.day = stored.day;
        this.requests = stored.requests;
        this.bytes = stored.bytes ?? 0;
        this.refused = { ...EMPTY_REFUSED, ...(stored.refused ?? {}) };
        for (const id of stored.devices ?? []) this.devices.add(id);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      this.roll(new Date());
      return this.json(this.snapshot(new Date()));
    }

    if (url.pathname === '/release' && request.method === 'POST') {
      // A read that was reserved but never reached R2 (a 404, a thrown fetch).
      if (this.used > 0) {
        this.used -= 1;
        await this.flush();
      }
      return this.json({ used: this.used });
    }

    const now = new Date();
    this.roll(now);

    // A cache hit still spends a Workers request, so it ticks but does not
    // reserve an R2 read.
    if (url.pathname === '/tick' && request.method === 'POST') {
      if (this.requests >= REQUEST_LIMIT) {
        return this.json(this.gate(now, false), 429);
      }
      this.requests += 1;
      this.unflushed += 1;
      if (this.unflushed >= FLUSH_TICKS) await this.flush();
      return this.json(this.gate(now, true));
    }

    // Bytes actually handed to a visitor. Reported after the response was
    // built, so it answers "how much did this device download" — the question
    // read counts cannot answer.
    if (url.pathname === '/serve' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { bytes?: unknown };
      const bytes = typeof body.bytes === 'number' && Number.isFinite(body.bytes) ? body.bytes : 0;
      if (bytes > 0) {
        this.bytes += Math.min(bytes, 1e12);
        this.unflushed += 1;
        // Batched like requests: losing a batch of byte counts to an eviction
        // costs a rounding error, not a decision.
        if (this.unflushed >= FLUSH_TICKS) await this.flush();
      }
      return this.json({ bytes: this.bytes });
    }

    if (url.pathname !== '/reserve' || request.method !== 'POST') {
      return this.json({ error: 'not found' }, 404);
    }

    const body = (await request.json().catch(() => ({}))) as { new?: unknown; d?: unknown };
    const isNewDevice = body.new === true;
    const device = typeof body.d === 'string' && /^[a-z0-9]{4,24}$/.test(body.d) ? body.d : '';

    if (this.requests >= REQUEST_LIMIT) {
      this.refused.requests += 1;
      const refused: Reservation = {
        allowed: false,
        reason: 'requests',
        limit: REQUEST_LIMIT,
        used: this.used,
        requests: this.requests,
        resetsAt: midnight(now),
      };
      return this.json(refused, 429);
    }
    this.requests += 1;

    const seen = device !== '' && this.devices.has(device);
    const decision = decide(this.used, isNewDevice);
    if (decision.allowed) {
      this.used += 1;
      // Remember the device so a later "I am new" from a browser that already
      // downloaded reads as a cleared cache, not as a first visit.
      if (device && !seen && this.devices.size < DEVICE_CAP) this.devices.add(device);
      // Reads are flushed immediately: the monthly ceiling is only exact if a
      // read that reached R2 cannot disappear with the isolate that counted it.
      await this.flush();
    } else {
      // Sorting the refusal is what the brief counts: a device with no history
      // is someone who arrived after the reserve filled, one with history that
      // claims to be new emptied its cache, and everything else still holds
      // its files.
      const bucket: keyof Refused = isNewDevice ? (seen ? 'cacheCleared' : 'freshNew') : 'returning';
      this.refused[bucket] += 1;
      await this.flush();
    }

    const reservation: Reservation = {
      ...decision,
      used: this.used,
      requests: this.requests,
      resetsAt: nextReset(now).toISOString(),
    };
    return this.json(reservation);
  }

  /** A new billing window (or UTC day) starts at zero. */
  private roll(now: Date): void {
    const id = windowId(now);
    const day = now.toISOString().slice(0, 10);
    if (this.window === id && this.day === day) return;
    if (this.window !== id) {
      this.window = id;
      this.used = 0;
      this.bytes = 0;
      this.refused = { ...EMPTY_REFUSED };
      this.devices.clear();
    }
    if (this.day !== day) {
      this.day = day;
      this.requests = 0;
    }
    this.unflushed = 0;
    void this.state.storage.put('window', this.stored());
  }

  private stored(): Stored {
    return {
      window: this.window,
      used: this.used,
      day: this.day,
      requests: this.requests,
      bytes: this.bytes,
      refused: this.refused,
      devices: this.devices.size > 0 ? [...this.devices] : undefined,
    };
  }

  private async flush(): Promise<void> {
    this.unflushed = 0;
    await this.state.storage.put('window', this.stored());
  }

  private gate(now: Date, allowed: boolean): Gate {
    return { allowed, requests: this.requests, limit: REQUEST_LIMIT, resetsAt: midnight(now) };
  }

  private snapshot(now: Date) {
    return {
      window: windowId(now),
      used: this.used,
      bytesServed: this.bytes,
      existingLimit: EXISTING_LIMIT,
      hardLimit: HARD_LIMIT,
      requests: this.requests,
      requestLimit: REQUEST_LIMIT,
      refused: this.refused,
      devicesKnown: this.devices.size,
      resetsAt: nextReset(now).toISOString(),
    };
  }

  private json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
