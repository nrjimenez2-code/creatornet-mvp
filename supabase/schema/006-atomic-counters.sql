-- 006 — atomic counters for post_metrics, user_interest_scores, comments_count
--
-- Run this in the Supabase SQL editor. Safe to run before or after merging the
-- code change: the application keeps using the old read-modify-write path
-- until these functions exist, and switches to them the moment they do.
--
-- WHY
-- lib/updatePostMetrics.ts, lib/updateInterestScore.ts and the comments routes
-- all did: SELECT the current value -> add in JavaScript -> UPDATE/UPSERT the
-- result. Two requests that overlap both read N and both write N+1, so one
-- increment is lost. On a post that gets a burst of views this under-counts
-- by a noticeable fraction, and those numbers feed the feed ranking
-- (post_conversion_score) and the creator dashboard.
--
-- WHAT THIS DOES
-- Functions that do the arithmetic inside one statement, so Postgres
-- serialises concurrent callers on the row. Each returns the new state.
--
-- SAFETY
-- Creates four functions. Changes no table, no data, no existing function.
-- Rollback is four DROPs (bottom of this file).

BEGIN;

-- ---------------------------------------------------------------------------
-- post_metrics: add deltas to any subset of the counters. Inserts the row if
-- missing. Deltas are clamped at zero; nothing here can decrement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_post_metrics(
  p_post_id         uuid,
  p_impressions     integer DEFAULT 0,
  p_views           integer DEFAULT 0,
  p_completions     integer DEFAULT 0,
  p_profile_clicks  integer DEFAULT 0,
  p_buy_clicks      integer DEFAULT 0,
  p_checkout_starts integer DEFAULT 0,
  p_purchases       integer DEFAULT 0,
  p_watch_seconds   numeric DEFAULT 0
)
RETURNS public.post_metrics
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  INSERT INTO public.post_metrics AS m (
    post_id, impressions, views, total_watch_seconds, completions,
    profile_clicks, buy_clicks, checkout_starts, purchases,
    post_conversion_score, updated_at
  )
  VALUES (
    p_post_id,
    greatest(0, coalesce(p_impressions, 0)),
    greatest(0, coalesce(p_views, 0)),
    greatest(0, coalesce(p_watch_seconds, 0)),
    greatest(0, coalesce(p_completions, 0)),
    greatest(0, coalesce(p_profile_clicks, 0)),
    greatest(0, coalesce(p_buy_clicks, 0)),
    greatest(0, coalesce(p_checkout_starts, 0)),
    greatest(0, coalesce(p_purchases, 0)),
    0,
    now()
  )
  ON CONFLICT (post_id) DO UPDATE SET
    impressions         = m.impressions         + EXCLUDED.impressions,
    views               = m.views               + EXCLUDED.views,
    total_watch_seconds = m.total_watch_seconds + EXCLUDED.total_watch_seconds,
    completions         = m.completions         + EXCLUDED.completions,
    profile_clicks      = m.profile_clicks      + EXCLUDED.profile_clicks,
    buy_clicks          = m.buy_clicks          + EXCLUDED.buy_clicks,
    checkout_starts     = m.checkout_starts     + EXCLUDED.checkout_starts,
    purchases           = m.purchases           + EXCLUDED.purchases,
    updated_at          = now()
  RETURNING *;
$function$;

-- The score formula (docs/MY_TASKS.md Task 3) is applied on the same row
-- inside the same call, so it is always consistent with the counters.
CREATE OR REPLACE FUNCTION public.bump_post_metrics_scored(
  p_post_id         uuid,
  p_impressions     integer DEFAULT 0,
  p_views           integer DEFAULT 0,
  p_completions     integer DEFAULT 0,
  p_profile_clicks  integer DEFAULT 0,
  p_buy_clicks      integer DEFAULT 0,
  p_checkout_starts integer DEFAULT 0,
  p_purchases       integer DEFAULT 0,
  p_watch_seconds   numeric DEFAULT 0
)
RETURNS public.post_metrics
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r public.post_metrics;
BEGIN
  PERFORM public.bump_post_metrics(
    p_post_id, p_impressions, p_views, p_completions, p_profile_clicks,
    p_buy_clicks, p_checkout_starts, p_purchases, p_watch_seconds
  );
  UPDATE public.post_metrics
  SET post_conversion_score =
        purchases * 25 + checkout_starts * 10 + buy_clicks * 5 + completions * 3 + views * 1
  WHERE post_id = p_post_id
  RETURNING * INTO r;
  RETURN r;
END;
$function$;

-- ---------------------------------------------------------------------------
-- user_interest_scores: upsert-add.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_interest_score(
  p_user_id  uuid,
  p_category text,
  p_delta    integer
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  INSERT INTO public.user_interest_scores AS s (user_id, category, score, updated_at)
  VALUES (p_user_id, p_category, p_delta, now())
  ON CONFLICT (user_id, category) DO UPDATE SET
    score      = s.score + EXCLUDED.score,
    updated_at = now()
  RETURNING score;
$function$;

-- ---------------------------------------------------------------------------
-- posts.comments_count: same shape as bump_post_likes from 002.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_post_comments(p_post_id uuid, p_delta integer)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE public.posts
  SET comments_count = greatest(0, coalesce(comments_count, 0) + p_delta)
  WHERE id = p_post_id
  RETURNING comments_count;
$function$;

-- Server-only. See the note in 002 about why FROM PUBLIC is the line that
-- matters: a new function is executable by PUBLIC by default, and these are
-- SECURITY DEFINER with caller-supplied deltas.
REVOKE EXECUTE ON FUNCTION public.bump_post_metrics(uuid, integer, integer, integer, integer, integer, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bump_post_metrics_scored(uuid, integer, integer, integer, integer, integer, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bump_interest_score(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bump_post_comments(uuid, integer) FROM PUBLIC, anon, authenticated;

COMMIT;

-- ROLLBACK
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.bump_post_metrics_scored(uuid, integer, integer, integer, integer, integer, integer, integer, numeric);
-- DROP FUNCTION IF EXISTS public.bump_post_metrics(uuid, integer, integer, integer, integer, integer, integer, integer, numeric);
-- DROP FUNCTION IF EXISTS public.bump_interest_score(uuid, text, integer);
-- DROP FUNCTION IF EXISTS public.bump_post_comments(uuid, integer);
-- COMMIT;
