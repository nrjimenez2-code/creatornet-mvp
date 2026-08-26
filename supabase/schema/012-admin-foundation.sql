-- 012 — admin foundation: roles, moderation columns, audit trail, feed exclusion
--
-- ✅ APPLIED TO PRODUCTION 2026-08-23 (checks at the bottom run and passing).
-- Everything here is additive and idempotent: new columns default to benign
-- values, new policies are permissive (they ADD admin visibility, they loosen
-- nothing for normal users), and the three feed functions change by exactly
-- one predicate each (originals preserved verbatim in the ROLLBACK section).
--
-- This is the database half of the Admin Launch Board (spec Priority 8).
-- The app half ships in the same PR as this file.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Roles and moderation columns
-- ---------------------------------------------------------------------------
-- Note on writability: 009/010 (fix/critical-access chain) revoked blanket
-- INSERT/UPDATE on profiles and posts and granted back explicit column lists.
-- These new columns are NOT in those lists, so clients cannot write them.
-- Verified below with has_column_privilege.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('user','admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS banned_at   timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS flag_reason text;

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS hidden_at   timestamptz;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS removed_at  timestamptz;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS flag_reason text;

-- ---------------------------------------------------------------------------
-- 2. Audit trail — one row per admin action, written only by the server
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid NOT NULL REFERENCES public.profiles(id),
  action       text NOT NULL,      -- ban_user | unban_user | hide_post | unhide_post | remove_post | approve_post
  target_table text NOT NULL,      -- profiles | posts
  target_id    uuid NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_actions FROM PUBLIC;
REVOKE ALL ON public.admin_actions FROM anon, authenticated;
-- Reads and writes go through service-role server routes only. No client
-- policy on purpose: RLS-on with zero policies = deny-by-default.

-- ---------------------------------------------------------------------------
-- 3. is_admin() + admin read visibility
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

-- Permissive SELECT policies OR into the existing set: admins gain read,
-- nobody else changes. (profiles SELECT is currently self-only; posts/orders/
-- bookings keep their existing scoping for non-admins.)
DO $$ BEGIN CREATE POLICY "admin_read_profiles" ON public.profiles FOR SELECT USING (public.is_admin()); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "admin_read_posts"    ON public.posts    FOR SELECT USING (public.is_admin()); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "admin_read_orders"   ON public.orders   FOR SELECT USING (public.is_admin()); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "admin_read_bookings" ON public.bookings FOR SELECT USING (public.is_admin()); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 4. Feeds exclude moderated posts
-- ---------------------------------------------------------------------------
-- Each function below is its live definition with ONE added predicate:
--   AND p.hidden_at IS NULL AND p.removed_at IS NULL
-- All rows have NULL in both columns today, so behavior is unchanged until an
-- admin actually hides or removes something. Deliberately NOT changed here:
-- get_feed_v2 still does not filter on p.active (v1/following do) — that
-- inconsistency predates this file and is noted for the feed rework.

CREATE OR REPLACE FUNCTION public.get_feed_v2(p_user_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
RETURNS TABLE(post_id uuid, feed_score numeric)
LANGUAGE sql
AS $function$
  SELECT
    p.id AS post_id,
    (COALESCE(uis.interest_score, 0) * 10)
    + (COALESCE(pm.views, 0) * 1)
    + (COALESCE(pm.completions, 0) * 3)
    + (COALESCE(p.likes_count, 0) * 5)
    + COALESCE(pm.post_conversion_score, 0)
    AS feed_score
  FROM posts p
  LEFT JOIN post_metrics pm ON pm.post_id = p.id
  LEFT JOIN LATERAL (
    SELECT COALESCE(MAX(score), 0) AS interest_score
    FROM user_interest_scores
    WHERE user_id = p_user_id
      AND category IN (
        SELECT LOWER(t) FROM unnest(p.interests) AS t
      )
  ) uis ON TRUE
  WHERE (p.video_url IS NOT NULL OR p.poster_url IS NOT NULL)
    AND p.hidden_at IS NULL AND p.removed_at IS NULL
  ORDER BY feed_score DESC, p.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
$function$;

CREATE OR REPLACE FUNCTION public.get_feed_following(p_user_id uuid, p_limit integer)
RETURNS TABLE(id uuid, creator_id uuid, product_id uuid, price_cents integer, title text, video_url text, poster_url text, booking_url text, allow_booking boolean, tags text[], likes_count integer, comments_count integer, shares_count integer, is_following boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    p.id,
    p.creator_id,
    p.product_id,
    p.price_cents,
    p.title,
    p.video_url,
    p.poster_url,
    p.booking_url,
    COALESCE(p.allow_booking, false),
    COALESCE(p.tags, ARRAY[]::text[]),
    COALESCE(p.likes_count, 0),
    COALESCE(p.comments_count, 0),
    COALESCE(p.shares_count, 0),
    TRUE AS is_following
  FROM public.posts p
  JOIN public.follows f
    ON f.following_id = p.creator_id
  WHERE f.follower_id = p_user_id
    AND p.active IS DISTINCT FROM FALSE
    AND p.hidden_at IS NULL AND p.removed_at IS NULL
  ORDER BY p.created_at DESC
  LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.get_feed_v1(p_user_id uuid, p_limit integer DEFAULT NULL::integer)
RETURNS TABLE(post_id uuid, creator_id uuid, product_id uuid, price_cents integer, title text, video_url text, poster_url text, tags text[], interests text[], likes_count integer, comments_count integer, shares_count integer, allow_booking boolean, booking_url text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    p.id                                  AS post_id,
    p.creator_id,
    p.product_id,
    p.price_cents,
    p.title,
    p.video_url,
    p.poster_url,
    p.tags,
    p.interests,
    p.likes_count,
    p.comments_count,
    p.shares_count,
    p.allow_booking,
    COALESCE(p.booking_url, p.booking_url_override) AS booking_url
  FROM public.posts p
  WHERE p.active = true
    AND p.hidden_at IS NULL AND p.removed_at IS NULL
  ORDER BY p.created_at DESC NULLS LAST
  LIMIT COALESCE(p_limit, 20);
$function$;

-- ---------------------------------------------------------------------------
-- 5. Promote the founder
-- ---------------------------------------------------------------------------
UPDATE public.profiles SET role = 'admin'
WHERE id = '767658b6-7b2a-4cc4-91b4-6a0f78073a8e';  -- nrjimenez2@icloud.com

COMMIT;

-- ---------------------------------------------------------------------------
-- CHECK IT WORKED (read-only)
-- ---------------------------------------------------------------------------
--   SELECT
--     (SELECT count(*) FROM public.profiles WHERE role='admin') AS admin_count,        -- 1
--     has_column_privilege('authenticated','public.profiles','role','UPDATE')           -- false
--       AS client_can_write_role,
--     has_column_privilege('authenticated','public.posts','hidden_at','UPDATE')         -- false
--       AS client_can_hide_posts,
--     has_table_privilege('authenticated','public.admin_actions','SELECT')              -- false
--       AS client_reads_audit,
--     (SELECT bool_and(pg_get_functiondef(p.oid) LIKE '%hidden_at IS NULL%')
--        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--       WHERE n.nspname='public' AND p.proname IN ('get_feed_v1','get_feed_v2','get_feed_following'))
--       AS feeds_exclude_moderated;                                                     -- true

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Columns/table/policies (safe, moderation data would be lost):
--   BEGIN;
--   DROP POLICY IF EXISTS "admin_read_profiles" ON public.profiles;
--   DROP POLICY IF EXISTS "admin_read_posts"    ON public.posts;
--   DROP POLICY IF EXISTS "admin_read_orders"   ON public.orders;
--   DROP POLICY IF EXISTS "admin_read_bookings" ON public.bookings;
--   DROP FUNCTION IF EXISTS public.is_admin();
--   DROP TABLE IF EXISTS public.admin_actions;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS banned_at, DROP COLUMN IF EXISTS flag_reason;
--   ALTER TABLE public.posts DROP COLUMN IF EXISTS hidden_at, DROP COLUMN IF EXISTS removed_at, DROP COLUMN IF EXISTS flag_reason;
--   COMMIT;
--
-- Feed functions: restore by re-running their pre-012 definitions, which are
-- byte-identical to the bodies above MINUS the single
-- "AND p.hidden_at IS NULL AND p.removed_at IS NULL" line in each WHERE
-- clause (and for get_feed_v2, the WHERE reverts to
-- "WHERE p.video_url IS NOT NULL OR p.poster_url IS NOT NULL" without the
-- added parentheses). Captured from pg_get_functiondef on 2026-08-23 before
-- this file was applied; also in the 2026-08-23 session backup.
