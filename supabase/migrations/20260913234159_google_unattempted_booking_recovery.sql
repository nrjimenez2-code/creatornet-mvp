begin;
alter table public.google_booking_jobs_v1 add column mutation_started_at timestamptz;
-- Existing attempts predate mutation tracking; conservatively retain their reservations.
update public.google_booking_jobs_v1 set mutation_started_at=created_at where attempts>0;
alter table public.google_booking_reservations_v1 drop constraint google_booking_reservations_v1_recovery_code_check;
alter table public.google_booking_reservations_v1 add constraint google_booking_reservations_v1_recovery_code_check
 check (recovery_code is null or recovery_code in ('google_booking_changed_externally','google_booking_time_passed','google_booking_time_unavailable'));
create function public.begin_google_booking_mutation_v1(p_job uuid,p_worker uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare j public.google_booking_jobs_v1; r public.google_booking_reservations_v1;
begin
 select * into j from public.google_booking_jobs_v1 where id=p_job and lease_id=p_worker and status='processing' for update;
 if not found or j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
 select * into r from public.google_booking_reservations_v1 where id=j.reservation_id for update;
 if not found or r.revision<>j.revision or r.status is distinct from
  (case j.action when 'create' then 'creating' when 'reschedule' then 'rescheduling' else 'canceling' end) then raise exception 'Booking operation changed'; end if;
 if j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
 update public.google_booking_jobs_v1 set mutation_started_at=coalesce(mutation_started_at,clock_timestamp()) where id=j.id;
end $$;
create function public.fail_unattempted_google_booking_v1(p_job uuid,p_worker uuid,p_reason text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare j public.google_booking_jobs_v1; r public.google_booking_reservations_v1;
begin
 if p_reason is null or p_reason not in ('google_booking_time_passed','google_booking_time_unavailable') then raise exception 'Invalid recovery reason'; end if;
 select * into j from public.google_booking_jobs_v1 where id=p_job and lease_id=p_worker and status='processing' for update;
 if not found or j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
 if j.action<>'create' or j.mutation_started_at is not null then return false; end if;
 select * into r from public.google_booking_reservations_v1 where id=j.reservation_id for update;
 if not found or r.revision<>j.revision or r.status<>'creating' or r.event_id is not null then return false; end if;
 if j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
 update public.google_booking_reservations_v1 set status='failed',recovery_code=p_reason,updated_at=clock_timestamp() where id=r.id;
 update public.google_booking_jobs_v1 set status='failed',last_error_code=p_reason,lease_id=null,lease_until=null where id=j.id;
 return true;
end $$;
revoke all on function public.begin_google_booking_mutation_v1(uuid,uuid),public.fail_unattempted_google_booking_v1(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.begin_google_booking_mutation_v1(uuid,uuid),public.fail_unattempted_google_booking_v1(uuid,uuid,text) to service_role;

create or replace function public.reserve_google_booking_v1(
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
      or existing.attribution_id is distinct from p_attribution or existing.purchase_id is distinct from p_purchase then raise exception 'Reservation request does not match the existing booking'; end if;
    if not ((existing.status='failed' or (existing.status='held' and existing.hold_expires_at<=now())) and existing.event_id is null
      and not exists(select 1 from public.google_booking_jobs_v1 where reservation_id=existing.id and (status<>'failed' or mutation_started_at is not null))) then
      if existing.starts_at is distinct from p_start or existing.ends_at is distinct from p_end then raise exception 'Reservation request does not match the existing booking'; end if;
      return existing.id;
    end if;
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
    values(p_id,p_connection,p_buyer,settings.calendar_id,p_post,p_attribution,p_purchase,p_start,p_end,before_minutes,after_minutes,now()+interval '5 minutes')
    on conflict(id) do update set calendar_id=excluded.calendar_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
      buffer_before_minutes=excluded.buffer_before_minutes,buffer_after_minutes=excluded.buffer_after_minutes,
      hold_expires_at=excluded.hold_expires_at,status='held',revision=google_booking_reservations_v1.revision+1,recovery_code=null,updated_at=now();
  return p_id;
end $$;
create or replace function public.enqueue_google_booking_create_v1(p_id uuid, p_buyer uuid)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare reservation public.google_booking_reservations_v1; job_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended((select connection_id::text from public.google_booking_reservations_v1 where id=p_id),904));
  select * into reservation from public.google_booking_reservations_v1 where id=p_id and buyer_id=p_buyer for update;
  if not found then raise exception 'Booking not found'; end if;
  if reservation.status='held' then
    if not exists(select 1 from public.scheduling_connections_v1 where id=reservation.connection_id and status='connected') then raise exception 'Google Calendar is not connected'; end if;
    if reservation.hold_expires_at<=now() then raise exception 'Booking hold expired'; end if;
    update public.google_booking_reservations_v1 set status='creating',updated_at=now() where id=p_id;
  elsif reservation.status not in ('creating','confirmed') then raise exception 'Booking cannot be created'; end if;
  insert into public.google_booking_jobs_v1(reservation_id,revision,action) values(p_id,reservation.revision,'create')
    on conflict(reservation_id,revision) do nothing;
  select id into job_id from public.google_booking_jobs_v1 where reservation_id=p_id and revision=reservation.revision;
  return job_id;
end $$;
commit;
