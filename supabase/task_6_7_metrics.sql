-- Task 6/7: optional metrics for creator earnings + post conversion (run after task_8).
-- Webhook increments these when present; safe to skip if you only want orders/purchases.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS total_earnings_cents BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS purchase_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.profiles.total_earnings_cents IS 'Sum of creator_amount from paid orders (webhook-maintained).';
COMMENT ON COLUMN public.posts.purchase_count IS 'Number of paid purchases linked to this post (webhook increment).';
