# health.py — one function per outside dependency.
#
# The operator brief is the first caller, but every check here is a plain
# function returning a Check, so a script, a route or a scheduled gate can call
# one dependency without collecting the rest:
#
#   from app.health import check_turso, check_market_data
#   if not check_market_data().ok: ...
#
# Each check catches its own failure and returns ok=False with the reason, so a
# report is always produced even when a provider is down. Nothing here sends
# mail or writes data.

# -------- Imports --------
import json
import os
import smtplib
import time
import urllib.request

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import requests

from app import config  # noqa: F401  (loads the repo-root .env)
from app.notify.mailer import smtp_settings
from app.turso.client import execute


# -------- Configuration --------
SITE_URL: str = os.environ.get("PUBLIC_SITE_URL", "https://sltp-app.com")
API_URL: str = os.environ.get("PUBLIC_API_URL", "https://sltp-web.onrender.com").rstrip("/")
DATA_URL: str = os.environ.get("SLTP_DATA_URL", "https://data.sltp-app.com").rstrip("/")
R2_BUCKET: str = os.environ.get("R2_BUCKET", "sltp-market-data")

HTTP_TIMEOUT: int = 15
# Render free spins down; a cold wake has taken over 30 seconds here.
BACKEND_TIMEOUT: int = 60

# Free-plan limits (override with env vars when a plan changes).
TURSO_STORAGE_LIMIT_MB: int = int(os.environ.get("TURSO_STORAGE_LIMIT_MB", "9216"))
BREVO_DAILY_LIMIT: int = int(os.environ.get("BREVO_DAILY_LIMIT", "300"))
BREVO_MONTHLY_LIMIT: int = int(os.environ.get("BREVO_MONTHLY_LIMIT", "9000"))

R2_CLASS_A_LIMIT: int = 1_000_000
R2_CLASS_B_LIMIT: int = 10_000_000
R2_BILLING_RESET_DAY: int = 6  # SLTP's Cloudflare cycle resets on the 6th
R2_CLASS_A = {
    "listbuckets", "putbucket", "listobjects", "putobject", "copyobject",
    "completemultipartupload", "createmultipartupload",
    "lifecyclestoragetiertransition", "listmultipartuploads", "uploadpart",
    "uploadpartcopy", "listparts", "putbucketencryption", "putbucketcors",
    "putbucketlifecycleconfiguration",
}
R2_CLASS_B = {
    "headbucket", "headobject", "getobject", "usagesummary",
    "getbucketencryption", "getbucketlocation", "getbucketcors",
    "getbucketlifecycleconfiguration",
}


# -------- Result shape --------
@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    metrics: dict[str, Any] = field(default_factory=dict)


def _result(name: str, ok: bool, detail: str, **metrics: Any) -> Check:
    return Check(name=name, ok=ok, detail=detail, metrics=metrics)


def _pct(used: int | float, limit: int | float) -> float:
    return round((used / limit) * 100, 2) if limit else 0.0


# -------- Website & API --------
def _get(url: str, timeout: int = HTTP_TIMEOUT, headers: dict[str, str] | None = None) -> tuple[int, float, str]:
    started = time.perf_counter()
    response = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
    return response.status_code, round((time.perf_counter() - started) * 1000, 1), response.text


def check_website() -> Check:
    try:
        status, ms, _ = _get(SITE_URL)
    except Exception as exc:  # noqa: BLE001 - a report must survive a dead host
        return _result("website", False, f"{SITE_URL} unreachable: {exc}")
    ok = status == 200
    return _result("website", ok, f"{status} in {ms:.0f} ms", status=status, latency_ms=ms, url=SITE_URL)


def check_backend() -> Check:
    try:
        status, ms, _ = _get(f"{API_URL}/", timeout=BACKEND_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        return _result("backend", False, f"{API_URL} unreachable: {exc}")
    ok = status == 200
    cold = " (cold start)" if ms > 5000 else ""
    return _result("backend", ok, f"{status} in {ms / 1000:.1f} s{cold}", status=status, latency_ms=ms, url=API_URL)


# -------- Supabase --------
def check_supabase() -> Check:
    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
        return _result("supabase", False, "SUPABASE_URL or SUPABASE_SERVICE_ROLE missing")
    try:
        status, ms, body = _get(
            f"{config.SUPABASE_URL}/auth/v1/health",
            headers=config.service_headers(),
        )
    except Exception as exc:  # noqa: BLE001
        return _result("supabase", False, f"health check failed: {exc}")
    ok = status == 200
    version = ""
    try:
        version = json.loads(body).get("version", "")
    except Exception:  # noqa: BLE001
        pass
    detail = f"{status} in {ms:.0f} ms" + (f" · GoTrue {version}" if version else "")
    return _result("supabase", ok, detail, status=status, latency_ms=ms, version=version)


# -------- Turso --------
def check_turso() -> Check:
    if not config.TURSO_URL or not config.TURSO_TOKEN:
        return _result("turso", False, "TURSO_DATABASE_URL or TURSO_AUTH_TOKEN missing")
    try:
        started = time.perf_counter()
        execute("SELECT 1 AS ok")
        latency = round((time.perf_counter() - started) * 1000, 1)

        storage_mb: float | None = None
        try:
            pages = execute("PRAGMA page_count")[0]["page_count"]
            size = execute("PRAGMA page_size")[0]["page_size"]
            storage_mb = round((pages * size) / (1024 * 1024), 2)
        except Exception:  # noqa: BLE001 - size is a bonus, not the check
            pass
    except Exception as exc:  # noqa: BLE001
        return _result("turso", False, f"query failed: {exc}")

    if storage_mb is None:
        detail = f"connected in {latency:.0f} ms"
    else:
        detail = f"{storage_mb:.1f} MB / {TURSO_STORAGE_LIMIT_MB / 1024:.1f} GB · {latency:.0f} ms"
    return _result(
        "turso", True, detail,
        latency_ms=latency,
        storage_mb=storage_mb,
        storage_limit_mb=TURSO_STORAGE_LIMIT_MB,
        storage_pct=_pct(storage_mb or 0, TURSO_STORAGE_LIMIT_MB),
    )


# -------- Market data --------
# The bucket serves the bytes itself, so there is no gate counter to read. What
# is worth reporting is what a reader actually gets: the published version, the
# newest session, and whether every bundle market is still there.
def check_market_data() -> Check:
    try:
        status, ms, body = _get(f"{DATA_URL}/META/manifest.json")
        payload = json.loads(body)
    except Exception as exc:  # noqa: BLE001
        return _result("market_data", False, f"manifest failed: {exc}")

    files = payload.get("files") or []
    bundles = [entry for entry in files if str(entry.get("key", "")).endswith(".bin")]
    markets = sorted({
        str(entry["key"]).split("/")[2]
        for entry in bundles
        if str(entry["key"]).count("/") >= 3
    })
    latest = max((str(entry.get("last_session") or "") for entry in bundles), default="")
    ok = status == 200 and bool(bundles) and len(markets) >= 2
    detail = (
        f"{len(bundles)} bundles · {', '.join(markets) or 'no markets'}"
        f" · latest {latest or '?'} · version {payload.get('version', '?')}"
    )
    return _result(
        "market_data", ok, detail,
        status=status,
        latency_ms=ms,
        version=payload.get("version"),
        bundles=len(bundles),
        markets=",".join(markets),
        latest_session=latest,
    )


# -------- R2 --------
R2_QUERY = """
query ($accountTag: String!, $startDate: Time, $endDate: Time, $bucketName: String) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $startDate, datetime_leq: $endDate, bucketName: $bucketName }
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}
"""


def _billing_window() -> tuple[datetime, datetime]:
    end = datetime.now(timezone.utc)
    if end.day >= R2_BILLING_RESET_DAY:
        start = end.replace(day=R2_BILLING_RESET_DAY, hour=0, minute=0, second=0, microsecond=0)
    else:
        previous = end.replace(day=1) - timedelta(days=1)
        start = previous.replace(day=R2_BILLING_RESET_DAY, hour=0, minute=0, second=0, microsecond=0)
    return start, end


def r2_operation_counts(bucket: str | None = None) -> dict[str, Any]:
    bucket = bucket or R2_BUCKET
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account_id:
        raise RuntimeError("Missing CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID")

    start, end = _billing_window()
    payload = {
        "query": R2_QUERY,
        "variables": {
            "accountTag": account_id,
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "bucketName": bucket,
        },
    }
    request = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = json.loads(response.read().decode())
    if body.get("errors"):
        raise RuntimeError(json.dumps(body["errors"]))

    groups = body["data"]["viewer"]["accounts"][0]["r2OperationsAdaptiveGroups"]
    class_a = class_b = 0
    for group in groups:
        action = "".join(c for c in group["dimensions"]["actionType"].lower() if c.isalnum())
        count = group["sum"]["requests"]
        if action in R2_CLASS_A:
            class_a += count
        elif action in R2_CLASS_B:
            class_b += count
    return {"class_a": class_a, "class_b": class_b, "since": start.date().isoformat(), "bucket": bucket}


def check_r2() -> Check:
    try:
        usage = r2_operation_counts()
    except Exception as exc:  # noqa: BLE001 - missing creds is a valid report line
        return _result("r2", False, str(exc))

    class_a, class_b = usage["class_a"], usage["class_b"]
    detail = (
        f"A {class_a:,} / {R2_CLASS_A_LIMIT:,} · B {class_b:,} / {R2_CLASS_B_LIMIT:,}"
        f" · since {usage['since']}"
    )
    return _result(
        "r2", True, detail,
        class_a=class_a, class_a_limit=R2_CLASS_A_LIMIT, class_a_pct=_pct(class_a, R2_CLASS_A_LIMIT),
        class_b=class_b, class_b_limit=R2_CLASS_B_LIMIT, class_b_pct=_pct(class_b, R2_CLASS_B_LIMIT),
        since=usage["since"], bucket=usage["bucket"],
    )


# -------- Brevo --------
def check_brevo() -> Check:
    settings = smtp_settings()
    if settings is None:
        return _result("brevo", False, "SMTP_HOST, SMTP_USER or SMTP_PASS missing",
                       daily_limit=BREVO_DAILY_LIMIT, monthly_limit=BREVO_MONTHLY_LIMIT)

    host, port, user, password = settings
    try:
        started = time.perf_counter()
        with smtplib.SMTP(host, port, timeout=10) as server:
            server.starttls()
            server.login(user, password)
        latency = round((time.perf_counter() - started) * 1000, 1)
    except Exception as exc:  # noqa: BLE001
        return _result("brevo", False, f"SMTP login failed: {exc}",
                       daily_limit=BREVO_DAILY_LIMIT, monthly_limit=BREVO_MONTHLY_LIMIT)

    plan = ""
    credits: int | None = None
    api_key = os.environ.get("BREVO_API_KEY")
    if api_key:
        try:
            response = requests.get(
                "https://api.brevo.com/v3/account",
                headers={"api-key": api_key, "accept": "application/json"},
                timeout=HTTP_TIMEOUT,
            )
            if response.ok:
                account = response.json()
                first = (account.get("plan") or [{}])[0]
                plan = str(first.get("type") or "")
                credits = first.get("credits")
        except Exception:  # noqa: BLE001 - SMTP already proved the account works
            pass

    detail = f"SMTP login ok · {BREVO_DAILY_LIMIT}/day cap"
    if plan:
        detail += f" · plan {plan}"
    if credits is not None:
        detail += f" · {credits} credits left"
    else:
        detail += " · usage needs BREVO_API_KEY"
    return _result(
        "brevo", True, detail,
        latency_ms=latency,
        daily_limit=BREVO_DAILY_LIMIT,
        monthly_limit=BREVO_MONTHLY_LIMIT,
        plan=plan or None,
        credits=credits,
        usage_known=credits is not None,
    )


# -------- Collection --------
CHECKS: tuple[tuple[str, Callable[[], Check]], ...] = (
    ("website", check_website),
    ("backend", check_backend),
    ("supabase", check_supabase),
    ("turso", check_turso),
    ("market_data", check_market_data),
    ("r2", check_r2),
    ("brevo", check_brevo),
)


def collect_health(names: list[str] | None = None) -> list[dict[str, Any]]:
    """Run every check (or the named subset) and never raise."""
    wanted = set(names) if names else None
    results: list[dict[str, Any]] = []
    for name, check in CHECKS:
        if wanted is not None and name not in wanted:
            continue
        try:
            result = check()
        except Exception as exc:  # noqa: BLE001
            result = _result(name, False, f"{type(exc).__name__}: {exc}")
        results.append(asdict(result))
    return results


def overall_ok(results: list[dict[str, Any]] | None = None) -> bool:
    return all(item.get("ok") for item in (results if results is not None else collect_health()))


if __name__ == "__main__":
    print(json.dumps(collect_health(), indent=2))
