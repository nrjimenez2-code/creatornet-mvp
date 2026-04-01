-- User interest scores table — run in Supabase SQL editor.
-- Tracks per-user, per-category interest scores built from behavior.
-- Safe to re-run: uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public.user_interest_scores (
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

ALTER TABLE public.user_interest_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own scores" ON public.user_interest_scores;
CREATE POLICY "Users read own scores"
  ON public.user_interest_scores FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access" ON public.user_interest_scores;
CREATE POLICY "Service role full access"
  ON public.user_interest_scores FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_user_interest_scores_user_id ON public.user_interest_scores (user_id);
CREATE INDEX IF NOT EXISTS idx_user_interest_scores_category ON public.user_interest_scores (user_id, category);

COMMENT ON TABLE public.user_interest_scores IS 'Per-user category interest scores. Updated continuously via server-side helpers based on watch behavior, likes, purchases etc.';
