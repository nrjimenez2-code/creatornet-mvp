-- 004 — stop anyone inserting fake analytics rows
--
-- Run in the Supabase SQL editor. Two tables, three policies dropped
-- (the two tables carry five policies in total; the two SELECT policies stay).

-- ---------------------------------------------------------------------------
-- WHAT IS WRONG TODAY
-- ---------------------------------------------------------------------------
-- Two tables have INSERT policies with WITH CHECK (true) granted to the public
-- role, which means anyone holding the app's public key can insert unlimited
-- rows into them:
--
--   post_views      policy "views_insert_any"
--   booking_clicks  policies "insert click" and "public insert/read clicks"
--
-- Neither table is written by ANY code in the repository. Verified by grepping
-- every reference: post_views has zero references outside the schema snapshot,
-- and booking_clicks appears once, at lib/routing.ts:79, as a SELECT.
--
-- WHY IT MATTERS
--
--   ⚠️ CORRECTED. An earlier version of this comment claimed both tables feed
--   live features. Re-checked against the database, and the honest answer is
--   weaker: neither is load-bearing TODAY. This is preventive hardening, not a
--   repair. The change itself is unaffected.
--
--   post_views does NOT feed the live analytics dashboard. There are FOUR
--   routines, not two. creator_kpis and creator_views_timeseries each have a
--   2-argument and a 3-argument overload. Only the 2-argument ones read
--   post_views, and nothing calls them. app/dashboard/analytics/page.tsx passes
--   p_creator_id, so it resolves to the 3-argument overloads, which read
--   post_events instead. Counts: post_events 1878 rows, post_views 6 rows with
--   the newest dated 2025-11-06. So forged post_views rows would not move any
--   number a creator currently sees. They would matter if the 2-argument
--   overloads were ever wired up.
--
--   booking_clicks is currently inert. getBookingTarget in lib/routing.ts is the
--   only reader, it has NO callers anywhere in the repo, and the table holds
--   0 rows. If it is wired up later it is intended to spread bookings across
--   closers, and forged rows would then let someone starve or flood one.
--
-- So neither is a money-loss bug and neither is corrupting anything right now.
-- The reason to do it is that both tables accept unlimited writes from anyone
-- holding the public key, for no benefit, and one of them is meant to become
-- routing logic.
--
-- NOT EXPLOITED, NOT TESTED. Read from the policies and the code.

-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE
-- ---------------------------------------------------------------------------
-- Nothing writes either table, so nothing can break by removing the ability to
-- write them from the client.
--
-- Reads are untouched, and the reason matters:
--
--   booking_clicks keeps two PUBLIC SELECT policies with USING (true), so reads
--   there keep working under ANY key. ⚠️ An earlier version of this comment said
--   "lib/routing.ts uses the service-role client". That was wrong and was never
--   checked: routing.ts imports only a TYPE from @supabase/supabase-js, and
--   supabaseAdmin is just the name of a function PARAMETER. Since the function
--   has no callers, nothing determines which key it would receive. The SELECT
--   policies are the real reason reads are safe, and it is the sturdier one.
--
--   creator_kpis and creator_views_timeseries are SECURITY DEFINER, so they
--   bypass RLS and are unaffected either way.
--
-- post_views currently holds 6 rows, presumably from code that has since been
-- removed. They are left alone.

BEGIN;

DROP POLICY IF EXISTS "views_insert_any"          ON public.post_views;
DROP POLICY IF EXISTS "insert click"              ON public.booking_clicks;
DROP POLICY IF EXISTS "public insert/read clicks" ON public.booking_clicks;

COMMIT;

-- ---------------------------------------------------------------------------
-- CHECK IT WORKED (read-only)
-- ---------------------------------------------------------------------------
--   SELECT tablename, policyname, cmd, with_check
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('post_views','booking_clicks')
--   ORDER BY tablename, policyname;
--
-- Expected afterwards: no INSERT policy remains on either table. The remaining
-- SELECT policies on booking_clicks ("read clicks", "public read clicks") are
-- left in place, so nothing that reads changes.
--
-- Then on the live site: open a creator analytics dashboard and confirm the
-- numbers still load, and confirm booking assignment still routes.

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--   BEGIN;
--   CREATE POLICY "views_insert_any" ON public.post_views
--     AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);
--   CREATE POLICY "insert click" ON public.booking_clicks
--     AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);
--   CREATE POLICY "public insert/read clicks" ON public.booking_clicks
--     AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);
--   COMMIT;

-- ---------------------------------------------------------------------------
-- CONTEXT WORTH KNOWING
-- ---------------------------------------------------------------------------
-- anon and authenticated hold INSERT, UPDATE and DELETE on ALL 27 public tables.
-- Row-level security is therefore doing 100% of the access control, and five
-- tables have it switched off entirely (see 003 and the RLS remediation).
--
-- These two are the only tables where an INSERT policy is unconditionally open.
-- That claim was re-tested more strictly than the first time: the original check
-- filtered on cmd = 'INSERT', which silently skips FOR ALL policies that also
-- grant INSERT. Including those surfaces three more tables (post_metrics,
-- user_interest_scores, watch_progress), but each carries a scoped USING
-- qualifier that Postgres reuses as the WITH CHECK when none is given, so none
-- of them is unconditionally open. The claim survives the stricter test.
--
-- The rest scope writes, though not all to auth.uid(): post_metrics and
-- user_interest_scores scope to auth.role() = 'service_role' instead. That is a
-- much smaller problem than it first looks, but the underlying posture — grant
-- everything, rely on policies — is worth revisiting deliberately rather than
-- table by table.
