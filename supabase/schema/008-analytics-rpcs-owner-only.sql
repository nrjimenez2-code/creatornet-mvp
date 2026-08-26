-- 008 — creator analytics RPCs: only the creator can read their own numbers
--
-- Run this in the Supabase SQL editor.
--
-- WHY
-- creator_kpis(p_start, p_end, p_creator_id) and
-- creator_views_timeseries(p_start, p_end, p_creator_id) are SECURITY DEFINER
-- (they have to be, post_events and orders are locked down) and EXECUTE on
-- them defaults to PUBLIC. They take p_creator_id from the caller and never
-- compare it to auth.uid(). So anyone holding the public anon key can pass
-- any creator's id and read their views, GMV, refunds, bookings and
-- mentorship sales.
--
-- WHAT THIS DOES
-- Replaces both functions with the same bodies plus one rule at the top:
-- p_creator_id must be NULL (meaning "me") or equal to auth.uid(). Anything
-- else returns the empty result, same shape as before, no error. Also
-- revokes EXECUTE from anon, since a signed-out visitor has no creator id.
--
-- The analytics page (app/dashboard/analytics/page.tsx) calls these as the
-- signed-in creator with their own id, so it is unaffected.
--
-- SAFETY
-- Replaces two functions in place. No table or data change. Rollback: rerun
-- the previous definitions from supabase/fix_creator_analytics_functions.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.creator_kpis(
  p_start DATE,
  p_end DATE,
  p_creator_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_creator_id UUID;
  v_views BIGINT := 0;
  v_unique_clicks BIGINT := 0;
  v_checkouts_started BIGINT := 0;
  v_purchases BIGINT := 0;
  v_gmv_cents BIGINT := 0;
  v_refunds BIGINT := 0;
  v_bookings_completed BIGINT := 0;
  v_mentorship_paid BIGINT := 0;
BEGIN
  v_creator_id := COALESCE(p_creator_id, auth.uid());

  -- Owner check. A caller may only ask about themselves.
  IF v_creator_id IS NULL OR auth.uid() IS NULL OR v_creator_id <> auth.uid() THEN
    RETURN jsonb_build_object(
      'views', 0,
      'unique_clicks', 0,
      'checkouts_started', 0,
      'purchases', 0,
      'gmv_cents', 0,
      'refunds', 0,
      'bookings_completed', 0,
      'mentorship_paid', 0
    );
  END IF;

  IF to_regclass('public.post_events') IS NOT NULL THEN
    SELECT
      COALESCE(COUNT(*) FILTER (WHERE ev.kind = 'view'), 0)::BIGINT,
      COALESCE(COUNT(DISTINCT ev.user_id) FILTER (WHERE ev.kind = 'buy_click' AND ev.user_id IS NOT NULL), 0)::BIGINT
        + COALESCE(COUNT(*) FILTER (WHERE ev.kind = 'buy_click' AND ev.user_id IS NULL), 0)::BIGINT,
      COALESCE(COUNT(*) FILTER (WHERE ev.kind = 'checkout_start'), 0)::BIGINT
    INTO
      v_views,
      v_unique_clicks,
      v_checkouts_started
    FROM public.post_events ev
    WHERE ev.creator_id = v_creator_id
      AND ev.occurred_at::date BETWEEN p_start AND p_end;
  END IF;

  SELECT
    COALESCE(COUNT(*) FILTER (WHERE o.status = 'paid'), 0)::BIGINT,
    COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.gross_amount ELSE 0 END), 0)::BIGINT,
    COALESCE(COUNT(*) FILTER (WHERE o.status = 'refunded'), 0)::BIGINT
  INTO
    v_purchases,
    v_gmv_cents,
    v_refunds
  FROM public.orders o
  WHERE o.creator_id = v_creator_id
    AND o.created_at::date BETWEEN p_start AND p_end;

  IF to_regclass('public.bookings') IS NOT NULL THEN
    EXECUTE $q$
      SELECT COALESCE(COUNT(*), 0)::BIGINT
      FROM public.bookings b
      WHERE b.creator_id = $1
        AND b.status = 'completed'
        AND b.created_at::date BETWEEN $2 AND $3
    $q$
    INTO v_bookings_completed
    USING v_creator_id, p_start, p_end;
  END IF;

  IF to_regclass('public.purchases') IS NOT NULL AND to_regclass('public.products') IS NOT NULL THEN
    EXECUTE $q$
      SELECT COALESCE(COUNT(*), 0)::BIGINT
      FROM public.purchases pu
      JOIN public.products pr ON pr.product_id = pu.product_id
      WHERE pu.creator_id = $1
        AND pu.status = 'complete'
        AND pr.type = 'mentorship'
        AND pu.created_at::date BETWEEN $2 AND $3
    $q$
    INTO v_mentorship_paid
    USING v_creator_id, p_start, p_end;
  END IF;

  RETURN jsonb_build_object(
    'views', COALESCE(v_views, 0),
    'unique_clicks', COALESCE(v_unique_clicks, 0),
    'checkouts_started', COALESCE(v_checkouts_started, 0),
    'purchases', COALESCE(v_purchases, 0),
    'gmv_cents', COALESCE(v_gmv_cents, 0),
    'refunds', COALESCE(v_refunds, 0),
    'bookings_completed', COALESCE(v_bookings_completed, 0),
    'mentorship_paid', COALESCE(v_mentorship_paid, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.creator_views_timeseries(
  p_start DATE,
  p_end DATE,
  p_creator_id UUID DEFAULT NULL
)
RETURNS TABLE(date TEXT, views BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH creator AS (
    -- Owner check: resolves to NULL (so the join below matches nothing and
    -- every day reads 0) unless the caller asks about themselves.
    SELECT CASE
      WHEN auth.uid() IS NULL THEN NULL
      WHEN COALESCE(p_creator_id, auth.uid()) = auth.uid() THEN auth.uid()
      ELSE NULL
    END AS creator_id
  ),
  days AS (
    SELECT gs::date AS d
    FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') gs
  ),
  views_by_day AS (
    SELECT
      ev.occurred_at::date AS d,
      COUNT(*)::BIGINT AS views
    FROM public.post_events ev
    JOIN creator c ON c.creator_id IS NOT NULL AND ev.creator_id = c.creator_id
    WHERE ev.kind = 'view'
      AND ev.occurred_at::date BETWEEN p_start AND p_end
    GROUP BY ev.occurred_at::date
  )
  SELECT
    to_char(days.d, 'YYYY-MM-DD') AS date,
    COALESCE(vbd.views, 0)::BIGINT AS views
  FROM days
  LEFT JOIN views_by_day vbd ON vbd.d = days.d
  ORDER BY days.d;
$$;

REVOKE EXECUTE ON FUNCTION public.creator_kpis(DATE, DATE, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.creator_views_timeseries(DATE, DATE, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.creator_kpis(DATE, DATE, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.creator_views_timeseries(DATE, DATE, UUID) TO authenticated, service_role;

-- The older two-argument overloads (no p_creator_id) only ever read
-- auth.uid(), so they cannot leak another creator's numbers, but a
-- signed-out caller has no reason to execute them either.
REVOKE EXECUTE ON FUNCTION public.creator_kpis(DATE, DATE) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.creator_views_timeseries(DATE, DATE) FROM PUBLIC, anon;

COMMIT;
