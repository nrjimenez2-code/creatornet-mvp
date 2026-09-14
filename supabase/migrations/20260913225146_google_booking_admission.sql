begin;
create unique index google_booking_purchase_unique_v1 on public.google_booking_reservations_v1(purchase_id) where purchase_id is not null;
create function public.google_reserved_intervals_v1(p_connection uuid,p_start timestamptz,p_end timestamptz,p_exclude uuid default null)
returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('start',occupied.a,'end',occupied.b)),'[]'::jsonb)
 from public.google_booking_reservations_v1 r
 cross join lateral (values
  (r.starts_at-make_interval(mins=>r.buffer_before_minutes),r.ends_at+make_interval(mins=>r.buffer_after_minutes)),
  (r.desired_starts_at-make_interval(mins=>r.buffer_before_minutes),r.desired_ends_at+make_interval(mins=>r.buffer_after_minutes))
 ) occupied(a,b)
 where r.connection_id=p_connection and r.id is distinct from p_exclude and r.status not in ('canceled','failed')
  and (r.status<>'held' or r.hold_expires_at>now()) and occupied.a<p_end and occupied.b>p_start;
$$;
create function public.reserve_google_booking_checked_v1(p_id uuid,p_connection uuid,p_buyer uuid,p_post uuid,
 p_start timestamptz,p_end timestamptz,p_attribution uuid,p_purchase uuid,p_calendar text,p_policy jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare prior public.google_booking_reservations_v1;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_connection::text,904));
 if not exists(select 1 from public.google_booking_settings_v1 s join public.scheduling_connections_v1 c on c.id=s.connection_id
   where s.connection_id=p_connection and s.calendar_id=p_calendar and s.availability=p_policy and s.active and c.status='connected'
   and exists(select 1 from public.google_calendar_watches_v1 w where w.id::text=c.webhook_id and w.connection_id=c.id
    and w.calendar_id=s.calendar_id and w.status='active' and w.expires_at>clock_timestamp())) then
  raise exception 'Calendar settings changed; refresh available times'; end if;
 select * into prior from public.google_booking_reservations_v1 where id=p_id for update;
 if found and (prior.status='failed' or (prior.status='held' and prior.hold_expires_at<=now()))
   and not exists(select 1 from public.google_booking_jobs_v1 where reservation_id=prior.id) then
  if prior.buyer_id is distinct from p_buyer or prior.connection_id is distinct from p_connection
    or prior.original_post_id is distinct from p_post or prior.attribution_id is distinct from p_attribution or prior.purchase_id is distinct from p_purchase then
   raise exception 'Reservation request does not match the existing booking'; end if;
  delete from public.google_booking_reservations_v1 where id=prior.id;
 end if;
 return public.reserve_google_booking_v1(p_id,p_connection,p_buyer,p_post,p_start,p_end,p_attribution,p_purchase);
end $$;
revoke all on function public.google_reserved_intervals_v1(uuid,timestamptz,timestamptz,uuid),
 public.reserve_google_booking_checked_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.google_reserved_intervals_v1(uuid,timestamptz,timestamptz,uuid),
 public.reserve_google_booking_checked_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid,text,jsonb) to service_role;
commit;
