(function(){let e=new Map;function t(){return typeof navigator<`u`&&!!navigator.storage?.getDirectory}function n(){return!t()}async function r(e){return(await navigator.storage.getDirectory()).getDirectoryHandle(`sltp-market`,{create:e})}async function i(e,t){let n=e.split(`/`).filter(Boolean),i=n.pop(),a=await r(t);for(let e of n)a=await a.getDirectoryHandle(e,{create:t});return{dir:a,name:i}}async function a(t){if(e.has(t))return!0;if(n())return!1;try{let{dir:e,name:n}=await i(t,!1);return await e.getFileHandle(n),!0}catch{return!1}}async function o(t){let r=e.get(t);if(r)return new File([r],t.split(`/`).pop()||t,{type:r.type});if(n())return null;try{let{dir:e,name:n}=await i(t,!1);return(await e.getFileHandle(n)).getFile()}catch{return null}}async function s(t,r){if(n()){e.set(t,r);return}let{dir:a,name:o}=await i(t,!0),s=await(await a.getFileHandle(o,{create:!0})).createWritable();try{await s.write(r)}finally{await s.close()}}let c=`WHEELS/resolved.json`,l=null;async function u(){if(l)return l;try{let e=await o(c);l=e?JSON.parse(await e.text()):{}}catch{l={}}return l}async function d(e,t){let n=await u();n[e]=t;try{await s(c,new Blob([JSON.stringify(n)],{type:`application/json`}))}catch{}}async function f(e,t){let n=await fetch(`https://pypi.org/pypi/${e}/${t}/json`);if(!n.ok)throw Error(`PyPI lookup failed for ${e}==${t} (${n.status})`);let r=await n.json(),i=(r.urls??[]).find(e=>e.filename.endsWith(`.whl`)&&!e.filename.includes(`cp`)&&!e.filename.includes(`pp`))??(r.urls??[]).find(e=>e.filename.endsWith(`.whl`));if(!i)throw Error(`No wheel found for ${e}==${t}`);return{filename:i.filename,url:i.url}}async function p(e,t,n,r){try{let i=`${n}==${r}`,c=(await u())[i],{filename:l,url:p}=c??await f(n,r);c||await d(i,{filename:l,url:p});let m=`WHEELS/${l}`,h=!0;if(!await a(m)){h=!1;let e=await fetch(p);if(!e.ok)throw Error(`Wheel download failed for ${l} (${e.status})`);await s(m,new Blob([await e.arrayBuffer()]))}let g=await o(m);if(!g)throw Error(`Wheel vanished after download: ${l}`);return e.FS.writeFile(`/tmp/${l}`,new Uint8Array(await g.arrayBuffer())),await t.install(`emfs:/tmp/${l}`),{cached:h,filename:l}}catch{return await t.install(`${n}==${r}`),{cached:!1,filename:null}}}let m=`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`;async function h(){return(await import(`${m}pyodide.mjs`)).loadPyodide({indexURL:m})}let g=null,_=!1,v=!1,y=null,b=!1,x=null,S=0,C=[];function w(e,t=0){t?self.postMessage({type:`run-status`,id:t,text:e}):self.postMessage({type:`status`,text:e})}function T(e,t,n,r,i,a){self.postMessage({id:e,kind:t,ok:n,data:r,error:i,...a})}function E(e){if(!g||e.length===0)return;let t=g.globals.get(`register_strategy`);for(let n of e)t(n.key,n.className,n.source)}async function D(e){if(_){E(e);return}let t=performance.now(),n=e=>{let n=performance.now();self.postMessage({kind:`progress`,stage:e,ms:Math.round(n-t)}),t=n},r=await h();if(g=r,r.setStdout({batched:e=>{S&&(C.push({stream:`stdout`,text:e}),self.postMessage({type:`stdout`,id:S,text:e}))}}),r.setStderr({batched:e=>{S&&(C.push({stream:`stderr`,text:e}),self.postMessage({type:`stderr`,id:S,text:e}))}}),n(`python`),await r.loadPackage([`micropip`,`numpy`,`pyarrow`,`python-dateutil`]),n(`packages`),!navigator.storage?.getDirectory)throw Error(`This browser has no OPFS, so the market cache cannot be mounted.`);let i=await(await navigator.storage.getDirectory()).getDirectoryHandle(`sltp-market`,{create:!0});r.FS.mkdirTree(`/home/pyodide/.sltp/cache`),await r.mountNativeFS(`/home/pyodide/.sltp/cache`,i),v=!0,n(`cache`),await p(r,r.pyimport(`micropip`),`sltp`,`0.1.42`),n(`wheels`),await r.runPythonAsync(`
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
    # path the readers open. Bars need no move: a flat bundle is already
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
`),n(`engine`),r.globals.get(`enable_browser_fetch`)(),await r.globals.get(`prime_remote_cache`)(),n(`data`),_=!0,E(e)}async function O(){if(_||await D([]),!g)throw Error(`the Python kernel is not ready yet`);if(b)return;let e=g;y||=e.runPython(`{}`);let t=y;w(`Preparing the workspace…`);try{e.runPython(`
import builtins
import json
import linecache
import os
import platform
import inspect
import shutil
import sys
import traceback
from pathlib import Path

python_version = platform.python_version()
PROJECT_ROOT = Path("/home/pyodide/project")
# Bars come from the mounted OPFS cache, the same source Research reads. This
# used to point at /data, a directory a prime step filled with links into the
# cache; that step went away when the two pages were merged into one kernel and
# nothing created /data afterwards, so a Lab run started before any Research
# run found no bars at all. The R2 re-check that /data existed to avoid is
# already off (BOOTSTRAP sets auto_update False).
os.environ.pop("SLTP_DATA_DIR", None)


def _format_error(exc):
    frames = [
        frame
        for frame in traceback.extract_tb(exc.__traceback__)
        if frame.filename == "<lab>"
        or frame.filename.startswith(str(PROJECT_ROOT))
    ]
    lines = ["Traceback (most recent call last):"] if frames else []
    for frame in frames:
        shown = frame.filename.replace(str(PROJECT_ROOT) + "/", "")
        lines.append(f'  File "{shown}", line {frame.lineno}, in {frame.name}')
        if frame.line:
            lines.append(f"    {frame.line.strip()}")
    tail = "".join(traceback.format_exception_only(type(exc), exc)).rstrip()
    # Exception-only text names the file for syntax errors; show it the same
    # way the frames above do, relative to the project root.
    lines.extend(tail.replace(str(PROJECT_ROOT) + "/", "").splitlines())
    return "\\n".join(lines)


def _clear_project_modules():
    for name, module in list(sys.modules.items()):
        filename = getattr(module, "__file__", None)
        if filename and str(filename).startswith(str(PROJECT_ROOT)):
            sys.modules.pop(name, None)


def _find_result(namespace):
    # Backtester.run returns a dict with metrics and equity. The script may
    # keep it in any name, so look at the values rather than guessing one.
    for value in reversed(list(namespace.values())):
        if isinstance(value, dict) and "metrics" in value and "equity" in value:
            return value
    return None


def _strategy_name(namespace):
    for value in reversed(list(namespace.values())):
        name = getattr(value, "name", None)
        if isinstance(name, str) and callable(getattr(value, "on_signal", None)):
            return name
        if isinstance(value, type) and callable(getattr(value, "on_signal", None)):
            return value.__name__
    return None


def _is_project_class(value):
    """True for classes defined by files the reader wrote, not by sltp."""
    if not isinstance(value, type):
        return False
    # The entry file runs in a plain exec namespace, not a module registered
    # as __main__, so inspect.getsourcefile cannot see its path. Any class in
    # that namespace is the reader's own.
    if value.__module__ == "__main__":
        return True
    module = sys.modules.get(value.__module__)
    filename = getattr(module, "__file__", None) or inspect.getsourcefile(value) or ""
    return str(filename).startswith(str(PROJECT_ROOT))


def _find_strategy(namespace):
    """The reader's Strategy class, preferring one defined in the open file."""
    from sltp import Strategy

    found = [
        value
        for value in namespace.values()
        if _is_project_class(value)
        and value is not Strategy
        and issubclass(value, Strategy)
    ]
    for value in reversed(found):
        if value.__module__ == "__main__":
            return value
    return found[-1] if found else None


def _default_start():
    from datetime import date, timedelta

    return (date.today() - timedelta(days=730)).isoformat()


def _status(text):
    # The callback is registered as a JS module. It used to be read with a
    # from-js import, but pyodide.globals is not the JS module
    # namespace, so that import always failed and the error was swallowed:
    # every stage message was lost and the page stayed on its first label for
    # the whole run.
    try:
        from lab_bridge import status

        status(text)
        return
    except Exception:
        pass
    try:
        from js import lab_status

        lab_status(text)
    except Exception:
        pass


def _benchmark_series(start, end):
    # The same buy-and-hold SPY line the CLI prints next to a lone strategy.
    # A benchmark failure costs the second line, never the result window.
    try:
        from sltp.web import _benchmark

        return [
            {"date": str(point["date"]), "value": float(point["portfolio_value"])}
            for point in _benchmark(start, end, True)
        ]
    except Exception:
        return []


def _chart_svg(result, payload):
    # The same static SVG the CLI writes, built from the equity already in the
    # payload so the benchmark is not run a second time.
    try:
        from sltp.graphs import ChartSeries, equity_chart

        equity = payload.get("equity") or []
        if not equity:
            return None
        name = payload.get("strategy_name") or "Strategy"
        series = [ChartSeries.from_equity(name, result.get("equity") or [])]
        benchmark = [
            {"date": point["date"], "portfolio_value": point["value"]}
            for point in payload.get("benchmark") or []
        ]
        if benchmark:
            series.append(
                ChartSeries.from_equity("Buy & Hold (SPY)", benchmark, color="#9aa3b2")
            )
        first = str(equity[0]["date"])
        last = str(equity[-1]["date"])
        return equity_chart(
            series,
            title=name,
            subtitle=f"{first} → {last} · {len(equity)} sessions · index starts at 100",
            start_value=100.0,
        )
    except Exception:
        return None


def _payload(result, namespace):
    from sltp.web import to_jsonable

    payload = to_jsonable(result)
    equity = payload.get("equity") or []
    stamp = payload.get("stamp") or {}
    start = str(stamp.get("actual_start") or (equity[0]["date"] if equity else ""))
    end = str(stamp.get("end") or (equity[-1]["date"] if equity else ""))
    payload["benchmark"] = _benchmark_series(start, end) if start and end else []
    payload["strategy_name"] = _strategy_name(namespace)
    # Rejections are part of the raw run and useful in the download even
    # though they are not a headline metric.
    payload["rejections"] = result.get("rejections") or {}
    # The chart source leads the object, so the download opens on it and the
    # rest of the result follows unchanged.
    return {"svg": _chart_svg(result, payload), **payload}


# What the last run wrote, so a rerun only touches the files that changed.
_PROJECT_WRITTEN = {}


def run_project(filename, files, settings_json="{}"):
    # Settings arrive as a JSON string so null/true mean the same thing here
    # as they do in the message from the page.
    settings = json.loads(settings_json) if settings_json else {}
    # Writing only the changed files is what makes a rerun cheap: the old code
    # deleted the tree and rewrote every file, so a one-line edit paid the
    # whole project's IO again. Files that disappeared are unlinked instead.
    PROJECT_ROOT.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        path = PROJECT_ROOT / name
        if _PROJECT_WRITTEN.get(name) == content and path.is_file():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        _PROJECT_WRITTEN[name] = content
    for stale_name in [name for name in _PROJECT_WRITTEN if name not in files]:
        stale = PROJECT_ROOT / stale_name
        if stale.is_file():
            stale.unlink()
        del _PROJECT_WRITTEN[stale_name]

    _clear_project_modules()
    # The base path is captured on the first run, after micropip has added its
    # site-packages entry, so reinstalling the project paths never loses it.
    if not hasattr(sys, "_lab_base_path"):
        sys._lab_base_path = list(sys.path)
    root = str(PROJECT_ROOT)
    entry = PROJECT_ROOT / filename
    entry_dir = str(entry.parent)
    sys.path[:] = [root, entry_dir] + [
        item for item in sys._lab_base_path if item not in (root, entry_dir)
    ]
    sys.argv = [filename]

    source = entry.read_text(encoding="utf-8")
    # Absolute filename, so traceback frames can be filtered to the project and
    # then shown relative to it; __file__ and linecache agree with that path.
    absolute = str(entry)
    linecache.cache[absolute] = (len(source), None, source.splitlines(True), absolute)
    namespace = {
        "__name__": "__main__",
        "__file__": absolute,
        "__package__": None,
        "__builtins__": builtins,
    }
    _status("Running your code…")
    try:
        exec(compile(source, absolute, "exec"), namespace)
    except Exception as exc:
        return json.dumps({"ok": False, "error": _format_error(exc)})

    # A script may still carry the old explicit Backtester call. Use that if
    # it exists; otherwise the reader only wrote a Strategy and the engine
    # supplies the Backtester, dates and run for them.
    result = _find_result(namespace)
    auto_run = result is None
    run_start = None
    run_end = None
    if result is None:
        strategy_class = _find_strategy(namespace)
        if strategy_class is None:
            return json.dumps({
                "ok": True,
                "result": None,
                "notice": "No Strategy subclass was found. Define a class that inherits from sltp.Strategy, then run again.",
            })
        run_start = str(settings.get("start") or _default_start())
        run_end = settings.get("end") or None
        _status("Running the strategy…")
        try:
            from sltp import Backtester

            participation = settings.get("max_participation")
            backtester = Backtester(
                strategy_class(),
                run_start,
                run_end,
                bool(settings.get("dividends", True)),
                spread_pct=float(settings.get("spread_pct") or 0.0),
                max_participation=None if participation is None else float(participation),
                borrow_rate=float(settings.get("borrow_rate") or 0.0),
                min_fill_notional=float(settings.get("min_fill_notional") or 0.0),
            )
            # Fees and slippage live on the book, not the Backtester signature.
            if settings.get("fee_rate") is not None:
                backtester.manager.FEE_RATE = float(settings["fee_rate"])
            if settings.get("slippage_pct") is not None:
                backtester.manager.SLIPPAGE_PCT = float(settings["slippage_pct"])
            result = backtester.run()
        except Exception as exc:
            return json.dumps({"ok": False, "error": _format_error(exc)})

    _status("Building the report…")
    try:
        payload = _payload(result, namespace)
        payload["run"] = {
            "auto": auto_run,
            "start": run_start or _default_start(),
            "end": run_end,
        }
        return json.dumps({"ok": True, "result": payload})
    except Exception:
        # The backtest ran; only the rich result could not be serialized.
        # Keep the log useful instead of turning a success into an error.
        return json.dumps({
            "ok": False,
            "error": "The strategy ran but its result could not be prepared for the report.",
        })


def reset_project():
    _clear_project_modules()
    if PROJECT_ROOT.exists():
        shutil.rmtree(PROJECT_ROOT)
    return "cleared"
`,{globals:t}),w(`Preparing the analyser…`);let n=e.pyimport(`micropip`);await p(e,n,`parso`,`0.8.7`),await p(e,n,`jedi`,`0.20.1`),await p(e,n,`pyflakes`,`4.1.0`),e.runPython(`
import json
import sys
from pathlib import Path

ANALYZE_ROOT = Path("/home/pyodide/analyze")


def _diagnose(code, path):
    class _Report:
        def __init__(self):
            self.items = []

        def flake(self, message):
            # str(message) leads with the temporary path the code is analysed
            # under, which means nothing to the reader; the template does not.
            template = getattr(message, "message", None)
            args = getattr(message, "message_args", ()) or ()
            text = template % args if template else str(message)
            # A name that does not exist is an error; a tidy-up is a warning.
            kind = type(message).__name__
            self.items.append({
                "line": getattr(message, "lineno", 1) or 1,
                "column": getattr(message, "col_offset", 0) or 0,
                "message": text,
                "severity": 1 if kind.startswith("Undefined") else 2,
            })

        def unexpectedError(self, filename, msg):
            self.items.append({"line": 1, "column": 0, "message": str(msg), "severity": 1})

        def syntaxError(self, filename, msg, lineno, offset, text):
            self.items.append({
                "line": lineno or 1,
                "column": max((offset or 1) - 1, 0),
                "message": str(msg),
                "severity": 1,
            })

    report = _Report()
    try:
        import pyflakes.api as _api

        _api.check(code, path, report)
    except Exception as exc:  # noqa: BLE001 - the reader gets the reason, not a crash
        return {"items": [{"line": 1, "column": 0, "message": str(exc), "severity": 1}]}
    return {"items": report.items}



def _import_candidates(code, line, column, files_json):
    """Names the reader has not imported yet, with the line that imports them."""
    import ast
    import re

    lines = code.splitlines()
    if line - 1 >= len(lines):
        return []
    word = re.search(r"[A-Za-z_][A-Za-z0-9_]*$", lines[line - 1][:column])
    if not word:
        return []
    prefix = word.group(0)

    found = {}
    try:
        import sltp

        for name in getattr(sltp, "__all__", None) or []:
            if name.startswith("_") or not name.startswith(prefix):
                continue
            value = getattr(sltp, name, None)
            found[name] = {
                "label": name,
                "kind": "class" if isinstance(value, type) else "function" if callable(value) else "statement",
                "detail": getattr(value, "__module__", None) or "sltp",
                "statement": f"from sltp import {name}",
            }
    except Exception:  # noqa: BLE001
        pass

    for name, content in (json.loads(files_json) if files_json else {}).items():
        stem = name.rsplit("/", 1)[-1].removesuffix(".py")
        if stem == "sltp" or stem.startswith("_"):
            continue
        try:
            tree = ast.parse(content)
        except SyntaxError:
            continue
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if node.name.startswith("_") or not node.name.startswith(prefix):
                continue
            found.setdefault(
                node.name,
                {
                    "label": node.name,
                    "kind": "class" if isinstance(node, ast.ClassDef) else "function",
                    "detail": name,
                    "statement": f"from {stem} import {node.name}",
                },
            )
    return list(found.values())


def _module_members(code, line, column):
    """What a module exports, for "from x import" and "x.".

    jedi reads source statically, so a package that resolves its public names
    lazily looks like it holds nothing but submodules. sltp does exactly that
    through __getattr__, which is why "from sltp import" offered data and web
    but not Strategy. Asking the package for its own __all__ is both shorter
    and always right, and it fixes every lazily-exported module at once.
    """
    import re

    lines = code.splitlines()
    if line - 1 >= len(lines):
        return []
    head = lines[line - 1][:column]
    match = re.search(r"from +([A-Za-z_][A-Za-z0-9_.]*) +import +([A-Za-z_][A-Za-z0-9_]*)?$", head)
    if match:
        module_name, typed = match.group(1), match.group(2) or ""
    else:
        match = re.search(r"([A-Za-z_][A-Za-z0-9_.]*)[.]([A-Za-z_][A-Za-z0-9_]*)?$", head)
        if not match:
            return []
        module_name, typed = match.group(1), match.group(2) or ""

    import importlib

    try:
        module = importlib.import_module(module_name)
    except Exception:  # noqa: BLE001 - not a module, so nothing to add
        return []

    exported = list(getattr(module, "__all__", None) or [n for n in dir(module) if not n.startswith("_")])
    items = []
    for name in exported:
        if not isinstance(name, str) or not name.startswith(typed):
            continue
        try:
            value = getattr(module, name)
        except Exception:  # noqa: BLE001 - a broken export costs its own entry only
            continue
        if isinstance(value, type):
            kind = "class"
        elif callable(value):
            kind = "function"
        else:
            kind = "statement"
        items.append({
            "label": name,
            "insertText": name,
            "kind": kind,
            "detail": getattr(value, "__module__", None) or module_name,
            "documentation": None,
        })
    return items


# What the last analysis request wrote, so an unchanged file is not rewritten
# on every keystroke.
_ANALYZE_WRITTEN = {}


def analyze(method, code, path, line, column, files_json=""):
    files = json.loads(files_json) if files_json else {}
    for name, content in files.items():
        if _ANALYZE_WRITTEN.get(name) == content:
            continue
        target = ANALYZE_ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.write_text(content, encoding="utf-8")
            _ANALYZE_WRITTEN[name] = content
        except OSError:
            pass

    current = ANALYZE_ROOT / path
    current.parent.mkdir(parents=True, exist_ok=True)
    current.write_text(code, encoding="utf-8")
    root = str(ANALYZE_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)

    if method == "diagnostics":
        return json.dumps({"ok": True, "data": _diagnose(code, str(current))})

    if method == "imports":
        return json.dumps({"ok": True, "data": {"items": _import_candidates(code, line, column, files_json)}})

    try:
        import jedi
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "error": "jedi is unavailable: " + str(exc)})

    try:
        project = jedi.Project(root)
        script = jedi.Script(code=code, path=str(current), project=project)

        if method == "complete":
            found = []
            seen = set()
            for item in script.complete(line, column):
                # jedi can offer the same name from more than one inference
                # path; one row per name is what a reader expects.
                if item.name in seen:
                    continue
                seen.add(item.name)
                found.append(
                    {
                        "label": item.name,
                        "insertText": item.name,
                        "kind": item.type,
                        "detail": item.description,
                        "documentation": item.docstring(),
                    }
                )
            for extra in _module_members(code, line, column):
                if extra["label"] not in seen:
                    seen.add(extra["label"])
                    found.append(extra)
            return json.dumps({"ok": True, "data": {"items": found[:200]}})

        if method == "hover":
            names = script.infer(line, column)
            if not names:
                return json.dumps({"ok": True, "data": None})
            first = names[0]
            return json.dumps({
                "ok": True,
                "data": {
                    "name": first.name,
                    "type": first.type,
                    "description": first.description,
                    "doc": first.docstring(),
                },
            })

        if method == "signature":
            found = script.get_signatures(line, column)
            signatures = []
            active = 0
            for index, signature in enumerate(found[:10]):
                if index == 0:
                    active = getattr(signature, "index", 0) or 0
                signatures.append({
                    "label": signature.name,
                    "params": [param.to_string() for param in signature.params],
                    "doc": signature.docstring(),
                })
            return json.dumps({"ok": True, "data": {"signatures": signatures, "active": active}})

        if method == "define":
            found = script.get_definitions(line, column)
            if not found:
                return json.dumps({"ok": True, "data": None})
            first = found[0]
            relative = None
            module_path = getattr(first, "module_path", None)
            if module_path:
                try:
                    relative = str(Path(module_path).resolve().relative_to(ANALYZE_ROOT.resolve()))
                except Exception:  # noqa: BLE001 - installed packages are outside the project
                    relative = None
            return json.dumps({
                "ok": True,
                "data": {
                    "path": relative,
                    "external": module_path is not None and relative is None,
                    "line": first.line,
                    "column": first.column + 1,
                    "name": first.name,
                },
            })
    except Exception as exc:  # noqa: BLE001 - a failed query must not kill the worker
        return json.dumps({"ok": False, "error": str(exc)})

    return json.dumps({"ok": False, "error": "unknown method " + method})
`,{globals:t}),x=null}catch(e){x=e instanceof Error?e.message:String(e)}b=!0}async function k(e,t,n,r,i){if(!g||!y)throw Error(`the Lab has not started yet`);let a=g;S=e,C=[],w(`Preparing the workspace…`,e),a.globals.set(`lab_status`,t=>w(String(t),e));let o=performance.now(),s={};for(let e of r)s[e.name]=e.name===t?n:e.content;try{let n=String(await a.runPythonAsync(`run_project(${JSON.stringify(t)}, ${JSON.stringify(s)}, ${JSON.stringify(JSON.stringify(i??{}))})`,{globals:y})),r;try{r=JSON.parse(n)}catch{r={ok:!1,error:n}}self.postMessage({type:`done`,id:e,ok:r.ok===!0,message:r.error,notice:r.notice,result:r.result??null,logs:C,durationMs:performance.now()-o})}catch(t){self.postMessage({type:`done`,id:e,ok:!1,message:t instanceof Error?t.message:String(t),logs:C,durationMs:performance.now()-o})}finally{S=0}}async function A(e){if(!g||!y)throw Error(`the Lab has not started yet`);let t={};for(let n of e.files)t[n.name]=n.content;try{let n=String(await g.runPythonAsync(`analyze(${JSON.stringify(e.method)}, ${JSON.stringify(e.code)}, ${JSON.stringify(e.path)}, ${JSON.stringify(e.line)}, ${JSON.stringify(e.column)}, ${JSON.stringify(JSON.stringify(t))})`,{globals:y})),r=JSON.parse(n);self.postMessage({type:`analyze-result`,id:e.id,ok:r.ok===!0,error:r.error,data:r.data??null})}catch(t){self.postMessage({type:`analyze-result`,id:e.id,ok:!1,error:t instanceof Error?t.message:String(t)})}}self.onmessage=async e=>{let t=e.data;try{if(t.kind===`init`){await D(t.strategies),T(t.id,t.kind,!0,JSON.stringify({ready:!0}),void 0,{mounted:v});return}if(t.kind!==`lab-warm`&&t.kind!==`run-project`&&t.kind!==`analyze`&&t.kind!==`reset-project`&&(!g||!_))throw Error(`engine is not ready yet`);if(t.kind===`lab-warm`){await O();let e=g,n=`unknown`;if(e)try{n=String(e.runPython(`python_version`,{globals:y??void 0}))}catch{}self.postMessage({type:`ready`,version:n,engine:!0,market:v,warning:x,cache:v}),T(t.id,t.kind,!0,JSON.stringify({ready:!0}));return}if(t.kind===`run-project`){await O(),await k(t.id,t.filename,t.code,t.files,t.settings),T(t.id,t.kind,!0,JSON.stringify({done:!0}));return}if(t.kind===`analyze`){await O(),await A(t),T(t.id,t.kind,!0,JSON.stringify({done:!0}));return}if(t.kind===`reset-project`){let e=g;b&&y&&e&&e.runPython(`reset_project()`,{globals:y}),T(t.id,t.kind,!0,JSON.stringify({ok:!0}));return}if(!g)throw Error(`engine is not ready yet`);if(t.kind===`run`){let e=g.globals.get(`run_strategy`),n=String(e(t.key,t.start,t.end));T(t.id,t.kind,!0,n);return}if(t.kind===`lab-load`){let e=g.globals.get(`load_all_market_data`),n=String(e(t.start,t.end));T(t.id,t.kind,!0,n);return}if(t.kind===`python`){let e=g.globals.get(`run_terminal`),n=String(e(t.code));T(t.id,t.kind,!0,n);return}}catch(e){T(t.id,t.kind??`?`,!1,void 0,e instanceof Error?e.message:String(e))}}})();