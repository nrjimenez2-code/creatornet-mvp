-- Additive search infrastructure. Source tables remain authoritative; expression
-- indexes update transactionally, so edits and moderation never leave stale hits.
begin;
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create or replace function public.search_normalize_v1(value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select trim(regexp_replace(regexp_replace(regexp_replace(
    lower(coalesce(value, '')), '\me[ -]?com(merce)?\M', 'ecommerce', 'g'),
    '\mdrop[ -]shipping\M', 'dropshipping', 'g'), '[^[:alnum:] ]+', ' ', 'g'));
$$;

create table if not exists public.search_video_text_v1 (
  post_id uuid primary key references public.posts(id) on delete cascade,
  source_url text not null,
  status text not null default 'pending' check (status in ('pending','processing','ready','failed')),
  transcript text not null default '',
  screen_text text not null default '',
  model text,
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  error_code text,
  search_text text generated always as (public.search_normalize_v1(transcript || ' ' || screen_text)) stored
);
alter table public.search_video_text_v1 enable row level security;
revoke all on public.search_video_text_v1 from public,anon,authenticated;
grant select,insert,update,delete on public.search_video_text_v1 to service_role;
create index if not exists search_video_text_fts_v1 on public.search_video_text_v1 using gin(to_tsvector('english',search_text)) where status='ready';
create index if not exists search_video_text_trgm_v1 on public.search_video_text_v1 using gin(search_text extensions.gin_trgm_ops) where status='ready';

create or replace function public.search_post_text_v1(p public.posts)
returns text language sql immutable parallel safe set search_path = '' as $$
  select public.search_normalize_v1(coalesce(p.title,'') || ' ' || coalesce(p.content,'') || ' ' ||
    coalesce(p.caption,'') || ' ' || coalesce(array_to_string(p.hashtags,' '),'') || ' ' ||
    coalesce(array_to_string(p.tags,' '),'') || ' ' || coalesce(array_to_string(p.topics,' '),''));
$$;

create or replace function public.search_profile_text_v1(p public.profiles)
returns text language sql immutable parallel safe set search_path = '' as $$
  select public.search_normalize_v1(coalesce(p.username,'') || ' ' || coalesce(p.full_name,'') || ' ' ||
    coalesce(p.tagline,'') || ' ' || coalesce(p.bio,''));
$$;

create or replace function public.search_offering_text_v1(o public.offerings)
returns text language sql immutable parallel safe set search_path = '' as $$
  -- Explicit allowlist: never index fulfillment links or private product metadata.
  select public.search_normalize_v1(coalesce(o.title,'') || ' ' ||
    coalesce(o.product_metadata->>'description','') || ' ' || coalesce(o.product_metadata->>'summary',''));
$$;

create index if not exists search_profiles_fts_v1 on public.profiles using gin
  (to_tsvector('english', public.search_profile_text_v1(profiles.*))) where banned_at is null;
create index if not exists search_posts_fts_v1 on public.posts using gin
  (to_tsvector('english', public.search_post_text_v1(posts.*))) where hidden_at is null and removed_at is null;
create index if not exists search_offerings_fts_v1 on public.offerings using gin
  (to_tsvector('english', public.search_offering_text_v1(offerings.*))) where is_active is true;
create index if not exists search_profiles_trgm_v1 on public.profiles using gin
  (public.search_profile_text_v1(profiles.*) extensions.gin_trgm_ops) where banned_at is null;
create index if not exists search_posts_trgm_v1 on public.posts using gin
  (public.search_post_text_v1(posts.*) extensions.gin_trgm_ops) where hidden_at is null and removed_at is null;
create index if not exists search_offerings_trgm_v1 on public.offerings using gin
  (public.search_offering_text_v1(offerings.*) extensions.gin_trgm_ops) where is_active is true;

create or replace function public.search_product_text_v1(p public.products)
returns text language sql immutable parallel safe set search_path = '' as $$
  select public.search_normalize_v1(coalesce(p.title,'') || ' ' || coalesce(p.description,'') || ' ' || coalesce(p.type,''));
$$;
create index if not exists search_products_fts_v1 on public.products using gin
  (to_tsvector('english',public.search_product_text_v1(products.*))) where active is distinct from false;
create index if not exists search_products_trgm_v1 on public.products using gin
  (public.search_product_text_v1(products.*) extensions.gin_trgm_ops) where active is distinct from false;

create or replace function public.search_relevance_v1(query_text text, related_terms text[] default '{}', page_number integer default 0, page_size integer default 20, identity_query text default '')
returns jsonb language sql stable security invoker
set search_path = public, extensions, pg_catalog
set statement_timeout = '5s'
set pg_trgm.word_similarity_threshold = '0.65'
as $$
with params as (
  select public.search_normalize_v1(left(query_text,160)) q,
    lower(trim(left(coalesce(nullif(identity_query,''),query_text),160))) nameq,
    plainto_tsquery('english', public.search_normalize_v1(left(query_text,160))) tsq,
    greatest(0,least(coalesce(page_number,0),500)) pn,
    greatest(1,least(coalesce(page_size,20),40)) ps
), public_products as not materialized (
  select o.*, sale.id sale_post_id from public.products o
  join lateral (
    select p.id from public.posts p where p.creator_id=o.creator_id and p.hidden_at is null and p.removed_at is null
      and (p.product_id=o.id or (p.product_id=o.product_id and not exists(select 1 from public.products preferred where preferred.id=p.product_id)))
    order by p.created_at desc,p.id limit 1
  ) sale on true
  where o.active is distinct from false
), sources as not materialized (
  select 'profile'::text kind, p.id, p.id creator_id, public.search_profile_text_v1(p) body,
    coalesce(p.username,p.full_name,'') title, p.created_at
  from public.profiles p where p.banned_at is null and nullif(trim(p.username),'') is not null
  union all
  select 'post', p.id, p.creator_id, public.search_post_text_v1(p), coalesce(p.title,p.content,p.caption,''), p.created_at
  from public.posts p join public.profiles c on c.id=p.creator_id
  where p.hidden_at is null and p.removed_at is null and c.banned_at is null and nullif(trim(c.username),'') is not null
  union all
  select 'offering', o.id, o.creator_id, public.search_offering_text_v1(o), o.title, o.created_at
  from public.offerings o join public.profiles c on c.id=o.creator_id
  where o.is_active is true and c.banned_at is null and nullif(trim(c.username),'') is not null
    and exists(select 1 from public.posts p where p.offering_id=o.id and p.creator_id=o.creator_id and p.hidden_at is null and p.removed_at is null)
  union all
  select 'product',o.id,o.creator_id,public.search_product_text_v1(product),o.title,o.created_at
  from public_products o join public.products product on product.id=o.id join public.profiles c on c.id=o.creator_id
  where c.banned_at is null and nullif(trim(c.username),'') is not null
  union all
  select 'booking',p.id,p.creator_id,public.search_post_text_v1(p) || ' consultation coaching call',coalesce(p.title,'1-on-1 call'),p.created_at
  from public.posts p join public.profiles c on c.id=p.creator_id
  where p.allow_booking is true and nullif(p.booking_url,'') is not null
    and p.hidden_at is null and p.removed_at is null and c.banned_at is null and nullif(trim(c.username),'') is not null
  union all
  select 'video_text',p.id,p.creator_id,v.search_text,coalesce(nullif(v.transcript,''),v.screen_text),p.created_at
  from public.search_video_text_v1 v join public.posts p on p.id=v.post_id join public.profiles c on c.id=p.creator_id
  where v.status='ready' and v.source_url=p.video_url and p.hidden_at is null and p.removed_at is null
    and c.banned_at is null and nullif(trim(c.username),'') is not null
), name_creators as (
  select c.id from public.profiles c cross join params p
  where c.banned_at is null and nullif(trim(c.username),'') is not null and length(p.q)>0
    and (lower(c.username)=p.nameq or lower(c.full_name)=p.nameq)
), matches as (
  select s.*, case
    when s.kind='profile' and s.id in (select id from name_creators) then 200.0
    when s.kind='profile' and starts_with(lower(s.title),p.nameq) then 100.0
    when to_tsvector('english',s.body) @@ p.tsq then (case when s.kind='video_text' then 40.0 else 60.0 end) + 20*ts_rank_cd(to_tsvector('english',s.body),p.tsq,32)
    when s.body ~ ('\m' || p.q) then 50.0
    when s.kind='post' and s.creator_id in (select id from name_creators) then 45.0
    when length(p.q)>=4 and s.body %> p.q then 30.0*word_similarity(p.q,s.body)
    else 15.0 end score,
    case when to_tsvector('english',s.body) @@ p.tsq or s.body ~ ('\m' || p.q) or (s.kind='profile' and starts_with(lower(s.title),p.nameq)) or (s.kind='post' and s.creator_id in (select id from name_creators)) then false else true end expanded
  from sources s cross join params p
  where length(p.q)>0 and (
    to_tsvector('english',s.body) @@ p.tsq or s.body ~ ('\m' || p.q)
    or (s.kind='profile' and starts_with(lower(s.title),p.nameq))
    or (length(p.q)>=4 and s.body %> p.q)
    or (s.kind='post' and s.creator_id in (select id from name_creators))
    or exists(select 1 from unnest(related_terms[1:8]) r where to_tsvector('english',s.body) @@ plainto_tsquery('english',public.search_normalize_v1(r)))
  )
), creator_scores as (
  select creator_id, max(score)+least(10.0,2.0*(count(distinct id)-1)) score,
    (array_agg(kind order by score desc,kind,id))[1] source,
    (array_agg(case when kind='profile' then (select coalesce(c.bio,c.tagline,c.full_name,c.username) from public.profiles c where c.id=matches.creator_id) else title end order by score desc,kind,id))[1] evidence,
    bool_and(expanded) expanded
  from matches group by creator_id
), creator_rows as (
  select jsonb_build_object('id',c.id,'username',c.username,'full_name',c.full_name,'avatar_url',c.avatar_url,
    'tagline',c.tagline,'is_verified_seller',(c.stripe_account_id is not null and c.stripe_onboarding_complete is true),
    'match_source',s.source,'match_reason',case when s.source='profile' then 'Matches profile' when s.source='post' then 'Matches public posts' when s.source='video_text' then 'Matches video speech or text' else 'Matches an offering' end,
    'match_evidence',left(s.evidence,160),'related_match',s.expanded,'score',s.score) item,
    row_number() over(order by s.score desc,c.id) rn
  from creator_scores s join public.profiles c on c.id=s.creator_id
), post_matches as (
  select distinct on(id) * from matches where kind in ('post','video_text') order by id,score desc,kind
), post_rows as (
  select jsonb_build_object('id',p.id,'content',coalesce(p.content,p.caption),'caption',coalesce(p.content,p.caption),
    'media_url',p.video_url,'poster_url',p.poster_url,'creator_id',p.creator_id,'likes_count',p.likes_count,
    'creator',jsonb_build_object('username',c.username,'full_name',c.full_name,'avatar_url',c.avatar_url),
    'related_match',m.expanded,'score',m.score) item,
    row_number() over(order by m.score desc,p.created_at desc,p.id) rn
  from post_matches m join public.posts p on p.id=m.id join public.profiles c on c.id=p.creator_id
), offering_hits as (
  select jsonb_build_object('id',o.id,'title',o.title,'creator_id',o.creator_id,'creator_username',c.username,
    'price_cents',o.price_cents,'currency',o.currency,'type',o.type,'score',m.score) item,
    m.score,o.created_at,o.id
  from matches m join public.offerings o on o.id=m.id join public.profiles c on c.id=o.creator_id where m.kind='offering'
  union all
  select jsonb_build_object('id',o.id,'title',o.title,'creator_id',o.creator_id,'creator_username',c.username,
    'post_id',o.sale_post_id,'price_cents',coalesce(nullif(o.amount_cents,0),o.price_cents),'currency',o.currency,'type',o.type,'score',m.score),m.score,o.created_at,o.id
  from matches m join public_products o on o.id=m.id join public.profiles c on c.id=o.creator_id where m.kind='product'
  union all
  select jsonb_build_object('id',p.id,'title',coalesce(p.title,'1-on-1 call'),'creator_id',p.creator_id,'creator_username',c.username,
    'post_id',p.id,'type','consultation','score',m.score),m.score,p.created_at,p.id
  from matches m join public.posts p on p.id=m.id join public.profiles c on c.id=p.creator_id where m.kind='booking'
), offering_rows as (
  select item,row_number() over(order by score desc,created_at desc,id) rn from offering_hits
)
select jsonb_build_object(
  'creators',coalesce((select jsonb_agg(item order by rn) from creator_rows where rn>p.pn*p.ps and rn<=(p.pn+1)*p.ps),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(item order by rn) from post_rows where rn>p.pn*p.ps and rn<=(p.pn+1)*p.ps),'[]'::jsonb),
  'offerings',coalesce((select jsonb_agg(item order by rn) from offering_rows where rn>p.pn*p.ps and rn<=(p.pn+1)*p.ps),'[]'::jsonb),
  'totals',jsonb_build_object('creators',(select count(*) from creator_rows),'videos',(select count(*) from post_rows),'offerings',(select count(*) from offering_rows)),
  'page',p.pn,'page_size',p.ps
) from params p;
$$;

revoke all on function public.search_relevance_v1(text,text[],integer,integer,text) from public,anon,authenticated;
grant execute on function public.search_relevance_v1(text,text[],integer,integer,text) to service_role;

create or replace function public.search_topics_v1(query_text text default '')
returns jsonb language sql stable security invoker set search_path = '' as $$
  with tags as (
    select public.search_normalize_v1(tag) topic, count(distinct p.creator_id) creators, count(distinct p.id) posts
    from public.posts p join public.profiles c on c.id=p.creator_id
    cross join lateral unnest(coalesce(p.hashtags,'{}') || coalesce(p.tags,'{}') || coalesce(p.topics,'{}')) tag
    where p.hidden_at is null and p.removed_at is null and c.banned_at is null
      and nullif(trim(c.username),'') is not null and p.created_at > now()-interval '30 days'
    group by public.search_normalize_v1(tag)
  ), ranked as (
    select topic, creators, posts from tags
    where length(topic) between 2 and 64 and (query_text='' or topic like public.search_normalize_v1(left(query_text,160)) || '%')
    order by creators desc,posts desc,topic limit 8
  ) select coalesce(jsonb_agg(jsonb_build_object('label',topic,'creator_count',creators,'post_count',posts)),'[]'::jsonb) from ranked;
$$;
revoke all on function public.search_topics_v1(text) from public,anon,authenticated;
grant execute on function public.search_topics_v1(text) to service_role;
commit;

