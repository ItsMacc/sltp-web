# config.py — one place for environment, database access and tiny helpers.
#
# Two-store design, split by size. Supabase holds auth, the small profile row
# and the churn log. Turso holds everything bulky, keyed by the Supabase uid:
# portfolios, API keys, watchlists, Lab strategies and cached backtest runs.

# -------- Imports --------
import os

from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv


# -------- Environment --------
# Load the repo-root .env by walking upward, so a module move cannot break it.
def _load_env() -> None:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / ".env"
        if candidate.is_file():
            load_dotenv(candidate)
            return


_load_env()

SUPABASE_URL: str = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY: str | None = os.environ.get("SUPABASE_SERVICE_ROLE")
SUPABASE_TIMEOUT: int = 15

TURSO_URL: str = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_TOKEN: str | None = os.environ.get("TURSO_AUTH_TOKEN")
TURSO_TIMEOUT: int = 15

# The gate Worker in gateway/. Its /__gate/status endpoint is the only place the
# market-read counters exist, so the operator brief reads them from there.
GATEWAY_URL: str = os.environ.get(
    "SLTP_GATEWAY_URL", "https://sltp-data.magicaltitan7.workers.dev"
).rstrip("/")

# Alpaca's news feed. The keys belong to a trading account, but the news
# endpoint is part of the free Basic plan: 200 requests a minute for the whole
# account, and nothing newer than fifteen minutes comes back. The URL is
# overridable so a test can point at a stub.
ALPACA_KEY_ID: str = (os.environ.get("ALPACA_API_KEY") or "").strip()
ALPACA_SECRET: str = (os.environ.get("ALPACA_SECRET_KEY") or "").strip()
ALPACA_DATA_URL: str = (os.environ.get("ALPACA_DATA_URL") or "https://data.alpaca.markets").rstrip("/")
NEWS_TIMEOUT: int = 20


# -------- Supabase REST --------
# Service-role headers. The backend is a trusted client: it bypasses RLS and
# every query is scoped to the user id from the verified JWT, never the body.
def service_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers: dict[str, str] = {
        "apikey": SUPABASE_SERVICE_KEY or "",
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY or ''}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def require_supabase() -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise RuntimeError("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE in .env")


def require_turso() -> None:
    if not TURSO_URL or not TURSO_TOKEN:
        raise RuntimeError("Turso is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env")


def require_alpaca() -> None:
    if not ALPACA_KEY_ID or not ALPACA_SECRET:
        raise RuntimeError("Alpaca is not configured. Set ALPACA_API_KEY and ALPACA_SECRET_KEY in .env")


# -------- Helpers --------
# The current time as an ISO string, for created_at and updated_at columns.
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# True when a PostgREST error means "this table does not exist yet" (schema.sql
# not pasted). Callers treat that as empty, so reads work before setup.
def is_missing_table(body: str) -> bool:
    return "42P01" in body or "Could not find the table" in body
