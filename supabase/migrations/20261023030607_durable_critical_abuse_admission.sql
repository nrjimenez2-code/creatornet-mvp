begin;
create schema abuse_private;
revoke all on schema abuse_private from public,anon,authenticated;
grant usage on schema abuse_private to service_role;
create table abuse_private.buckets (
 action text not null, subject text not null, window_seconds integer not null,
 window_start timestamptz not null, requests bigint not null default 0 check(requests>=0),
 bytes bigint not null default 0 check(bytes>=0), seconds bigint not null default 0 check(seconds>=0),
 primary key(action,subject,window_seconds,window_start)
);
create index abuse_bucket_expiry on abuse_private.buckets(window_start);
create table abuse_private.upload_reservations (
 action text not null, actor text not null, operation text not null,
 contract text not null, resource text not null, created_at timestamptz not null,
 primary key(action,actor,operation)
);
create index abuse_upload_expiry on abuse_private.upload_reservations(created_at);
alter table abuse_private.buckets enable row level security;
alter table abuse_private.upload_reservations enable row level security;
revoke all on all tables in schema abuse_private from public,anon,authenticated;
grant select,insert,update,delete on all tables in schema abuse_private to service_role;

-- Limits are server-owned, not supplied by a client. UTC fixed windows admit a
-- bounded burst at the boundary; daily upload reservations count issued capacity,
-- including uncertain/canceled operations, rather than claiming actual billing.
create function public.abuse_admit_v1(
 p_action text,p_actor text,p_ip text,p_operation text default null,
 p_contract text default null,p_resource text default null,p_bytes bigint default 0,p_seconds bigint default 0
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 t timestamptz:=clock_timestamp(); policies jsonb; rule jsonb; state abuse_private.buckets;
 prior abuse_private.upload_reservations; start_at timestamptz; retry integer:=0;
 actor_limit integer; ip_limit integer; is_upload boolean; is_reused boolean:=false;
begin
 if p_actor !~ '^[a-f0-9]{64}$' or p_ip !~ '^[a-f0-9]{64}$' or p_actor is null or p_ip is null
   or p_bytes is null or p_seconds is null or p_bytes<0 or p_seconds<0 then raise exception 'Invalid admission'; end if;
 is_upload:=p_action in ('public_upload','premium_upload');
 case p_action
 when 'feed_page' then actor_limit:=120;ip_limit:=1200;
 when 'feed_session' then actor_limit:=6;ip_limit:=120;
 when 'search' then actor_limit:=60;ip_limit:=600;
 when 'search_suggest' then actor_limit:=90;ip_limit:=900;
 when 'public_upload' then actor_limit:=30;ip_limit:=300;
 when 'premium_upload' then actor_limit:=20;ip_limit:=200;
 else raise exception 'Unknown admission action'; end case;
 -- Anonymous callers without a signed actor share only the generous IP
 -- budget, rather than a signed-in user's lower per-account NAT allowance.
 if p_actor=p_ip and not is_upload then actor_limit:=ip_limit; end if;
 if not is_upload and (p_bytes<>0 or p_seconds<>0 or p_operation is not null or p_contract is not null or p_resource is not null)
   then raise exception 'Invalid read admission'; end if;
 if is_upload then
  if p_operation is null or p_operation !~ '^[a-f0-9]{64}$' or p_contract is null or p_contract !~ '^[a-f0-9]{64}$'
   or p_resource is null or length(p_resource) not between 1 and 512
   or p_bytes<=0 or (p_action='public_upload' and (p_bytes>524288000 or p_seconds<>0))
   or (p_action='premium_upload' and (p_bytes>=30000000000 or p_seconds not between 1 and 36000)) then raise exception 'Invalid upload admission'; end if;
  -- Serialize the same operation before creating its identity. This lock has no
  -- provider side effects and is released at transaction end.
  perform pg_advisory_xact_lock(hashtextextended(p_action||p_actor||p_operation,0));
  select * into prior from abuse_private.upload_reservations
    where action=p_action and actor=p_actor and operation=p_operation;
  if found then
   if prior.contract<>p_contract then raise exception 'Upload contract changed'; end if;
   is_reused:=true;p_resource:=prior.resource;
  end if;
 end if;
 policies:=jsonb_build_array(
   jsonb_build_object('subject','a:'||p_actor,'window',60,'count',actor_limit),
   jsonb_build_object('subject','i:'||p_ip,'window',60,'count',ip_limit));
 if p_action='feed_session' then
  policies:=policies||jsonb_build_array(jsonb_build_object('subject','a:'||p_actor,'window',3600,'count',60),
    jsonb_build_object('subject','i:'||p_ip,'window',3600,'count',1200));
 elsif is_upload and not is_reused then
  policies:=policies||jsonb_build_array(jsonb_build_object('subject','a:'||p_actor,'window',86400,
    'count',case when p_action='public_upload' then 200 else 20 end,
    'bytes',case when p_action='public_upload' then 21474836480::bigint else 120000000000::bigint end,
    'seconds',case when p_action='premium_upload' then 144000 else 0 end));
 end if;
 -- Canonical lock order prevents deadlocks when two admissions share only an
 -- IP or actor. Denial never spends a subset of the count/byte/time budgets.
 begin
 for rule in select value from jsonb_array_elements(policies) order by value->>'subject',(value->>'window')::integer loop
  start_at:=to_timestamp(floor(extract(epoch from t)/(rule->>'window')::integer)*(rule->>'window')::integer);
  insert into abuse_private.buckets(action,subject,window_seconds,window_start)
    values(p_action,rule->>'subject',(rule->>'window')::integer,start_at) on conflict do nothing;
  select * into state from abuse_private.buckets where action=p_action and subject=rule->>'subject'
    and window_seconds=(rule->>'window')::integer and window_start=start_at for update;
  if state.requests+1>(rule->>'count')::bigint or
    (rule ? 'bytes' and state.bytes+p_bytes>(rule->>'bytes')::bigint) or
    (rule ? 'seconds' and state.seconds+p_seconds>(rule->>'seconds')::bigint) then
    retry:=greatest(retry,ceil(extract(epoch from start_at+make_interval(secs=>(rule->>'window')::integer)-t))::integer);
  end if;
 end loop;
 if retry>0 then raise exception using errcode='CN429',message='Admission budget exhausted'; end if;
 for rule in select value from jsonb_array_elements(policies) loop
  start_at:=to_timestamp(floor(extract(epoch from t)/(rule->>'window')::integer)*(rule->>'window')::integer);
  update abuse_private.buckets set requests=requests+1,bytes=bytes+p_bytes,seconds=seconds+p_seconds
   where action=p_action and subject=rule->>'subject' and window_seconds=(rule->>'window')::integer and window_start=start_at;
 end loop;
 if is_upload and not is_reused then insert into abuse_private.upload_reservations values(p_action,p_actor,p_operation,p_contract,p_resource,t); end if;
 exception when sqlstate 'CN429' then
  -- A denied random actor must not leave zero-count rows behind. The inner
  -- subtransaction rolls back inserts and all debits before this response.
  return jsonb_build_object('allowed',false,'retry_after',retry);
 end;
 delete from abuse_private.buckets where (action,subject,window_seconds,window_start) in (
  select action,subject,window_seconds,window_start from abuse_private.buckets where window_start<t-interval '2 days'
   order by window_start limit 100 for update skip locked);
 -- Upload identities last beyond every upload URL/lease. Private asset rows
 -- independently preserve provider recovery before quota admission is reached.
 if not is_upload then
  delete from abuse_private.upload_reservations where (action,actor,operation) in (
   select action,actor,operation from abuse_private.upload_reservations where created_at<t-interval '7 days'
   order by created_at limit 20 for update skip locked);
 end if;
 return jsonb_build_object('allowed',true,'reused',is_reused,'resource',p_resource);
end; $$;
revoke all on function public.abuse_admit_v1(text,text,text,text,text,text,bigint,bigint) from public,anon,authenticated;
grant execute on function public.abuse_admit_v1(text,text,text,text,text,text,bigint,bigint) to service_role;
commit;
