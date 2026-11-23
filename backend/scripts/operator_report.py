#!/usr/bin/env python3
# operator_report.py — the daily operator brief.
#
# Answers, every morning: how many people signed up, how many ever came back,
# how many finished onboarding, how many are building anything, and who left.
#
# Accounts come from Supabase auth, the authoritative signup record, which
# exists before a person ever opens the app. Usage comes from the app tables,
# written on first sign-in and again when the setup wizard completes.
#
# USAGE (from backend/):
#   ../.venv/bin/python scripts/operator_report.py          print today's brief
#   ../.venv/bin/python scripts/operator_report.py --send   mail it to the operator
#   ../.venv/bin/python scripts/operator_report.py --send --force   ignore the already-sent marker
#
# The sent marker is one row in Turso (ops_state, key operator_report_sent), so a
# scheduled runner that starts with an empty home directory still knows the brief
# went out. Without Turso configured it falls back to ~/.sltp/operator_report_sent.
# A rerun on the same day stays quiet unless --force is passed.

# -------- Imports --------
import argparse
import sys

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

NY_TZ = ZoneInfo("America/New_York")

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import (
    DATA_URL,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    SUPABASE_TIMEOUT,
    TURSO_TOKEN,
    TURSO_URL,
    service_headers,
)
from app.health import collect_health
from app.notify.mailer import admin_recipient, ops_report_email
from app.turso import userdata
from app.users import store

SUPABASE_PAGE_SIZE: int = 1000
SENT_MARKER: Path = Path.home() / ".sltp" / "operator_report_sent"


# -------- Accounts (Supabase auth) --------
# Every auth account, one page at a time. Paging matters: per_page caps at
# 1000 and the endpoint silently returns the first page again if never advanced.
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
        if _parse_time(row.get("deleted_at")) is not None and _parse_time(row.get("deleted_at")) >= month_ago:
            recent += 1
    return {"total": len(rows), "recent_30d": recent}


# Usage blends both stores: identity in Supabase, everything bulky in Turso.
def usage_summary() -> dict[str, Any]:
    usage = dict(store.usage_counts())
    usage["onboarded"] = userdata.count_portfolios_onboarded()
    usage["api_keys"] = userdata.count_api_keys()
    return usage


# -------- Market data --------
# The bucket is public and serves every byte itself, so there is no refused-read
# counter any more. The brief reports what readers get instead: the published
# version, the newest session and the bundle markets that exist. An unreachable
# bucket reads as None ("unknown"), never as zero.
def fetch_market_status() -> dict[str, Any] | None:
    try:
        response = requests.get(f"{DATA_URL}/META/manifest.json", timeout=SUPABASE_TIMEOUT)
        response.raise_for_status()
        manifest = response.json()
    except (requests.RequestException, ValueError):
        return None
    files = manifest.get("files") or []
    bundles = [entry for entry in files if str(entry.get("key", "")).endswith(".bin")]
    markets = sorted({
        str(entry["key"]).split("/")[2]
        for entry in bundles
        if str(entry["key"]).count("/") >= 3
    })
    return {
        "version": manifest.get("version"),
        "bundles": len(bundles),
        "markets": markets,
        "latest": max((str(entry.get("last_session") or "") for entry in bundles), default=""),
        "delisted": fetch_delisted_archive(),
    }


# The delisted archive is a sibling object in the same public bucket, so the
# brief answers "what stopped trading" with what the archive says rather than
# with a local file a scheduled runner would not have.
def fetch_delisted_archive() -> dict[str, Any] | None:
    try:
        response = requests.get(f"{DATA_URL}/META/delisted.json", timeout=SUPABASE_TIMEOUT)
        response.raise_for_status()
        body = response.json()
    except (requests.RequestException, ValueError):
        return None
    symbols = body.get("symbols") or []
    if not isinstance(symbols, list):
        return None
    return {
        "total": len(symbols),
        "stripped": sum(1 for entry in symbols if isinstance(entry, dict) and entry.get("stripped")),
        "pending": sum(1 for entry in symbols if isinstance(entry, dict) and not entry.get("stripped")),
        "renamed": sum(1 for entry in symbols if isinstance(entry, dict) and entry.get("replacement")),
    }


def build_report() -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    accounts = fetch_auth_accounts()
    market = fetch_market_status()
    return {
        # The New York date, not the UTC one. The brief goes out at 17:30 ET, and
        # keyed on UTC a run after 19:00 ET is stamped with tomorrow's date —
        # which then makes tomorrow's scheduled run look like a duplicate and
        # skip itself.
        "date": datetime.now(NY_TZ).date().isoformat(),
        "accounts": summarize_accounts(accounts, now),
        "usage": usage_summary(),
        "deletions": deletion_summary(now),
        "followed_strategies": followed_strategies(),
        "health": collect_health(),
        "market": market,
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
        "",
        "Churn",
        f"  deleted in 30d:   {val(deletions.get('recent_30d'))}",
        f"  total deleted:    {val(deletions.get('total'))}",
    ]

    # The bucket is not a table: a missing status means the manifest could not
    # be read, never a schema problem.
    market = report.get("market")
    lines += ["", "Market data (public bucket)"]
    if not isinstance(market, dict):
        lines.append("  manifest unreachable — no status available")
    else:
        lines += [
            f"  version:         {market.get('version') or 'unknown'}",
            f"  newest session:  {market.get('latest') or 'unknown'}",
            f"  bundles:         {market.get('bundles')}",
            f"  markets:         {', '.join(market.get('markets') or []) or 'none'}",
        ]
        delisted = market.get("delisted")
        if not isinstance(delisted, dict):
            lines.append("  delisted:        archive unreachable")
        else:
            lines.append(
                f"  delisted:        {delisted.get('total')} archived "
                f"({delisted.get('stripped')} stripped, {delisted.get('pending')} pending, "
                f"{delisted.get('renamed')} renamed)"
            )
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


# -------- Already-sent marker --------
# Turso first, because that is the copy every machine shares. The file is read
# only when there is no database to ask (a laptop without .env), and is written
# as a local breadcrumb either way, so running it by hand still behaves.
MARKER_KEY = "operator_report_sent"


def _turso_ready() -> bool:
    return bool(TURSO_URL and TURSO_TOKEN)


def last_sent_date() -> str | None:
    if _turso_ready():
        try:
            return userdata.get_ops_state(MARKER_KEY)
        except Exception as err:  # noqa: BLE001 - the file below is the fallback
            print(f"Turso marker unreadable ({err}); using the local file.")
    try:
        return SENT_MARKER.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def already_sent_today(date_str: str) -> bool:
    return last_sent_date() == date_str


def mark_sent(date_str: str) -> None:
    if _turso_ready():
        try:
            userdata.set_ops_state(MARKER_KEY, date_str)
        except Exception as err:  # noqa: BLE001 - never fail a sent mail on bookkeeping
            print(f"Could not record the send in Turso: {err}")
    try:
        SENT_MARKER.parent.mkdir(parents=True, exist_ok=True)
        SENT_MARKER.write_text(date_str + "\n", encoding="utf-8")
    except OSError:
        pass


# -------- CLI --------
def main() -> int:
    parser = argparse.ArgumentParser(description="Print or mail the daily SLTP operator brief.")
    parser.add_argument("--send", action="store_true", help="mail the brief to the operator address")
    parser.add_argument("--force", action="store_true", help="send even if today's brief already went out")
    args = parser.parse_args()

    report = build_report()
    print(format_text(report))

    if not args.send:
        return 0

    if already_sent_today(report["date"]) and not args.force:
        print(f"Today's brief already went out; pass --force to resend.")
        return 0

    to = admin_recipient()
    if not to:
        print("No operator address: set ADMIN_EMAIL or SENDER_EMAIL in .env")
        return 1
    ok, err = ops_report_email(to, report)
    if not ok:
        print(f"Send FAILED: {err}")
        return 1
    mark_sent(report["date"])
    print(f"Mailed to {to}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
