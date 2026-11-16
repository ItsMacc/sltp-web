(function(){let e=new Map;function t(){return typeof navigator<`u`&&!!navigator.storage?.getDirectory}function n(){return!t()}async function r(e){try{let t=new Set(e),n=(await c(`WHEELS`)).filter(e=>e.endsWith(`.whl`)&&!t.has(e));return await Promise.all(n.map(e=>u(`WHEELS/${e}`))),n}catch{return[]}}async function i(e){return(await navigator.storage.getDirectory()).getDirectoryHandle(`sltp-market`,{create:e})}async function a(e,t){let n=e.split(`/`).filter(Boolean),r=n.pop(),a=await i(t);for(let e of n)a=await a.getDirectoryHandle(e,{create:t});return{dir:a,name:r}}async function o(t){if(e.has(t))return!0;if(n())return!1;try{let{dir:e,name:n}=await a(t,!1);return await e.getFileHandle(n),!0}catch{return!1}}async function s(t){let r=e.get(t);if(r)return new File([r],t.split(`/`).pop()||t,{type:r.type});if(n())return null;try{let{dir:e,name:n}=await a(t,!1);return(await e.getFileHandle(n)).getFile()}catch{return null}}async function c(t){let r=t.replace(/\/$/,``)+`/`,a=[...e.keys()].filter(e=>e.startsWith(r)).map(e=>e.slice(r.length));if(n())return a;let o=[...a],s=async(e,t)=>{for await(let n of e.values())n.kind===`file`?o.push(t+n.name):n.kind===`directory`&&await s(n,`${t}${n.name}/`)};try{let e=t.split(`/`).filter(Boolean),n=await i(!1);for(let t of e)n=await n.getDirectoryHandle(t);await s(n,``)}catch{}return o}async function l(t,r){if(n()){e.set(t,r);return}let{dir:i,name:o}=await a(t,!0),s=await(await i.getFileHandle(o,{create:!0})).createWritable();try{await s.write(r)}finally{await s.close()}}async function u(t){if(e.delete(t),!n())try{let{dir:e,name:n}=await a(t,!1);await e.removeEntry(n)}catch{}}let d=`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`;async function f(){return(await import(`${d}pyodide.mjs`)).loadPyodide({indexURL:d})}async function p(e,t){let n=await fetch(`https://pypi.org/pypi/${e}/${t}/json`);if(!n.ok)throw Error(`PyPI lookup failed for ${e}==${t} (${n.status})`);let r=await n.json(),i=(r.urls??[]).find(e=>e.filename.endsWith(`.whl`)&&!e.filename.includes(`cp`)&&!e.filename.includes(`pp`))??(r.urls??[]).find(e=>e.filename.endsWith(`.whl`));if(!i)throw Error(`No wheel found for ${e}==${t}`);return{filename:i.filename,url:i.url}}async function m(e,t,n,r){let{filename:i,url:a}=await p(n,r),c=`WHEELS/${i}`,u=!0;if(!await o(c)){u=!1;let e=await fetch(a);if(!e.ok)throw Error(`Wheel download failed for ${i} (${e.status})`);await l(c,new Blob([await e.arrayBuffer()]))}let d=await s(c);if(!d)throw Error(`Wheel vanished after download: ${i}`);return e.FS.writeFile(`/tmp/${i}`,new Uint8Array(await d.arrayBuffer())),await t.install(`emfs:/tmp/${i}`),{cached:u,filename:i}}let h=null,g=!1,_=!1,v=!1;function y(e,t,n,r,i,a){self.postMessage({id:e,kind:t,ok:n,data:r,error:i,...a})}async function b(e){if(g)return _;let t=performance.now(),n=e=>{let n=performance.now();self.postMessage({kind:`progress`,stage:e,ms:Math.round(n-t)}),t=n},i=await f();h=i,n(`python`),await i.loadPackage([`micropip`,`numpy`]),n(`numpy`);try{let e=await(await navigator.storage.getDirectory()).getDirectoryHandle(`sltp-market`,{create:!0});i.FS.mkdirTree(`/home/pyodide/.sltp/cache`),await i.mountNativeFS(`/home/pyodide/.sltp/cache`,e),v=!0}catch{}n(`cache`);let a=i.pyimport(`micropip`),o=await Promise.all([m(i,a,`sltp`,`0.1.38`),m(i,a,`python-dateutil`,`2.9.0`)]);await r(o.map(e=>e.filename)),n(`wheels`),await i.runPythonAsync(`
import json
import time

_STRATEGIES = {}

# Timings for one run: how much of it was reading bars, and how much was the
# day loop itself. Printed in the UI, so a slow phone names its bottleneck
# instead of leaving the reader staring at a spinner.
_IO_STATS = {"io_seconds": 0.0, "io_calls": 0}

def _probe(stage, **detail):
    # JSON string, not a Python object: the page persists it immediately, so
    # the last checkpoint survives a WebKit process kill.
    try:
        from js import postMessage
        postMessage(json.dumps({"kind": "probe", "stage": stage, "detail": json.dumps(detail, default=str)}))
    except Exception:
        pass







def _install_flat_market_reader():
    # sltp 0.1.38 reads market_data_*.parquet only. The bucket now carries
    # self-contained .bin bundles, so patch the bar-file discovery and the
    # history/calendar readers. Actions and the catalog stay parquet.
    import json
    import os
    import re
    import struct
    import numpy as np
    from sltp.data import market_data_service as m

    if getattr(m, "_sltp_flat_reader", False):
        return

    m.CHUNK_PATTERN = re.compile(r"^market_data_(d{4}).bin$")
    m.RECENT_FILE = os.path.join(m.MARKET_DIR, "market_data_recent.bin")

    def _read_bundle(path):
        with open(path, "rb") as handle:
            raw = handle.read()
        magic, fmt, header_len, rows = struct.unpack_from("<8sIIQ", raw, 0)
        if magic != b"SLTPFLAT" or fmt != 1:
            raise RuntimeError(f"not a flat market bundle: {path}")
        header = json.loads(raw[24:24 + header_len])
        if len(raw) != 24 + header_len + rows * 24:
            raise RuntimeError(f"flat bundle length mismatch: {path}")
        base = 24 + header_len
        offsets = header["offsets"]
        dates = np.frombuffer(raw, dtype="<u2", count=rows, offset=base + offsets["date"]).astype(np.int32)
        columns = {
            name: np.frombuffer(raw, dtype="<f4", count=rows, offset=base + offsets[name])
            for name in ("open", "high", "low", "close", "vol")
        }
        return header, dates, columns

    def _read_requested_histories(symbols, files=None, start=None, end=None):
        wanted = list(dict.fromkeys(symbols))
        if not wanted:
            return {}
        file_list = files if files is not None else m.bar_files()
        low = int(m.to_code(start)) if start is not None else 0
        high = int(m.to_code(end)) if end is not None else int(np.iinfo(np.int32).max)
        pieces = {}
        for path in file_list:
            header, dates, columns = _read_bundle(path)
            positions = {symbol: index for index, symbol in enumerate(header["symbols"])}
            for symbol in wanted:
                index = positions.get(symbol)
                if index is None:
                    continue
                first = int(header["starts"][index])
                count = int(header["counts"][index])
                if count <= 0:
                    continue
                lo, hi = m._window_edges(dates[first:first + count], low, high)
                if lo >= hi:
                    continue
                at = slice(first + lo, first + hi)
                pieces.setdefault(symbol, []).append((
                    dates[at], columns["open"][at], columns["high"][at],
                    columns["low"][at], columns["close"][at], columns["vol"][at],
                ))
        return m._finalize_histories(pieces)

    def _read_trading_calendar(files=None):
        file_list = files if files is not None else m.bar_files()
        dates = [_read_bundle(path)[1] for path in file_list]
        codes = np.unique(np.concatenate(dates)) if dates else np.empty(0, dtype=np.int32)
        m.CALENDAR.register(m.labels_from_codes(codes))
        return codes

    def _read_tickers_with_bars():
        names = set()
        for path in m.bar_files():
            names.update(_read_bundle(path)[0]["symbols"])
        return sorted(names)

    def _newest_code_in(path):
        header, _, _ = _read_bundle(path)
        return int(m.to_code(header["last_session"]))

    m._read_requested_histories = _read_requested_histories
    m._read_trading_calendar = _read_trading_calendar
    m._read_tickers_with_bars = _read_tickers_with_bars
    m._newest_code_in = _newest_code_in
    m._sltp_flat_reader = True


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
        _probe("bulk.begin", requested=len(symbols))
        try:
            universe = service.get_all_tickers()
            _probe("bulk.universe", count=len(universe))
            histories = original(universe, start, end)
            _probe("bulk.histories", count=len(histories))
        except Exception as error:
            _probe("bulk.error", error=str(error))
            # The canonical read is an optimisation. If the catalog is
            # unavailable, let the engine take its normal path.
            return original(symbols, start, end)
        result = {symbol: histories[symbol] for symbol in symbols if symbol in histories}
        _probe("bulk.done", returned=len(result))
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

    _probe("run.enter", key=key, start=start, end=end)
    _install_shared_bulk_cache()
    _probe("run.shared-cache.ready")

    # A new date window invalidates the old decoded bars. Release them before
    # the new read instead of waiting for the cache limit to evict them after
    # the new dictionary has already been allocated.
    global _LAST_RUN_WINDOW
    window = (start, end or None)
    if _LAST_RUN_WINDOW != window:
        _probe("run.cache-clear.begin")
        with _market._LOAD_LOCK:
            _market._BULK_CACHE.clear()
            _market.refresh_market_data_cache()
        _LAST_RUN_WINDOW = window
        import gc as _gc
        _gc.collect()
        _probe("run.cache-clear.done")

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
    _probe("run.backtester.begin")
    try:
        result = Backtester(cls(), start, end or None).run()
        _probe("run.backtester.done")
    finally:
        _run_seconds = time.perf_counter() - _started
        _backtester._get_histories = _original_backtester
        if _original_market is not None:
            _market._get_histories = _original_market
    # sltp's curve points carry portfolio_value; accept a bare value too so
    # a point never dies inside to_jsonable with a bare KeyError. Anything
    # else fails loud, naming the keys, the range and the engine version.
    stamp = result.get("stamp") or {}
    _probe("run.equity.begin", points=len(result.get("equity") or []))
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
    _probe("run.serialize.begin")
    text = json.dumps(payload)
    _probe("run.serialize.done", chars=len(text))
    payload = None
    result = None
    import gc as _gc
    _gc.collect()
    _probe("run.done")
    return text


# The lab variable the phone page asks for. It is deliberately exposed in
# the worker globals so later terminal commands can inspect it.
LAB_HISTORIES = {}

def load_all_market_data(start="2022-01-01", end=None, chunk_size=1000):
    from sltp.data import market_data_service as service
    _probe("lab.load.begin", start=start, end=end, chunk=chunk_size)
    universe = service.get_all_tickers()
    _probe("lab.universe", tickers=len(universe))
    # Use the undecorated reader so each 1,000-ticker batch is actually a
    # separate batch instead of the shared-cache wrapper decoding the world.
    reader = getattr(service, "_sltp_original_bulk_histories", service._bulk_histories)
    histories = {}
    started = time.perf_counter()
    for offset in range(0, len(universe), chunk_size):
        batch = universe[offset:offset + chunk_size]
        _probe("lab.chunk.begin", offset=offset, count=len(batch), loaded=len(histories))
        try:
            part = reader(batch, start, end or None)
            histories.update(part)
        except Exception as error:
            _probe("lab.chunk.error", offset=offset, error=str(error))
            continue
        elapsed = time.perf_counter() - started
        _probe(
            "LOADED %d tickers in %.1fs" % (len(histories), elapsed),
            loaded=len(histories),
            seconds=round(elapsed, 1),
            total=len(universe),
        )
    rows = 0
    for frame in histories.values():
        try:
            rows += len(frame)
        except Exception:
            pass
    globals()["LAB_UNIVERSE"] = universe
    globals()["LAB_HISTORIES"] = histories
    _probe("lab.load.done", tickers=len(histories), rows=rows)
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
    # The bucket layout is uppercase (SYMBOL_DATA) while the readers open
    # the lowercase symbol_data directory beside the market dir, so mirror
    # the small metadata files to the names sltp actually opens. Bars and
    # actions already sit where sltp looks (MARKET_DAILY/). Runs at every
    # boot, so a half-written file heals itself on the next visit.
    _install_flat_market_reader()
    import shutil
    from pathlib import Path
    from sltp.data import market_data_service as _mds
    from sltp.data import remote as _remote

    # Self-heal: anything cached without the parquet magic is dropped so
    # the sync below downloads it again.
    for directory in (Path(_remote.CACHE_ROOT) / "MARKET_DAILY", Path(_mds.SYMBOL_DATA_DIR)):
        if directory.is_dir():
            for cached in directory.glob("*.parquet"):
                with open(cached, "rb") as handle:
                    if handle.read(4) != b"PAR1":
                        cached.unlink()
    _remote.sync_catalog()
    _remote.sync_actions()
    src = Path(_remote.CACHE_ROOT) / "SYMBOL_DATA"
    dest = Path(_mds.SYMBOL_DATA_DIR)
    if src.is_dir():
        dest.mkdir(parents=True, exist_ok=True)
        try:
            same = src.resolve() == dest.resolve()
        except OSError:
            same = False
        if not same:
            for child in src.iterdir():
                if child.is_file():
                    try:
                        shutil.copy2(child, dest / child.name)
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
`),n(`engine`),i.globals.get(`enable_browser_fetch`)(),await i.globals.get(`prime_remote_cache`)(),n(`data`);let s=i.globals.get(`register_strategy`);for(let t of e)s(t.key,t.className,t.source);return _=o.every(e=>e.cached),g=!0,_}self.onmessage=async e=>{let t=e.data;try{if(t.kind===`init`){let e=await b(t.strategies);y(t.id,t.kind,!0,JSON.stringify({ready:!0}),void 0,{wheelsCached:e,mounted:v});return}if(!h||!g)throw Error(`engine is not ready yet`);if(t.kind===`run`){let e=h.globals.get(`run_strategy`),n=String(e(t.key,t.start,t.end));y(t.id,t.kind,!0,n);return}if(t.kind===`lab-load`){let e=h.globals.get(`load_all_market_data`),n=String(e(t.start,t.end));y(t.id,t.kind,!0,n);return}if(t.kind===`python`){let e=h.globals.get(`run_terminal`),n=String(e(t.code));y(t.id,t.kind,!0,n);return}}catch(e){y(t.id,t.kind??`?`,!1,void 0,e instanceof Error?e.message:String(e))}}})();