# access.py — who may read the operator report.
#
# Two independent ways in, because the role column needs a schema paste that the
# owner might not have done yet:
#
#   role    the profile row says "admin". This is the real mechanism: it travels
#           with the account, and changing it needs database access, not a build.
#   email   the address is listed in ADMIN_EMAILS (or ADMIN_EMAIL, the address the
#           brief is mailed to). This is the bootstrap: the first admin exists
#           before any row says so.
#
# The check runs on the server, against the verified session, never on anything
# the browser sends. A 403 is the answer for everyone else.

# -------- Imports --------
import os

from typing import Any

from fastapi import HTTPException

from app.users import store

# The account this deployment belongs to. Kept here so a fresh database still has
# one admin without a manual UPDATE: the address is the identity, not a secret.
OWNER_EMAILS: frozenset[str] = frozenset({"magicaltitan7@gmail.com"})


def admin_emails() -> set[str]:
    listed: set[str] = set(OWNER_EMAILS)
    # ADMIN_EMAIL is deliberately not read here: it is where the brief is mailed,
    # which is a different question from who may open the report page.
    for name in ("ADMIN_EMAILS",):
        raw = os.environ.get(name) or ""
        for part in raw.replace(";", ",").split(","):
            address = part.strip().lower()
            if address:
                listed.add(address)
    return listed


def is_admin(user: dict[str, Any]) -> bool:
    email = (user.get("email") or "").strip().lower()
    if email and email in admin_emails():
        return True
    # A profile row without the role column reads as "user": the bootstrap above
    # is what keeps a fresh database usable. A failed read is a no, never a 500:
    # an operator page is not worth taking the request down for.
    role = (user.get("role") or "").strip().lower()
    if not role:
        try:
            role = str((store.get_profile(user["id"]) or {}).get("role") or "").strip().lower()
        except Exception:
            return False
    return role == "admin"


def require_admin(user: dict[str, Any]) -> None:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Operator access only.")
