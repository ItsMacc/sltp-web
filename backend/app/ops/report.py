# report.py — the daily operator brief, as data.
#
# One builder, two readers: the scheduled script mails it, and Settings shows it
# to an admin. Keeping the assembly here means the email and the page can never
# disagree about what the numbers are.
#
# Accounts come from Supabase auth, the authoritative signup record, which exists
# before a person ever opens the app. Usage comes from the app tables, written on
# first sign-in and again when the setup wizard completes. The gate counters come
# from the market-data Worker, which is the only place they exist.

# -------- Imports --------
import os

from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from app.config import (
    GATEWAY_URL,
    SUPABASE_SERVICE_KEY,
    SUPABASE_TIMEOUT,
    SUPABASE_URL,
    service_headers,
)
from app.health import collect_health
from app.turso import userdata
from app.users import store

SUPABASE_PAGE_SIZE: int = 1000

# Cloudflare's analytics API. Optional on purpose: the brief still answers every
# question it can without it, and says the storage line is unavailable rather
# than printing a zero that looks like "nothing is stored".
CLOUDFLARE_API_TOKEN: str = os.environ.get("CLOUDFLARE_API_TOKEN", "")
CLOUDFLARE_ACCOUNT_ID: str = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
CLOUDFLARE_GRAPHQL: str = "https://api.cloudflare.com/client/v4/graphql"

# The bucket the gateway writes market data into (gateway/wrangler.jsonc).
R2_BUCKET_NAME: str = os.environ.get("R2_BUCKET_NAME", "sltp-market-data")
# The Worker that serves it.
WORKER_NAME: str = os.environ.get("GATEWAY_WORKER_NAME", "sltp-data")


# -------- Accounts (Supabase auth) --------
# Every auth account, one page at a time. Paging matters: per_page caps at 1000
# and the endpoint silently returns the first page again if never advanced.
def fetch_auth_accounts() -> list[dict[str, Any]]:
    if not SUPABASE_SERVICE_KEY:
        raise RuntimeError("SUPABASE_SERVICE_ROLE is required to read the account list.")

    headers = service_headers()
    accounts: list[dict[str, Any]] = []
    page: int = 1
    while True:
        response = requests.get(
            f"{SUPABASE_URL}/auth/v1/admin/users",
            params={"page": page, "per_page": SUPABASE_PAGE_SIZE},
            headers=headers,
            timeout=SUPABASE_TIMEOUT,
        )
        response.raise_for_status()
        body = response.json()

        # Newer GoTrue wraps the list; older builds return a bare array
        batch = body.get("users") if isinstance(body, dict) else body
        if not isinstance(batch, list) or not batch:
            break
        accounts.extend(batch)
        if len(batch) < SUPABASE_PAGE_SIZE:
            break
        page += 1
    return accounts


# Parse an ISO timestamp, tolerating the formats GoTrue emits.
def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


# Count signups by age and accounts by last activity.
def summarize_accounts(accounts: list[dict[str, Any]], now: datetime) -> dict[str, int]:
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    summary: dict[str, int] = {
        "total": len(accounts),
        "new_7d": 0,
        "new_30d": 0,
        "never_signed_in": 0,
        "active_7d": 0,
        "active_30d": 0,
    }
    for account in accounts:
        created = _parse_time(account.get("created_at"))
        if created is not None:
            if created >= week_ago:
                summary["new_7d"] += 1
            if created >= month_ago:
                summary["new_30d"] += 1

        # last_sign_in_at is null until the person completes a first sign-in
        last_seen = _parse_time(account.get("last_sign_in_at"))
        if last_seen is None:
            summary["never_signed_in"] += 1
            continue
        if last_seen >= week_ago:
            summary["active_7d"] += 1
        if last_seen >= month_ago:
            summary["active_30d"] += 1
    return summary


# -------- Report assembly --------
# How many users follow each strategy, most followed first.
def followed_strategies() -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for preferences in userdata.all_portfolio_preferences():
        if not isinstance(preferences, dict):
            continue
        for item in preferences.get("followedStrategies") or []:
            strategy_id = item.get("id") if isinstance(item, dict) else item
            if isinstance(strategy_id, str) and strategy_id:
                counts[strategy_id] = counts.get(strategy_id, 0) + 1
    return sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))


# Deletions from the churn log, with the 30-day count.
def deletion_summary(now: datetime) -> dict[str, Any]:
    month_ago = now - timedelta(days=30)
    rows = store.list_account_deletions()
    recent = 0
    for row in rows:
        deleted_at = _parse_time(row.get("deleted_at"))
        if deleted_at is not None and deleted_at >= month_ago:
            recent += 1
    return {"total": len(rows), "recent_30d": recent}


# Usage blends both stores: identity in Supabase, everything bulky in Turso.
def usage_summary() -> dict[str, Any]:
    usage: dict[str, Any] = dict(store.usage_counts())
    usage["onboarded"] = userdata.count_portfolios_onboarded()
    usage["api_keys"] = userdata.count_api_keys()
    # Recorded per account row, so the brief can say how many are on each tier
    # before any of them have paid for anything.
    usage["tiers"] = store.tier_counts()
    return usage


# -------- Market gate --------
# How many downloads the month refused, and who they were. The gate is the only
# place these exist: the browser never reports back, so the counter it keeps is
# the whole record. Missing or unreachable gate reads as None ("unknown"), never
# as zero, so a quiet line cannot be mistaken for a quiet month.
def fetch_gate_status() -> dict[str, Any] | None:
    try:
        response = requests.get(f"{GATEWAY_URL}/__gate/status", timeout=SUPABASE_TIMEOUT)
        response.raise_for_status()
        body = response.json()
        return body if isinstance(body, dict) else None
    except (requests.RequestException, ValueError):
        return None


# The refused counts, named the way the operator thinks about them.
def refused_summary(gate: dict[str, Any] | None) -> dict[str, Any] | None:
    if not gate:
        return None
    refused = gate.get("refused") or {}
    return {
        "fresh_new": refused.get("freshNew"),
        "cache_cleared": refused.get("cacheCleared"),
        "returning": refused.get("returning"),
        "requests": refused.get("requests"),
        "total": sum(v for v in refused.values() if isinstance(v, int)),
    }


# -------- Cloudflare usage (optional) --------
# Storage and Worker requests live in Cloudflare's analytics API, which needs a
# read token. Without one this answers {"configured": false} and the page says so:
# an invented zero would read as "nothing stored", which is a different and much
# worse claim than "not measured".
def _graphql(query: str) -> dict[str, Any]:
    response = requests.post(
        CLOUDFLARE_GRAPHQL,
        headers={"Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}"},
        json={"query": query},
        timeout=SUPABASE_TIMEOUT,
    )
    response.raise_for_status()
    body = response.json()
    if body.get("errors"):
        first = body["errors"][0]
        raise RuntimeError(str(first.get("message") or first))
    return body.get("data") or {}


def cloudflare_usage() -> dict[str, Any]:
    if not CLOUDFLARE_API_TOKEN or not CLOUDFLARE_ACCOUNT_ID:
        return {"configured": False}

    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(days=1)
    since = day_ago.strftime("%Y-%m-%dT%H:%M:%SZ")
    until = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    storage_query = f"""{{
      viewer {{ accounts(filter: {{accountTag: "{CLOUDFLARE_ACCOUNT_ID}"}}) {{
        r2StorageAdaptiveGroups(
          limit: 1
          filter: {{date_geq: "{day_ago.date().isoformat()}", bucketName: "{R2_BUCKET_NAME}"}}
          orderBy: [date_DESC]
        ) {{ max {{ payloadSize objectCount metadataSize }} dimensions {{ date bucketName }} }}
      }} }}
    }}"""
    worker_query = f"""{{
      viewer {{ accounts(filter: {{accountTag: "{CLOUDFLARE_ACCOUNT_ID}"}}) {{
        workersInvocationsAdaptive(
          limit: 100
          filter: {{datetime_geq: "{since}", datetime_leq: "{until}", scriptName: "{WORKER_NAME}"}}
        ) {{ sum {{ requests errors subrequests }} dimensions {{ datetime scriptName }} }}
      }} }}
    }}"""

    report: dict[str, Any] = {"configured": True, "r2": None, "worker": None, "error": None}
    try:
        storage = _graphql(storage_query)
        groups = (
            storage.get("viewer", {}).get("accounts", [{}])[0].get("r2StorageAdaptiveGroups") or []
        )
        if groups:
            sizes = groups[0].get("max") or {}
            report["r2"] = {
                "payload_bytes": sizes.get("payloadSize"),
                "metadata_bytes": sizes.get("metadataSize"),
                "objects": sizes.get("objectCount"),
                "date": (groups[0].get("dimensions") or {}).get("date"),
            }
    except (requests.RequestException, RuntimeError, ValueError, KeyError, IndexError) as err:
        report["error"] = f"R2: {err}"

    try:
        worker = _graphql(worker_query)
        rows = worker.get("viewer", {}).get("accounts", [{}])[0].get("workersInvocationsAdaptive") or []
        totals = {"requests": 0, "errors": 0, "subrequests": 0}
        for row in rows:
            sums = row.get("sum") or {}
            for key in totals:
                value = sums.get(key)
                if isinstance(value, (int, float)):
                    totals[key] += int(value)
        report["worker"] = totals if rows else None
    except (requests.RequestException, RuntimeError, ValueError, KeyError, IndexError) as err:
        report["error"] = (report["error"] + " · " if report["error"] else "") + f"Worker: {err}"

    return report


# -------- Assembly --------
def build_report() -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    accounts = fetch_auth_accounts()
    gate = fetch_gate_status()
    return {
        "date": now.date().isoformat(),
        "generated_at": now.isoformat(),
        "accounts": summarize_accounts(accounts, now),
        "usage": usage_summary(),
        "deletions": deletion_summary(now),
        "followed_strategies": followed_strategies(),
        "health": collect_health(),
        "gate": gate,
        "refused": refused_summary(gate),
        "cloudflare": cloudflare_usage(),
    }


# -------- Presentation --------
def format_text(report: dict[str, Any]) -> str:
    accounts = report.get("accounts", {})
    usage = report.get("usage", {})
    deletions = report.get("deletions", {})

    def val(v: Any) -> str:
        return str(v) if v is not None else "unknown (table missing?)"

    lines = [
        f"SLTP operator brief — {report.get('date')}",
        "",
        "Accounts (Supabase auth)",
        f"  total:            {val(accounts.get('total'))}",
        f"  new in 7 days:    {val(accounts.get('new_7d'))}",
        f"  new in 30 days:   {val(accounts.get('new_30d'))}",
        f"  never signed in:  {val(accounts.get('never_signed_in'))}",
        f"  active in 7 days: {val(accounts.get('active_7d'))}",
        f"  active in 30 days:{val(accounts.get('active_30d'))}",
        "",
        "Usage (app tables)",
        f"  profiles:         {val(usage.get('profiles'))}",
        f"  onboarded:        {val(usage.get('onboarded'))}",
        f"  active API keys:  {val(usage.get('api_keys'))}",
        f"  deletions logged: {val(usage.get('deletions'))}",
    ]

    tiers = usage.get("tiers") or {}
    if tiers:
        lines += ["", "Tiers"]
        lines += [f"  {name}: {count if count is not None else 'unknown'}" for name, count in tiers.items()]

    lines += [
        "",
        "Churn",
        f"  deleted in 30d:   {val(deletions.get('recent_30d'))}",
        f"  total deleted:    {val(deletions.get('total'))}",
    ]

    # The gate is not a table, so a missing count means "the Worker has not been
    # redeployed yet" or "it could not be reached", never a schema problem.
    def gval(v: Any) -> str:
        return "unknown" if v is None else str(v)

    gate = report.get("gate")
    refused = report.get("refused")
    lines += ["", "Failed to serve (this billing month)"]
    if not refused:
        lines.append("  gate unreachable — no count available")
    else:
        lines += [
            f"  new users (no cache):    {gval(refused.get('fresh_new'))}",
            f"  cache cleared:           {gval(refused.get('cache_cleared'))}",
            f"  returning (has files):   {gval(refused.get('returning'))}",
            f"  daily request line:      {gval(refused.get('requests'))}",
            f"  total refused:           {gval(refused.get('total'))}",
        ]
        if isinstance(gate, dict):
            lines += [
                "",
                "Gate counters",
                f"  reads used:      {gval(gate.get('used'))} of {gval(gate.get('hardLimit'))}",
                f"  requests today:  {gval(gate.get('requests'))} of {gval(gate.get('requestLimit'))}",
                f"  window:          {gval(gate.get('window'))} (resets {gval(gate.get('resetsAt'))})",
            ]

    cloud = report.get("cloudflare") or {}
    lines += ["", "Cloudflare"]
    if not cloud.get("configured"):
        lines.append("  not measured — set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID")
    else:
        r2 = cloud.get("r2")
        worker = cloud.get("worker")
        if r2:
            payload = r2.get("payload_bytes")
            lines.append(
                f"  R2 {R2_BUCKET_NAME}: {r2.get('objects')} objects"
                + (f", {payload / 1e9:.2f} GB" if isinstance(payload, (int, float)) else "")
            )
        else:
            lines.append(f"  R2 {R2_BUCKET_NAME}: no sample for today")
        if worker:
            lines.append(
                f"  Worker {WORKER_NAME} (24h): {worker.get('requests')} requests, "
                f"{worker.get('errors')} errors"
            )
        else:
            lines.append(f"  Worker {WORKER_NAME}: no sample for today")
        if cloud.get("error"):
            lines.append(f"  last error: {cloud['error']}")

    followed = report.get("followed_strategies") or []
    if followed:
        lines += ["", "Followed strategies"]
        lines += [f"  {sid}: {n}" for sid, n in followed]

    health = report.get("health") or []
    if health:
        lines += ["", "Health"]
        for item in health:
            status = "ok" if item.get("ok") else "FAIL"
            lines.append(f"  {item.get('name', ''):<10} {status:<4} {item.get('detail', '')}")
    return "\n".join(lines)
