-- 003 — make purchases writable only by the server
--
-- ⚠️ THIS IS THE MOST IMPORTANT CHANGE IN THE QUEUE. Read the whole file before
-- running it. It is two statements and it closes a complete paywall bypass.
--
-- Run in the Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- WHAT IS WRONG TODAY
-- ---------------------------------------------------------------------------
-- The `anon` and `authenticated` roles hold INSERT and UPDATE on public.purchases,
-- including on the `access_granted` column itself. Confirmed with:
--
--   SELECT has_table_privilege('authenticated','public.purchases','INSERT'),
--          has_column_privilege('authenticated','public.purchases','access_granted','INSERT');
--   -- both true
--
-- (Note: information_schema.column_privileges returns EMPTY here and is misleading.
--  It filters to the current role. has_*_privilege is the authoritative check.)
--
-- Row-level security is therefore the only gate, and every INSERT policy on
-- purchases checks one thing: auth.uid() = buyer_id. Nothing constrains
-- access_granted, status, or amount.
--
-- app/api/premium/access/route.ts grants a signed download URL when it finds a
-- purchases row matching buyer_id + post_id + access_granted = true. It reads
-- that with the SERVICE-ROLE client, so RLS does not re-check anything.
--
-- Chain: any signed-up account inserts one row for itself with
-- access_granted = true, calls /api/premium/access, and downloads any paid
-- product. Stripe is never involved. No payment occurs.
--
-- The same grants also let a buyer UPDATE or DELETE their own purchase record
-- after the fact, which is a separate problem this closes at the same time.
--
-- NOT EXPLOITED, NOT TESTED. This is read from the grants, the policies and the
-- route source. Nothing was executed against the live site.

-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE TO RUN
-- ---------------------------------------------------------------------------
-- Every write to purchases in the codebase comes from a server route:
--
--   app/api/checkout/route.ts          service-role
--   app/api/confirm-purchase/route.ts  service-role
--   app/api/stripe/confirm/route.ts    service-role
--   app/api/stripe/webhook/route.ts    service-role
--   app/api/webhook/route.ts           user-scoped  (see note below)
--
-- There are ZERO writes from browser code. Verified by grepping every file that
-- touches purchases for insert/update/upsert/delete and checking which client
-- each one builds.
--
-- service_role is unaffected by revoking from anon and authenticated, so all
-- four service-role routes keep working exactly as they do now.
--
-- The one exception, app/api/webhook/route.ts, uses a request-scoped client. A
-- Stripe webhook has no logged-in user, so auth.uid() is NULL and its writes are
-- ALREADY being rejected by the INSERT policies. This revoke does not change its
-- behaviour; it makes an existing no-op explicit. That handler is being retired
-- separately once the Stripe dashboard confirms which endpoint is registered.

BEGIN;

REVOKE INSERT, UPDATE, DELETE ON public.purchases FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.purchases FROM authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- CHECK IT WORKED (read-only)
-- ---------------------------------------------------------------------------
--   SELECT r.rolname,
--          has_table_privilege(r.rolname,'public.purchases','SELECT') AS can_read,
--          has_table_privilege(r.rolname,'public.purchases','INSERT') AS can_insert,
--          has_table_privilege(r.rolname,'public.purchases','UPDATE') AS can_update,
--          has_table_privilege(r.rolname,'public.purchases','DELETE') AS can_delete
--   FROM (VALUES ('anon'),('authenticated')) AS r(rolname);
--
-- Expected afterwards: can_read stays TRUE (buyers must still see their own
-- purchases, and the SELECT policies scope that correctly). The other three
-- become FALSE.
--
-- Then on the live site, confirm nothing broke:
--   1. buy something end to end, and check it appears in the library
--   2. open a previously purchased premium item and confirm it still downloads
--   3. open the buyer's purchase history

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--   BEGIN;
--   GRANT INSERT, UPDATE, DELETE ON public.purchases TO anon;
--   GRANT INSERT, UPDATE, DELETE ON public.purchases TO authenticated;
--   COMMIT;
--
-- Running the rollback re-opens the bypass described above. Only do it if a real
-- flow breaks, and say which one, so the right narrow fix can replace it.

-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT FIX
-- ---------------------------------------------------------------------------
-- The same pattern — client roles holding INSERT/UPDATE with RLS as the only
-- gate — also applies to orders, posts, products and bookings. Those are not
-- touched here because each needs its own check of which flows write them from
-- the browser, and this file should stay small enough to review in one sitting.
--
-- purchases is first because it is the one wired directly to file access.
