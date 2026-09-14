-- 101 — show creator name, @handle and avatar to SIGNED-OUT feed visitors.
--
-- ============================================================================
-- ✅ APPLIED TO PRODUCTION 2026-09-13 ~00:10Z (project rvkqxgghqitkwzdsuclz),
--    with Landon's explicit approval. Verified after apply:
--      · 1 overload, SECURITY DEFINER, search_path pinned to public, 27 args
--        (3 in + 24 out) — 023's creator_verified and 025's purchase_count
--        both survived, no column regression
--      · EXECUTE still granted to anon, authenticated, postgres, service_role
--      · anon RPC now returns creator_name / creator_username /
--        creator_avatar_url populated on every row
--      · www.creatornet.net/dashboard SIGNED OUT now renders "luis", "luis",
--        "Noah Jimenez" — the generic "Creator" placeholder is gone
--    ROLLBACK: re-run 023 (see ROLLBACK below), or restore the pre-apply
--    definition captured at apply time.
--
-- ⚠️ ONE CHANGE WAS MADE AT APPLY TIME, and it matters:
--    this file said `create function public.get_feed_v3(` — but the function
--    already existed with the identical (text, integer, integer) signature, so
--    that fails with 42723 "function already exists" and the whole transaction
--    rolls back. It could never have applied as written. It was applied as
--    `create or replace function`, which also fails closed if the 24-column
--    return type ever drifts. The line below is corrected to what actually ran.
-- It widens what an anonymous caller can read, so it is a security-posture
-- decision, not a bug fix. (Note: in this repo a "-STAGED"/"UNAPPLIED" marker
-- is NOT reliable — 023 is named STAGED and IS live. Verify with a probe, not
-- the filename.)
-- ============================================================================
--
-- THE PROBLEM
-- get_feed_v3 returns creator_name / creator_username / creator_avatar_url as
-- NULL when auth.uid() is null. Every signed-out visitor therefore sees a feed
-- where all three cards read "Creator" with a default avatar. That is the front
-- door of the product and the first thing a launch visitor sees.
-- Confirmed live 2026-09-11 on www.creatornet.net/dashboard signed out.
--
-- WHY THIS IS NOT PROTECTING ANYTHING
-- The same fields are already published to anonymous visitors on the creator
-- page, which is server-rendered with the service role:
--   GET /creators/luis  (signed out) -> renders name "luis", handle "@luis",
--   the full bio and follower counts, and puts "luis (@luis) · CreatorNet" in
--   the <title>.
-- So the data is public one click away. The feed gate costs a good first
-- impression and buys no privacy.
--
-- WHY IT WAS WRITTEN THIS WAY
-- 014's header explains it: the service-role /api/profiles route that
-- get_feed_v3 replaced required an authenticated caller, so v3 preserved that
-- posture rather than widening it. A deliberate, conservative choice — made
-- before this was the public front door.
--
-- WHAT CHANGES
-- Exactly three lines. Based on the definition VERIFIED LIVE: the production
-- response returns all 24 columns of 023, including creator_verified AND
-- purchase_count, which uniquely identifies 023 as the deployed version.
--
--   -  case when v_uid is not null then x.r_creator_name end,
--   -  case when v_uid is not null then x.r_creator_username end,
--   -  case when v_uid is not null then x.r_creator_avatar_url end,
--   +  x.r_creator_name,
--   +  x.r_creator_username,
--   +  x.r_creator_avatar_url,
--
-- Nothing else moves. is_liked and is_following still only ever reveal the
-- caller's own rows; the viewer is still auth.uid() and never a parameter;
-- the limit/offset caps are unchanged; feed_score is still not returned.
--
-- WHAT DOES NOT CHANGE
-- Nothing here exposes email, phone, Stripe ids, earnings or any private
-- profile column. Only the three display fields the creator page already shows.
--
-- ROLLBACK
-- Re-run supabase/schema/023-feed-v3-verified-seller-STAGED.sql, which restores
-- the gated definition exactly.

begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
begin
  -- Refuse to run against anything but the expected live shape.
  if to_regclass('public.posts') is null or to_regclass('public.profiles') is null then
    raise exception 'feed prerequisites missing'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='get_feed_v3'
  ) then raise exception 'get_feed_v3 does not exist; apply 023 first'; end if;
end;
$preflight$;

create or replace function public.get_feed_v3(
  p_tab text default 'discover',
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  post_id uuid,
  creator_id uuid,
  product_id uuid,
  price_cents integer,
  title text,
  video_url text,
  poster_url text,
  interests text[],
  hashtags text[],
  created_at timestamptz,
  likes_count integer,
  comments_count integer,
  shares_count integer,
  allow_booking boolean,
  booking_url text,
  creator_name text,
  creator_username text,
  creator_avatar_url text,
  product_type text,
  product_price_cents integer,
  is_liked boolean,
  is_following boolean,
  purchase_count integer,
  creator_verified boolean
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 2000);
begin
  if p_tab = 'following' then
    -- Following feed requires a logged-in viewer.
    if v_uid is null then
      return;
    end if;

    return query
    select
      p.id,
      p.creator_id,
      p.product_id,
      p.price_cents,
      p.title,
      p.video_url,
      p.poster_url,
      p.interests,
      p.hashtags,
      p.created_at,
      coalesce(p.likes_count, 0),
      coalesce(p.comments_count, 0),
      coalesce(p.shares_count, 0),
      coalesce(p.allow_booking, false),
      p.booking_url,
      prof.full_name,
      prof.username,
      prof.avatar_url,
      prod.p_type,
      prod.p_price,
      exists (
        select 1 from likes l
        where l.user_id = v_uid and l.post_id = p.id
      ),
      true,
      coalesce(p.purchase_count, 0),
      (prof.stripe_account_id is not null and coalesce(prof.stripe_onboarding_complete, false))
    from posts p
    join follows f
      on f.following_id = p.creator_id
     and f.follower_id = v_uid
    left join profiles prof on prof.id = p.creator_id
    left join lateral (
      select pr.type as p_type,
             case
               when pr.amount_cents > 0 then pr.amount_cents
               when pr.price_cents  > 0 then pr.price_cents
               else null
             end as p_price
      from products pr
      where p.product_id is not null
        and (pr.id = p.product_id or pr.product_id = p.product_id)
      order by (pr.id = p.product_id) desc
      limit 1
    ) prod on true
    where p.active is distinct from false
      and p.hidden_at is null
      and p.removed_at is null
      and (p.video_url is not null or p.poster_url is not null)
    order by p.created_at desc, p.id desc
    limit v_limit offset v_offset;

  else
    -- Discover: ranking formula byte-for-byte from get_feed_v2.
    return query
    select
      x.r_post_id,
      x.r_creator_id,
      x.r_product_id,
      x.r_price_cents,
      x.r_title,
      x.r_video_url,
      x.r_poster_url,
      x.r_interests,
      x.r_hashtags,
      x.r_created_at,
      x.r_likes_count,
      x.r_comments_count,
      x.r_shares_count,
      x.r_allow_booking,
      x.r_booking_url,
      x.r_creator_name,
      x.r_creator_username,
      x.r_creator_avatar_url,
      x.r_product_type,
      x.r_product_price_cents,
      (v_uid is not null and exists (
        select 1 from likes l
        where l.user_id = v_uid and l.post_id = x.r_post_id
      )),
      (v_uid is not null and exists (
        select 1 from follows f
        where f.follower_id = v_uid and f.following_id = x.r_creator_id
      )),
      x.r_purchase_count,
      x.r_creator_verified
    from (
      select
        p.id as r_post_id,
        p.creator_id as r_creator_id,
        p.product_id as r_product_id,
        p.price_cents as r_price_cents,
        p.title as r_title,
        p.video_url as r_video_url,
        p.poster_url as r_poster_url,
        p.interests as r_interests,
        p.hashtags as r_hashtags,
        p.created_at as r_created_at,
        coalesce(p.likes_count, 0) as r_likes_count,
        coalesce(p.comments_count, 0) as r_comments_count,
        coalesce(p.shares_count, 0) as r_shares_count,
        coalesce(p.allow_booking, false) as r_allow_booking,
        p.booking_url as r_booking_url,
        (coalesce(uis.interest_score, 0) * 10)
          + (coalesce(pm.views, 0) * 1)
          + (coalesce(pm.completions, 0) * 3)
          + (coalesce(p.likes_count, 0) * 5)
          + coalesce(pm.post_conversion_score, 0) as r_feed_score,
        prof.full_name as r_creator_name,
        prof.username as r_creator_username,
        prof.avatar_url as r_creator_avatar_url,
        prod.p_type as r_product_type,
        prod.p_price as r_product_price_cents,
        coalesce(p.purchase_count, 0) as r_purchase_count,
        (prof.stripe_account_id is not null and coalesce(prof.stripe_onboarding_complete, false)) as r_creator_verified
      from posts p
      left join post_metrics pm on pm.post_id = p.id
      left join profiles prof on prof.id = p.creator_id
      left join lateral (
        select coalesce(max(score), 0) as interest_score
        from user_interest_scores
        where user_id = v_uid
          and category in (
            select lower(t) from unnest(p.interests) as t
          )
      ) uis on true
      left join lateral (
        select pr.type as p_type,
               case
                 when pr.amount_cents > 0 then pr.amount_cents
                 when pr.price_cents  > 0 then pr.price_cents
                 else null
               end as p_price
        from products pr
        where p.product_id is not null
          and (pr.id = p.product_id or pr.product_id = p.product_id)
        order by (pr.id = p.product_id) desc
        limit 1
      ) prod on true
      where (p.video_url is not null or p.poster_url is not null)
        and p.hidden_at is null
        and p.removed_at is null
        and p.active is distinct from false
    ) x
    order by x.r_feed_score desc, x.r_created_at desc, x.r_post_id desc
    limit v_limit offset v_offset;
  end if;
end;
$fn$;

revoke all on function public.get_feed_v3(text, integer, integer) from public;
grant execute on function public.get_feed_v3(text, integer, integer)
  to anon, authenticated, service_role;


commit;

-- ── CHECK BLOCK (run after applying; paste output) ──────────────────────────
-- 1. Function exists, SECURITY DEFINER, search_path pinned, 24 output columns:
--    select proname, prosecdef, proconfig, pronargs,
--           array_length(proallargtypes, 1) as all_args
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and proname = 'get_feed_v3';
--    (expect prosecdef = true, proconfig = {search_path=public}, all_args = 27 = 3 in + 24 out)
-- 2. creator_verified is present, boolean, never null, on both tabs:
--    select post_id, creator_verified from get_feed_v3('discover', 5, 0);
--    select post_id, creator_verified from get_feed_v3('following', 5, 0);
--    (expect: true/false on every row, no NULLs; following is empty when anon)
-- 3. It matches the profiles rule exactly (same rows, same verdict):
--    select count(*) as mismatches
--    from get_feed_v3('discover', 50, 0) f
--    left join profiles pr on pr.id = f.creator_id
--    where (pr.stripe_account_id is not null
--           and coalesce(pr.stripe_onboarding_complete, false)) <> f.creator_verified;
--    (expect: 0)
-- 4. purchase_count from 025 survived (not silently dropped):
--    select count(*) as mismatches
--    from get_feed_v3('discover', 50, 0) f
--    join posts p on p.id = f.post_id
--    where coalesce(p.purchase_count, 0) <> f.purchase_count;
--    (expect: 0)
-- 5. Ordering unchanged vs. the 025 definition (compare post_id order of
--    get_feed_v3('discover', 20, 0) before and after — must be identical).
-- 6. Grants survived the DROP:
--    select grantee, privilege_type from information_schema.routine_privileges
--    where routine_name = 'get_feed_v3';
--    (expect anon, authenticated, service_role EXECUTE)
-- 7. No raw Stripe id leaks through the function:
--    select pg_get_functiondef('public.get_feed_v3(text,integer,integer)'::regprocedure)
--      not like '%stripe_account_id,%' as no_raw_id_column;
--    (expect: true — the column only appears inside the "is not null" test)

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Re-run supabase/schema/025-feed-v3-purchase-count-STAGED.sql as-is (it
-- begins with the required `drop function if exists`, so the return-type
-- change is handled). To roll back 025 as well, follow 025's own ROLLBACK
-- (drop, then re-run 014). The client tolerates the column disappearing
-- (a missing creator_verified maps to false — no badge, nothing else changes).
commit;
