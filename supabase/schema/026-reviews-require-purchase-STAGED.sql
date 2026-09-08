-- 026-reviews-require-purchase-STAGED.sql
-- ✅ APPLIED TO PRODUCTION 2026-09-08 (migration 026_reviews_require_purchase),
--    with Landon's explicit go and a backup at
--    ~/.creatornet/db-backup-2026-09-07-reviews-and-feed/.
--    The filename still ends in -STAGED; treat THIS header as the truth.
--
--    Two corrections were made to this file BEFORE it was applied:
--      1. `coalesce(status,'') not in (...)` -> `status not in (...)`. PostgREST's
--         .not("status","in",...) drops a NULL status, so the coalesce would have
--         made this policy MORE PERMISSIVE than the route it mirrors.
--      2. The helper now also takes p_creator and joins posts, mirroring the
--         route's isPostOwnedByCreator gate. Without it a buyer with one real
--         purchase could POST to PostgREST and attach the review to a DIFFERENT
--         creator, because the reviews page lists by creator_id.
--
--    Verified after applying: anon forging a review through PostgREST now gets
--    42501 permission denied (it held an INSERT grant before); anon can still
--    READ reviews (200); admin moderation is unaffected because
--    app/api/admin/remove-review uses the service role and bypasses RLS.
--    Policy logic proved on synthesized rows: allows only a real buyer of that
--    post from that creator; denies wrong-creator, refunded, not-granted,
--    NULL-status and no-purchase.
--
-- WHY. PR #132 established "only people who bought from this creator may
-- review them", and PR #136 narrowed it to the exact offer. Both gates live
-- ONLY in app/api/reviews/route.ts. The database still allows any signed-in
-- account to write its own review row directly through PostgREST:
--
--   verified 2026-09-07 on prod
--   RLS on public.reviews: ENABLED
--   policy "Users can insert their own reviews"  WITH CHECK (auth.uid() = reviewer_id)
--   policy "Users can update their own reviews"  WITH CHECK (auth.uid() = reviewer_id)
--   grants: authenticated AND anon both hold INSERT, UPDATE, DELETE, TRUNCATE
--
-- So the purchase requirement is advisory. Anyone with an account can POST to
-- /rest/v1/reviews and fabricate a review for a creator they never paid.
-- Nobody can do it by accident, and it cannot be exploited profitably today
-- because zero purchases exist — but it must be closed before launch, because
-- review counts are the social proof the marketplace sells on.
--
-- WHAT THIS DOES
--   1. public.has_live_purchase_of_post(buyer, post) — SECURITY DEFINER.
--      It has to be SECURITY DEFINER: `authenticated` holds NO SELECT grant on
--      public.purchases (only TRIGGER/REFERENCES/TRUNCATE), so an inline
--      subquery inside a policy would fail for exactly the role the policy is
--      meant to constrain. search_path is pinned (017b policy).
--   2. INSERT and UPDATE policies additionally require post_id IS NOT NULL and
--      a live purchase of that post.
--   3. anon loses INSERT/UPDATE/DELETE/TRUNCATE on reviews. It keeps SELECT
--      ("Anyone can read reviews"). anon has no auth.uid() so it could never
--      satisfy the policy anyway; this removes pointless surface.
--
-- The rule is byte-for-byte lib/reviewEligibility.ts: access_granted = true
-- AND status NOT IN ('refunded','failed'), keyed by post_id. Change both or
-- neither.
--
-- ORDER. Apply only AFTER PR #136 is deployed (it is — main 17a6778). The v1
-- code wrote post_id = NULL; under this policy those writes would be refused.
-- Rows written before 024 keep post_id NULL and stay readable and deletable;
-- they simply cannot be edited any more, which the app never attempts (it
-- looks a review up by (reviewer_id, post_id), so a NULL row never matches).
--
-- ⚠️ BLAST RADIUS. app/api/reviews/route.ts writes with the request-scoped,
-- RLS-respecting client (createServerClient), NOT the service role. If this
-- policy and the route's own check ever disagree, real reviews start failing.
-- They agree today: the route calls hasQualifyingPurchaseForPost() with the
-- same rule before writing.

begin;

create or replace function public.has_live_purchase_of_post(
  p_buyer uuid,
  p_post uuid,
  p_creator uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.purchases pu
    join public.posts po on po.id = pu.post_id
    where pu.buyer_id = p_buyer
      and pu.post_id = p_post
      and pu.access_granted
      -- NOT coalesce(status,''): PostgREST's .not("status","in",...) drops a
      -- NULL status (NULL NOT IN (..) is NULL, which fails a WHERE), so
      -- coalescing would make this policy MORE permissive than the route it is
      -- meant to mirror. `status` is nullable, so keep the semantics identical.
      and pu.status not in ('refunded', 'failed')
      -- The offer must actually be this creator's, mirroring the route's second
      -- gate (isPostOwnedByCreator). Without it a buyer with one real purchase
      -- could POST straight to PostgREST and attach the review to a DIFFERENT
      -- creator, since the reviews page lists by creator_id.
      and po.creator_id = p_creator
  );
$fn$;

comment on function public.has_live_purchase_of_post(uuid, uuid, uuid) is
  'True when the buyer holds a live (access_granted, status not refunded/failed) purchase of that post AND the post belongs to that creator. Mirrors lib/reviewEligibility.ts hasQualifyingPurchaseForPost + isPostOwnedByCreator exactly — change all of them or none.';

revoke all on function public.has_live_purchase_of_post(uuid, uuid, uuid) from public;
revoke all on function public.has_live_purchase_of_post(uuid, uuid, uuid) from anon;
grant execute on function public.has_live_purchase_of_post(uuid, uuid, uuid) to authenticated;

drop policy if exists "Users can insert their own reviews" on public.reviews;
create policy "Users can insert their own reviews"
  on public.reviews
  for insert
  with check (
    auth.uid() = reviewer_id
    and post_id is not null
    and public.has_live_purchase_of_post(auth.uid(), post_id, creator_id)
  );

drop policy if exists "Users can update their own reviews" on public.reviews;
create policy "Users can update their own reviews"
  on public.reviews
  for update
  using (auth.uid() = reviewer_id)
  with check (
    auth.uid() = reviewer_id
    and post_id is not null
    and public.has_live_purchase_of_post(auth.uid(), post_id, creator_id)
  );

revoke insert, update, delete, truncate on public.reviews from anon;

commit;

-- ---------------------------------------------------------------------------
-- CHECK (read-only; run after applying — every row should say ok)
-- ---------------------------------------------------------------------------
-- select 'helper exists' as what,
--        case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--                          where n.nspname='public' and p.proname='has_live_purchase_of_post')
--             then 'ok' else 'MISSING' end as result
-- union all
-- select 'helper is security definer',
--        case when (select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--                   where n.nspname='public' and p.proname='has_live_purchase_of_post')
--             then 'ok' else 'NOT DEFINER' end
-- union all
-- select 'anon cannot execute helper',
--        case when not has_function_privilege('anon','public.has_live_purchase_of_post(uuid,uuid,uuid)','execute')
--             then 'ok' else 'ANON CAN EXECUTE' end
-- union all
-- select 'authenticated can execute helper',
--        case when has_function_privilege('authenticated','public.has_live_purchase_of_post(uuid,uuid,uuid)','execute')
--             then 'ok' else 'MISSING' end
-- union all
-- select 'insert policy now requires a purchase',
--        case when (select pg_get_expr(polwithcheck, polrelid) from pg_policy
--                   where polrelid='public.reviews'::regclass and polname='Users can insert their own reviews')
--             like '%has_live_purchase_of_post%' then 'ok' else 'NOT ENFORCED' end
-- union all
-- select 'update policy now requires a purchase',
--        case when (select pg_get_expr(polwithcheck, polrelid) from pg_policy
--                   where polrelid='public.reviews'::regclass and polname='Users can update their own reviews')
--             like '%has_live_purchase_of_post%' then 'ok' else 'NOT ENFORCED' end
-- union all
-- select 'anon lost write grants on reviews',
--        case when not has_table_privilege('anon','public.reviews','insert')
--              and not has_table_privilege('anon','public.reviews','update')
--              and not has_table_privilege('anon','public.reviews','delete')
--             then 'ok' else 'STILL GRANTED' end
-- union all
-- select 'anon can still read reviews',
--        case when has_table_privilege('anon','public.reviews','select') then 'ok' else 'BROKE PUBLIC READS' end
-- union all
-- select 'existing rows untouched',
--        (select count(*)::text from public.reviews) || ' rows';

-- ---------------------------------------------------------------------------
-- ROLLBACK (restores the pre-026 policies exactly as captured 2026-09-07)
-- ---------------------------------------------------------------------------
-- begin;
-- drop policy if exists "Users can insert their own reviews" on public.reviews;
-- create policy "Users can insert their own reviews" on public.reviews
--   for insert with check (auth.uid() = reviewer_id);
-- drop policy if exists "Users can update their own reviews" on public.reviews;
-- create policy "Users can update their own reviews" on public.reviews
--   for update using (auth.uid() = reviewer_id) with check (auth.uid() = reviewer_id);
-- grant insert, update, delete on public.reviews to anon;   -- only if you truly want this back
-- drop function if exists public.has_live_purchase_of_post(uuid, uuid, uuid);
-- commit;
