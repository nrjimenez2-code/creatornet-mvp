-- DB MIGRATION REQUIRED. Backend-only cumulative analytics; no feed-ranking changes.
begin;
create schema if not exists private;
create table public.video_insight_aggregates_v1 (
  post_id uuid not null references public.posts(id) on delete cascade,
  media_version text not null,
  duration_seconds double precision check(duration_seconds > 0 and duration_seconds <= 43200),
  sessions bigint not null default 0,
  watch_seconds double precision not null default 0,
  unique_seconds double precision not null default 0,
  completions bigint not null default 0,
  opening bigint not null default 0,
  buckets double precision[] not null default '{}',
  sources jsonb not null default '{}',
  collection_started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(post_id,media_version)
);
create table public.video_insight_sessions_v1 (
  id uuid primary key,
  post_id uuid not null,
  media_version text not null,
  actor_hash text not null check(actor_hash ~ '^[a-f0-9]{64}$'),
  token_hash text not null check(token_hash ~ '^[a-f0-9]{64}$'),
  source text not null check(source in ('discover','following','profile','search','direct','unknown')),
  surface text not null check(surface in ('feed','watch')),
  started_at timestamptz not null default now(),
  sequence integer not null default 0,
  watch_seconds double precision not null default 0,
  unique_seconds double precision not null default 0,
  intervals jsonb not null default '[]',
  buckets double precision[] not null default '{}',
  completed boolean not null default false,
  opening boolean not null default false,
  foreign key(post_id,media_version) references public.video_insight_aggregates_v1(post_id,media_version) on delete cascade
);
create index video_insight_session_cleanup_v1 on public.video_insight_sessions_v1(started_at);
create index video_insight_session_post_v1 on public.video_insight_sessions_v1(post_id,media_version);
create index video_insight_actor_limits_v1 on public.video_insight_sessions_v1(actor_hash,started_at);
alter table public.video_insight_sessions_v1 enable row level security;
alter table public.video_insight_aggregates_v1 enable row level security;
revoke all on public.video_insight_sessions_v1,public.video_insight_aggregates_v1 from public,anon,authenticated;
grant select,insert,update,delete on public.video_insight_sessions_v1,public.video_insight_aggregates_v1 to service_role;

create function private.video_insight_union_v1(p_intervals jsonb) returns jsonb
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare item record; result jsonb := '[]'; a double precision; b double precision;
begin
  for item in select (v->>0)::double precision as lo,(v->>1)::double precision as hi
    from jsonb_array_elements(p_intervals) v order by 1,2
  loop
    if a is null then a:=item.lo;b:=item.hi;
    elsif item.lo <= b then b:=greatest(b,item.hi);
    else result:=result||jsonb_build_array(jsonb_build_array(a,b));a:=item.lo;b:=item.hi;
    end if;
  end loop;
  if a is not null then result:=result||jsonb_build_array(jsonb_build_array(a,b));end if;
  return result;
end $$;

create function public.start_video_insight_session_v1(p_id uuid,p_post uuid,p_actor text,p_token text,p_media text,p_duration double precision,p_source text,p_surface text,p_started timestamptz)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare existing public.video_insight_sessions_v1; total integer; n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('video-insights:'||p_actor,0));
  select * into existing from public.video_insight_sessions_v1 where id=p_id;
  if found then
    if existing.actor_hash<>p_actor or existing.token_hash<>p_token or existing.post_id<>p_post or existing.media_version<>p_media or existing.surface<>p_surface or existing.source<>p_source
      then raise exception 'Session mismatch' using errcode='22023';end if;
    return;
  end if;
  perform 1 from public.posts where id=p_post and removed_at is null for share;
  if not found then raise exception 'Post unavailable' using errcode='22023';end if;
  select count(*) into total from public.video_insight_sessions_v1 where actor_hash=p_actor and started_at>now()-interval '1 hour';
  if total>=600 then raise exception 'Session budget exceeded' using errcode='22023';end if;
  n:=case when p_duration is null then 0 when p_duration<=300 then ceil(p_duration)::integer else 300 end;
  insert into public.video_insight_aggregates_v1(post_id,media_version,duration_seconds,buckets)
    values(p_post,p_media,p_duration,array_fill(0::double precision,array[n])) on conflict do nothing;
  -- Consistent lock order: aggregate, then session. Serializes starts/events/read/purge.
  perform 1 from public.video_insight_aggregates_v1 where post_id=p_post and media_version=p_media for update;
  insert into public.video_insight_sessions_v1(id,post_id,media_version,actor_hash,token_hash,source,surface,buckets,started_at)
    values(p_id,p_post,p_media,p_actor,p_token,p_source,p_surface,array_fill(0::double precision,array[n]),greatest(now()-interval '30 seconds',least(now(),p_started)));
  update public.video_insight_aggregates_v1 set sessions=sessions+1,
    sources=jsonb_set(sources,array[p_source],to_jsonb(coalesce((sources->>p_source)::bigint,0)+1)),updated_at=now()
    where post_id=p_post and media_version=p_media;
end $$;

create function public.merge_video_insight_event_v1(p_id uuid,p_actor text,p_token text,p_sequence integer,p_seconds double precision,p_intervals jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare s public.video_insight_sessions_v1; a public.video_insight_aggregates_v1;
  merged jsonb; item jsonb; lo double precision; hi double precision; unique_time double precision:=0;
  opening_time double precision:=0; opening_done boolean:=false; completion_done boolean:=false;
  measured double precision[]; updated double precision[]; n integer; i integer; width double precision; bucket_end double precision;
begin
  select * into s from public.video_insight_sessions_v1 where id=p_id and actor_hash=p_actor and token_hash=p_token;
  if not found or s.started_at<now()-interval '12 hours' then raise exception 'Invalid session' using errcode='22023';end if;
  perform 1 from public.posts where id=s.post_id and removed_at is null for share;
  if not found then raise exception 'Post unavailable' using errcode='22023';end if;
  select * into a from public.video_insight_aggregates_v1 where post_id=s.post_id and media_version=s.media_version for update;
  select * into s from public.video_insight_sessions_v1 where id=p_id for update;
  if not found then raise exception 'Session deleted' using errcode='22023';end if;
  if p_sequence<=s.sequence then return;end if;
  if p_sequence is null or p_seconds is null or p_intervals is null or p_sequence>1000000 or p_seconds<s.watch_seconds or p_seconds<0 or p_seconds>43200 or p_seconds='NaN'::double precision
    or p_seconds>extract(epoch from(now()-s.started_at))+2 or jsonb_typeof(p_intervals)<>'array' or jsonb_array_length(p_intervals)>512
    then raise exception 'Invalid cumulative update' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(p_intervals) loop
    if jsonb_typeof(item)<>'array' or jsonb_array_length(item)<>2 or jsonb_typeof(item->0)<>'number' or jsonb_typeof(item->1)<>'number'
      then raise exception 'Invalid interval' using errcode='22023';end if;
    lo:=(item->>0)::double precision;hi:=(item->>1)::double precision;
    if lo<0 or hi<=lo or hi>coalesce(a.duration_seconds,43200) or lo='NaN'::double precision or hi='NaN'::double precision
      then raise exception 'Interval outside timeline' using errcode='22023';end if;
  end loop;
  merged:=private.video_insight_union_v1(s.intervals||p_intervals);
  if jsonb_array_length(merged)>512 then raise exception 'Too many intervals' using errcode='22023';end if;
  n:=coalesce(array_length(a.buckets,1),0);measured:=array_fill(0::double precision,array[n]);updated:=a.buckets;
  width:=case when a.duration_seconds<=300 then 1 else a.duration_seconds/300 end;
  for item in select value from jsonb_array_elements(merged) loop
    lo:=(item->>0)::double precision;hi:=(item->>1)::double precision;
    unique_time:=unique_time+hi-lo;
    opening_time:=opening_time+greatest(0,least(hi,least(3,a.duration_seconds))-lo);
    for i in 1..n loop
      bucket_end:=least(i*width,a.duration_seconds);
      measured[i]:=measured[i]+greatest(0,least(hi,bucket_end)-greatest(lo,(i-1)*width))/(bucket_end-(i-1)*width);
    end loop;
  end loop;
  if unique_time>p_seconds*16+0.1 then raise exception 'Implausible coverage' using errcode='22023';end if;
  if a.duration_seconds is not null then
    completion_done:=unique_time>=a.duration_seconds*0.9;
    opening_done:=opening_time>=least(3,a.duration_seconds)-0.000001;
  end if;
  for i in 1..n loop updated[i]:=a.buckets[i]+measured[i]-s.buckets[i];end loop;
  update public.video_insight_aggregates_v1 set watch_seconds=watch_seconds+p_seconds-s.watch_seconds,
    unique_seconds=unique_seconds+unique_time-s.unique_seconds,
    completions=completions+completion_done::integer-s.completed::integer,
    opening=opening+opening_done::integer-s.opening::integer,buckets=updated,updated_at=now()
    where post_id=s.post_id and media_version=s.media_version;
  update public.video_insight_sessions_v1 set sequence=p_sequence,watch_seconds=p_seconds,unique_seconds=unique_time,
    completed=completion_done,opening=opening_done,intervals=merged,buckets=measured where id=p_id;
end $$;

create function public.read_video_insights_v1(p_post uuid,p_owner uuid,p_media text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.video_insight_aggregates_v1;
begin
  if not exists(select 1 from public.posts where id=p_post and creator_id=p_owner and removed_at is null)
    then raise exception 'Owner required' using errcode='42501';end if;
  select * into a from public.video_insight_aggregates_v1 where post_id=p_post and media_version=p_media;
  if not found then return null;end if;
  return jsonb_build_object('sessions',a.sessions,'watch_seconds',a.watch_seconds,'unique_seconds',a.unique_seconds,
    'completions',a.completions,'opening',a.opening,'buckets',to_jsonb(a.buckets),'sources',a.sources,
    'collection_started_at',a.collection_started_at,'updated_at',a.updated_at);
end $$;

create function public.cleanup_video_insight_sessions_v1() returns bigint
language plpgsql security invoker set search_path=pg_catalog as $$
declare total bigint;
begin delete from public.video_insight_sessions_v1 where started_at<now()-interval '30 days';get diagnostics total=row_count;return total;end $$;

-- Soft deletion preserves buyers' media access, but removes insight history.
create function private.purge_deleted_video_insights_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if new.removed_at is not null then delete from public.video_insight_aggregates_v1 where post_id=new.id;end if;
  return new;
end $$;
create trigger purge_deleted_video_insights_v1 after update of removed_at on public.posts
for each row when (old.removed_at is null and new.removed_at is not null) execute function private.purge_deleted_video_insights_v1();

revoke all on function private.video_insight_union_v1(jsonb),private.purge_deleted_video_insights_v1(),
  public.start_video_insight_session_v1(uuid,uuid,text,text,text,double precision,text,text,timestamptz),
  public.merge_video_insight_event_v1(uuid,text,text,integer,double precision,jsonb),
  public.read_video_insights_v1(uuid,uuid,text),public.cleanup_video_insight_sessions_v1() from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.video_insight_union_v1(jsonb),public.start_video_insight_session_v1(uuid,uuid,text,text,text,double precision,text,text,timestamptz),
  public.merge_video_insight_event_v1(uuid,text,text,integer,double precision,jsonb),
  public.read_video_insights_v1(uuid,uuid,text),public.cleanup_video_insight_sessions_v1() to service_role;
-- Reuse an installed scheduler. If pg_cron is unavailable, rollout requires an existing daily scheduler to call the cleanup RPC.
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('video-insight-session-cleanup-v1','17 3 * * *','select public.cleanup_video_insight_sessions_v1()');
  end if;
end $$;
commit;
