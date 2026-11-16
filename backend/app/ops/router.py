# router.py — the operator endpoints the Settings page calls.
#
# /api/ops/me answers whether this account may see the report at all, so the page
# can hide the tab instead of rendering one that 403s. /api/ops/report is the same
# brief the nightly email contains, assembled by app.ops.report.build_report.

# -------- Imports --------
from typing import Any

from fastapi import APIRouter, Depends

from app.auth.jwt_auth import get_current_user
from app.ops import report as ops_report
from app.ops.access import is_admin, require_admin

router = APIRouter()


# -------- Endpoints --------
# Cheap permission probe. Never fails for a signed-in account.
@router.get("/api/ops/me")
async def ops_me(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    return {"admin": is_admin(user)}


# The brief, on demand. Slow on purpose: it pages through auth accounts and asks
# the gate Worker, so the page shows a loading state rather than prefetching it.
@router.get("/api/ops/report")
async def ops_report_view(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    require_admin(user)
    built = ops_report.build_report()
    built["text"] = ops_report.format_text(built)
    return built
