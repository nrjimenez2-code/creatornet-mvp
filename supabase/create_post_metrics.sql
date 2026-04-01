-- Post metrics table — run in Supabase SQL editor.
-- Tracks per-post performance for feed ranking (sales flywheel).
-- Safe to re-run: uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public.post_metrics (
  post_id UUID PRIMARY KEY REFERENCES public.posts (id) ON DELETE CASCADE,
  impressions INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  total_watch_seconds NUMERIC NOT NULL DEFAULT 0,
  avg_watch_time_seconds NUMERIC GENERATED ALWAYS AS (
    CASE WHEN views = 0 THEN 0 ELSE total_watch_seconds / views END
  ) STORED,
  completions INTEGER NOT NULL DEFAULT 0,
  completion_rate NUMERIC GENERATED ALWAYS AS (
    CASE WHEN views = 0 THEN 0 ELSE completions::numeric / views END
  ) STORED,
  profile_clicks INTEGER NOT NULL DEFAULT 0,
  buy_clicks INTEGER NOT NULL DEFAULT 0,
  checkout_starts INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  conversion_rate NUMERIC GENERATED ALWAYS AS (
    CASE WHEN views = 0 THEN 0 ELSE purchases::numeric / views END
  ) STORED,
  post_conversion_score NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.post_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read post metrics" ON public.post_metrics;
CREATE POLICY "Public read post metrics"
  ON public.post_metrics FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service role write post metrics" ON public.post_metrics;
CREATE POLICY "Service role write post metrics"
  ON public.post_metrics FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_post_metrics_post_id ON public.post_metrics (post_id);
CREATE INDEX IF NOT EXISTS idx_post_metrics_conversion_score ON public.post_metrics (post_conversion_score DESC);

COMMENT ON TABLE public.post_metrics IS 'Per-post performance metrics used for feed ranking (sales flywheel). Auto-created on post insert; updated via server-side helpers.';
