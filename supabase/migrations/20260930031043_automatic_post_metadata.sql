-- Additive opt-in only. Do not backfill posts or reset existing extraction attempts.
begin;
alter table public.posts add column classification_version integer
  check (classification_version is null or classification_version = 1);
alter table public.search_video_text_v1
  add column classification_version integer,
  add column source_fingerprint text,
  add column classification_context jsonb,
  add column visual_summary text not null default '',
  add column generated_labels jsonb not null default '[]',
  add column classification_source text,
  add column analysis_usage jsonb;
-- The existing table is service-only, including these new columns.
alter table public.search_video_text_v1 enable row level security;
revoke all on public.search_video_text_v1 from public,anon,authenticated;
grant select,insert,update,delete on public.search_video_text_v1 to service_role;

create function public.guard_post_classification_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.classification_version is distinct from old.classification_version then
    raise exception 'classification_version is immutable';
  end if;
  if current_user in ('anon','authenticated') and new.classification_version is not null and
    (tg_op='INSERT' or new.interests is distinct from old.interests or new.topics is distinct from old.topics) then
    raise exception 'automatic metadata requires the publishing service';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_post_classification_v1() from public,anon,authenticated;
create trigger guard_post_classification_v1 before insert or update on public.posts
for each row execute function public.guard_post_classification_v1();

-- Public profile text only; learning interests and private offer data are excluded.
create function public.post_classification_context_v1(target_post uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'post_id',p.id,'creator_id',p.creator_id,'source_url',p.video_url,
    'classification_version',p.classification_version,'duration_seconds',p.duration_seconds,
    'title',p.title,'content',p.content,'caption',p.caption,
    'bio',c.bio,'tagline',c.tagline,'username',c.username,
    'active',p.active,'hidden_at',p.hidden_at,'removed_at',p.removed_at,'banned_at',c.banned_at,
    'product_id',p.product_id,'offering_id',p.offering_id,
    'offers',coalesce((select jsonb_agg(offer order by position) from (
      select 1 position,jsonb_build_object('title',r.title,'description',r.description) offer
      from public.products r where (r.id=p.product_id or r.product_id=p.product_id)
        and r.creator_id=p.creator_id and r.active is distinct from false
      union all
      select 2,jsonb_build_object('title',o.title,'description',o.product_metadata->>'description')
      from public.offerings o where o.id=p.offering_id and o.creator_id=p.creator_id and o.is_active is true
    ) offers),'[]'::jsonb)
  ) from public.posts p join public.profiles c on c.id=p.creator_id where p.id=target_post;
$$;
revoke all on function public.post_classification_context_v1(uuid) from public,anon,authenticated;
grant execute on function public.post_classification_context_v1(uuid) to service_role;

create function public.post_classification_fingerprint_v1(context jsonb)
returns text language sql immutable security invoker set search_path = '' as $$
  select encode(sha256(convert_to(context::text,'UTF8')),'hex');
$$;
revoke all on function public.post_classification_fingerprint_v1(jsonb) from public,anon,authenticated;
grant execute on function public.post_classification_fingerprint_v1(jsonb) to service_role;

create or replace function public.claim_search_video_v1()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare target public.posts; token uuid := gen_random_uuid(); context jsonb; fingerprint text;
begin
  if not pg_try_advisory_xact_lock(58920260912) then return null; end if;
  if exists(select 1 from public.search_video_text_v1 where status='processing' and lease_until>now()) then return null; end if;
  select p.* into target from public.posts p
  join public.profiles c on c.id=p.creator_id
  left join public.search_video_text_v1 v on v.post_id=p.id
  where p.hidden_at is null and p.removed_at is null and c.banned_at is null
    and nullif(trim(c.username),'') is not null and nullif(p.video_url,'') is not null
    and (p.classification_version is null or p.active is distinct from false)
    and (v.post_id is null or v.source_url<>p.video_url or
      (v.attempts<3 and v.retry_at<=now() and (v.lease_until is null or v.lease_until<now()) and
        (v.status<>'ready' or (p.classification_version=1 and v.source_fingerprint is distinct from
          public.post_classification_fingerprint_v1(public.post_classification_context_v1(p.id))))))
  order by (v.post_id is null) desc,p.created_at desc,p.id limit 1 for update of p skip locked;
  if target.id is null then return null; end if;
  if target.classification_version=1 then
    -- Freeze context sources for this transaction. Finish takes the same locks.
    perform 1 from public.profiles where id=target.creator_id for share;
    perform 1 from public.products where id=target.product_id or product_id=target.product_id for share;
    perform 1 from public.offerings where id=target.offering_id for share;
    context:=public.post_classification_context_v1(target.id);
    if context->>'banned_at' is not null or nullif(trim(context->>'username'),'') is null then return null; end if;
    fingerprint:=public.post_classification_fingerprint_v1(context);
  end if;
  insert into public.search_video_text_v1(post_id,source_url,status,attempts,lease_token,lease_until,updated_at,
    classification_version,classification_context,source_fingerprint)
    values(target.id,target.video_url,'processing',1,token,now()+interval '4 minutes',now(),
      target.classification_version,context,fingerprint)
  on conflict(post_id) do update set
    source_url=excluded.source_url,status='processing',
    attempts=case when search_video_text_v1.source_url=excluded.source_url then search_video_text_v1.attempts+1 else 1 end,
    transcript='',screen_text='',lease_token=token,lease_until=excluded.lease_until,updated_at=now(),
    classification_version=excluded.classification_version,classification_context=excluded.classification_context,
    source_fingerprint=excluded.source_fingerprint,visual_summary='',generated_labels='[]',classification_source=null,analysis_usage=null;
  return jsonb_build_object('post_id',target.id,'source_url',target.video_url,'lease_token',token,
    'duration_seconds',target.duration_seconds,'classification_version',target.classification_version,
    'classification_context',context,'source_fingerprint',fingerprint);
end;
$$;
revoke all on function public.claim_search_video_v1() from public,anon,authenticated;
grant execute on function public.claim_search_video_v1() to service_role;

create function public.finish_post_classification_v1(target_post uuid,token uuid,fingerprint text,
  spoken_text text,visible_text text,visual_text text,labels jsonb,categories text[],topics text[],
  metadata_source text,model_id text,usage_receipt jsonb,failure_code text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare p public.posts; v public.search_video_text_v1; context jsonb;
begin
  select * into p from public.posts where id=target_post for update;
  if p.id is null or p.classification_version is distinct from 1 then return false; end if;
  perform 1 from public.profiles where id=p.creator_id for share;
  perform 1 from public.products where id=p.product_id or product_id=p.product_id for share;
  perform 1 from public.offerings where id=p.offering_id for share;
  select * into v from public.search_video_text_v1 where post_id=p.id for update;
  context:=public.post_classification_context_v1(p.id);
  if v.post_id is null or v.status<>'processing' or v.lease_token is distinct from token or v.lease_until is null or v.lease_until<=now()
    or v.classification_version is distinct from 1 or v.source_fingerprint is distinct from fingerprint
    or fingerprint is null
    or v.source_url is distinct from p.video_url
    or fingerprint is distinct from public.post_classification_fingerprint_v1(context)
    or context->>'creator_id' is distinct from v.classification_context->>'creator_id'
    or p.hidden_at is not null or p.removed_at is not null or p.active is false
    or context->>'banned_at' is not null or nullif(trim(context->>'username'),'') is null then return false; end if;
  if failure_code is null then
    if categories is null or not categories <@ array['business & entrepreneurship','money & investing',
      'content creation & marketing','technology & ai','health & fitness','personal growth & relationships',
      'arts, design & hobbies','education & career skills']::text[] or cardinality(categories)>8
      or topics is null or cardinality(topics)>20 or exists(select 1 from unnest(topics) t where t is null or length(t)>80 or length(trim(t))=0)
      or labels is null or jsonb_typeof(labels)<>'array' or jsonb_array_length(labels)>8
      or length(coalesce(visual_text,''))>4000 or length(coalesce(spoken_text,''))>60000 or length(coalesce(visible_text,''))>20000 then
      raise exception 'invalid classification';
    end if;
    update public.posts set interests=categories,topics=finish_post_classification_v1.topics where id=p.id;
  end if;
  update public.search_video_text_v1 set
    status=case when failure_code is null then 'ready' else 'failed' end,
    transcript=case when failure_code is null then coalesce(spoken_text,'') else '' end,
    screen_text=case when failure_code is null then coalesce(visible_text,'') else '' end,
    visual_summary=case when failure_code is null then coalesce(visual_text,'') else '' end,
    generated_labels=case when failure_code is null then labels else '[]'::jsonb end,
    classification_source=case when failure_code is null then metadata_source else null end,
    model=model_id,analysis_usage=usage_receipt,error_code=left(failure_code,80),
    lease_until=null,lease_token=null,retry_at=now()+interval '30 minutes',updated_at=now()
  where post_id=p.id;
  return true;
end;
$$;
revoke all on function public.finish_post_classification_v1(uuid,uuid,text,text,text,text,jsonb,text[],text[],text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_post_classification_v1(uuid,uuid,text,text,text,text,jsonb,text[],text[],text,text,jsonb,text) to service_role;
commit;
