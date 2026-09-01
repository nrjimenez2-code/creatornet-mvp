-- 015-analytics-rollup.sql  (P5 — creator analytics performance)
--
-- ✅ APPLIED TO PRODUCTION 2026-09-01 (Landon's explicit OK). Recorded here as the
-- as-built record. Applied in 4 stages via mcp apply_migration, names:
--   015_analytics_rollup_stage1_table_and_refresh_fn
--   (stage 2 backfill run as SELECT: refresh_post_events_daily('2026-04-01', current_date))
--   015_analytics_rollup_stage3_creator_kpis_repointed
--   015_analytics_rollup_stage4_views_timeseries_repointed
--   015_analytics_rollup_stage5_nightly_cron
--   015_analytics_rollup_fix_refresh_fn_grants   <-- SEE "GRANT FIX" BELOW
--
-- ⚠️ GRANT FIX (found by the check block, folded in below): the original
-- `revoke all ... from public` did NOT remove EXECUTE from anon/authenticated,
-- because Supabase default privileges grant it explicitly to those roles on every
-- new function in schema public. That briefly left this SECURITY DEFINER
-- aggregate-and-write function anon-callable. Now revoked BY NAME and verified:
-- has_function_privilege(anon)=false, (authenticated)=false, (service_role)=true.
-- Any future function in this schema must revoke from anon+authenticated BY NAME.
--
-- VERIFIED AFTER APPLY (prod, read-only):
--   * backfill: 754 rollup rows, 2026-04-27..2026-09-01; rollup views 1106 vs raw
--     full-day 1105 — differs by exactly today's 1 view (today is served raw), correct.
--   * old-vs-new KPI equality: 3 busiest creators x 2 ranges = 6/6 EXACT matches
--     (537/119, 367/84, 143/39 views).
--   * timeseries: 15/15 days exact, totals 119 = 119.
--   * cron 'refresh-post-events-daily' active, '10 0 * * *'.
--   * owner gates + SECURITY DEFINER + search_path preserved on both RPCs; ACLs
--     unchanged (authenticated + service_role, no anon).
--   * post_events_daily: RLS on, 0 policies, anon/authenticated SELECT = false.
--   * plan: Index Scan using idx_ped_creator_day, 0.173 ms (was a full raw scan
--     with a non-sargable ::date cast).
--
-- KNOWN LIMITATION (documented, not a blocker): between 00:00 and 00:10 UTC the
-- previous day is already read from the rollup but that day's row was last
-- refreshed by the 00:10 cron run on the day itself, so "yesterday" can
-- under-report for those 10 minutes, then self-heals when cron runs. Options if
-- it ever matters: move the job to 00:01, or run it hourly (the upsert is cheap
-- and idempotent).
--
-- ORIGINAL PRE-APPLY HEADER FOLLOWS.
-- Apply order (each step read-back-verified):
--   1. table + refresh function + grants
--   2. one-time backfill:  select public.refresh_post_events_daily('2026-04-01', current_date);
--   3. replace the two 3-arg RPCs
--   4. cron schedule
-- Rollback: drop the cron job, drop function refresh_post_events_daily, drop
-- table post_events_daily, and re-create the two RPCs from
-- ~/.creatornet/db-backup-2026-08-27-feed-rpcs/... (a fresh snapshot of BOTH
-- 3-arg RPC definitions must be taken immediately before applying — step 0).
--
-- What this fixes (verified live 2026-08-28): the LIVE 3-arg creator_kpis and
-- creator_views_timeseries scan raw post_events (2,108 rows and growing per
-- view/scroll) with a non-sargable `occurred_at::date BETWEEN` filter on every
-- dashboard load. After a high-traffic day that table is millions of rows and
-- the dashboard dies (spec Priority 5).
--
-- Design:
--   * post_events_daily — one row per (day, post_id, kind) with an event count.
--     Refreshed by an idempotent UPSERT function (no DELETEs anywhere).
--   * The RPCs read the rollup for FULL days (day < current_date) and scan raw
--     post_events ONLY for today, with a sargable timestamp range that uses the
--     existing idx_post_events_creator_occurred index.
--   * unique_clicks stays on raw buy_click rows for the whole range: distinct
--     users across a range cannot be derived from daily rollups, and buy_click
--     is the rarest event kind (5 rows today; purchase-intent scale, not
--     view scale) — sargable + kind-filtered it stays cheap forever.
--   * DB timezone is UTC (verified), so `occurred_at::date` grouping in the
--     rollup is byte-equivalent to the old filters. No day-boundary drift.
--   * auth.uid() owner checks in both RPCs preserved VERBATIM.
--   * Raw-event retention (the sanctioned DELETE) is deliberately NOT in this
--     migration — staged separately in 016 and needs its own explicit OK.

-- ── 1. Rollup table ─────────────────────────────────────────────────────────
create table if not exists public.post_events_daily (
  day        date   not null,
  creator_id uuid   not null,
  post_id    uuid   not null,
  kind       text   not null,
  events     bigint not null default 0,
  primary key (day, post_id, kind)
);

create index if not exists idx_ped_creator_day
  on public.post_events_daily (creator_id, day);

-- Nothing reads this table except SECURITY DEFINER RPCs; deny direct access.
alter table public.post_events_daily enable row level security;
revoke all on table public.post_events_daily from anon, authenticated;

-- ── 2. Refresh function (idempotent upsert, no deletes) ─────────────────────
create or replace function public.refresh_post_events_daily(p_from date, p_to date)
returns void
language sql
security definer
set search_path = public
as $fn$
  insert into public.post_events_daily (day, creator_id, post_id, kind, events)
  select ev.occurred_at::date, ev.creator_id, ev.post_id, ev.kind, count(*)
  from public.post_events ev
  where ev.occurred_at >= p_from::timestamptz
    and ev.occurred_at <  (p_to + 1)::timestamptz
  group by 1, 2, 3, 4
  on conflict (day, post_id, kind)
  do update set events = excluded.events, creator_id = excluded.creator_id;
$fn$;

revoke all on function public.refresh_post_events_daily(date, date) from public;
grant execute on function public.refresh_post_events_daily(date, date) to service_role;

-- ── 3. Repointed creator_kpis (3-arg; owner check preserved verbatim) ───────
create or replace function public.creator_kpis(p_start date, p_end date, p_creator_id uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_creator_id uuid;
  v_views bigint := 0;
  v_unique_clicks bigint := 0;
  v_checkouts_started bigint := 0;
  v_purchases bigint := 0;
  v_gmv_cents bigint := 0;
  v_refunds bigint := 0;
  v_bookings_completed bigint := 0;
  v_mentorship_paid bigint := 0;
  v_rollup_end date := least(p_end, current_date - 1);
  v_raw_start timestamptz := greatest(p_start, current_date)::timestamptz;
  v_range_end timestamptz := (p_end + 1)::timestamptz;
begin
  v_creator_id := coalesce(p_creator_id, auth.uid());

  -- Owner check. A caller may only ask about themselves.
  if v_creator_id is null or auth.uid() is null or v_creator_id <> auth.uid() then
    return jsonb_build_object(
      'views', 0, 'unique_clicks', 0, 'checkouts_started', 0, 'purchases', 0,
      'gmv_cents', 0, 'refunds', 0, 'bookings_completed', 0, 'mentorship_paid', 0
    );
  end if;

  -- Views + checkout starts: rollup for full days, raw ONLY for today.
  select
    coalesce((select sum(d.events) from public.post_events_daily d
              where d.creator_id = v_creator_id and d.kind = 'view'
                and d.day between p_start and v_rollup_end), 0)
    + coalesce((select count(*) from public.post_events ev
                where ev.creator_id = v_creator_id and ev.kind = 'view'
                  and ev.occurred_at >= v_raw_start
                  and ev.occurred_at <  v_range_end), 0),
    coalesce((select sum(d.events) from public.post_events_daily d
              where d.creator_id = v_creator_id and d.kind = 'checkout_start'
                and d.day between p_start and v_rollup_end), 0)
    + coalesce((select count(*) from public.post_events ev
                where ev.creator_id = v_creator_id and ev.kind = 'checkout_start'
                  and ev.occurred_at >= v_raw_start
                  and ev.occurred_at <  v_range_end), 0)
  into v_views, v_checkouts_started;

  -- Unique buy-clicks: raw for the whole range (distinct users cannot be
  -- summed from daily rollups); sargable + kind-filtered, tiny event class.
  select
    coalesce(count(distinct ev.user_id) filter (where ev.user_id is not null), 0)::bigint
    + coalesce(count(*) filter (where ev.user_id is null), 0)::bigint
  into v_unique_clicks
  from public.post_events ev
  where ev.creator_id = v_creator_id and ev.kind = 'buy_click'
    and ev.occurred_at >= p_start::timestamptz
    and ev.occurred_at <  v_range_end;

  -- Orders (same logic as before; date filter made sargable — UTC-equivalent).
  select
    coalesce(count(*) filter (where o.status = 'paid'), 0)::bigint,
    coalesce(sum(case when o.status = 'paid' then o.gross_amount else 0 end), 0)::bigint,
    coalesce(count(*) filter (where o.status = 'refunded'), 0)::bigint
  into v_purchases, v_gmv_cents, v_refunds
  from public.orders o
  where o.creator_id = v_creator_id
    and o.created_at >= p_start::timestamptz
    and o.created_at <  v_range_end;

  if to_regclass('public.bookings') is not null then
    execute $q$
      select coalesce(count(*), 0)::bigint
      from public.bookings b
      where b.creator_id = $1
        and b.status = 'completed'
        and b.created_at >= $2::timestamptz
        and b.created_at <  ($3 + 1)::timestamptz
    $q$
    into v_bookings_completed
    using v_creator_id, p_start, p_end;
  end if;

  if to_regclass('public.purchases') is not null and to_regclass('public.products') is not null then
    execute $q$
      select coalesce(count(*), 0)::bigint
      from public.purchases pu
      join public.products pr on pr.product_id = pu.product_id
      where pu.creator_id = $1
        and pu.status = 'complete'
        and pr.type = 'mentorship'
        and pu.created_at >= $2::timestamptz
        and pu.created_at <  ($3 + 1)::timestamptz
    $q$
    into v_mentorship_paid
    using v_creator_id, p_start, p_end;
  end if;

  return jsonb_build_object(
    'views', coalesce(v_views, 0),
    'unique_clicks', coalesce(v_unique_clicks, 0),
    'checkouts_started', coalesce(v_checkouts_started, 0),
    'purchases', coalesce(v_purchases, 0),
    'gmv_cents', coalesce(v_gmv_cents, 0),
    'refunds', coalesce(v_refunds, 0),
    'bookings_completed', coalesce(v_bookings_completed, 0),
    'mentorship_paid', coalesce(v_mentorship_paid, 0)
  );
end;
$fn$;

-- ── 4. Repointed creator_views_timeseries (3-arg; owner gate preserved) ─────
create or replace function public.creator_views_timeseries(p_start date, p_end date, p_creator_id uuid default null::uuid)
returns table(date text, views bigint)
language sql
security definer
set search_path = public
as $fn$
  with creator as (
    -- Owner check: resolves to NULL (so the joins below match nothing and
    -- every day reads 0) unless the caller asks about themselves.
    select case
      when auth.uid() is null then null
      when coalesce(p_creator_id, auth.uid()) = auth.uid() then auth.uid()
      else null
    end as creator_id
  ),
  days as (
    select gs::date as d
    from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') gs
  ),
  rollup_days as (
    select d.day as d, sum(d.events)::bigint as views
    from public.post_events_daily d
    join creator c on c.creator_id is not null and d.creator_id = c.creator_id
    where d.kind = 'view'
      and d.day between p_start and least(p_end, current_date - 1)
    group by d.day
  ),
  today_raw as (
    select ev.occurred_at::date as d, count(*)::bigint as views
    from public.post_events ev
    join creator c on c.creator_id is not null and ev.creator_id = c.creator_id
    where ev.kind = 'view'
      and ev.occurred_at >= greatest(p_start, current_date)::timestamptz
      and ev.occurred_at <  (p_end + 1)::timestamptz
    group by ev.occurred_at::date
  )
  select
    to_char(days.d, 'YYYY-MM-DD') as date,
    coalesce(r.views, 0) + coalesce(t.views, 0) as views
  from days
  left join rollup_days r on r.d = days.d
  left join today_raw  t on t.d = days.d
  order by days.d;
$fn$;

-- ── 5. Nightly refresh via pg_cron (00:10 UTC; re-covers the last 3 days) ───
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'refresh-post-events-daily') then
    perform cron.unschedule('refresh-post-events-daily');
  end if;
  perform cron.schedule(
    'refresh-post-events-daily',
    '10 0 * * *',
    $job$select public.refresh_post_events_daily((current_date - 2), current_date)$job$
  );
end
$do$;

-- ── CHECK BLOCK (run after applying; paste output) ──────────────────────────
-- 1. Backfill ran and covers the data:
--    select count(*) as rollup_rows, min(day), max(day),
--           (select sum(events) from post_events_daily where kind='view') as rollup_views,
--           (select count(*) from post_events where kind='view'
--             and occurred_at < current_date::timestamptz) as raw_full_day_views
--    from post_events_daily;   -- rollup_views must equal raw_full_day_views
-- 2. Old-vs-new KPI equality for a real creator (run the old body's expressions
--    side by side — see docs/P5-VERIFICATION-2026-08-28.sql).
-- 3. Cron registered: select jobname, schedule from cron.job;
