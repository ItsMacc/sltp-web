-- ============================================================
-- SLTP — Supabase schema (app tables)
-- ============================================================
-- Paste this ONCE into the Supabase dashboard: SQL Editor -> New query.
-- Everything is IF NOT EXISTS, so re-running it is safe.
--
-- The users table already exists (Supabase Auth profile mirror with a
-- settings jsonb column). This file adds the ONE table the API keeps in
-- Supabase:
--
--   account_deletions churn log: the only trace left after erasure
--
-- Portfolios, API keys and everything bulky live in Turso
-- (backend/app/turso/schema.sql), keyed by the Supabase uid. There are
-- deliberately no portfolios or api_keys tables here: an older revision
-- of this file created them, and keeping them invites writing user data
-- to the wrong store. If your project still has those empty tables from
-- the old version, leaving them is harmless — nothing reads them.
--
-- Row Level Security is enabled with default-deny. The backend uses the
-- service role (which bypasses RLS).
-- -------- Account level (tier and role) --------
-- Two facts about a person that do not belong in the settings blob: the plan
-- they are on, and whether they may see the operator report. Rows created before
-- these columns existed get the defaults, so nothing needs backfilling.
--
--   tier   free | plus | pro   (USER_TIERS on the backend lists the names)
--   role   user | admin        (admins get the Reports tab in Settings)
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

-- The owner account. Safe to re-run: it only ever writes the admin role.
UPDATE users SET role = 'admin' WHERE lower(email) = 'magicaltitan7@gmail.com';


-- ============================================================

-- -------- Account deletions (churn log; insert-only) --------
CREATE TABLE IF NOT EXISTS account_deletions (
  user_id uuid NOT NULL PRIMARY KEY,
  email text,
  name text,
  deleted_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE account_deletions ENABLE ROW LEVEL SECURITY;

-- The churn log is backend-only: no client access at all.
