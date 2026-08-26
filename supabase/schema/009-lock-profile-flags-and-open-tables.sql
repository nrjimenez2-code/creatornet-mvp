-- 009 — profiles: server-only columns, and RLS on the last open tables
--
-- Run in the Supabase SQL editor (or `supabase db query -f`). Grants and
-- RLS only; no table structure or data changes. Applied to production
-- 2026-08-23 and verified as the authenticated and anon roles.
--
-- A. profiles: a signed-in user could UPDATE every column of their own row,
--    including stripe_account_id, stripe_onboarding_complete,
--    charges_enabled, payouts_enabled, onboarding_complete,
--    total_earnings_cents, review_rating, review_count. That is enough to
--    mark yourself sell-ready with any Connect account id, or set your own
--    earnings and rating. The app only ever writes these through the
--    service role (Connect routes, webhook, reviews route). The browser
--    writes username, full_name, bio, tagline, avatar_url, interests only
--    (checked: app/profile/edit, app/onboarding).
--
-- B. Four tables had row-level security OFF with full anon/authenticated
--    grants: booking_payments (Stripe ids, amounts, payment links),
--    profile_reviews, post_engagements, _patch_export. Enabling RLS with
--    no policies means only the service role can touch them, which is how
--    the app already uses them. 011 (landont987) enables RLS on the same
--    four tables; both files are idempotent, whichever runs first.
--
-- NOT in this file any more: revoking set_profile_rating from
-- authenticated. The deployed ProfileStarRating component calls that
-- function straight from the browser, and revoking it before the deploy
-- broke ratings in production for half an hour on 2026-08-23. 011 rewrites
-- the function to take the reviewer from auth.uid() and keeps the grant,
-- which closes the forgery without a code dependency. Lesson recorded:
-- a revoke that assumes a new server route ships in the same deploy as
-- that route, never ahead of it.

BEGIN;

-- A. profiles: server-only columns.
-- A column-level REVOKE does not narrow a table-level GRANT, so the table
-- write privilege is removed and the browser-editable columns are granted
-- back explicitly. Everything the UI writes is in this list
-- (app/profile/edit: id, username, tagline, avatar_url, bio;
--  app/onboarding: username, interests). anon never writes profiles.
REVOKE INSERT, UPDATE ON public.profiles FROM anon, authenticated;

GRANT UPDATE (username, full_name, bio, tagline, avatar_url, interests, "Interests", updated_at)
  ON public.profiles TO authenticated;
GRANT INSERT (id, username, full_name, bio, tagline, avatar_url, interests, "Interests", created_at, updated_at)
  ON public.profiles TO authenticated;

-- B. tables that were wide open
ALTER TABLE public.booking_payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_reviews   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_engagements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._patch_export     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.booking_payments FROM anon, authenticated;
REVOKE ALL ON public.profile_reviews  FROM anon, authenticated;
REVOKE ALL ON public.post_engagements FROM anon, authenticated;
REVOKE ALL ON public._patch_export    FROM anon, authenticated;

COMMIT;

-- VERIFY (read-only)
-- select column_name from information_schema.column_privileges
--   where table_name='profiles' and grantee='authenticated' and privilege_type='UPDATE';
--   -- expect: Interests, avatar_url, bio, created_at, full_name, id, interests, tagline, updated_at, username
-- select relname, relrowsecurity from pg_class
--   where relname in ('booking_payments','profile_reviews','post_engagements','_patch_export');
--   -- expect: all true

-- ROLLBACK
-- GRANT INSERT, UPDATE ON public.profiles TO anon, authenticated;  -- restores all columns
-- ALTER TABLE public.booking_payments DISABLE ROW LEVEL SECURITY;  (and the other three)
-- GRANT ALL ON public.booking_payments TO anon, authenticated;      (and the other three)
