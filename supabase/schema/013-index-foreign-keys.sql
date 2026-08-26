-- 013 — index every foreign key (Priority 2/5: "add database indexes where needed")
--
-- ✅ APPLIED TO PRODUCTION 2026-08-23. Verified afterwards: zero unindexed
-- foreign keys remain (the check query is at the bottom).
--
-- WHY: Supabase's performance advisor flagged 20 foreign keys with no covering
-- index. The launch-relevant ones are the social/feed paths — comments.post_id
-- (every comment panel), likes.post_id (like lookups), follows.following_id
-- (follower checks and counts), post_events.user_id (analytics) — the rest are
-- cheap insurance at current size and correct hygiene at launch size.
-- Every statement was GENERATED from pg_constraint (not hand-typed), is
-- additive, idempotent, and instant at current row counts.
--
-- NOT done here, on purpose (flagged by the same advisor, needs its own pass):
--   * 10 duplicate indexes (e.g. purchases has three session_id indexes) —
--     dropping the extras is safe but deserves a reviewed list.
--   * 74 "auth_rls_initplan" policies re-evaluating auth.uid() per row —
--     meaningful at launch scale; fix is rewriting policies to
--     (SELECT auth.uid()), which belongs with a deliberate policy pass.
--   * 158 multiple-permissive-policy warnings — same policy pass.
--   * 2 tables with no primary key.

BEGIN;
CREATE INDEX IF NOT EXISTS idx_admin_actions_actor_id ON public.admin_actions (actor_id);
CREATE INDEX IF NOT EXISTS idx_booking_clicks_closer_id ON public.booking_clicks (closer_id);
CREATE INDEX IF NOT EXISTS idx_booking_clicks_viewer_id ON public.booking_clicks (viewer_id);
CREATE INDEX IF NOT EXISTS idx_booking_clicks_post_id ON public.booking_clicks (post_id);
CREATE INDEX IF NOT EXISTS idx_booking_payments_buyer_id ON public.booking_payments (buyer_id);
CREATE INDEX IF NOT EXISTS idx_booking_payments_product_id ON public.booking_payments (product_id);
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON public.comments (user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON public.comments (post_id);
CREATE INDEX IF NOT EXISTS idx_follows_following_id ON public.follows (following_id);
CREATE INDEX IF NOT EXISTS idx_likes_post_id ON public.likes (post_id);
CREATE INDEX IF NOT EXISTS idx_offerings_creator_id ON public.offerings (creator_id);
CREATE INDEX IF NOT EXISTS idx_orders_booking_id ON public.orders (booking_id);
CREATE INDEX IF NOT EXISTS idx_orders_offering_id ON public.orders (offering_id);
CREATE INDEX IF NOT EXISTS idx_post_engagements_user_id ON public.post_engagements (user_id);
CREATE INDEX IF NOT EXISTS idx_post_events_user_id ON public.post_events (user_id);
CREATE INDEX IF NOT EXISTS idx_post_likes_user_id ON public.post_likes (user_id);
CREATE INDEX IF NOT EXISTS idx_posts_user_id ON public.posts (user_id);
CREATE INDEX IF NOT EXISTS idx_profile_reviews_reviewer_id ON public.profile_reviews (reviewer_id);
CREATE INDEX IF NOT EXISTS idx_team_routing_default_closer_id ON public.team_routing (default_closer_id);
CREATE INDEX IF NOT EXISTS idx_watch_progress_post_id ON public.watch_progress (post_id);
COMMIT;

-- CHECK (read-only) — expect 0:
--   SELECT count(*) FROM pg_constraint c
--   WHERE c.contype='f' AND connamespace='public'::regnamespace
--     AND NOT EXISTS (
--       SELECT 1 FROM pg_index i
--       WHERE i.indrelid = c.conrelid
--         AND (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey::int2[]);
--
-- ROLLBACK: DROP INDEX IF EXISTS <name>; for any of the twenty above.
