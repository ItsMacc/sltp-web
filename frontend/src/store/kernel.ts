// kernel.ts — the single owner of the Python worker.
//
// Research and the Lab used to boot a Pyodide each: two interpreters, two WASM
// heaps, two cold starts for the same packages. There is one worker now, this
// module owns it, and both pages talk to it through here.
//
// Two jobs beyond wiring:
//
//   routing    one request id space, one pending map, so a reply can never be
//              delivered to the wrong caller.
//   supervision  a runaway run cannot be interrupted inside WASM, so stopping
//              one means throwing the interpreter away. That is a decision
//              both pages have to hear about: `supervise()` kills the worker,
//              fails everything in flight, and tells every subscriber to
//              forget its warm state so the next call boots a fresh kernel.

/** Every message the kernel can emit: replies, progress and run streams. */
export interface KernelMessage {
  id?: number;
  kind?: string;
  type?: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

type Pending = {
  kind: string;
  resolve: (message: KernelMessage) => void;
  reject: (error: Error) => void;
  timer: number;
};

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
const listeners = new Set<(message: KernelMessage) => void>();
const crashListeners = new Set<(reason: string) => void>();

/** Every kernel message, in arrival order. Both pages filter by kind. */
export function onKernelMessage(listener: (message: KernelMessage) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Told when the kernel was thrown away, so warm state can be forgotten. */
export function onKernelCrash(listener: (reason: string) => void): () => void {
  crashListeners.add(listener);
  return () => {
    crashListeners.delete(listener);
  };
}

function failAll(reason: string): void {
  for (const [, entry] of pending) {
    window.clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<KernelMessage | string>) => {
    let message: KernelMessage;
    try {
      message = typeof event.data === 'string' ? (JSON.parse(event.data) as KernelMessage) : event.data;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    for (const listener of listeners) listener(message);
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    window.clearTimeout(entry.timer);
    if (message.ok === false) {
      entry.reject(new Error(message.error || 'the kernel call failed'));
      return;
    }
    entry.resolve(message);
  };
  const die = (reason: string) => {
    if (worker !== created) return;
    supervise(reason);
  };
  created.onerror = (event: ErrorEvent) => die(event.message || 'the Python kernel stopped unexpectedly');
  created.onmessageerror = () => die('the Python kernel sent a message this browser could not read');
  worker = created;
  return created;
}

/**
 * Throws the interpreter away. Everything in flight fails with the reason and
 * every subscriber forgets its warm state; the next call starts a fresh
 * kernel. This is the one path a hang or crash takes, so a Lab run that never
 * returns cannot leave Research waiting on a dead interpreter.
 */
export function supervise(reason: string): void {
  worker?.terminate();
  worker = null;
  failAll(reason);
  for (const listener of crashListeners) listener(reason);
}

/** True when a live worker exists. A crash clears it. */
export function kernelAlive(): boolean {
  return worker !== null;
}

/**
 * One request, one reply. `timeoutMs` is the caller's ceiling: it fails the
 * call, not the worker — a caller decides for itself whether a timeout means
 * the interpreter is bad.
 */
export function call(
  kind: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  /** Handed the request id synchronously, so streamed messages can be matched. */
  onId?: (id: number) => void,
): Promise<KernelMessage> {
  const instance = ensureWorker();
  const id = (seq += 1);
  onId?.(id);
  return new Promise<KernelMessage>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${kind} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(id, { kind, resolve, reject, timer });
    instance.postMessage({ id, kind, ...payload });
  });
}

/** For tests and sign-out cleanup: forget the kernel entirely. */
export function destroyKernel(reason = 'the kernel was reset'): void {
  supervise(reason);
}
