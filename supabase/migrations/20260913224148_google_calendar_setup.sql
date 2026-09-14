begin;
create function public.configure_google_calendar_v1(p_connection uuid,p_creator uuid,p_lease uuid,p_calendar text,
 p_conflicts text[],p_availability jsonb,p_title text,p_watch uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare c public.scheduling_connections_v1; w public.google_calendar_watches_v1;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_connection::text,904));
 select * into c from public.scheduling_connections_v1 where id=p_connection and creator_id=p_creator and provider='google' for update;
 if not found or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp()
  or c.status not in ('pending','connected') or c.credentials_ciphertext is null then raise exception 'Google setup lease expired'; end if;
 select * into w from public.google_calendar_watches_v1 where id=p_watch and connection_id=c.id and calendar_id=p_calendar
  and status='active' and expires_at>clock_timestamp()+interval '5 minutes';
 if not found then raise exception 'Calendar notifications are not ready'; end if;
 if exists(select 1 from public.google_booking_reservations_v1 where connection_id=c.id
  and status not in ('canceled','failed') and calendar_id<>p_calendar) then raise exception 'Existing bookings use the previous calendar'; end if;
 insert into public.google_booking_settings_v1(connection_id,calendar_id,conflict_calendar_ids,availability,title)
 values(c.id,p_calendar,p_conflicts,p_availability,p_title)
 on conflict(connection_id) do update set calendar_id=excluded.calendar_id,conflict_calendar_ids=excluded.conflict_calendar_ids,
 availability=excluded.availability,title=excluded.title,active=true,updated_at=now();
 update public.google_calendar_watches_v1 set status='retiring' where connection_id=c.id and id<>w.id and status in ('pending','active','error');
 update public.scheduling_connections_v1 set status='connected',webhook_id=w.id::text,webhook_secret_ciphertext=w.token_ciphertext,
  last_checked_at=now(),last_error_code=null,updated_at=now() where id=c.id;
end $$;
revoke all on function public.configure_google_calendar_v1(uuid,uuid,uuid,text,text[],jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.configure_google_calendar_v1(uuid,uuid,uuid,text,text[],jsonb,text,uuid) to service_role;
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
  insert into public.google_booking_jobs_v1(reservation_id,revision,action) values(p_id,0,'create')
    on conflict(reservation_id,revision) do nothing;
  select id into job_id from public.google_booking_jobs_v1 where reservation_id=p_id and revision=0;
  return job_id;
end $$;


create or replace function public.request_google_booking_change_v1(
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
  if not exists(select 1 from public.scheduling_connections_v1 where id=connection and status='connected') then raise exception 'Google Calendar is not connected'; end if;
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


create function public.begin_google_calendar_disconnect_v1(p_connection uuid,p_creator uuid,p_lease uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare c public.scheduling_connections_v1;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_connection::text,904));
 select * into c from public.scheduling_connections_v1 where id=p_connection and creator_id=p_creator and provider='google' for update;
 if not found or c.lease_id is distinct from p_lease or c.lease_until<=clock_timestamp() then raise exception 'Google connection lease expired'; end if;
 if exists(select 1 from public.google_booking_reservations_v1 where connection_id=c.id and status in ('creating','rescheduling','canceling')) then
  raise exception 'Wait for pending booking changes before disconnecting'; end if;
 update public.google_booking_reservations_v1 set status='failed',updated_at=now() where connection_id=c.id and status='held';
 update public.scheduling_connections_v1 set status='disconnecting',updated_at=now() where id=c.id;
end $$;
revoke all on function public.begin_google_calendar_disconnect_v1(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_google_calendar_disconnect_v1(uuid,uuid,uuid) to service_role;

commit;
