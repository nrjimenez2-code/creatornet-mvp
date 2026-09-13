begin;
alter table public.google_booking_reservations_v1 add column recovery_code text
 check (recovery_code is null or recovery_code='google_booking_changed_externally');
create function public.clear_google_booking_recovery_v1() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status in ('creating','rescheduling','canceling') then new.recovery_code=null; end if;
 return new;
end $$;
create trigger clear_google_booking_recovery_v1 before update on public.google_booking_reservations_v1
 for each row execute function public.clear_google_booking_recovery_v1();
revoke all on function public.clear_google_booking_recovery_v1() from public,anon,authenticated;
create function public.recover_google_reschedule_v1(p_job uuid,p_worker uuid,p_event text,p_etag text,
 p_start timestamptz,p_end timestamptz,p_canceled boolean) returns uuid
language plpgsql security invoker set search_path='' as $$
declare j public.google_booking_jobs_v1; r public.google_booking_reservations_v1;
 a public.discover_booking_attribution_v1; owner_id uuid;
begin
 select * into j from public.google_booking_jobs_v1 where id=p_job and lease_id=p_worker and status='processing' for update;
 if not found or j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
 select * into r from public.google_booking_reservations_v1 where id=j.reservation_id for update;
 if not found or j.action<>'reschedule' or r.status<>'rescheduling' or r.revision<>j.revision
  or r.event_id is null or r.event_id is distinct from p_event then raise exception 'Booking operation changed'; end if;
 if p_canceled is null then raise exception 'Calendar status is required'; end if;
 if not p_canceled and (p_etag is null or length(p_etag)=0 or p_etag is not distinct from r.event_etag
  or p_start is null or p_end is null or p_end<=p_start) then raise exception 'Recovery requires a changed calendar event'; end if;
 if r.attribution_id is not null then
  select creator_id into owner_id from public.scheduling_connections_v1 where id=r.connection_id and provider='google';
  select * into a from public.discover_booking_attribution_v1 where id=r.attribution_id for update;
  if not found or owner_id is null or a.user_id is distinct from r.buyer_id or a.creator_id is distinct from owner_id
   or a.post_id is distinct from r.original_post_id or a.provider is distinct from 'google'
   or a.provider_booking_id is distinct from r.event_id then raise exception 'Google booking attribution mismatch'; end if;
 end if;
 update public.google_booking_reservations_v1 set status=case when p_canceled then 'canceled' else 'confirmed' end,
  starts_at=case when p_canceled then starts_at else p_start end,ends_at=case when p_canceled then ends_at else p_end end,
  event_etag=coalesce(p_etag,event_etag),desired_starts_at=null,desired_ends_at=null,
  recovery_code='google_booking_changed_externally',updated_at=clock_timestamp() where id=r.id;
 if r.attribution_id is not null and not public.confirm_discover_booking_v1(r.attribution_id,'google',r.event_id,clock_timestamp(),
  case when p_canceled then r.starts_at else p_start end,p_canceled) then raise exception 'Could not recover booking attribution'; end if;
 if j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
 update public.google_booking_jobs_v1 set status='failed',last_error_code='google_booking_changed_externally',lease_id=null,lease_until=null where id=j.id;
 return r.id;
end $$;
revoke all on function public.recover_google_reschedule_v1(uuid,uuid,text,text,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.recover_google_reschedule_v1(uuid,uuid,text,text,timestamptz,timestamptz,boolean) to service_role;
commit;
