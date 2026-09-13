-- Taxonomy-only migration. Apply before the matching client release.
-- Unknown legacy values remain intact, and originals are archived privately.
begin;
lock table public.profiles, public.posts, public.user_interest_scores in share row exclusive mode;
create or replace function public.canonical_interest_v1(raw text)
returns text language sql immutable parallel safe set search_path = '' as $$
 select case lower(trim(regexp_replace(raw, '\s+', ' ', 'g')))
 when 'entrepreneurship' then 'business & entrepreneurship'
 when 'social media growth' then 'content creation & marketing'
 when 'content creation' then 'content creation & marketing'
 when 'online skills' then 'education & career skills'
 when 'self improvement' then 'personal growth & relationships'
 when 'tech & ai automation' then 'technology & ai'
 else lower(trim(regexp_replace(raw, '\s+', ' ', 'g'))) end;
$$;
create or replace function public.canonical_interests_v1(raw text[])
returns text[] language sql immutable parallel safe set search_path = '' as $$
 select coalesce(array_agg(category order by first_seen), '{}'::text[]) from (
   select public.canonical_interest_v1(value) category, min(position) first_seen
   from unnest(raw) with ordinality as input(value, position)
   where value is not null and trim(value) <> ''
   group by public.canonical_interest_v1(value)
 ) normalized;
$$;
create table if not exists public.interest_taxonomy_archive_v1 (
 source text not null, row_key text not null, original jsonb not null,
 archived_at timestamptz not null default now(), primary key(source,row_key)
);
alter table public.interest_taxonomy_archive_v1 enable row level security;
revoke all on public.interest_taxonomy_archive_v1 from public,anon,authenticated;
grant select,insert on public.interest_taxonomy_archive_v1 to service_role;
do $archive$ begin
if not exists (select 1 from public.interest_taxonomy_archive_v1 where source='migration' and row_key='taxonomy-v1') then
insert into public.interest_taxonomy_archive_v1(source,row_key,original)
 select 'profiles',id::text,jsonb_build_object('interests',interests) from public.profiles
 on conflict do nothing;
insert into public.interest_taxonomy_archive_v1(source,row_key,original)
 select 'posts',id::text,jsonb_build_object('interests',interests,'topics',topics) from public.posts
 on conflict do nothing;
insert into public.interest_taxonomy_archive_v1(source,row_key,original)
 select 'user_interest_scores',user_id::text || ':' || category,to_jsonb(s) from public.user_interest_scores s
 on conflict do nothing;

insert into public.interest_taxonomy_archive_v1(source,row_key,original) values ('migration','taxonomy-v1','{}');
end if;
end $archive$;

-- Preserve the specific topics lost when two categories merge into one.
alter table public.profiles add column if not exists interest_topics text[] not null default '{}';
update public.profiles p set interest_topics = array(
 select distinct topic from unnest(p.interest_topics || array(
   select lower(trim(i)) from jsonb_array_elements_text(p.interests) i
   where lower(trim(i)) in ('entrepreneurship','social media growth','content creation','online skills','self improvement','tech & ai automation')
 )) topic order by topic
);
update public.posts p set topics = array(
 select distinct topic from unnest(coalesce(p.topics,'{}') || array(
   select lower(trim(i)) from unnest(p.interests) i
   where lower(trim(i)) in ('entrepreneurship','social media growth','content creation','online skills','self improvement','tech & ai automation')
 )) topic order by topic
);
update public.profiles set interests=to_jsonb(public.canonical_interests_v1(array(select jsonb_array_elements_text(interests))))
 where interests is not null;
update public.posts set interests=public.canonical_interests_v1(interests)
 where interests is not null;

-- Merge alias collisions without losing learned points or inventing new ones.
-- Integer overflow aborts the transaction instead of silently truncating scores.
create temporary table interest_scores_merged on commit drop as
 select user_id,public.canonical_interest_v1(category) category,
 sum(score)::integer score,max(updated_at) updated_at
 from public.user_interest_scores group by user_id,public.canonical_interest_v1(category);
delete from public.user_interest_scores;
insert into public.user_interest_scores(user_id,category,score,updated_at)
 select user_id,category,score,updated_at from interest_scores_merged;

create or replace function public.normalize_saved_interests_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.interests is not null then
   if tg_table_name='posts' then
    new.topics:=array(select distinct topic from unnest(coalesce(new.topics,'{}')||array(
     select lower(trim(i)) from unnest(new.interests) i where lower(trim(i)) in
     ('entrepreneurship','social media growth','content creation','online skills','self improvement','tech & ai automation')
    )) topic order by topic);
    new.interests := public.canonical_interests_v1(new.interests);
   elsif tg_table_name='profiles' then
    new.interest_topics:=array(select distinct topic from unnest(coalesce(new.interest_topics,'{}')||array(
     select lower(trim(i)) from jsonb_array_elements_text(new.interests) i where lower(trim(i)) in
     ('entrepreneurship','social media growth','content creation','online skills','self improvement','tech & ai automation')
    )) topic order by topic);
    new.interests := to_jsonb(public.canonical_interests_v1(array(select jsonb_array_elements_text(new.interests))));
   end if;
 end if;
 return new;
end;
$$;
drop trigger if exists normalize_profile_interests_v1 on public.profiles;
create trigger normalize_profile_interests_v1 before insert or update of interests
 on public.profiles for each row execute function public.normalize_saved_interests_v1();
drop trigger if exists normalize_post_interests_v1 on public.posts;
create trigger normalize_post_interests_v1 before insert or update of interests
 on public.posts for each row execute function public.normalize_saved_interests_v1();
commit;
