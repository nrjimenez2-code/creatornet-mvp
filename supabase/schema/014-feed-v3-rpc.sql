-- 014-feed-v3-rpc.sql
-- P2 feed scaling: get_feed_v3 — ONE call returning everything FeedList needs.
--
-- ⚠️ DEPLOY ORDER: apply this in prod BEFORE (or with) the FeedList client
-- deploy. The rewritten client has no fallback to the old RPCs — if the
-- client ships first, every feed load shows the error state until this runs.
--
-- Replaces the client-side 7-round-trip waterfall (get_feed_v2 → posts re-fetch →
-- /api/posts/product-ids → products → /api/profiles → likes → follows) with a
-- single RPC. Ranking formula and filters are IDENTICAL to get_feed_v2 for the
-- discover tab, and to get_feed_following for the following tab, except:
--   1. A deterministic final tiebreaker (p.id desc) so offset pagination can
--      never duplicate/skip rows on exact score+created_at ties.
--   2. The following tab now filters media-less posts server-side (the client
--      already dropped them after fetch) and supports offset pagination.
--   3. Product meta joins products by PK first (pr.id = posts.product_id),
--      falling back to the legacy product_id column. The old client join used
--      ONLY the legacy column and silently lost meta for 13 of 24 posts; the PK
--      path matches the server-side checkout (resolvePostForProduct). Verified
--      2026-08-26: 0 rows where the two paths disagree.
--
-- Security model (mirrors what the app enforces today):
--   * SECURITY DEFINER because profiles RLS is owner-read-only; the feed needs
--     creator name/username/avatar. The service-role /api/profiles route this
--     replaces required an authenticated caller, so profile fields are gated:
--     anonymous callers get NULL creator_name/username/avatar_url.
--   * The viewer is ALWAYS auth.uid() — never a client-supplied parameter
--     (get_feed_v2 trusted p_user_id from the client; v3 closes that).
--   * is_liked / is_following only ever reveal the caller's own rows.
--   * p_limit hard-capped at 50, p_offset at 2000 — the function is publicly
--     callable; nobody gets to ask the free-plan database for 100k rows or a
--     giant top-N sort in one call.
--   * feed_score is used for ordering but NOT returned. post_metrics SELECT is
--     public today (verified 2026-08-26: USING(true) for public), so returning
--     the score would leak nothing new — but the client never reads it, and
--     omitting it keeps this function safe if post_metrics reads are ever
--     locked down post-launch.
--   * Discover adds `active is distinct from false` (get_feed_v2 didn't check
--     it; get_feed_following did). Verified a no-op on live data — 0 eligible
--     posts have active=false — but it closes the gap if a future "pause my
--     post" feature starts using the column.

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
  is_following boolean
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
      true
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
      case when v_uid is not null then x.r_creator_name end,
      case when v_uid is not null then x.r_creator_username end,
      case when v_uid is not null then x.r_creator_avatar_url end,
      x.r_product_type,
      x.r_product_price_cents,
      (v_uid is not null and exists (
        select 1 from likes l
        where l.user_id = v_uid and l.post_id = x.r_post_id
      )),
      (v_uid is not null and exists (
        select 1 from follows f
        where f.follower_id = v_uid and f.following_id = x.r_creator_id
      ))
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
        prod.p_price as r_product_price_cents
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

-- ── CHECK BLOCK (run after applying; paste output) ──────────────────────────
-- 1. Function exists, is SECURITY DEFINER, search_path pinned:
--    select proname, prosecdef, proconfig
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and proname = 'get_feed_v3';
-- 2. Anon-shaped call returns ranked rows with NULL profile fields:
--    select post_id, creator_name is null as name_hidden
--    from get_feed_v3('discover', 5, 0);
--    (run via SQL editor = superuser, auth.uid() is null → name_hidden = true)
-- 3. Ordering matches get_feed_v2 for the same window:
--    select v2.post_id = v3.post_id as same
--    from (select post_id, row_number() over () rn from get_feed_v2(null, 20, 0)) v2
--    join (select post_id, row_number() over () rn from get_feed_v3('discover', 20, 0)) v3
--    using (rn);
--    (expect: every row true)
