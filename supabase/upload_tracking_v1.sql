-- LOCAL INSTALLATION DRAFT. Not installed on any shared/hosted database.
-- This versioned unit is exercised unchanged by isolated local PostgreSQL tests.
-- A later approved migration/installation packet must verify Storage operation
-- helpers and signed-upload behavior, and positively finish legacy direct uploads.
-- No expiry, client acknowledgment or object HEAD establishes provider quiescence.

begin;

create schema if not exists upload_tracking;
revoke all on schema upload_tracking from public;
grant usage on schema upload_tracking to service_role, authenticated, anon;

create table upload_tracking.control_v1 (
  singleton boolean primary key default true check (singleton),
  paused boolean not null default true,
  generation bigint not null default 0 check (generation >= 0),
  reason text not null default 'not_activated' check (length(reason) <= 160),
  updated_at timestamptz not null default clock_timestamp()
);
insert into upload_tracking.control_v1(singleton) values(true);

create table upload_tracking.attempts_v1 (
  id uuid primary key,
  operation_id uuid not null,
  owner_id uuid not null,
  purpose text not null check (purpose in ('video','thumbnail','premium','avatar')),
  provider text not null check (provider in ('r2','supabase')),
  bucket text not null check (length(bucket) between 1 and 128),
  object_key text not null,
  content_type text not null check (
    length(content_type) between 3 and 128 and content_type = lower(content_type)
    and content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'
  ),
  expected_bytes bigint check (expected_bytes between 1 and 9007199254740991),
  extension text not null check (extension ~ '^[a-z0-9]{1,8}$'),
  admission_generation bigint not null,
  state text not null default 'reserved' check (
    state in ('reserved','capability_issued','object_observed',
              'verification_unavailable','object_mismatch')
  ),
  admitted_at timestamptz not null default clock_timestamp(),
  capability_issued_at timestamptz,
  nominal_expires_at timestamptz,
  client_outcome text check (client_outcome in ('uploaded','failed','aborted')),
  observed_object jsonb,
  observed_identity text check (length(observed_identity) <= 1600),
  verification_error_code text,
  last_checked_at timestamptz,
  check (expected_bytes is not null or purpose in ('video','thumbnail')),
  check (
    (purpose in ('video','thumbnail') and provider='r2')
    or (purpose='premium' and provider='supabase' and bucket='premium')
    or (purpose='avatar' and provider='supabase' and bucket='avatars')
  ),
  unique(provider,bucket,object_key)
);
create index upload_attempts_owner_operation_v1
  on upload_tracking.attempts_v1(owner_id,operation_id);
create index upload_attempts_admitted_cursor_v1
  on upload_tracking.attempts_v1(admitted_at,id);

create table upload_tracking.observations_v1 (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references upload_tracking.attempts_v1(id),
  identity text not null check (length(identity) <= 1600),
  metadata jsonb not null,
  observed_at timestamptz not null default clock_timestamp(),
  unique(attempt_id,identity)
);

alter table upload_tracking.control_v1 enable row level security;
alter table upload_tracking.attempts_v1 enable row level security;
alter table upload_tracking.observations_v1 enable row level security;
revoke all on upload_tracking.control_v1, upload_tracking.attempts_v1,
  upload_tracking.observations_v1 from public, anon, authenticated;
grant select,insert,update on upload_tracking.control_v1,
  upload_tracking.attempts_v1 to service_role;
grant select,insert on upload_tracking.observations_v1 to service_role;
grant usage,select on sequence upload_tracking.observations_v1_id_seq to service_role;

create function public.reserve_upload_attempt_v1(
  p_id uuid, p_operation_id uuid, p_owner_id uuid, p_purpose text,
  p_content_type text, p_expected_bytes bigint, p_extension text, p_bucket text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  c upload_tracking.control_v1%rowtype;
  a upload_tracking.attempts_v1%rowtype;
  provider_name text;
  object_name text;
begin
  select * into c from upload_tracking.control_v1 where singleton for update;
  if not found then raise exception 'upload_controls_unavailable'; end if;
  select * into a from upload_tracking.attempts_v1 where id=p_id for update;
  if found then
    if a.owner_id is distinct from p_owner_id
      or a.operation_id is distinct from p_operation_id
      or a.purpose is distinct from p_purpose
      or a.content_type is distinct from p_content_type
      or a.expected_bytes is distinct from p_expected_bytes
      or a.extension is distinct from p_extension
      or a.bucket is distinct from p_bucket then
      raise exception 'upload_attempt_conflict';
    end if;
    return jsonb_build_object('created',false,'attempt',to_jsonb(a));
  end if;
  if c.paused then raise exception 'upload_admission_paused'; end if;
  if p_id is null or p_operation_id is null or p_owner_id is null
    or p_purpose is null or p_purpose not in ('video','thumbnail','premium','avatar')
    or p_extension is null or p_extension !~ '^[a-z0-9]{1,8}$'
    or p_content_type is null or p_content_type <> lower(p_content_type)
    or length(p_content_type)>128
    or p_content_type !~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'
    or p_bucket is null or length(p_bucket) not between 1 and 128
    or p_expected_bytes is null
    or (p_expected_bytes is not null and
        (p_expected_bytes < 1 or p_expected_bytes > 9007199254740991))
    or (p_purpose='video' and p_expected_bytes > 524288000)
    or (p_purpose='thumbnail' and p_expected_bytes > 10485760)
    or (p_purpose='avatar' and p_expected_bytes > 5242880)
    or (p_purpose='premium' and p_bucket <> 'premium')
    or (p_purpose='avatar' and p_bucket <> 'avatars') then
    raise exception 'upload_invalid_request';
  end if;
  if exists(
    select 1 from upload_tracking.attempts_v1 old
    where old.owner_id=p_owner_id and old.operation_id=p_operation_id
      and (old.purpose is distinct from p_purpose
        or old.content_type is distinct from p_content_type
        or old.expected_bytes is distinct from p_expected_bytes
        or old.bucket is distinct from p_bucket)
  ) then raise exception 'upload_operation_conflict'; end if;
  provider_name := case when p_purpose in ('video','thumbnail') then 'r2' else 'supabase' end;
  object_name := p_owner_id::text || '/' || p_id::text || '.' || p_extension;
  if p_purpose='video' then object_name := 'videos/' || p_owner_id::text || '/launch_' || p_id::text || '.' || p_extension; end if;
  if p_purpose='thumbnail' then object_name := 'thumbnails/' || p_owner_id::text || '/launch_' || p_id::text || '.' || p_extension; end if;
  insert into upload_tracking.attempts_v1(
    id,operation_id,owner_id,purpose,provider,bucket,object_key,
    content_type,expected_bytes,extension,admission_generation
  ) values(
    p_id,p_operation_id,p_owner_id,p_purpose,provider_name,p_bucket,object_name,
    p_content_type,p_expected_bytes,p_extension,c.generation
  ) returning * into a;
  return jsonb_build_object('created',true,'attempt',to_jsonb(a));
end;
$$;

create function public.publish_upload_attempt_v1(
  p_id uuid,p_owner_id uuid,p_nominal_expires_at timestamptz
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  c upload_tracking.control_v1%rowtype;
  a upload_tracking.attempts_v1%rowtype;
begin
  -- Same lock order as reservation and closure; no lock spans a provider call.
  select * into c from upload_tracking.control_v1 where singleton for update;
  if not found then raise exception 'upload_controls_unavailable'; end if;
  select * into a from upload_tracking.attempts_v1 where id=p_id and owner_id=p_owner_id for update;
  if not found then raise exception 'upload_attempt_not_found'; end if;
  if c.paused then raise exception 'upload_admission_paused'; end if;
  if a.state <> 'reserved' then raise exception 'upload_attempt_conflict'; end if;
  if a.admission_generation<>c.generation then raise exception 'upload_attempt_conflict'; end if;
  if p_nominal_expires_at is null or p_nominal_expires_at <= clock_timestamp()
    or p_nominal_expires_at > clock_timestamp()+interval '4 hours' then
    raise exception 'upload_invalid_expiry';
  end if;
  update upload_tracking.attempts_v1
    set state='capability_issued',capability_issued_at=clock_timestamp(),
        nominal_expires_at=p_nominal_expires_at
    where id=p_id returning * into a;
  return to_jsonb(a);
end;
$$;

create function public.note_upload_issuance_failure_v1(
  p_id uuid,p_owner_id uuid,p_reason text
) returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_reason not in ('SIGNING_UNAVAILABLE','PUBLISH_UNCONFIRMED','ADMISSION_PAUSED') then
    raise exception 'upload_invalid_request';
  end if;
  update upload_tracking.attempts_v1 set verification_error_code=p_reason
    where id=p_id and owner_id=p_owner_id;
  -- Never deletes a reservation or declares an ambiguous signing call inactive.
end;
$$;

create function public.get_upload_attempt_v1(p_id uuid,p_owner_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select to_jsonb(a) from upload_tracking.attempts_v1 a
  where a.id=p_id and a.owner_id=p_owner_id;
$$;

create function public.observe_upload_attempt_v1(
  p_id uuid,p_owner_id uuid,p_client_outcome text,
  p_metadata jsonb,p_error_code text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  a upload_tracking.attempts_v1%rowtype;
  observed_state text;
  computed_identity text;
  object_size numeric;
  object_type text;
begin
  select * into a from upload_tracking.attempts_v1
    where id=p_id and owner_id=p_owner_id for update;
  if not found then raise exception 'upload_attempt_not_found'; end if;
  if p_client_outcome is not null and p_client_outcome not in ('uploaded','failed','aborted') then
    raise exception 'upload_invalid_request';
  end if;
  if p_error_code is not null and p_error_code not in
    ('VERIFICATION_UNAVAILABLE','OBJECT_NOT_FOUND','OBJECT_MISMATCH','BINDING_MISMATCH') then
    raise exception 'upload_invalid_request';
  end if;
  if p_metadata is not null then
    if jsonb_typeof(p_metadata) is distinct from 'object' then
      raise exception 'upload_invalid_observation';
    end if;
    if exists(select 1 from jsonb_object_keys(p_metadata) k
                where k not in ('size','contentType','etag','version'))
      or jsonb_typeof(p_metadata->'size') is distinct from 'number'
      or jsonb_typeof(p_metadata->'contentType') is distinct from 'string'
      or (p_metadata->'etag' is not null and jsonb_typeof(p_metadata->'etag') not in ('string','null'))
      or (p_metadata->'version' is not null and jsonb_typeof(p_metadata->'version') not in ('string','null'))
      or length(coalesce(p_metadata->>'etag',''))>512
      or length(coalesce(p_metadata->>'version',''))>512 then
      raise exception 'upload_invalid_observation';
    end if;
    object_size := (p_metadata->>'size')::numeric;
    object_type := p_metadata->>'contentType';
    if object_size<1 or object_size>9007199254740991 or trunc(object_size)<>object_size
      or length(object_type)>128
      or object_type !~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$' then
      raise exception 'upload_invalid_observation';
    end if;
    computed_identity := p_metadata::text;
    if length(computed_identity)>1600 then raise exception 'upload_invalid_observation'; end if;
    insert into upload_tracking.observations_v1(attempt_id,identity,metadata)
      values(p_id,computed_identity,p_metadata) on conflict(attempt_id,identity) do nothing;
    observed_state := case
      when p_error_code='OBJECT_MISMATCH' or a.state='object_mismatch'
        or object_type<>a.content_type
        or (a.expected_bytes is not null and object_size<>a.expected_bytes)
        or (a.purpose='video' and object_size>524288000)
        or (a.purpose='thumbnail' and object_size>10485760)
        or (a.purpose='avatar' and object_size>5242880)
        or (a.observed_identity is not null and a.observed_identity<>computed_identity)
      then 'object_mismatch' else 'object_observed' end;
    update upload_tracking.attempts_v1 set
      state=observed_state,
      observed_object=coalesce(observed_object,p_metadata),
      observed_identity=coalesce(observed_identity,computed_identity),
      client_outcome=coalesce(p_client_outcome,client_outcome),
      verification_error_code=case when observed_state='object_mismatch'
        then 'OBJECT_MISMATCH' else p_error_code end,
      last_checked_at=clock_timestamp()
      where id=p_id returning * into a;
  else
    update upload_tracking.attempts_v1 set
      state=case when state='object_mismatch' then state
        when p_error_code is not null then 'verification_unavailable' else state end,
      client_outcome=coalesce(p_client_outcome,client_outcome),
      verification_error_code=coalesce(p_error_code,verification_error_code),
      last_checked_at=clock_timestamp()
      where id=p_id returning * into a;
  end if;
  return to_jsonb(a);
end;
$$;

create function public.set_upload_admission_v1(
  p_paused boolean,p_expected_generation bigint,p_reason text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare c upload_tracking.control_v1%rowtype;
begin
  select * into c from upload_tracking.control_v1 where singleton for update;
  if not found then raise exception 'upload_controls_unavailable'; end if;
  if p_paused is null or p_expected_generation is null
    or p_reason is null or length(p_reason) not between 1 and 160 then
    raise exception 'upload_invalid_request';
  end if;
  if c.generation<>p_expected_generation then raise exception 'upload_control_conflict'; end if;
  if c.paused is distinct from p_paused then
    update upload_tracking.control_v1
      set paused=p_paused,generation=generation+1,reason=p_reason,updated_at=clock_timestamp()
      where singleton returning * into c;
  end if;
  return to_jsonb(c);
end;
$$;

create function public.upload_maintenance_snapshot_v1()
returns jsonb language sql security invoker set search_path='' as $$
  select jsonb_build_object(
    'control',(select to_jsonb(c) from upload_tracking.control_v1 c where singleton),
    'attemptCount',(select count(*) from upload_tracking.attempts_v1),
    'objectObservedCount',(select count(*) from upload_tracking.attempts_v1 where observed_object is not null),
    'unresolvedCount',(select count(*) from upload_tracking.attempts_v1),
    'legacyUploadCoverage','unknown',
    'providerQuiescenceProven',false,
    'safeToRestore',false,
    'attempts',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from
      (select * from upload_tracking.attempts_v1 order by admitted_at,id limit 100) a),
    'hasMore',(select count(*)>100 from upload_tracking.attempts_v1)
  );
$$;

-- Stable keyset pagination exposes every retained attempt without an unbounded
-- browser response. Service-only; table visibility is never granted to users.
create function public.list_upload_attempts_v1(
  p_after_at timestamptz default null,p_after_id uuid default null,p_limit integer default 100
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare rows jsonb; last_row jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100
    or (p_after_at is null) is distinct from (p_after_id is null) then
    raise exception 'upload_invalid_request';
  end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.admitted_at,a.id),'[]'::jsonb) into rows
    from (select * from upload_tracking.attempts_v1
      where p_after_at is null or (admitted_at,id)>(p_after_at,p_after_id)
      order by admitted_at,id limit p_limit) a;
  last_row := rows->(jsonb_array_length(rows)-1);
  return jsonb_build_object('attempts',rows,'nextCursor',case
    when last_row is not null and exists(select 1 from upload_tracking.attempts_v1
      where (admitted_at,id)>((last_row->>'admitted_at')::timestamptz,(last_row->>'id')::uuid))
    then jsonb_build_object('admittedAt',last_row->>'admitted_at','id',last_row->>'id')
    else null end);
end;
$$;

-- Existing permissive Storage policies remain necessary. These policies only
-- restrict the two existing private/public Supabase upload buckets.
-- Operation-aware authorization deliberately rejects ordinary direct uploads
-- after cutover. All new clients use admitted signed-upload workflows.
create function upload_tracking.storage_write_allowed_v1(p_bucket text,p_key text)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  actor uuid := auth.uid();
  c upload_tracking.control_v1%rowtype;
  a upload_tracking.attempts_v1%rowtype;
begin
  if actor is null then return false; end if;
  select * into c from upload_tracking.control_v1 where singleton for share;
  if not found then return false; end if;
  select * into a from upload_tracking.attempts_v1
    where owner_id=actor and provider='supabase' and bucket=p_bucket and object_key=p_key;
  if not found then return false; end if;
  if storage.allow_only_operation('object.sign_upload_url') then
    return not c.paused and a.admission_generation=c.generation;
  end if;
  if storage.allow_only_operation('object.upload_signed') then
    return true; -- admitted capability continuation, including while paused
  end if;
  return false; -- ordinary, multipart, move/copy, and unknown operations
end;
$$;

revoke all on function upload_tracking.storage_write_allowed_v1(text,text) from public;
grant execute on function upload_tracking.storage_write_allowed_v1(text,text)
  to authenticated,anon,service_role;

create policy upload_tracking_media_insert_v1 on storage.objects
  as restrictive for insert to authenticated,anon
  with check (
    bucket_id not in ('premium','avatars')
    or upload_tracking.storage_write_allowed_v1(bucket_id,name)
  );
create policy upload_tracking_media_update_v1 on storage.objects
  as restrictive for update to authenticated,anon
  using (
    bucket_id not in ('premium','avatars')
    or upload_tracking.storage_write_allowed_v1(bucket_id,name)
  )
  with check (
    bucket_id not in ('premium','avatars')
    or upload_tracking.storage_write_allowed_v1(bucket_id,name)
  );

revoke all on function public.reserve_upload_attempt_v1(uuid,uuid,uuid,text,text,bigint,text,text)
  from public,anon,authenticated;
revoke all on function public.publish_upload_attempt_v1(uuid,uuid,timestamptz)
  from public,anon,authenticated;
revoke all on function public.note_upload_issuance_failure_v1(uuid,uuid,text)
  from public,anon,authenticated;
revoke all on function public.get_upload_attempt_v1(uuid,uuid)
  from public,anon,authenticated;
revoke all on function public.observe_upload_attempt_v1(uuid,uuid,text,jsonb,text)
  from public,anon,authenticated;
revoke all on function public.set_upload_admission_v1(boolean,bigint,text)
  from public,anon,authenticated;
revoke all on function public.upload_maintenance_snapshot_v1()
  from public,anon,authenticated;
revoke all on function public.list_upload_attempts_v1(timestamptz,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.reserve_upload_attempt_v1(uuid,uuid,uuid,text,text,bigint,text,text),
  public.publish_upload_attempt_v1(uuid,uuid,timestamptz),
  public.note_upload_issuance_failure_v1(uuid,uuid,text),
  public.get_upload_attempt_v1(uuid,uuid),
  public.observe_upload_attempt_v1(uuid,uuid,text,jsonb,text),
  public.set_upload_admission_v1(boolean,bigint,text),
  public.upload_maintenance_snapshot_v1(),
  public.list_upload_attempts_v1(timestamptz,uuid,integer) to service_role;


-- Requires the current-main durable abuse-admission schema. This service-only
-- read path preserves exact retained legacy evidence without creating/debiting
-- a reservation or claiming historical signing, expiry, completion or drain.
create function public.find_legacy_public_upload_reservation_v1(
  p_actor text,p_operation text,p_contract text,p_resource text
) returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('resource',r.resource)
  from abuse_private.upload_reservations r
  where r.action='public_upload' and r.actor=p_actor and r.operation=p_operation
    and r.contract=p_contract and r.resource=p_resource
    and p_actor ~ '^[a-f0-9]{64}$' and p_operation ~ '^[a-f0-9]{64}$'
    and p_contract ~ '^[a-f0-9]{64}$'
$$;
revoke all on function public.find_legacy_public_upload_reservation_v1(text,text,text,text) from public,anon,authenticated;
grant execute on function public.find_legacy_public_upload_reservation_v1(text,text,text,text) to service_role;

commit;

