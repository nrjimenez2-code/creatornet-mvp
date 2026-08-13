-- 002 — atomic like counter
--
-- Run this in the Supabase SQL editor. It is safe to run before or after merging
-- the code change; the application falls back to the old behaviour until this
-- exists, and starts using this the moment it does.
--
-- WHY
-- The like route did: SELECT likes_count -> add/subtract one in JavaScript ->
-- UPDATE with the computed value. Two people liking the same post at the same
-- moment both read N and both write N+1, so the post ends on N+1 instead of N+2.
-- That is the "view/like counts become wrong" item in the pre-launch spec
-- (Priority 4), and it also feeds the recommendation logic bad numbers.
--
-- WHAT THIS DOES
-- Moves the arithmetic inside a single UPDATE, so Postgres serialises concurrent
-- callers on the row itself. No read-then-write window. Returns the new value in
-- the same round trip, so the API does not need a follow-up read.
--
-- SAFETY
-- Creates one new function. Changes no table, no data, no existing function.
-- Rolling back is a single DROP (bottom of this file).

BEGIN;

CREATE OR REPLACE FUNCTION public.bump_post_likes(p_post_id uuid, p_delta integer)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE public.posts
  SET likes_count = greatest(0, coalesce(likes_count, 0) + p_delta)
  WHERE id = p_post_id
  RETURNING likes_count;
$function$;

-- Only the server calls this, with the service-role key. A signed-out visitor
-- has no business moving a like count directly.
REVOKE EXECUTE ON FUNCTION public.bump_post_likes(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bump_post_likes(uuid, integer) FROM authenticated;

COMMIT;


-- ---------------------------------------------------------------------------
-- CHECK IT WORKED (read-only, safe to run)
-- ---------------------------------------------------------------------------
-- Should return one row with security_definer = true and search_path pinned:
--
--   SELECT p.proname,
--          pg_get_function_identity_arguments(p.oid) AS args,
--          p.prosecdef AS security_definer,
--          array_to_string(p.proconfig, ', ') AS config
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'bump_post_likes';
--
-- Then, on the live site: like a post, unlike it, and confirm the number goes
-- up by one and back down by one. The app log line
-- "[post-counters] bump_post_likes unavailable" should stop appearing.


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Dropping this is safe. The application detects the missing function and falls
-- back to its previous behaviour automatically.
--
--   DROP FUNCTION IF EXISTS public.bump_post_likes(uuid, integer);


-- ---------------------------------------------------------------------------
-- NOT INCLUDED ON PURPOSE
-- ---------------------------------------------------------------------------
-- 1. The three existing functions increment_post_likes / _comments / _shares are
--    left alone. They are atomic and correct, but their search_path is NOT
--    pinned. Pinning it is worth doing and belongs in its own change, together
--    with the wider SECURITY DEFINER lockdown, so that one review covers all of
--    them rather than fixing one in passing here.
--
-- 2. No index on likes(post_id). Counting likes from the source table would
--    currently be a sequential scan, because the only usable index leads with
--    user_id. That matters if anyone later tries to recompute counts rather than
--    maintain them. It is not needed for this change and adding an index to a
--    live table deserves its own decision.
