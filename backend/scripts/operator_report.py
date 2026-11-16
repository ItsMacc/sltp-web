#!/usr/bin/env python3
# operator_report.py — the daily operator brief.
#
# Answers, every morning: how many people signed up, how many ever came back,
# how many finished onboarding, how many are building anything, and who left.
#
# The assembly lives in app/ops/report.py, because Settings shows the same brief
# to an admin on demand. This file is the scheduled half: print it, or mail it.
#
# USAGE (from backend/):
#   ../.venv/bin/python scripts/operator_report.py          print today's brief
#   ../.venv/bin/python scripts/operator_report.py --send   mail it to the operator
#   ../.venv/bin/python scripts/operator_report.py --send --force   ignore the already-sent marker
#
# The sent marker lives in ~/.sltp/operator_report_sent (one ISO date). A rerun on
# the same day stays quiet unless --force is passed.

# -------- Imports --------
import argparse
import sys

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.notify.mailer import admin_recipient, ops_report_email
from app.ops.report import build_report, format_text

SENT_MARKER: Path = Path.home() / ".sltp" / "operator_report_sent"


# -------- Already-sent marker --------
def already_sent_today(date_str: str) -> bool:
    try:
        return SENT_MARKER.read_text(encoding="utf-8").strip() == date_str
    except OSError:
        return False


def mark_sent(date_str: str) -> None:
    SENT_MARKER.parent.mkdir(parents=True, exist_ok=True)
    SENT_MARKER.write_text(date_str + "\n", encoding="utf-8")


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
        print("Today's brief already went out; pass --force to resend.")
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
