-- 004 — stop anyone inserting fake analytics rows
--
-- Run in the Supabase SQL editor. Two tables, four policies.

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
--   post_views feeds the creator analytics dashboard. Both creator_kpis() and
--   creator_views_timeseries() read it. So forged rows inflate the view numbers
--   creators are shown, and any decision made from them.
--
--   booking_clicks decides WHICH CLOSER GETS A BOOKING. lib/routing.ts reads the
--   200 most recent rows and assigns the next booking to whoever appears least.
--   Forged rows let someone starve one closer or flood another.
--
-- Neither is a money-loss bug. Both corrupt data the platform makes decisions
-- from, which is what Priority 4 means by "recommendation data is not corrupted
-- by bad counts".
--
-- NOT EXPLOITED, NOT TESTED. Read from the policies and the code.

-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE
-- ---------------------------------------------------------------------------
-- Nothing writes either table, so nothing can break by removing the ability to
-- write them from the client. Reads are untouched: lib/routing.ts uses the
-- service-role client, and creator_kpis / creator_views_timeseries are
-- SECURITY DEFINER, so both bypass RLS entirely and are unaffected.
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
-- The rest at least scope writes to auth.uid(). That is a much smaller problem
-- than it first looks, but the underlying posture — grant everything, rely on
-- policies — is worth revisiting deliberately rather than table by table.
