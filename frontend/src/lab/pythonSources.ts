// pythonSources.ts — the Lab's Python program, kept as source text.
//
// It used to live inside the Lab's own worker. The kernel runs one interpreter
// for both pages, so the Lab's program is now executed into its own module
// namespace inside that interpreter instead of booting a second Pyodide. The
// text is unchanged; only where it is executed moved.

export const LAB_BOOTSTRAP = `
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
`;

export const ANALYZER = `
import ast
import enum
import inspect
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


# Typed stubs for the engine, generated from the installed wheel. jedi reads
# them instead of the package source, which is what turns "data." and
# "result." into typed answers rather than an inference over a rectangle of
# Python it has to guess about. They live outside sys.path so a backtest still
# imports the real package.
STUB_ROOT = ANALYZE_ROOT.parent / "stubs"

_STUB_BUILTINS = {
    "Any",
    "None",
    "bool",
    "bytes",
    "dict",
    "float",
    "frozenset",
    "int",
    "list",
    "object",
    "set",
    "str",
    "tuple",
    "type",
}

_STUB_TYPES = {
    "str": "str",
    "int": "int",
    "float": "float",
    "bool": "bool",
    "list": "list[Any]",
    "dict": "dict[str, Any]",
    "tuple": "tuple[Any, ...]",
    "NoneType": "None",
}


_STUB_NAMES = {
    "Annotated",
    "Any",
    "Callable",
    "ClassVar",
    "Dict",
    "False",
    "Final",
    "FrozenSet",
    "Iterable",
    "Iterator",
    "List",
    "Literal",
    "Mapping",
    "None",
    "Optional",
    "Sequence",
    "Set",
    "True",
    "Tuple",
    "Type",
    "Union",
}


def _stub_tokens(text):
    """The parts of an annotation expression, or None when it is not one."""
    tokens = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == '"' or char == "'":
            close = text.find(char, index + 1)
            if close < 0:
                return None
            tokens.append(("literal", text[index:close + 1]))
            index = close + 1
            continue
        if char.isalpha() or char == "_":
            start = index
            while index < len(text) and (text[index].isalnum() or text[index] == "_"):
                index += 1
            word = text[start:index]
            # A dotted name keeps its last part: the stub defines the class, not
            # the module path the class was reached through.
            while (
                index < len(text)
                and text[index] == "."
                and index + 1 < len(text)
                and (text[index + 1].isalpha() or text[index + 1] == "_")
            ):
                index += 1
                start = index
                while index < len(text) and (text[index].isalnum() or text[index] == "_"):
                    index += 1
                word = text[start:index]
            tokens.append(("name", word))
            continue
        if char.isdigit():
            start = index
            while index < len(text) and (text[index].isdigit() or text[index] == "."):
                index += 1
            tokens.append(("literal", text[start:index]))
            continue
        if char == ".":
            start = index
            while index < len(text) and text[index] == ".":
                index += 1
            tokens.append(("literal", text[start:index]))
            continue
        if char in " [](),|":
            tokens.append(("mark", char))
            index += 1
            continue
        return None
    return tokens


def _stub_expression(text, known):
    """Rewrites an annotation, keeping every part the stub is able to name."""
    tokens = _stub_tokens(text)
    if not tokens:
        return "Any"
    out = []
    index = 0
    while index < len(tokens):
        kind, value = tokens[index]
        if kind != "name":
            out.append(value)
            index += 1
            continue
        look = index + 1
        while look < len(tokens) and tokens[look] == ("mark", " "):
            look += 1
        subscripted = look < len(tokens) and tokens[look] == ("mark", "[")
        if value in _STUB_TYPES and not subscripted:
            # 'list' on its own holds anything; 'list[int]' keeps its own element
            # type rather than turning into 'list[Any][int]'.
            out.append(_STUB_TYPES[value])
        elif subscripted and (value in _STUB_TYPES or value in _STUB_BUILTINS):
            out.append(value)
        elif value in _STUB_NAMES or value in _STUB_BUILTINS or value in known:
            out.append(value)
        else:
            # An unknown base takes its subscript with it: 'Any[str]' is not an
            # annotation, and a stub that will not parse helps nobody.
            out.append("Any")
            skip = index + 1
            while skip < len(tokens) and tokens[skip] == ("mark", " "):
                skip += 1
            if skip < len(tokens) and tokens[skip] == ("mark", "["):
                depth = 0
                while skip < len(tokens):
                    if tokens[skip] == ("mark", "["):
                        depth += 1
                    elif tokens[skip] == ("mark", "]"):
                        depth -= 1
                        if depth == 0:
                            skip += 1
                            break
                    skip += 1
            index = skip
            continue
        index += 1
    return "".join(out).strip()


def _stub_annotation(annotation, known):
    """A stub-safe annotation, keeping everything this stub can name.

    The editor shows these verbatim, so a Literal's choices and a list's element
    type are the whole point: they are where a reader learns that an argument
    takes "long" or "short" rather than any string. What cannot be named here
    still becomes Any, but whole -- never left half-written, because 'Any[str]'
    does not parse and a stub that does not parse is worse than none.
    """
    if annotation is inspect.Signature.empty:
        return "Any"
    if annotation is None:
        return "None"
    name = getattr(annotation, "__name__", None)
    # A parameterised alias ('list[int]') is a type as well, but its parameters
    # are the answer; only a bare class is named by its own name alone.
    if isinstance(annotation, type) and not getattr(annotation, "__args__", None):
        if name in _STUB_TYPES:
            return _STUB_TYPES[name]
        if name in known:
            return name
    text = str(annotation).replace("typing.", "")
    if text.startswith("<class '") and text.endswith("'>"):
        text = text[8:-2]
    expression = _stub_expression(text, known)
    try:
        ast.parse(expression, mode="eval")
    except SyntaxError:
        return "Any"
    return expression


def _stub_default(value):
    """The default as a reader would type it, or None when there is none.

    A parameter popup is read for its defaults: 'period=...' withholds the one
    fact the reader came for, while 'period=252' answers it. Only small literals
    and enum members are reproduced -- anything else keeps the placeholder,
    because a repr like a bare object address is noise that also lies.
    """
    if value is inspect.Parameter.empty:
        return None
    if value is None or isinstance(value, (bool, int, float, str, bytes)):
        text = repr(value)
        return text if len(text) <= 32 else "..."
    if isinstance(value, enum.Enum):
        return f"{type(value).__name__}.{value.name}"
    if isinstance(value, tuple) and 0 < len(value) <= 4:
        parts = []
        for item in value:
            rendered = _stub_default(item)
            if rendered is None or rendered == "...":
                return "..."
            parts.append(rendered)
        return "(" + ", ".join(parts) + ("," if len(parts) == 1 else "") + ")"
    return "..."


def _stub_signature(function, method=False, known=frozenset()):
    """The parameter list plus return type, written the way a stub wants it."""
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):
        return None
    parts = ["self"] if method else []
    # '*args' already marks the split; without a mark, a keyword-only parameter
    # would be offered positionally in the popup and then rejected by the call.
    saw_split = False
    for parameter in signature.parameters.values():
        if parameter.kind is parameter.KEYWORD_ONLY and not saw_split:
            parts.append("*")
            saw_split = True
        rendered = parameter.name
        if parameter.kind is parameter.VAR_POSITIONAL:
            rendered = "*" + rendered
            saw_split = True
        elif parameter.kind is parameter.VAR_KEYWORD:
            rendered = "**" + rendered
        if parameter.annotation is not inspect.Parameter.empty:
            rendered += ": " + _stub_annotation(parameter.annotation, known)
        default = _stub_default(parameter.default)
        if default is not None:
            rendered += " = " + default
        parts.append(rendered)
    returns = ""
    if signature.return_annotation is not inspect.Signature.empty:
        returns = " -> " + _stub_annotation(signature.return_annotation, known)
    return "(" + ", ".join(parts) + ")" + returns


def _stub_source(package):
    """One stub module for the package: classes, attributes, methods, constants."""
    lines = [
        "from typing import (Annotated, Any, Callable, ClassVar, Dict, Final,",
        "                    FrozenSet, Iterable, Iterator, List, Literal, Mapping,",
        "                    Optional, Sequence, Set, Tuple, Type, Union)",
        "",
        "",
    ]

    # sltp resolves its public names lazily, so dir() and getmembers() see an
    # almost empty package. __all__ plus getattr is the surface it publishes.
    names = {name for name, _ in inspect.getmembers(package) if not name.startswith("_")}
    names.update(name for name in (getattr(package, "__all__", None) or []) if not name.startswith("__"))
    values = {}
    for candidate in sorted(names):
        try:
            values[candidate] = getattr(package, candidate)
        except Exception:  # noqa: BLE001 - a lazy name that will not load
            continue
    known = {name for name, value in values.items() if inspect.isclass(value)}

    def emit_class(name, cls):
        body = []
        seen = set()
        for attribute, annotation in (getattr(cls, "__annotations__", None) or {}).items():
            body.append(f"    {attribute}: {_stub_annotation(annotation, known)}")
            seen.add(attribute)
        try:
            properties = inspect.getmembers(cls, lambda member: isinstance(member, property))
        except Exception:  # noqa: BLE001 - a broken descriptor is not fatal
            properties = []
        for attribute, prop in properties:
            if attribute.startswith("_") or attribute in seen:
                continue
            fget = prop.fget
            annotation = getattr(fget, "__annotations__", {}).get("return")
            body.append(f"    {attribute}: {_stub_annotation(annotation, known)}")
            seen.add(attribute)
        try:
            members = inspect.getmembers(cls, inspect.isfunction)
        except Exception:  # noqa: BLE001
            members = []
        for member, function in members:
            if member.startswith("_") or member in seen:
                continue
            body.append(
                f"    def {member}{_stub_signature(function, known=known) or '(self, *args, **kwargs)'}: ..."
            )
            seen.add(member)
        try:
            instance = cls()
        except Exception:  # noqa: BLE001 - not every class is constructible
            instance = None
        if instance is not None:
            for member in dir(instance):
                if member.startswith("_") or member in seen:
                    continue
                try:
                    value = getattr(instance, member)
                except Exception:  # noqa: BLE001
                    continue
                if callable(value):
                    text = _stub_signature(value, method=True, known=known)
                    body.append(f"    def {member}{text or '(self, *args, **kwargs)'}: ...")
                else:
                    body.append(f"    {member}: {_stub_annotation(type(value), known)}")
                seen.add(member)
        lines.append(f"class {name}:")
        lines.extend(body or ["    ..."])
        lines.append("")

    for name, value in values.items():
        if inspect.ismodule(value):
            continue
        if inspect.isclass(value):
            emit_class(name, value)
        elif inspect.isfunction(value):
            lines.append(f"def {name}{_stub_signature(value, known=known) or '(*args, **kwargs)'}: ...")
            lines.append("")
        elif not callable(value):
            lines.append(f"{name}: {_stub_annotation(type(value), known)}")
            lines.append("")
    return "\\n".join(lines) + "\\n"


def write_stubs():
    """Writes the engine's stubs once per session, and never fails a completion."""
    import ast

    target = STUB_ROOT / "sltp" / "__init__.pyi"
    if target.exists():
        return True
    try:
        import sltp

        source = _stub_source(sltp)
        ast.parse(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source, encoding="utf-8")
        return True
    except Exception:  # noqa: BLE001 - jedi falls back to reading the package
        return False


def symbol_index():
    """The engine's public surface, for completions the editor can answer alone.

    Built from the installed package, not from a list typed into the frontend:
    a release that adds a knob or renames one appears in the completion popup
    with no site change and no second copy to keep in sync.
    """
    import importlib

    import sltp
    import sltp.graphs
    import sltp.utils
    import sltp.web

    def public(obj):
        return sorted({name for name in dir(obj) if not name.startswith("__")})

    def submodules(package):
        # The market package is not lazy, but only the submodules that import
        # are worth offering: a completion list is a promise the name works.
        names = []
        for name in package.__all__ if hasattr(package, "__all__") else ():
            names.append(name)
        for name in ("catalog", "fx", "index", "layout", "market_data", "remote", "service"):
            try:
                importlib.import_module(f"{package.__name__}.{name}")
            except Exception:  # noqa: BLE001 - an absent submodule is not an error
                continue
            names.append(name)
        return sorted(set(names))

    try:
        # The knobs and helpers are instance state as often as class members,
        # so an instance is part of the answer.
        strategy = sorted(set(public(sltp.Strategy)) | set(public(sltp.Strategy())))
    except Exception:  # noqa: BLE001 - the class alone is still worth having
        strategy = public(sltp.Strategy)

    # Naming a method in a subclass is a request to override one; only the
    # engine's own functions are candidates for that.
    strategy_methods = sorted(
        name
        for name, member in inspect.getmembers(sltp.Strategy, inspect.isfunction)
        if not name.startswith("_")
    )

    import sltp.market

    write_stubs()

    index = {
        "sltp": sorted(
            set(getattr(sltp, "__all__", None) or public(sltp))
            | {"market", "graphs", "utils", "web"}
        ),
        "Strategy": [name for name in strategy if not name.startswith("__")],
        "Strategy.methods": strategy_methods,
        "StockData": public(sltp.StockData),
        "Trade": sorted(sltp.Trade.__dataclass_fields__),
        "Order": sorted(sltp.Order.__dataclass_fields__),
        "OrderSizing": [member.name for member in sltp.OrderSizing],
        "PositionType": [member.name for member in sltp.PositionType],
        "RebalanceFrequency": [member.name for member in sltp.RebalanceFrequency],
        "EventType": [member.name for member in sltp.EventType],
        "sltp.web": public(sltp.web),
        "sltp.utils": public(sltp.utils),
        "sltp.market": submodules(sltp.market),
        "sltp.graphs": public(sltp.graphs),
    }
    for name in ("Backtester", "PortfolioManager", "Event"):
        held = getattr(sltp, name, None)
        if held is not None:
            try:
                index[name] = public(held)
            except Exception:  # noqa: BLE001 - optional surface
                continue
    return index


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

    if method == "symbols":
        try:
            return json.dumps({"ok": True, "data": symbol_index()})
        except Exception as exc:  # noqa: BLE001 - the popup falls back to keywords
            return json.dumps({"ok": False, "error": str(exc)})

    try:
        import jedi
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "error": "jedi is unavailable: " + str(exc)})

    try:
        added = []
        if (STUB_ROOT / "sltp" / "__init__.pyi").exists():
            added.append(str(STUB_ROOT))
        try:
            project = jedi.Project(root, added_sys_path=added)
        except TypeError:  # older jedi has no added_sys_path
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
`;
