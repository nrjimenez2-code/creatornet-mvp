-- 009 — three things anyone with the public anon key could do, closed
--
-- Run in the Supabase SQL editor (or `supabase db query -f`). Verified
-- against production on 2026-08-23 before writing; see the checks at the
-- bottom. No table structure or data changes; grants, RLS and one REVOKE.
--
-- A. profiles: a signed-in user could UPDATE every column of their own row,
--    including stripe_account_id, stripe_onboarding_complete,
--    charges_enabled, payouts_enabled, onboarding_complete,
--    total_earnings_cents, review_rating, review_count. That is enough to
--    mark yourself sell-ready with any Connect account id, or set your own
--    earnings and rating. The app only ever writes these through the
--    service role (Connect routes, webhook, reviews route). The browser
--    writes username, full_name, bio, tagline, avatar_url, interests only
--    (checked: app/profile/edit, app/onboarding). Column-level REVOKE keeps
--    those working and blocks the rest.
--
-- B. Four tables had row-level security OFF with full anon/authenticated
--    grants: booking_payments (Stripe ids, amounts, payment links),
--    profile_reviews, post_engagements, _patch_export. Anyone could read,
--    edit or delete every row with the key shipped in the JS bundle.
--    Enabling RLS with no policies means only the service role can touch
--    them, which is how the app already uses them (bookings/list and the
--    webhook go through the admin client; nothing in components/ or app/
--    pages reads them directly).
--
-- C. set_profile_rating(p_profile_id, p_reviewer_id, p_rating) is
--    SECURITY DEFINER, executable by anyone, and takes the reviewer id as a
--    parameter: rate any creator as any user. Only a dead component
--    (components/ProfileStarRating.tsx, imported nowhere) calls it. The
--    live review flow uses /api/reviews + update_profile_rating via the
--    service role. Revoke from anon/authenticated; service_role keeps it.

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

-- C. rating-as-anyone function
REVOKE EXECUTE ON FUNCTION public.set_profile_rating(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;

COMMIT;

-- VERIFY (read-only)
-- select column_name from information_schema.column_privileges
--   where table_name='profiles' and grantee='authenticated' and privilege_type='UPDATE';
--   -- expect: Interests, avatar_url, bio, created_at, full_name, id, interests, tagline, updated_at, username
-- select relname, relrowsecurity from pg_class
--   where relname in ('booking_payments','profile_reviews','post_engagements','_patch_export');
--   -- expect: all true
-- select has_function_privilege('anon','public.set_profile_rating(uuid,uuid,integer)','EXECUTE');
--   -- expect: false

-- ROLLBACK
-- GRANT INSERT, UPDATE ON public.profiles TO anon, authenticated;  -- restores all columns
-- ALTER TABLE public.booking_payments DISABLE ROW LEVEL SECURITY;  (and the other three)
-- GRANT ALL ON public.booking_payments TO anon, authenticated;      (and the other three)
-- GRANT EXECUTE ON FUNCTION public.set_profile_rating(uuid, uuid, integer) TO anon, authenticated;
