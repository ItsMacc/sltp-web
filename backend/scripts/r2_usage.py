"""Print R2 Class A and Class B operation counts for the current billing month.

Same numbers as the dashboard's bucket Metrics tab. The query and the limits
live in app/health.py, so the operator brief and this script can never drift.

USAGE (from backend/):
    ../.venv/bin/python scripts/r2_usage.py

Setup: set these two env vars in the repo-root .env first:

    CLOUDFLARE_API_TOKEN=<token with analytics read on the account>
    CLOUDFLARE_ACCOUNT_ID=<account id>
"""

# -------- Imports --------
import sys

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.health import R2_CLASS_A_LIMIT, R2_CLASS_B_LIMIT, r2_operation_counts


def main() -> int:
    usage = r2_operation_counts()
    print(f"Bucket: {usage['bucket']}")
    print(f"Since: {usage['since']}")
    print(f"Class A: {usage['class_a']:,} / {R2_CLASS_A_LIMIT:,}")
    print(f"Class B: {usage['class_b']:,} / {R2_CLASS_B_LIMIT:,}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - a CLI prints, it does not traceback
        raise SystemExit(str(exc))
