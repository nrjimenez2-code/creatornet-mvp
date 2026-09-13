begin;
create or replace function public.fail_unattempted_google_booking_v1(p_job uuid,p_worker uuid,p_reason text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare j public.google_booking_jobs_v1; r public.google_booking_reservations_v1;
begin
 if p_reason is null or p_reason not in ('google_booking_time_passed','google_booking_time_unavailable') then raise exception 'Invalid recovery reason'; end if;
 select * into j from public.google_booking_jobs_v1 where id=p_job and lease_id=p_worker and status='processing' for update;
 if not found or j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
 if j.action not in ('create','reschedule') or j.mutation_started_at is not null then return false; end if;
 select * into r from public.google_booking_reservations_v1 where id=j.reservation_id for update;
 if not found or r.revision<>j.revision or r.status is distinct from (case j.action when 'create' then 'creating' else 'rescheduling' end)
  or (j.action='create' and r.event_id is not null) or (j.action='reschedule' and r.event_id is null) then return false; end if;
 if j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
 update public.google_booking_reservations_v1 set status=case j.action when 'create' then 'failed' else 'confirmed' end,
  desired_starts_at=null,desired_ends_at=null,recovery_code=p_reason,updated_at=clock_timestamp() where id=r.id;
 update public.google_booking_jobs_v1 set status='failed',last_error_code=p_reason,lease_id=null,lease_until=null where id=j.id;
 return true;
end $$;

commit;
