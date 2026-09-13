create function public.list_google_bookings_v1(p_actor uuid,p_role text,p_before timestamptz default null,p_before_id uuid default null)
returns table(id uuid,connection_id uuid,status text,starts_at timestamptz,ends_at timestamptz,
 desired_starts_at timestamptz,desired_ends_at timestamptz,revision bigint,created_at timestamptz,title text,counterparty_name text)
language sql security invoker set search_path='' as $$
 select r.id,r.connection_id,r.status,r.starts_at,r.ends_at,r.desired_starts_at,r.desired_ends_at,r.revision,r.created_at,
  coalesce(s.title,'Google Calendar call'),coalesce(nullif(p.full_name,''),nullif(p.username,''),'CreatorNet member')
 from public.google_booking_reservations_v1 r
 join public.scheduling_connections_v1 c on c.id=r.connection_id and c.provider='google'
 left join public.google_booking_settings_v1 s on s.connection_id=c.id
 left join public.profiles p on p.id=case when p_role='buyer' then c.creator_id else r.buyer_id end
 where ((p_role='buyer' and r.buyer_id=p_actor) or (p_role='creator' and c.creator_id=p_actor))
 and r.status not in ('held','failed')
 and ((p_before is null and p_before_id is null) or (p_before is not null and p_before_id is not null and (r.created_at,r.id)<(p_before,p_before_id)))
 order by r.created_at desc,r.id desc limit 21;
$$;
revoke all on function public.list_google_bookings_v1(uuid,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.list_google_bookings_v1(uuid,text,timestamptz,uuid) to service_role;
