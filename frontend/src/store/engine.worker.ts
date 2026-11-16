// engine.worker.ts — the sltp engine, off the UI thread.
//
// A module Web Worker that boots Pyodide, mounts the OPFS market cache
// straight into the Emscripten filesystem, installs the pinned sltp
// release, and answers run calls with JSON strings. The engine is never
// modified here: every call below is public sltp API.
//
// Reads need no bridge: the worker mounts the same `sltp-market` directory
// the sync downloads into at sltp's own cache path (`~/.sltp/cache`), and
// the bucket layout the sync mirrors is almost the layout sltp expects:
// bars and actions sit in MARKET_DAILY/ where sltp looks, and boot mirrors
// the uppercase SYMBOL_DATA/ catalog to the lowercase symbol_data/ dir the
// readers open. A run over a range the sync never fetched
// still resolves — sltp's own fetch hook downloads the gap through the
// browser stack (synchronous XHR, which is why this worker exists: the
// main thread cannot do it), landing in the same mounted files.
//
// Dependencies come from the Pyodide distribution and sltp is the one pip
// install. That wheel rides OPFS like the Lab's do (WHEELS/ plus the resolved
// PyPI filename), so only a first visit talks to PyPI at all. The market bytes
// are already on disk in OPFS.


import { ANALYZER, LAB_BOOTSTRAP } from '../lab/pythonSources';
import { installWheel } from './wheels';

/** Pinned runtime: the full build serves loadPyodide plus every wheel. */
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
/** Engine pin: matches backend/requirements.txt. The only pip install here:
    numpy, pyarrow and python-dateutil all ship in the Pyodide distribution
    and are loaded as binary packages, because a WASM runtime cannot use the
    CPython wheels on PyPI. */
const SLTP_VERSION = '0.1.39';

/** The slice of the Pyodide JS API this worker touches. */
/** The Lab's analyser pins: the same wheels the Lab used to install itself. */
const JEDI_VERSION = '0.20.1';
const PARSO_VERSION = '0.8.7';
const PYFLAKES_VERSION = '4.1.0';

interface PyodideApi {
  loadPackage: (names: string | string[]) => Promise<void>;
  runPython: (code: string, options?: { globals?: unknown }) => unknown;
  runPythonAsync: (code: string, options?: { globals?: unknown }) => Promise<unknown>;
  setStdout: (options: { batched?: (text: string) => void }) => void;
  setStderr: (options: { batched?: (text: string) => void }) => void;
  pyimport: (name: string) => { install: (requirement: string) => Promise<unknown> };
  globals: {
    get: (name: string) => ((...args: unknown[]) => unknown) & Record<string, unknown>;
    set: (name: string, value: unknown) => void;
  };
  FS: { mkdirTree: (path: string) => void; writeFile: (path: string, data: Uint8Array) => void };
  mountNativeFS: (mountpoint: string, handle: FileSystemDirectoryHandle) => Promise<unknown>;
}

async function loadPyodideAtPin(): Promise<PyodideApi> {
  // @vite-ignore keeps this a runtime CDN fetch instead of a build asset.
  const module = (await import(/* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`)) as {
    loadPyodide: (options: { indexURL: string }) => Promise<PyodideApi>;
  };
  return module.loadPyodide({ indexURL: PYODIDE_INDEX_URL });
}

interface StrategyInit {
  key: string;
  className: string;
  source: string;
}

type Incoming =
  | { id: number; kind: 'init'; strategies: StrategyInit[] }
  | { id: number; kind: 'run'; key: string; start: string; end: string | null }
  | { id: number; kind: 'lab-load'; start: string; end: string | null }
  | { id: number; kind: 'python'; code: string }
  // The Lab shares this interpreter now. Its program is executed into its own
  // namespace, so the two pages share a Pyodide without sharing names.
  | { id: number; kind: 'lab-warm' }
  | {
      id: number;
      kind: 'run-project';
      filename: string;
      code: string;
      files: { name: string; content: string }[];
      settings?: Record<string, unknown>;
    }
  | {
      id: number;
      kind: 'analyze';
      method: string;
      code: string;
      path: string;
      line: number;
      column: number;
      files: { name: string; content: string }[];
    }
  | { id: number; kind: 'reset-project' };

// Everything the worker needs from Python, defined once. Drivers return
// JSON strings so the only thing crossing the worker boundary is text.
const BOOTSTRAP = `
import json
import time

_STRATEGIES = {}

# The bars are already in the mounted OPFS cache and the page's own sync owns
# freshness. With auto-update on, sltp re-reads R2 metadata through a
# synchronous XHR before every read, serialising the run behind the network
# for nothing.
from sltp.data import config as _config
_config.set_auto_update(False)

# Timings for one run: how much of it was reading bars, and how much was the
# day loop itself. Printed in the UI, so a slow phone names its bottleneck
# instead of leaving the reader staring at a spinner.
_IO_STATS = {"io_seconds": 0.0, "io_calls": 0}


# The user-facing date window of the last run. Changing it is a memory
# boundary: the old window's decoded universes are dead weight while the new
# one is being built, and on a phone their overlap is enough to kill the tab.
_LAST_RUN_WINDOW = None


def register_strategy(key, classname, source):
    namespace = {}
    exec(compile(source, "<" + key + ">", "exec"), namespace)
    _STRATEGIES[key] = namespace[classname]


def _install_shared_bulk_cache():
    # Every large strategy ranks the same US universe. sltp keys its bulk
    # cache by the exact ticker list, so Adaptive Momentum, Minimum
    # Volatility and Mean Reversion each kept their own full decode. Two of
    # those dictionaries are enough to push a phone WebView over its memory
    # ceiling on the third run. Read one canonical universe and hand each
    # strategy only the names it asked for; the cache stays warm across
    # strategies and Pyodide only holds one copy of the bars.
    from sltp.data import market_data_service as service

    if getattr(service, "_sltp_shared_bulk", False):
        return

    original = service._bulk_histories

    def shared_bulk(symbols, start, end):
        if len(symbols) <= service.SYMBOL_CACHE_LIMIT:
            return original(symbols, start, end)
        try:
            universe = service.get_all_tickers()
            histories = original(universe, start, end)
        except Exception as error:
            # The canonical read is an optimisation. If the catalog is
            # unavailable, let the engine take its normal path.
            return original(symbols, start, end)
        result = {symbol: histories[symbol] for symbol in symbols if symbol in histories}
        return result

    service._sltp_original_bulk_histories = original
    service._bulk_histories = shared_bulk
    service.BULK_CACHE_LIMIT = 1
    service._sltp_shared_bulk = True


def run_strategy(key, start, end):
    from sltp.backtesting import Backtester
    from sltp.backtesting import backtester as _backtester
    from sltp.data import market_data_service as _market
    from sltp.web import to_jsonable

    _install_shared_bulk_cache()

    # A new date window invalidates the old decoded bars. Release them before
    # the new read instead of waiting for the cache limit to evict them after
    # the new dictionary has already been allocated.
    global _LAST_RUN_WINDOW
    window = (start, end or None)
    if _LAST_RUN_WINDOW != window:
        with _market._LOAD_LOCK:
            _market._BULK_CACHE.clear()
            _market.refresh_market_data_cache()
        _LAST_RUN_WINDOW = window
        import gc as _gc
        _gc.collect()

    # Time the bar reads. The backtester imported _get_histories by name, so
    # both module globals are patched; the timer is restored afterwards so a
    # failed run cannot leave the engine instrumented.
    _IO_STATS["io_seconds"] = 0.0
    _IO_STATS["io_calls"] = 0
    # These counters used to survive the boot fetch, so every warm run still
    # reported the first download. Reset them with the bar-read timer.
    _BRIDGE_STATS["seconds"] = 0.0
    _BRIDGE_STATS["bytes"] = 0
    _BRIDGE_STATS["files"] = 0
    _original_backtester = _backtester._get_histories
    _original_market = getattr(_market, "_get_histories", None)

    def _timed(fn):
        def wrapper(*args, **kwargs):
            started = time.perf_counter()
            try:
                return fn(*args, **kwargs)
            finally:
                _IO_STATS["io_seconds"] += time.perf_counter() - started
                _IO_STATS["io_calls"] += 1
        return wrapper

    _backtester._get_histories = _timed(_original_backtester)
    if _original_market is not None:
        _market._get_histories = _timed(_original_market)

    cls = _STRATEGIES[key]
    _started = time.perf_counter()
    try:
        result = Backtester(cls(), start, end or None).run()
    finally:
        _run_seconds = time.perf_counter() - _started
        _backtester._get_histories = _original_backtester
        if _original_market is not None:
            _market._get_histories = _original_market
    # sltp's curve points carry portfolio_value; accept a bare value too so
    # a point never dies inside to_jsonable with a bare KeyError. Anything
    # else fails loud, naming the keys, the range and the engine version.
    stamp = result.get("stamp") or {}
    equity = []
    for point in result.get("equity") or []:
        if "portfolio_value" in point:
            value = point["portfolio_value"]
        elif "value" in point:
            value = point["value"]
        else:
            raise ValueError(
                f"equity point has keys {sorted(point.keys())} "
                f"for {key} {start}..{end} (sltp {stamp.get('sltp_version')})"
            )
        equity.append({"date": str(point["date"]), "value": float(value)})
    payload = to_jsonable(result)
    payload["equity"] = equity
    payload["timings"] = {
        "run_seconds": round(_run_seconds, 2),
        "io_seconds": round(_IO_STATS["io_seconds"], 2),
        "io_calls": _IO_STATS["io_calls"],
        "bridge_seconds": round(_BRIDGE_STATS["seconds"], 2),
        "bridge_bytes": _BRIDGE_STATS["bytes"],
        "bridge_files": _BRIDGE_STATS["files"],
    }
    # Hand back the text and let the tray of equity/trade objects go: Safari
    # kills a tab that keeps a finished five-year result resident, which is
    # what a reader sees as the page reloading itself.
    text = json.dumps(payload)
    payload = None
    result = None
    import gc as _gc
    _gc.collect()
    return text


# The lab variable the phone page asks for. It is deliberately exposed in
# the worker globals so later terminal commands can inspect it.
LAB_HISTORIES = {}

def load_all_market_data(start="2022-01-01", end=None, chunk_size=1000):
    from sltp.data import market_data_service as service
    universe = service.get_all_tickers()
    # Use the undecorated reader so each 1,000-ticker batch is actually a
    # separate batch instead of the shared-cache wrapper decoding the world.
    reader = getattr(service, "_sltp_original_bulk_histories", service._bulk_histories)
    histories = {}
    started = time.perf_counter()
    for offset in range(0, len(universe), chunk_size):
        batch = universe[offset:offset + chunk_size]
        try:
            part = reader(batch, start, end or None)
            histories.update(part)
        except Exception as error:
            continue
        elapsed = time.perf_counter() - started
    rows = 0
    for frame in histories.values():
        try:
            rows += len(frame)
        except Exception:
            pass
    globals()["LAB_UNIVERSE"] = universe
    globals()["LAB_HISTORIES"] = histories
    return json.dumps({"tickers": len(histories), "universe": len(universe), "rows": rows})


def run_terminal(code):
    import io
    import contextlib
    import traceback
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output):
            exec(compile(code, "<lab>", "exec"), globals())
        return json.dumps({"ok": True, "stdout": output.getvalue()})
    except Exception:
        return json.dumps({"ok": False, "stdout": output.getvalue(), "error": traceback.format_exc()})


def prime_remote_cache():
    # sltp reads bars from ~/.sltp/cache/MARKET_DAILY (the OPFS directory
    # mounted there) and the catalog beside it in ~/.sltp/cache/symbol_data,
    # while the bucket and the browser sync both write the uppercase
    # SYMBOL_DATA/ name. Mirror the small metadata files onto the lowercase
    # path the readers open. Bars need no move: a 0.1.39 bundle is already
    # a MARKET_DAILY/market_data_<year>.bin. Runs at every boot, so a
    # half-written file heals itself on the next visit.
    import shutil
    from pathlib import Path
    from sltp.data import remote as _remote

    cache = Path(_remote.CACHE_ROOT)
    market = cache / "MARKET_DAILY"
    symbol_dir = cache / "symbol_data"

    # Self-heal: a parquet without its magic is a truncated download, and a
    # bundle too small to hold a header is not a bundle. Drop both so the
    # next sync (or sltp's own fetch) writes them again.
    for cached in [*market.glob("*.parquet"), *symbol_dir.glob("*.parquet")]:
        try:
            with open(cached, "rb") as handle:
                broken = handle.read(4) != b"PAR1"
        except OSError:
            broken = True
        if broken:
            cached.unlink(missing_ok=True)
    for cached in market.glob("*.bin"):
        try:
            if cached.stat().st_size <= 24:
                cached.unlink()
        except OSError:
            pass

    # Metadata already on disk means no network: the main-thread sync owns
    # freshness, and sltp's own fetch still fills a missing bundle on demand.
    have_catalog = (cache / "SYMBOL_DATA" / "symbol_catalog.parquet").is_file() or (
        symbol_dir / "symbol_catalog.parquet"
    ).is_file()
    if not (have_catalog and (market / "market_actions.parquet").is_file()):
        _remote.sync_catalog()
        _remote.sync_actions()

    symbol_dir.mkdir(parents=True, exist_ok=True)

    src = cache / "SYMBOL_DATA"
    if src.is_dir():
        try:
            same = src.resolve() == symbol_dir.resolve()
        except OSError:
            same = False
        if not same:
            for child in src.iterdir():
                if child.is_file():
                    try:
                        shutil.copy2(child, symbol_dir / child.name)
                    except shutil.SameFileError:
                        # Case-insensitive checkout: src and dest are one dir.
                        pass
`;

/** Sync downloads through the browser's own network stack. open_url decodes
    to text, which corrupts parquet beyond its ASCII magic, so the response
    is read as an arraybuffer without a text step. Anything sltp fetches
    through here lands in the mounted OPFS files, where the main-thread
    sync counts it like any download of its own. */
const FETCH_BRIDGE = `
_BRIDGE_STATS = {"seconds": 0.0, "bytes": 0, "files": 0}


def enable_browser_fetch():
    from pyodide.http import open_url
    from sltp.data.remote import set_fetch

    # sltp ships the public r2.dev URL, which is closed now. Every remote read
    # goes through the gate instead: the unversioned alias serves the small
    # metadata files, and the cache mounted from OPFS serves the bars.
    import sltp.data.remote as _remote
    _remote.REMOTE_BASE_URL = "https://sltp-data.magicaltitan7.workers.dev/v/live"

    def _bridge(url, dest):
        from pathlib import Path
        from js import Uint8Array, XMLHttpRequest

        started = time.perf_counter()
        request = XMLHttpRequest.new()
        request.open("GET", str(url), False)
        request.responseType = "arraybuffer"
        request.send(None)
        if request.status != 200:
            raise IOError(f"download {url} failed with status {request.status}")
        data = Uint8Array.new(request.response).to_py().tobytes()
        _BRIDGE_STATS["seconds"] += time.perf_counter() - started
        _BRIDGE_STATS["bytes"] += len(data)
        _BRIDGE_STATS["files"] += 1
        path = Path(str(dest))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes(data))
        if path.suffix == ".parquet" and data[:4] != b"PAR1":
            raise IOError("download from " + str(url) + " is not a parquet file")

    set_fetch(_bridge)
`;

let pyodide: PyodideApi | null = null;
let booted = false;
let cacheMounted = false;

/** The Lab's namespace, created on its first request and reused after that. */
let labGlobals: Record<string, unknown> | null = null;
let labReady = false;
/** Why the Lab half is degraded, when it is. */
let labWarning: string | null = null;
/** The project run whose stdout is arriving right now. */
let currentRun = 0;
let currentLogs: { stream: 'stdout' | 'stderr'; text: string }[] = [];

/** Status lines for the Lab's progress panel. */
function labStatus(text: string, id = 0): void {
  if (id) self.postMessage({ type: 'run-status', id, text });
  else self.postMessage({ type: 'status', text });
}

function reply(
  id: number,
  kind: string,
  ok: boolean,
  data?: unknown,
  error?: string,
  extra?: Record<string, unknown>,
) {
  self.postMessage({ id, kind, ok, data, error, ...extra });
}

/** Registers the prebuilt strategies in the running interpreter. Idempotent:
    a key is overwritten, so a second init from another page is harmless. */
function registerStrategies(strategies: StrategyInit[]): void {
  if (!pyodide || strategies.length === 0) return;
  const register = pyodide.globals.get('register_strategy');
  for (const entry of strategies) {
    register(entry.key, entry.className, entry.source);
  }
}

async function boot(strategies: StrategyInit[]): Promise<void> {
  // The Lab may have booted the kernel first (with no strategies). Registering
  // here is what makes Research work on a kernel someone else started.
  if (booted) {
    registerStrategies(strategies);
    return;
  }
  // One stage message per step, so the page can say what the first run is
  // waiting on instead of a blank "Loading engine…".
  let last = performance.now();
  const step = (stage: string) => {
    const now = performance.now();
    self.postMessage({ kind: 'progress', stage, ms: Math.round(now - last) });
    last = now;
  };
  const instance = await loadPyodideAtPin();
  pyodide = instance;
  // The Lab's program prints through these, one line at a time; a Research
  // run prints nothing, so currentRun stays 0 and the lines are dropped.
  instance.setStdout({
    batched: (text: string) => {
      if (!currentRun) return;
      currentLogs.push({ stream: 'stdout', text });
      self.postMessage({ type: 'stdout', id: currentRun, text });
    },
  });
  instance.setStderr({
    batched: (text: string) => {
      if (!currentRun) return;
      currentLogs.push({ stream: 'stderr', text });
      self.postMessage({ type: 'stderr', id: currentRun, text });
    },
  });
  step('python');
  // Everything sltp imports besides itself (numpy, pyarrow, python-dateutil)
  // comes from the Pyodide distribution: a WASM runtime cannot load the
  // CPython wheels on PyPI, so these load as binary packages and the one
  // pip install below has nothing left to resolve.
  await instance.loadPackage(['micropip', 'numpy', 'pyarrow', 'python-dateutil']);
  step('packages');
  // The market cache, always mounted where sltp looks for it: OPFS
  // sltp-market/ appears as ~/.sltp/cache inside Pyodide, so runs read the
  // bars the sync already downloaded instead of pulling them again. No
  // mount means no run — a memory filesystem would silently refetch the
  // history and then lose it on reload.
  if (!navigator.storage?.getDirectory) {
    throw new Error('This browser has no OPFS, so the market cache cannot be mounted.');
  }
  const root = await navigator.storage.getDirectory();
  const cacheHandle = await root.getDirectoryHandle('sltp-market', { create: true });
  instance.FS.mkdirTree('/home/pyodide/.sltp/cache');
  await instance.mountNativeFS('/home/pyodide/.sltp/cache', cacheHandle);
  cacheMounted = true;
  step('cache');
  // The one pip install, from the shared OPFS wheel cache: a warm visit reads
  // the wheel and its PyPI filename off disk and asks PyPI nothing.
  const micropip = instance.pyimport('micropip');
  await installWheel(instance, micropip, 'sltp', SLTP_VERSION);
  step('wheels');
  await instance.runPythonAsync(BOOTSTRAP + FETCH_BRIDGE);
  step('engine');
  const enableFetch = instance.globals.get('enable_browser_fetch');
  enableFetch();
  // Mirror the uppercase bucket layout to the lowercase paths sltp opens
  // (SYMBOL_DATA/ -> symbol_data/), fetching anything still missing.
  const prime = instance.globals.get('prime_remote_cache');
  await prime();
  step('data');
  booted = true;
  registerStrategies(strategies);
}

/**
 * Boots the Lab's half of this interpreter: its own namespace, its project
 * runner, and — from the shared OPFS wheel cache — its analyser. Called on
 * the first Lab request only, because a Research run should not pay for jedi.
 */
async function warmLab(): Promise<void> {
  // The Lab can be the first page to need Python: boot the kernel for it and
  // let Research register its strategies later into the same interpreter.
  if (!booted) await boot([]);
  if (!pyodide) throw new Error('the Python kernel is not ready yet');
  if (labReady) return;
  const instance = pyodide;
  if (!labGlobals) labGlobals = instance.runPython('{}') as Record<string, unknown>;
  const namespace = labGlobals;
  labStatus('Preparing the workspace…');
  try {
    instance.runPython(LAB_BOOTSTRAP, { globals: namespace });
    labStatus('Preparing the analyser…');
    const micropip = instance.pyimport('micropip');
    await installWheel(instance, micropip, 'parso', PARSO_VERSION);
    await installWheel(instance, micropip, 'jedi', JEDI_VERSION);
    await installWheel(instance, micropip, 'pyflakes', PYFLAKES_VERSION);
    instance.runPython(ANALYZER, { globals: namespace });
    labWarning = null;
  } catch (error) {
    // The runner still works without jedi; the reason is kept for the status.
    labWarning = error instanceof Error ? error.message : String(error);
  }
  labReady = true;
}

/** One project run: streams its output, then posts the run's own reply. */
async function runProject(
  id: number,
  filename: string,
  code: string,
  files: { name: string; content: string }[],
  settings: Record<string, unknown> | undefined,
): Promise<void> {
  if (!pyodide || !labGlobals) throw new Error('the Lab has not started yet');
  const instance = pyodide;
  currentRun = id;
  currentLogs = [];
  labStatus('Preparing the workspace…', id);
  instance.globals.set('lab_status', (text: unknown) => labStatus(String(text), id));
  const started = performance.now();
  const source: Record<string, string> = {};
  for (const file of files) source[file.name] = file.name === filename ? code : file.content;
  try {
    const outcome = String(
      await instance.runPythonAsync(
        `run_project(${JSON.stringify(filename)}, ${JSON.stringify(source)}, ${JSON.stringify(JSON.stringify(settings ?? {}))})`,
        { globals: labGlobals },
      ),
    );
    let parsed: { ok?: boolean; result?: unknown; error?: string; notice?: string };
    try {
      parsed = JSON.parse(outcome) as typeof parsed;
    } catch {
      parsed = { ok: false, error: outcome };
    }
    self.postMessage({
      type: 'done',
      id,
      ok: parsed.ok === true,
      message: parsed.error,
      notice: parsed.notice,
      result: parsed.result ?? null,
      logs: currentLogs,
      durationMs: performance.now() - started,
    });
  } catch (error) {
    self.postMessage({
      type: 'done',
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      logs: currentLogs,
      durationMs: performance.now() - started,
    });
  } finally {
    currentRun = 0;
  }
}

/** One editor question, answered by jedi inside the Lab's namespace. */
async function analyzeRequest(message: Extract<Incoming, { kind: 'analyze' }>): Promise<void> {
  if (!pyodide || !labGlobals) throw new Error('the Lab has not started yet');
  const files: Record<string, string> = {};
  for (const file of message.files) files[file.name] = file.content;
  try {
    const raw = String(
      await pyodide.runPythonAsync(
        `analyze(${JSON.stringify(message.method)}, ${JSON.stringify(message.code)}, ${JSON.stringify(message.path)}, ${JSON.stringify(message.line)}, ${JSON.stringify(message.column)}, ${JSON.stringify(JSON.stringify(files))})`,
        { globals: labGlobals },
      ),
    );
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; data?: unknown };
    self.postMessage({
      type: 'analyze-result',
      id: message.id,
      ok: parsed.ok === true,
      error: parsed.error,
      data: parsed.data ?? null,
    });
  } catch (error) {
    self.postMessage({
      type: 'analyze-result',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const message = event.data;
  try {
    if (message.kind === 'init') {
      await boot(message.strategies);
      reply(message.id, message.kind, true, JSON.stringify({ ready: true }), undefined, {
        mounted: cacheMounted,
      });
      return;
    }
    const isLabCall =
      message.kind === 'lab-warm' ||
      message.kind === 'run-project' ||
      message.kind === 'analyze' ||
      message.kind === 'reset-project';
    // A Lab call may be what boots the kernel; a Research call never is.
    if (!isLabCall && (!pyodide || !booted)) throw new Error('engine is not ready yet');
    if (message.kind === 'lab-warm') {
      await warmLab();
      let version = 'unknown';
      try {
        version = String(pyodide.runPython('python_version', { globals: labGlobals ?? undefined }));
      } catch {
        /* the version line is a nicety, not a contract */
      }
      self.postMessage({
        type: 'ready',
        version,
        engine: true,
        market: cacheMounted,
        warning: labWarning,
        cache: cacheMounted,
      });
      reply(message.id, message.kind, true, JSON.stringify({ ready: true }));
      return;
    }
    if (message.kind === 'run-project') {
      await warmLab();
      await runProject(message.id, message.filename, message.code, message.files, message.settings);
      reply(message.id, message.kind, true, JSON.stringify({ done: true }));
      return;
    }
    if (message.kind === 'analyze') {
      await warmLab();
      await analyzeRequest(message);
      reply(message.id, message.kind, true, JSON.stringify({ done: true }));
      return;
    }
    if (message.kind === 'reset-project') {
      if (labReady && labGlobals) pyodide.runPython('reset_project()', { globals: labGlobals });
      reply(message.id, message.kind, true, JSON.stringify({ ok: true }));
      return;
    }
    if (message.kind === 'run') {
      const runStrategy = pyodide.globals.get('run_strategy');
      const text = String(runStrategy(message.key, message.start, message.end));
      reply(message.id, message.kind, true, text);
      return;
    }
    if (message.kind === 'lab-load') {
      const loadAll = pyodide.globals.get('load_all_market_data');
      const text = String(loadAll(message.start, message.end));
      reply(message.id, message.kind, true, text);
      return;
    }
    if (message.kind === 'python') {
      const runTerminal = pyodide.globals.get('run_terminal');
      const text = String(runTerminal(message.code));
      reply(message.id, message.kind, true, text);
      return;
    }
  } catch (error) {
    reply(
      message.id,
      (message as { kind?: string }).kind ?? '?',
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
};
