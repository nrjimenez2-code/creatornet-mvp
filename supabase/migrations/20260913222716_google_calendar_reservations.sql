alter table public.scheduling_connections_v1 drop constraint scheduling_connections_v1_provider_check;
alter table public.scheduling_connections_v1 add constraint scheduling_connections_v1_provider_check
  check (provider in ('calcom','calendly','google'));
alter table public.scheduling_oauth_attempts_v1 drop constraint scheduling_oauth_attempts_v1_provider_check;
alter table public.scheduling_oauth_attempts_v1 add constraint scheduling_oauth_attempts_v1_provider_check
  check (provider in ('calcom','calendly','google'));

create table public.google_booking_settings_v1 (
  connection_id uuid primary key references public.scheduling_connections_v1(id) on delete cascade,
  calendar_id text not null,
  conflict_calendar_ids text[] not null,
  availability jsonb not null check (jsonb_typeof(availability) = 'object'),
  title text not null check (length(title) between 1 and 160),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  check (cardinality(conflict_calendar_ids) between 1 and 50),
  check (calendar_id = any(conflict_calendar_ids))
);

create table public.google_calendar_watches_v1 (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.scheduling_connections_v1(id) on delete cascade,
  calendar_id text not null,
  resource_id text,
  token_ciphertext text not null,
  expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending','active','retiring','stopped','error')),
  sync_token_ciphertext text,
  next_page_token_ciphertext text,
  sync_requested_at timestamptz,
  last_synced_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  check (status <> 'active' or (resource_id is not null and expires_at is not null)),
  check ((lease_id is null) = (lease_until is null))
);
create index google_calendar_watches_renewal_v1 on public.google_calendar_watches_v1(expires_at) where status='active';

create table public.google_booking_reservations_v1 (
  id uuid primary key,
  connection_id uuid not null references public.scheduling_connections_v1(id),
  buyer_id uuid not null references public.profiles(id),
  calendar_id text not null,
  original_post_id uuid not null,
  attribution_id uuid,
  purchase_id uuid,
  status text not null default 'held' check (status in ('held','creating','confirmed','rescheduling','canceling','canceled','failed')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  buffer_before_minutes integer not null check (buffer_before_minutes between 0 and 240),
  buffer_after_minutes integer not null check (buffer_after_minutes between 0 and 240),
  desired_starts_at timestamptz,
  desired_ends_at timestamptz,
  hold_expires_at timestamptz not null,
  event_id text,
  event_etag text,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((desired_starts_at is null and desired_ends_at is null) or (desired_starts_at is not null and desired_ends_at > desired_starts_at)),
  check (status <> 'confirmed' or event_id is not null)
);
create index google_booking_reservation_conflicts_v1 on public.google_booking_reservations_v1(connection_id, starts_at, ends_at)
  where status not in ('canceled','failed');
create index google_booking_reservation_buyer_v1 on public.google_booking_reservations_v1(buyer_id, starts_at);

create table public.google_booking_jobs_v1 (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.google_booking_reservations_v1(id),
  revision bigint not null,
  action text not null check (action in ('create','reschedule','cancel')),
  status text not null default 'pending' check (status in ('pending','processing','retry','complete','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  unique (reservation_id, revision),
  check ((lease_id is null) = (lease_until is null))
);
create index google_booking_jobs_due_v1 on public.google_booking_jobs_v1(next_attempt_at) where status in ('pending','retry','processing');

-- Only authenticated application routes using the service role call this function.
-- The route must verify buyer identity, source video/purchase and provider availability first.
create function public.reserve_google_booking_v1(
  p_id uuid, p_connection uuid, p_buyer uuid, p_post uuid,
  p_start timestamptz, p_end timestamptz, p_attribution uuid default null, p_purchase uuid default null
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  existing public.google_booking_reservations_v1;
  settings public.google_booking_settings_v1;
  before_minutes integer;
  after_minutes integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_connection::text, 904));
  select * into existing from public.google_booking_reservations_v1 where id=p_id;
  if found then
    if existing.connection_id is distinct from p_connection or existing.buyer_id is distinct from p_buyer or existing.original_post_id is distinct from p_post
      or existing.starts_at is distinct from p_start or existing.ends_at is distinct from p_end
      or existing.attribution_id is distinct from p_attribution or existing.purchase_id is distinct from p_purchase then
      raise exception 'Reservation request does not match the existing booking';
    end if;
    return existing.id;
  end if;
  if not exists(select 1 from public.scheduling_connections_v1 where id=p_connection and provider='google' and status='connected') then
    raise exception 'Google Calendar is not connected';
  end if;
  select * into settings from public.google_booking_settings_v1 where connection_id=p_connection and active;
  if not found then raise exception 'Booking hours are not configured'; end if;
  before_minutes := (settings.availability->>'bufferBeforeMinutes')::integer;
  after_minutes := (settings.availability->>'bufferAfterMinutes')::integer;
  if p_start is null or p_end is null or p_start<=now() or p_end<=p_start
    or p_end-p_start<>make_interval(mins=>(settings.availability->>'durationMinutes')::integer)
    or (settings.availability->>'durationMinutes') is null
    or before_minutes is null or after_minutes is null then raise exception 'Invalid booking interval'; end if;
  -- Only never-attempted holds may expire. Creating/rescheduling jobs remain reserved
  -- until their external outcome has been reconciled, regardless of elapsed time.
  update public.google_booking_reservations_v1 set status='failed',updated_at=now()
    where connection_id=p_connection and status='held' and hold_expires_at<=now();
  if exists(select 1 from public.google_booking_reservations_v1 r where r.connection_id=p_connection
    and r.status not in ('canceled','failed') and (
      tstzrange(r.starts_at-make_interval(mins=>r.buffer_before_minutes),r.ends_at+make_interval(mins=>r.buffer_after_minutes),'[)') &&
      tstzrange(p_start-make_interval(mins=>before_minutes),p_end+make_interval(mins=>after_minutes),'[)')
      or (r.desired_starts_at is not null and
        tstzrange(r.desired_starts_at-make_interval(mins=>r.buffer_before_minutes),r.desired_ends_at+make_interval(mins=>r.buffer_after_minutes),'[)') &&
        tstzrange(p_start-make_interval(mins=>before_minutes),p_end+make_interval(mins=>after_minutes),'[)'))
    )) then raise exception 'That time is no longer available'; end if;
  insert into public.google_booking_reservations_v1(id,connection_id,buyer_id,calendar_id,original_post_id,attribution_id,purchase_id,
    starts_at,ends_at,buffer_before_minutes,buffer_after_minutes,hold_expires_at)
    values(p_id,p_connection,p_buyer,settings.calendar_id,p_post,p_attribution,p_purchase,p_start,p_end,before_minutes,after_minutes,now()+interval '5 minutes');
  return p_id;
end $$;

create function public.enqueue_google_booking_create_v1(p_id uuid, p_buyer uuid)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare reservation public.google_booking_reservations_v1; job_id uuid;
begin
  select * into reservation from public.google_booking_reservations_v1 where id=p_id and buyer_id=p_buyer for update;
  if not found then raise exception 'Booking not found'; end if;
  if reservation.status='held' then
    if reservation.hold_expires_at<=now() then raise exception 'Booking hold expired'; end if;
    update public.google_booking_reservations_v1 set status='creating',updated_at=now() where id=p_id;
  elsif reservation.status not in ('creating','confirmed') then raise exception 'Booking cannot be created'; end if;
  insert into public.google_booking_jobs_v1(reservation_id,revision,action) values(p_id,0,'create')
    on conflict(reservation_id,revision) do nothing;
  select id into job_id from public.google_booking_jobs_v1 where reservation_id=p_id and revision=0;
  return job_id;
end $$;

create function public.request_google_booking_change_v1(
  p_id uuid, p_buyer uuid, p_revision bigint, p_action text,
  p_start timestamptz default null, p_end timestamptz default null
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare reservation public.google_booking_reservations_v1; connection uuid; job_id uuid; existing_job public.google_booking_jobs_v1;
begin
  if p_action not in ('reschedule','cancel') or p_action is null or p_revision is null then raise exception 'Invalid booking action'; end if;
  select connection_id into connection from public.google_booking_reservations_v1 where id=p_id and buyer_id=p_buyer;
  if not found then raise exception 'Booking not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(connection::text,904));
  select * into reservation from public.google_booking_reservations_v1 where id=p_id and buyer_id=p_buyer for update;
  select * into existing_job from public.google_booking_jobs_v1 where reservation_id=p_id and revision=p_revision+1;
  if found then
    if existing_job.action=p_action and (p_action='cancel' or
      (reservation.desired_starts_at is not distinct from p_start and reservation.desired_ends_at is not distinct from p_end) or
      (existing_job.status='complete' and reservation.starts_at is not distinct from p_start and reservation.ends_at is not distinct from p_end))
      then return existing_job.id; end if;
    raise exception 'A different change already used this booking version';
  end if;
  if reservation.revision<>p_revision or reservation.status<>'confirmed' then raise exception 'Booking changed; refresh before trying again'; end if;
  if p_action='reschedule' then
    if not exists(select 1 from public.scheduling_connections_v1 where id=connection and status='connected') then raise exception 'Google Calendar is not connected'; end if;
    if p_start is null or p_end is null or p_start<=now() or p_end-p_start<>reservation.ends_at-reservation.starts_at then raise exception 'Invalid booking interval'; end if;
    if exists(select 1 from public.google_booking_reservations_v1 r where r.connection_id=connection and r.id<>p_id
      and r.status not in ('canceled','failed') and (r.status<>'held' or r.hold_expires_at>now()) and (
      tstzrange(r.starts_at-make_interval(mins=>r.buffer_before_minutes),r.ends_at+make_interval(mins=>r.buffer_after_minutes),'[)') &&
        tstzrange(p_start-make_interval(mins=>reservation.buffer_before_minutes),p_end+make_interval(mins=>reservation.buffer_after_minutes),'[)') or
      (r.desired_starts_at is not null and tstzrange(r.desired_starts_at-make_interval(mins=>r.buffer_before_minutes),r.desired_ends_at+make_interval(mins=>r.buffer_after_minutes),'[)') &&
        tstzrange(p_start-make_interval(mins=>reservation.buffer_before_minutes),p_end+make_interval(mins=>reservation.buffer_after_minutes),'[)'))
      )) then raise exception 'That time is no longer available'; end if;
  end if;
  update public.google_booking_reservations_v1 set revision=revision+1,
    status=case when p_action='cancel' then 'canceling' else 'rescheduling' end,
    desired_starts_at=case when p_action='reschedule' then p_start else null end,
    desired_ends_at=case when p_action='reschedule' then p_end else null end,updated_at=now() where id=p_id;
  insert into public.google_booking_jobs_v1(reservation_id,revision,action) values(p_id,p_revision+1,p_action) returning id into job_id;
  return job_id;
end $$;

create function public.claim_google_booking_job_v1(p_worker uuid)
returns setof public.google_booking_jobs_v1 language plpgsql security invoker set search_path=public,pg_temp as $$
declare job_id uuid;
begin
  if p_worker is null then raise exception 'Missing worker lease'; end if;
  select id into job_id from public.google_booking_jobs_v1
    where ((status in ('pending','retry') and next_attempt_at<=now()) or (status='processing' and lease_until<now()))
    order by next_attempt_at,id limit 1 for update skip locked;
  if not found then return; end if;
  return query update public.google_booking_jobs_v1 set status='processing',attempts=attempts+1,
    lease_id=p_worker,lease_until=now()+interval '5 minutes' where id=job_id returning *;
end $$;

create function public.complete_google_booking_job_v1(
  p_job uuid, p_worker uuid, p_event_id text, p_event_etag text,
  p_start timestamptz default null, p_end timestamptz default null
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare job public.google_booking_jobs_v1; reservation public.google_booking_reservations_v1;
begin
  select * into job from public.google_booking_jobs_v1 where id=p_job and lease_id=p_worker and status='processing' and lease_until>now() for update;
  if not found then raise exception 'Booking worker lease expired'; end if;
  select * into reservation from public.google_booking_reservations_v1 where id=job.reservation_id for update;
  if reservation.revision<>job.revision then raise exception 'Booking revision changed'; end if;
  if job.action<>'cancel' then
    if p_event_id is null or length(p_event_id)=0 or p_event_etag is null or length(p_event_etag)=0
      or p_start is distinct from coalesce(reservation.desired_starts_at,reservation.starts_at)
      or p_end is distinct from coalesce(reservation.desired_ends_at,reservation.ends_at) then raise exception 'Calendar event does not match the reserved time'; end if;
    if reservation.event_id is not null and reservation.event_id<>p_event_id then raise exception 'Calendar event identity changed'; end if;
    update public.google_booking_reservations_v1 set status='confirmed',event_id=p_event_id,event_etag=p_event_etag,
      starts_at=p_start,ends_at=p_end,desired_starts_at=null,desired_ends_at=null,updated_at=now() where id=reservation.id;
  else
    update public.google_booking_reservations_v1 set status='canceled',desired_starts_at=null,desired_ends_at=null,updated_at=now() where id=reservation.id;
  end if;
  update public.google_booking_jobs_v1 set status='complete',lease_id=null,lease_until=null,last_error_code=null where id=p_job;
  return reservation.id;
end $$;

alter table public.google_booking_settings_v1 enable row level security;
alter table public.google_calendar_watches_v1 enable row level security;
alter table public.google_booking_reservations_v1 enable row level security;
alter table public.google_booking_jobs_v1 enable row level security;
revoke all on public.google_booking_settings_v1, public.google_calendar_watches_v1,
  public.google_booking_reservations_v1, public.google_booking_jobs_v1 from public,anon,authenticated;
grant all on public.google_booking_settings_v1, public.google_calendar_watches_v1,
  public.google_booking_reservations_v1, public.google_booking_jobs_v1 to service_role;
revoke all on function public.reserve_google_booking_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid),
  public.enqueue_google_booking_create_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_google_booking_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid),
  public.enqueue_google_booking_create_v1(uuid,uuid) to service_role;
revoke all on function public.request_google_booking_change_v1(uuid,uuid,bigint,text,timestamptz,timestamptz),
  public.claim_google_booking_job_v1(uuid) from public,anon,authenticated;
grant execute on function public.request_google_booking_change_v1(uuid,uuid,bigint,text,timestamptz,timestamptz),
  public.claim_google_booking_job_v1(uuid) to service_role;
revoke all on function public.complete_google_booking_job_v1(uuid,uuid,text,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_google_booking_job_v1(uuid,uuid,text,text,timestamptz,timestamptz) to service_role;
