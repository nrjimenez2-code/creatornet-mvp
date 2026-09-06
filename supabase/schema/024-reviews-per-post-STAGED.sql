-- 024-reviews-per-post-STAGED.sql
-- ⚠️ STAGED — NOT APPLIED. Apply only with Landon's explicit OK and a fresh
-- backup (Supabase free plan = no PITR). Merging the PR does NOT run it.
--
-- Reviews become per OFFER (Noah #5, step 2). An offer is a post, and a
-- buyer's purchases are keyed by purchases.post_id, so a review now names the
-- post it is about:
--   1. reviews.post_id uuid NULL → posts(id) ON DELETE CASCADE
--      (nullable: rows written before this file keep NULL and stay visible;
--       deleting a post deletes the reviews of that offer, same as purchases)
--   2. DROP the old one-review-per-creator rule, UNIQUE (reviewer_id, creator_id)
--      — named reviews_reviewer_id_creator_id_key in snapshot-2026-08-12.sql,
--      but looked up by its definition so a renamed constraint is still found
--      and a re-run is a no-op
--   3. one review per buyer per offer: a partial unique index on
--      (reviewer_id, post_id) WHERE post_id IS NOT NULL
--   4. an index on the new foreign key (013-index-foreign-keys.sql policy)
--
-- ORDER MATTERS. The app on feat/reviews-per-offer writes reviews.post_id.
-- Until this file has run, every POST /api/reviews would fail on the missing
-- column (500). Merge #132 first, run this, then merge the per-offer PR.
-- Running this file BEFORE the per-offer code ships is safe: v1 never reads
-- or writes post_id, and dropping the creator-level unique only lets a buyer
-- hold more than one review per creator, which v1 never attempts.
--
-- Security: unchanged. RLS on reviews stays on; no policy references the
-- unique constraint or the new column. update_profile_rating still averages
-- every review per creator, so one buyer with two offers now counts twice —
-- intended: they are reviewing two different things.

begin;

alter table public.reviews
  add column if not exists post_id uuid references public.posts(id) on delete cascade;

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.reviews'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (reviewer_id, creator_id)'
  loop
    execute format('alter table public.reviews drop constraint %I', c.conname);
    raise notice 'dropped %', c.conname;
  end loop;
end $$;

create unique index if not exists reviews_reviewer_post_unique
  on public.reviews (reviewer_id, post_id)
  where post_id is not null;

create index if not exists idx_reviews_post_id
  on public.reviews (post_id);

comment on column public.reviews.post_id is
  'The offer (post) this review is about. NULL only for rows written before 024 (per-creator reviews).';

commit;

-- ---------------------------------------------------------------------------
-- CHECK (read-only; run after applying — every row should say ok)
-- ---------------------------------------------------------------------------
-- select 'post_id column' as what,
--        case when exists (select 1 from information_schema.columns
--                          where table_schema='public' and table_name='reviews' and column_name='post_id')
--             then 'ok' else 'MISSING' end as result
-- union all
-- select 'old unique gone',
--        case when not exists (select 1 from pg_constraint
--                              where conrelid='public.reviews'::regclass and contype='u'
--                                and pg_get_constraintdef(oid)='UNIQUE (reviewer_id, creator_id)')
--             then 'ok' else 'STILL THERE' end
-- union all
-- select 'per-post unique index',
--        case when exists (select 1 from pg_indexes
--                          where schemaname='public' and tablename='reviews' and indexname='reviews_reviewer_post_unique')
--             then 'ok' else 'MISSING' end
-- union all
-- select 'fk index',
--        case when exists (select 1 from pg_indexes
--                          where schemaname='public' and tablename='reviews' and indexname='idx_reviews_post_id')
--             then 'ok' else 'MISSING' end
-- union all
-- select 'legacy rows still visible (post_id null)', count(*)::text || ' rows'
--   from public.reviews where post_id is null;

-- ---------------------------------------------------------------------------
-- ROLLBACK (only if the per-offer code is NOT deployed — it writes post_id)
-- ---------------------------------------------------------------------------
-- The old UNIQUE (reviewer_id, creator_id) can only come back if no reviewer
-- holds two reviews for one creator. Once buyers have reviewed two offers
-- from the same creator, that is no longer true, and this block reports the
-- duplicates instead of failing halfway. Decide (delete or keep) before
-- re-running.
--
-- begin;
-- drop index if exists public.reviews_reviewer_post_unique;
-- drop index if exists public.idx_reviews_post_id;
-- do $$
-- declare
--   dupes integer;
-- begin
--   select count(*) into dupes from (
--     select reviewer_id, creator_id from public.reviews
--     group by reviewer_id, creator_id having count(*) > 1
--   ) d;
--   if dupes = 0 then
--     alter table public.reviews
--       add constraint reviews_reviewer_id_creator_id_key unique (reviewer_id, creator_id);
--     raise notice 'restored reviews_reviewer_id_creator_id_key';
--   else
--     raise notice '% reviewer/creator pairs hold more than one review; old unique NOT restored', dupes;
--   end if;
-- end $$;
-- alter table public.reviews drop column if exists post_id;
-- commit;
