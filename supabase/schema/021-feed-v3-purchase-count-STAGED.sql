-- 021-feed-v3-purchase-count-STAGED.sql
-- ⚠️ STAGED — NOT APPLIED. Apply only with Landon's explicit OK and a fresh
-- backup (Supabase free plan = no PITR). Merging this PR does NOT run it.
--
-- Adds posts.purchase_count to get_feed_v3 so the feed can render social
-- proof ("126 students" / "38 purchases"). The function body is IDENTICAL to
-- 014-feed-v3-rpc.sql except:
--   1. `purchase_count integer` appended to RETURNS TABLE
--   2. `coalesce(p.purchase_count, 0)` appended to both select branches
-- Changing RETURNS TABLE requires DROP + CREATE (create or replace cannot
-- change a function's return type), so the grants are re-issued below.
--
-- The client (lib/feedV3.ts) treats a missing column as null and renders
-- nothing, so deploy order does not matter: client-first shows no proof,
-- migration-first is ignored until the client ships. Either order is safe.
-- The UI threshold (lib/socialProof.ts SOCIAL_PROOF_MIN_COUNT) ships OFF.
--
-- Security: unchanged from 014. purchase_count is already readable through
-- the posts table's public SELECT policy; browsers cannot UPDATE it (010).

begin;

drop function if exists public.get_feed_v3(text, integer, integer);

create function public.get_feed_v3(
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
  purchase_count integer
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
      coalesce(p.purchase_count, 0)
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
      )),
      x.r_purchase_count
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
        coalesce(p.purchase_count, 0) as r_purchase_count
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
-- 1. Function exists, SECURITY DEFINER, search_path pinned, 23 output columns:
--    select proname, prosecdef, proconfig, pronargs,
--           array_length(proallargtypes, 1) as all_args
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and proname = 'get_feed_v3';
--    (expect prosecdef = true, proconfig = {search_path=public}, all_args = 26 = 3 in + 23 out)
-- 2. purchase_count is present and never null:
--    select post_id, purchase_count from get_feed_v3('discover', 5, 0);
--    (expect: integer >= 0 on every row, no NULLs)
-- 3. It matches the table (same rows, same values):
--    select count(*) as mismatches
--    from get_feed_v3('discover', 50, 0) f
--    join posts p on p.id = f.post_id
--    where coalesce(p.purchase_count, 0) <> f.purchase_count;
--    (expect: 0)
-- 4. Ordering unchanged vs. the 014 definition (compare post_id order of
--    get_feed_v3('discover', 20, 0) before and after — must be identical).
-- 5. Grants survived the DROP:
--    select grantee, privilege_type from information_schema.routine_privileges
--    where routine_name = 'get_feed_v3';
--    (expect anon, authenticated, service_role EXECUTE)

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Re-run supabase/schema/014-feed-v3-rpc.sql after:
--    drop function if exists public.get_feed_v3(text, integer, integer);
-- (014 uses create or replace; the DROP first is required because the return
-- type differs.) The client tolerates the column disappearing (maps to null).
