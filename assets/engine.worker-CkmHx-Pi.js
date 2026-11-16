(function(){let e=`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`,t=`0.1.39`;async function n(){return(await import(`${e}pyodide.mjs`)).loadPyodide({indexURL:e})}let r=null,i=!1,a=!1;function o(e,t,n,r,i,a){self.postMessage({id:e,kind:t,ok:n,data:r,error:i,...a})}async function s(e){if(i)return;let o=performance.now(),s=o,c=e=>{let t=performance.now();console.log(`[engine] stage ${e}: +${Math.round(t-s)}ms (boot ${Math.round(t-o)}ms)`),self.postMessage({kind:`progress`,stage:e,ms:Math.round(t-s),total:Math.round(t-o)}),s=t};console.log(`[engine] boot start`,{strategies:e.map(e=>e.key),cores:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory});let l=await n();if(r=l,c(`python`),await l.loadPackage([`micropip`,`numpy`,`pyarrow`,`python-dateutil`]),c(`packages`),!navigator.storage?.getDirectory)throw Error(`This browser has no OPFS, so the market cache cannot be mounted.`);let u=performance.now(),d=await(await navigator.storage.getDirectory()).getDirectoryHandle(`sltp-market`,{create:!0});l.FS.mkdirTree(`/home/pyodide/.sltp/cache`),await l.mountNativeFS(`/home/pyodide/.sltp/cache`,d),a=!0,console.log(`[engine] OPFS mounted in ${Math.round(performance.now()-u)}ms`,{opfs:`sltp-market`,pyodide:`/home/pyodide/.sltp/cache`}),c(`cache`);let f=performance.now();await l.pyimport(`micropip`).install(`sltp==${t}`),console.log(`[engine] pip install sltp==${t} in ${Math.round(performance.now()-f)}ms`),c(`wheels`),await l.runPythonAsync(`
import json
import time

_STRATEGIES = {}

# Same setup as the standalone benchmark page: the bars are already in the
# mounted OPFS cache, so the engine must never reach for the network mid-run.
# With auto-update on, sltp re-checks R2 through a synchronous XHR before it
# reads, and on a phone that reads as a minute-long download instead of a
# backtest.
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

    print(f"[run] {key} {start}..{end or 'latest'} starting", flush=True)
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
        print(
            f"[run] {key} done in {_run_seconds:.2f}s "
            f"(bar reads {_IO_STATS['io_seconds']:.2f}s in {_IO_STATS['io_calls']} calls, "
            f"bridge {_BRIDGE_STATS['files']} files / "
            f"{_BRIDGE_STATS['bytes'] / 1048576:.1f} MB)",
            flush=True,
        )
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
    print(
        f"[prime] {cache}: {len(list(market.glob('*.bin')))} bundles, "
        f"catalog={symbol_dir.joinpath('symbol_catalog.parquet').is_file()}",
        flush=True,
    )

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
        print("[prime] catalog/actions missing, fetching metadata", flush=True)
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
    print("[prime] ready", flush=True)

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
`),c(`engine`),l.globals.get(`enable_browser_fetch`)();let p=l.globals.get(`prime_remote_cache`),m=performance.now();await p(),console.log(`[engine] cache prime in ${Math.round(performance.now()-m)}ms`),c(`data`);let h=l.globals.get(`register_strategy`);for(let t of e)h(t.key,t.className,t.source);i=!0,console.log(`[engine] boot complete in ${Math.round(performance.now()-o)}ms`)}self.onmessage=async e=>{let t=e.data,n=performance.now();console.log(`[engine] <- ${t.kind}`,t.kind===`run`?{key:t.key,start:t.start,end:t.end}:{id:t.id});try{if(t.kind===`init`){await s(t.strategies),o(t.id,t.kind,!0,JSON.stringify({ready:!0}),void 0,{mounted:a}),console.log(`[engine] init answered in ${Math.round(performance.now()-n)}ms`);return}if(!r||!i)throw Error(`engine is not ready yet`);if(t.kind===`run`){let e=r.globals.get(`run_strategy`);console.log(`[engine] run ${t.key} dispatched to Python`);let i=String(e(t.key,t.start,t.end));console.log(`[engine] run ${t.key} returned ${i.length} bytes in ${Math.round(performance.now()-n)}ms`),o(t.id,t.kind,!0,i);return}if(t.kind===`lab-load`){let e=r.globals.get(`load_all_market_data`),n=String(e(t.start,t.end));o(t.id,t.kind,!0,n);return}if(t.kind===`python`){let e=r.globals.get(`run_terminal`),n=String(e(t.code));o(t.id,t.kind,!0,n);return}}catch(e){console.error(`[engine] message failed`,t.kind,e),o(t.id,t.kind??`?`,!1,void 0,e instanceof Error?e.message:String(e))}}})();