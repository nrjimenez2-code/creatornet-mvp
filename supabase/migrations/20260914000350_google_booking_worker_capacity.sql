begin;
create or replace function public.claim_google_booking_job_v1(p_worker uuid)
returns setof public.google_booking_jobs_v1 language plpgsql security invoker set search_path='' as $$
declare chosen_connection uuid; job_id uuid;
begin
 if p_worker is null then raise exception 'Missing worker lease'; end if;
 select c.id into chosen_connection from public.scheduling_connections_v1 c
 join public.google_booking_reservations_v1 r on r.connection_id=c.id
 join public.google_booking_jobs_v1 j on j.reservation_id=r.id
 where c.provider='google' and c.status in ('connected','disconnecting')
 and (c.lease_until is null or c.lease_until<clock_timestamp()) and (c.status='connected' or j.action='cancel')
 and ((j.status in ('pending','retry') and j.next_attempt_at<=clock_timestamp()) or (j.status='processing' and j.lease_until<clock_timestamp()))
 and not exists(select 1 from public.google_booking_jobs_v1 active_job join public.google_booking_reservations_v1 active_res on active_res.id=active_job.reservation_id
  where active_res.connection_id=c.id and active_job.status='processing' and active_job.lease_until>clock_timestamp())
 order by j.next_attempt_at,j.id for update of c skip locked limit 1;
 if not found then return; end if;
 -- Recheck with a fresh statement snapshot after taking the connection lock.
 if exists(select 1 from public.google_booking_jobs_v1 j join public.google_booking_reservations_v1 r on r.id=j.reservation_id
  where r.connection_id=chosen_connection and j.status='processing' and j.lease_until>clock_timestamp()) then return; end if;
 select j.id into job_id from public.google_booking_jobs_v1 j join public.google_booking_reservations_v1 r on r.id=j.reservation_id
 join public.scheduling_connections_v1 c on c.id=r.connection_id
 where r.connection_id=chosen_connection and (c.status='connected' or j.action='cancel')
 and ((j.status in ('pending','retry') and j.next_attempt_at<=clock_timestamp()) or (j.status='processing' and j.lease_until<clock_timestamp()))
 order by j.next_attempt_at,j.id for update of j skip locked limit 1;
 if not found then return; end if;
 return query update public.google_booking_jobs_v1 set status='processing',attempts=attempts+1,lease_id=p_worker,
  lease_until=clock_timestamp()+interval '5 minutes' where id=job_id returning *;
end $$;
commit;
