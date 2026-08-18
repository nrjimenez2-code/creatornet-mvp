-- 005 — lock down stripe_events
--
-- ⚠️ RUN THIS TOGETHER WITH THE CODE IN PR #81. That PR promotes stripe_events
-- from an unused empty table into the gate that decides whether a payment gets
-- recorded. Right now anyone holding the site's public key can write to it.
--
-- Run in the Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- WHAT IS WRONG TODAY
-- ---------------------------------------------------------------------------
-- Verified against the live database:
--
--   relrowsecurity                                       = false   (RLS is OFF)
--   policies on the table                                = 0
--   has_table_privilege('anon','stripe_events','INSERT')  = true
--   has_table_privilege('anon','stripe_events','DELETE')  = true
--   row count                                            = 0
--
-- The anon key ships inside the browser bundle, so "anon" means anybody.
--
-- WHY IT MATTERS ONLY ONCE #81 SHIPS
--
-- Today the table is unused, so writing to it achieves nothing. After #81 the
-- webhook does: INSERT the Stripe event id, and if it conflicts, treat that
-- delivery as an already-processed duplicate and skip it.
--
-- That turns a writable table into a way to suppress payments. Someone who can
-- write a row carrying an event id BEFORE Stripe delivers that event would make
-- the real webhook skip it: the customer is charged, and no purchase, earnings
-- row or access grant is ever written. Deleting rows is the milder direction —
-- it removes the duplicate protection and lets a retry re-run side effects.
--
-- Predicting a Stripe event id is not trivial, so this is a hardening step
-- rather than a live exploit. But the table should never have been writable
-- from a browser, and it is one statement to fix.
--
-- NOT EXPLOITED, NOT TESTED. Read from the catalog and the code.

-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE
-- ---------------------------------------------------------------------------
-- Only server code touches this table, and only through the service-role key
-- (lib/stripeEvents.ts builds its client from SUPABASE_SERVICE_ROLE_KEY). The
-- service role bypasses RLS and is unaffected by revoking from anon and
-- authenticated, so the webhook keeps working exactly as it does now.
--
-- Nothing in the browser reads or writes stripe_events. Confirmed with
-- git grep: the only references are lib/stripeEvents.ts, its test, and the
-- schema snapshot.
--
-- The table has 0 rows, so there is nothing to migrate or lose.

BEGIN;

ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.stripe_events FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.stripe_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.stripe_events FROM authenticated;

COMMIT;

-- No policies are added on purpose. RLS with zero policies means deny-by-default
-- for everyone except the service role, which is exactly the intent here.
--
-- The FROM PUBLIC line matters and is easy to leave out: Postgres grants
-- privileges to PUBLIC by default in several cases, and every role inherits
-- that grant, so revoking from anon and authenticated alone can remove nothing.
-- That exact mistake was found and fixed in 002.

-- ---------------------------------------------------------------------------
-- CHECK IT WORKED (read-only)
-- ---------------------------------------------------------------------------
--   SELECT c.relrowsecurity AS rls_enabled,
--          has_table_privilege('anon','public.stripe_events','INSERT') AS anon_insert,
--          has_table_privilege('anon','public.stripe_events','DELETE') AS anon_delete,
--          has_table_privilege('authenticated','public.stripe_events','INSERT') AS auth_insert
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relname = 'stripe_events';
--
-- Expected afterwards: rls_enabled = true, and all three privilege checks false.
--
-- Then take a real test payment and confirm the purchase still records. That is
-- the only check that proves the webhook still writes.

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--   BEGIN;
--   ALTER TABLE public.stripe_events DISABLE ROW LEVEL SECURITY;
--   GRANT INSERT, UPDATE, DELETE ON public.stripe_events TO anon;
--   GRANT INSERT, UPDATE, DELETE ON public.stripe_events TO authenticated;
--   COMMIT;
--
-- Only needed if payment recording stops, which would mean the webhook is not
-- using the service-role key the way this file assumes. Say so rather than
-- leaving the rollback in place, because it re-opens the suppression path.
