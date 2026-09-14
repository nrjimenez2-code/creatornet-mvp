-- Reconnection removes the auth blocker; do not leave retained work on its old
-- exponential backoff. Preserve active leases, attempts and mutation evidence.
create function public.wake_google_booking_retries_v1() returns trigger
language plpgsql security invoker set search_path='' as $function$
begin
 update public.google_booking_jobs_v1 j
 set next_attempt_at=least(j.next_attempt_at,clock_timestamp())
 from public.google_booking_reservations_v1 r
 where r.id=j.reservation_id and r.connection_id=new.id and j.status='retry'
  and j.revision=r.revision and r.status in ('creating','rescheduling','canceling');
 return new;
end $function$;
revoke all on function public.wake_google_booking_retries_v1() from public,anon,authenticated;
grant execute on function public.wake_google_booking_retries_v1() to service_role;
create trigger google_reconnect_retry_wakeup_v1 after update of status
on public.scheduling_connections_v1 for each row
when (new.provider='google' and new.status='connected' and old.status is distinct from new.status)
execute function public.wake_google_booking_retries_v1();
