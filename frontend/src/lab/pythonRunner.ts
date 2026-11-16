// pythonRunner.ts — the page-facing side of the Lab's Python.
//
// The interpreter is the shared kernel (store/kernel.ts): Research and the Lab
// run in one Pyodide, and the Lab's program is a module namespace inside it.
// This module owns what is genuinely the Lab's: the status the page shows, one
// run at a time, a hard time limit per run, and the analyser's request map.
//
// A snippet that never finishes would hold the interpreter forever, so every
// run has a limit: the kernel is thrown away — which Research also hears about
// — the reader is told, and the next call boots a fresh one.

import { call, onKernelCrash, onKernelMessage, supervise } from '../store/kernel';
import type { LabLogEntry } from './backtestTypes';
import type { EngineRunSettings } from './runSettings';
import type { RunResult } from './pythonTypes';

export type PythonStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PythonState {
  status: PythonStatus;
  /** The interpreter version Pyodide reports, once it is up. */
  version: string | null;
  error: string | null;
  /** What the boot is doing right now, shown while the engine installs. */
  detail: string | null;
  /** Whether the pinned sltp wheel installed at boot. */
  engine: boolean | null;
  /** Whether the OPFS market cache and its metadata are ready. */
  market: boolean | null;
  /** Why the engine is missing, when it is. */
  warning: string | null;
}

/** How long one file may run before the kernel is replaced. A backtest can
    warm its cache on the first run, so this is minutes rather than seconds. */
const RUN_TIMEOUT_MS = 300_000;
/** A cold kernel downloads Pyodide, the packages and the wheels. */
const WARM_TIMEOUT_MS = 600_000;

let state: PythonState = { status: 'idle', version: null, error: null, detail: null, engine: null, market: null, warning: null };
const listeners = new Set<() => void>();

let warming = false;

interface ActiveRun {
  id: number;
  onOutput?: (text: string) => void;
  onOutputError?: (text: string) => void;
  onProgress?: (text: string) => void;
  resolve: (result: RunResult) => void;
  timer: number;
}

let activeRun: ActiveRun | null = null;

/** Analysis rounds in flight; each one resolves by its own id. */
const pendingAnalysis = new Map<number, (reply: AnalyzeReply) => void>();

export interface AnalyzeRequest {
  method: 'complete' | 'hover' | 'signature' | 'define' | 'diagnostics' | 'imports';
  code: string;
  path: string;
  line: number;
  column: number;
  files: { name: string; content: string }[];
}

export interface AnalyzeReply {
  ok: boolean;
  error?: string;
  data?: unknown;
}

function publish(next: Partial<PythonState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function getPythonState(): PythonState {
  return state;
}

export function subscribePython(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function settle(result: RunResult): void {
  if (!activeRun) return;
  window.clearTimeout(activeRun.timer);
  const { resolve } = activeRun;
  activeRun = null;
  resolve(result);
}

function onMessage(message: Record<string, unknown>): void {
  const type = typeof message.type === 'string' ? message.type : null;
  if (!type) return;

  if (type === 'analyze-result') {
    const id = Number(message.id);
    const finish = pendingAnalysis.get(id);
    if (finish) {
      pendingAnalysis.delete(id);
      finish({
        ok: message.ok === true,
        error: typeof message.error === 'string' ? message.error : undefined,
        data: message.data,
      });
    }
    return;
  }

  if (type === 'ready') {
    publish({
      status: 'ready',
      version: typeof message.version === 'string' ? message.version : null,
      error: null,
      detail: null,
      engine: message.engine === true,
      market: message.market === true,
      warning: typeof message.warning === 'string' ? message.warning : null,
    });
    return;
  }

  if (type === 'status') {
    publish({ detail: typeof message.text === 'string' ? message.text : null });
    return;
  }

  if (type === 'run-status') {
    if (!activeRun || Number(message.id) !== activeRun.id) return;
    activeRun.onProgress?.(String(message.text ?? ''));
    return;
  }

  if (type === 'stdout' || type === 'stderr') {
    if (!activeRun || Number(message.id) !== activeRun.id) return;
    const deliver = type === 'stdout' ? activeRun.onOutput : activeRun.onOutputError;
    deliver?.(String(message.text ?? ''));
    return;
  }

  if (type === 'done') {
    if (!activeRun || Number(message.id) !== activeRun.id) return;
    const ok = message.ok === true;
    settle({
      ok,
      error: ok ? undefined : typeof message.message === 'string' ? message.message : 'The snippet failed',
      durationMs: Number(message.durationMs ?? 0),
      result: message.result,
      logs: message.logs as LabLogEntry[] | undefined,
      notice: typeof message.notice === 'string' ? message.notice : undefined,
    });
  }
}

onKernelMessage(onMessage);

// A kernel that died — or was thrown away by the other page — leaves nothing
// warm. The Lab says so and boots a fresh one on the next request.
onKernelCrash((reason) => {
  if (activeRun) {
    settle({ ok: false, error: reason, durationMs: 0 });
  }
  publish({ status: 'idle', version: null, detail: null, engine: null, market: null, warning: null });
});

/** Boots the Lab's half of the kernel once. Repeated calls are free. */
export function loadPython(): void {
  if (state.status === 'loading' || state.status === 'ready' || warming) return;
  warming = true;
  publish({ status: 'loading', error: null, detail: 'Loading Python…', engine: null, market: null, warning: null });
  void call('lab-warm', {}, WARM_TIMEOUT_MS)
    .catch((error: unknown) => {
      publish({
        status: 'error',
        error: error instanceof Error ? error.message : 'Python could not start',
        detail: null,
      });
    })
    .finally(() => {
      warming = false;
    });
}

/** Retries after a failed boot. */
export function restartPython(): void {
  supervise('the Lab asked for a fresh interpreter');
  publish({ status: 'idle', error: null, version: null, detail: null, engine: null, market: null, warning: null });
  loadPython();
}

/**
 * Asks the interpreter that is already running to analyse some code. Nothing
 * is installed and nothing is started here: jedi lives in the Lab's namespace.
 */
export function analyze(request: AnalyzeRequest): Promise<AnalyzeReply> {
  if (state.status !== 'ready') {
    return Promise.resolve({
      ok: false,
      error: state.status === 'loading' ? 'Python is still starting' : 'Python is not ready yet',
    });
  }
  return new Promise<AnalyzeReply>((resolve) => {
    let timer = 0;
    const finish = (reply: AnalyzeReply) => {
      window.clearTimeout(timer);
      resolve(reply);
    };
    timer = window.setTimeout(() => {
      resolve({ ok: false, error: 'the analysis request timed out' });
    }, 15_000);
    void call('analyze', { ...request }, 15_000, (id) => {
      pendingAnalysis.set(id, finish);
    }).catch((error: unknown) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });
}

/**
 * Runs one project, streaming stdout and stderr as they arrive. The promise
 * resolves for a Python error as well, since the error is output, not a crash.
 */
export function runPython(
  filename: string,
  code: string,
  files: { name: string; content: string }[],
  handlers: {
    onOutput?: (text: string) => void;
    onOutputError?: (text: string) => void;
    onProgress?: (text: string) => void;
  } = {},
  settings?: EngineRunSettings,
): Promise<RunResult> {
  if (state.status !== 'ready') {
    return Promise.resolve({
      ok: false,
      error: state.status === 'loading' ? 'Python is still starting' : 'Python is not running',
      durationMs: 0,
    });
  }

  // One run at a time: stdout has no way to tell two apart.
  if (activeRun) {
    return Promise.resolve({ ok: false, error: 'A file is already running', durationMs: 0 });
  }

  return new Promise<RunResult>((resolve) => {
    const timer = window.setTimeout(() => {
      settle({
        ok: false,
        error: `Stopped after ${Math.round(RUN_TIMEOUT_MS / 1000)} seconds. Python restarted and the files from this session were cleared.`,
        durationMs: RUN_TIMEOUT_MS,
      });
      supervise('a Lab run was stopped after its time limit');
    }, RUN_TIMEOUT_MS);

    activeRun = {
      id: 0,
      onOutput: handlers.onOutput,
      onOutputError: handlers.onOutputError,
      onProgress: handlers.onProgress,
      resolve,
      timer,
    };
    void call('run-project', { filename, code, files, settings }, RUN_TIMEOUT_MS + 5_000, (id) => {
      if (activeRun) activeRun.id = id;
    }).catch((error: unknown) => {
      settle({
        ok: false,
        error: error instanceof Error ? error.message : 'the run failed',
        durationMs: 0,
      });
    });
  });
}

/**
 * Ends a run. Python cannot be interrupted inside a call, so stopping means
 * throwing the kernel away; Research is told and boots a fresh one on its next
 * run. The Lab's next request starts a fresh interpreter from the files on
 * screen.
 */
export function stopRun(): void {
  if (!activeRun) return;
  settle({
    ok: false,
    error: 'Cancelled. The next run starts a fresh interpreter.',
    durationMs: 0,
  });
  supervise('the Lab cancelled its run');
}

/** Clears the files and modules of the last run, keeping Python warm. */
export function resetProjectFiles(): void {
  void call('reset-project', {}, 20_000).catch(() => undefined);
}
