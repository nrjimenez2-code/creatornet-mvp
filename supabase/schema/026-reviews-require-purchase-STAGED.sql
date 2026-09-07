-- 026-reviews-require-purchase-STAGED.sql
-- ⚠️ STAGED — NOT APPLIED. Apply only with Landon's explicit OK and a fresh
-- backup (Supabase free plan = no PITR). Merging this PR does NOT run it.
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

create or replace function public.has_live_purchase_of_post(p_buyer uuid, p_post uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.purchases pu
    where pu.buyer_id = p_buyer
      and pu.post_id = p_post
      and pu.access_granted
      and coalesce(pu.status, '') not in ('refunded', 'failed')
  );
$fn$;

comment on function public.has_live_purchase_of_post(uuid, uuid) is
  'True when the buyer holds a live (non-refunded, non-failed, access_granted) purchase of that post. Mirrors lib/reviewEligibility.ts. SECURITY DEFINER because authenticated cannot select public.purchases.';

revoke all on function public.has_live_purchase_of_post(uuid, uuid) from public;
revoke all on function public.has_live_purchase_of_post(uuid, uuid) from anon;
grant execute on function public.has_live_purchase_of_post(uuid, uuid) to authenticated;

drop policy if exists "Users can insert their own reviews" on public.reviews;
create policy "Users can insert their own reviews"
  on public.reviews
  for insert
  with check (
    auth.uid() = reviewer_id
    and post_id is not null
    and public.has_live_purchase_of_post(auth.uid(), post_id)
  );

drop policy if exists "Users can update their own reviews" on public.reviews;
create policy "Users can update their own reviews"
  on public.reviews
  for update
  using (auth.uid() = reviewer_id)
  with check (
    auth.uid() = reviewer_id
    and post_id is not null
    and public.has_live_purchase_of_post(auth.uid(), post_id)
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
--        case when not has_function_privilege('anon','public.has_live_purchase_of_post(uuid,uuid)','execute')
--             then 'ok' else 'ANON CAN EXECUTE' end
-- union all
-- select 'authenticated can execute helper',
--        case when has_function_privilege('authenticated','public.has_live_purchase_of_post(uuid,uuid)','execute')
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
-- drop function if exists public.has_live_purchase_of_post(uuid, uuid);
-- commit;
