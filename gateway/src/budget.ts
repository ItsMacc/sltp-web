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
}

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
  private unflushed = 0;

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

    if (url.pathname !== '/reserve' || request.method !== 'POST') {
      return this.json({ error: 'not found' }, 404);
    }

    const body = (await request.json().catch(() => ({}))) as { new?: unknown };
    const isNewDevice = body.new === true;

    if (this.requests >= REQUEST_LIMIT) {
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

    const decision = decide(this.used, isNewDevice);
    if (decision.allowed) {
      this.used += 1;
      // Reads are flushed immediately: the monthly ceiling is only exact if a
      // read that reached R2 cannot disappear with the isolate that counted it.
      await this.flush();
    } else if (this.unflushed >= FLUSH_TICKS) {
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
    }
    if (this.day !== day) {
      this.day = day;
      this.requests = 0;
    }
    this.unflushed = 0;
    void this.state.storage.put('window', this.stored());
  }

  private stored(): Stored {
    return { window: this.window, used: this.used, day: this.day, requests: this.requests };
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
      existingLimit: EXISTING_LIMIT,
      hardLimit: HARD_LIMIT,
      requests: this.requests,
      requestLimit: REQUEST_LIMIT,
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
