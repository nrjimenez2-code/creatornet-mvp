-- Feed ranking function — run in Supabase SQL editor.
-- Combines user interest score + post engagement + post conversion score.
-- Safe to re-run: uses CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION get_feed_v2(
  p_user_id UUID,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  post_id UUID,
  feed_score NUMERIC
)
LANGUAGE sql
AS $$
  SELECT
    p.id AS post_id,
    COALESCE(uis.score, 0)
    + (COALESCE(pm.views, 0) * 1)
    + (COALESCE(pm.completions, 0) * 3)
    + (COALESCE(p.likes_count, 0) * 5)
    + COALESCE(pm.post_conversion_score, 0)
    AS feed_score
  FROM posts p
  LEFT JOIN post_metrics pm ON pm.post_id = p.id
  LEFT JOIN user_interest_scores uis
    ON uis.user_id = p_user_id
    AND uis.category = LOWER(p.interests[1])
  WHERE p.video_url IS NOT NULL OR p.poster_url IS NOT NULL
  ORDER BY feed_score DESC, p.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
$$;
