begin;
create function public.reschedule_google_booking_checked_v1(p_id uuid,p_buyer uuid,p_revision bigint,p_start timestamptz,p_end timestamptz,p_policy jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.google_booking_reservations_v1;
begin
 select * into r from public.google_booking_reservations_v1 where id=p_id and buyer_id=p_buyer;
 if not found then raise exception 'Booking not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended(r.connection_id::text,904));
 if not exists(select 1 from public.google_booking_settings_v1 s join public.scheduling_connections_v1 c on c.id=s.connection_id
  where s.connection_id=r.connection_id and s.calendar_id=r.calendar_id and s.availability=p_policy and s.active and c.status='connected'
  and exists(select 1 from public.google_calendar_watches_v1 w where w.id::text=c.webhook_id and w.connection_id=c.id
   and w.calendar_id=s.calendar_id and w.status='active' and w.expires_at>clock_timestamp())) then raise exception 'Calendar settings changed; refresh available times'; end if;
 if r.starts_at<=clock_timestamp() then raise exception 'This booking has already started'; end if;
 return public.request_google_booking_change_v1(p_id,p_buyer,p_revision,'reschedule',p_start,p_end);
end $$;
revoke all on function public.reschedule_google_booking_checked_v1(uuid,uuid,bigint,timestamptz,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.reschedule_google_booking_checked_v1(uuid,uuid,bigint,timestamptz,timestamptz,jsonb) to service_role;
commit;
