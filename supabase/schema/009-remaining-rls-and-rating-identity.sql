-- 009 — enable RLS on the last four open tables, and stop star ratings
--       being written under someone else's name
--
-- ✅ APPLIED TO PRODUCTION 2026-08-23, with the checks at the bottom run and
--    passing. This file is the versioned record of that change, in the same
--    way 002-008 record theirs. Running it again is harmless: every statement
--    is idempotent (ENABLE ROW LEVEL SECURITY and GRANT/REVOKE re-apply
--    cleanly, CREATE OR REPLACE re-creates the same function).

-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- 1. Four tables still had row-level security switched off with zero policies:
--
--      booking_payments   (real payment rows)
--      profile_reviews    (star ratings)
--      post_engagements   (empty)
--      _patch_export      (empty, leftover from a one-off patch script)
--
--    anon and authenticated hold table-level INSERT/UPDATE/DELETE on every
--    public table, so with RLS off these four were readable and writable by
--    anyone holding the site's public key — which ships in every visitor's
--    browser by design. (stripe_events, the fifth table from the original
--    audit finding, was closed separately by 005.)
--
-- 2. set_profile_rating accepted the reviewer's id as a parameter and wrote
--    whatever it was handed. It is SECURITY DEFINER and was callable with the
--    public key, so anyone could post a rating as any other user.
--
-- 3. Both rating functions kept the Postgres-default EXECUTE grant to PUBLIC.
--    Revoking only anon/authenticated removes nothing while that grant stands
--    (every role inherits PUBLIC) — the exact mistake 002 documents.

-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE
-- ---------------------------------------------------------------------------
-- * Every code path that touches booking_payments builds a service-role
--   client (verified in all four files that reference the table:
--   bookings/[bookingId]/payment-link, bookings/[bookingId], bookings/list,
--   stripe/webhook). The service role bypasses RLS, so deny-by-default
--   changes nothing for the app.
-- * Nothing in the codebase reads or writes profile_reviews, post_engagements
--   or _patch_export directly; profile_reviews is only touched through the
--   two SECURITY DEFINER functions below, which are owned by postgres and
--   bypass RLS.
-- * set_profile_rating keeps its exact signature, so the deployed frontend
--   (components/ProfileStarRating.tsx) keeps working with no code change.
--   The passed-in reviewer id is now ignored in favour of auth.uid().

BEGIN;

-- 1. Deny-by-default on the four remaining open tables.
ALTER TABLE public.booking_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_reviews  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._patch_export    ENABLE ROW LEVEL SECURITY;

-- 2. Ratings are written as the signed-in caller, never as a named parameter.
CREATE OR REPLACE FUNCTION public.set_profile_rating(
  p_profile_id  uuid,
  p_reviewer_id uuid,   -- accepted for compatibility, deliberately ignored
  p_rating      integer
)
RETURNS TABLE(avg_rating numeric, review_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reviewer uuid := auth.uid();
BEGIN
  IF v_reviewer IS NULL THEN
    RAISE EXCEPTION 'set_profile_rating: not authenticated';
  END IF;

  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'set_profile_rating: rating must be between 1 and 5';
  END IF;

  IF v_reviewer = p_profile_id THEN
    RAISE EXCEPTION 'set_profile_rating: cannot rate your own profile';
  END IF;

  INSERT INTO public.profile_reviews (profile_id, reviewer_id, rating)
  VALUES (p_profile_id, v_reviewer, p_rating)
  ON CONFLICT (profile_id, reviewer_id)
  DO UPDATE SET rating = EXCLUDED.rating, updated_at = now();

  RETURN QUERY
    SELECT COALESCE(AVG(rating), 0)::numeric(10,2),
           COUNT(*)::integer
    FROM public.profile_reviews
    WHERE profile_id = p_profile_id;
END;
$function$;

-- Signed-out visitors have no business rating anyone; the PUBLIC revoke is
-- the one that actually does the work (see 002 for why).
REVOKE EXECUTE ON FUNCTION public.set_profile_rating(uuid, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_profile_rating(uuid, uuid, integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_profile_rating(uuid, uuid, integer) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.set_profile_rating(uuid, uuid, integer) TO service_role;

-- 3. update_profile_rating: server-only, search_path pinned.
ALTER FUNCTION public.update_profile_rating(uuid) SET search_path TO 'public';
REVOKE EXECUTE ON FUNCTION public.update_profile_rating(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_profile_rating(uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.update_profile_rating(uuid) TO service_role;

-- 4. Drop the misleading write policies on purchases. 003 already revoked the
--    table privileges these policies sat on, so they had no effect — but
--    "no client writes" is PERMISSIVE (permissive policies OR together, so it
--    blocked nothing even before 003) and reads like a lock to the next
--    person. Misleading artifacts get removed, not kept.
DROP POLICY IF EXISTS "purchases: owner can update" ON public.purchases;
DROP POLICY IF EXISTS "purchases_owner_update"      ON public.purchases;
DROP POLICY IF EXISTS "purchases: owner can delete" ON public.purchases;
DROP POLICY IF EXISTS "no client writes"            ON public.purchases;

COMMIT;

-- ---------------------------------------------------------------------------
-- CHECK IT WORKED (read-only) — all run and passing 2026-08-23
-- ---------------------------------------------------------------------------
--   -- All five audit tables now deny-by-default (true, 0 policies each):
--   SELECT c.relname, c.relrowsecurity,
--          (SELECT count(*) FROM pg_policies p
--            WHERE p.schemaname='public' AND p.tablename=c.relname) AS policies
--   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public'
--     AND c.relname IN ('booking_payments','profile_reviews','post_engagements',
--                       'stripe_events','_patch_export');
--
--   -- Rating functions: authenticated+service_role only, auth.uid() enforced:
--   SELECT p.proname, coalesce(array_to_string(p.proacl,' | '),'PUBLIC-default (BAD)')
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public'
--     AND p.proname IN ('set_profile_rating','update_profile_rating');
--   -- expect NO bare "=X/" entry and NO anon= entry in either ACL
--
--   -- No write policies remain on purchases:
--   SELECT count(*) FROM pg_policies
--   WHERE schemaname='public' AND tablename='purchases'
--     AND cmd IN ('UPDATE','DELETE','ALL');   -- expect 0
--
-- Then on the live site: signed in, leave a star rating on another creator and
-- watch the average update; complete a booking payment; open a profile that
-- has reviews and confirm they still display.

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--   BEGIN;
--   ALTER TABLE public.booking_payments DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.profile_reviews  DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.post_engagements DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public._patch_export    DISABLE ROW LEVEL SECURITY;
--   COMMIT;
--
-- The previous set_profile_rating body (which trusted p_reviewer_id) is
-- preserved verbatim in docs/plan rollback captures dated 2026-08-12 and in
-- the 2026-08-23 pre-change backup. Do not restore it: it re-opens the
-- impersonation hole. If rating breaks, say which flow, so a narrow fix can
-- replace the rollback.
--
-- The four dropped purchases policies had no effect after 003 and blocked
-- nothing before it ("no client writes" was PERMISSIVE with USING false).
-- Their exact definitions are in the 2026-08-23 pre-change backup if ever
-- needed for reference.
