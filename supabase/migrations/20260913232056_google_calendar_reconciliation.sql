begin;
alter table public.google_calendar_watches_v1 add column sweep_cursor uuid, add column sweep_started_at timestamptz,
 add column sweep_polled_at timestamptz, add column sync_generation bigint not null default 0,
 add column swept_generation bigint not null default -1, add column sweep_generation bigint;
create function public.request_google_calendar_sync_v1(p_watch uuid) returns void language sql security invoker set search_path='' as $$
 update public.google_calendar_watches_v1 set sync_generation=sync_generation+1,sync_requested_at=clock_timestamp()
 where id=p_watch and status in ('active','retiring');
$$;
create function public.claim_google_calendar_sweep_v1(p_worker uuid) returns setof public.google_calendar_watches_v1
language plpgsql security invoker set search_path='' as $$
declare selected uuid;
begin
 select w.id into selected from public.google_calendar_watches_v1 w join public.scheduling_connections_v1 c on c.id=w.connection_id
 where w.status='active' and c.status='connected' and (w.lease_until is null or w.lease_until<clock_timestamp())
 and (w.sweep_started_at is not null or w.sync_generation>w.swept_generation or w.last_synced_at is null or w.last_synced_at<clock_timestamp()-interval '1 hour')
 order by w.sweep_polled_at nulls first,w.id for update of w skip locked limit 1;
 if not found then return; end if;
 return query update public.google_calendar_watches_v1 set lease_id=p_worker,lease_until=clock_timestamp()+interval '5 minutes',
  sweep_polled_at=clock_timestamp(),sweep_started_at=coalesce(sweep_started_at,clock_timestamp()),
  sweep_generation=coalesce(sweep_generation,sync_generation) where id=selected returning *;
end $$;
create function public.finish_google_calendar_sweep_v1(p_watch uuid,p_worker uuid,p_cursor uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 update public.google_calendar_watches_v1 set sweep_cursor=p_cursor,
  last_synced_at=case when p_cursor is null then sweep_started_at else last_synced_at end,
  swept_generation=case when p_cursor is null then sweep_generation else swept_generation end,
  sweep_started_at=case when p_cursor is null then null else sweep_started_at end,
  sweep_generation=case when p_cursor is null then null else sweep_generation end,lease_id=null,lease_until=null
 where id=p_watch and lease_id=p_worker and lease_until>clock_timestamp() and status='active';
 if not found then raise exception 'Calendar sweep lease expired'; end if;
end $$;
create function public.reconcile_google_calendar_booking_v1(p_watch uuid,p_worker uuid,p_id uuid,p_revision bigint,p_event text,p_etag text,p_start timestamptz,p_end timestamptz,p_canceled boolean)
returns boolean language plpgsql security invoker set search_path='' as $$
declare r public.google_booking_reservations_v1; w public.google_calendar_watches_v1;
begin
 select * into w from public.google_calendar_watches_v1 where id=p_watch for update;
 if not found or w.lease_id is distinct from p_worker or w.lease_until is null or w.lease_until<=clock_timestamp() or w.status<>'active' then return false; end if;
 select * into r from public.google_booking_reservations_v1 where id=p_id for update;
 if not found or w.connection_id is distinct from r.connection_id or w.calendar_id is distinct from r.calendar_id or w.lease_until<=clock_timestamp() or p_revision is null or r.revision<>p_revision or r.status not in ('confirmed','canceled') or r.event_id is distinct from p_event then return false; end if;
 if p_canceled is null then raise exception 'Calendar status is required'; end if;
 if not p_canceled and (p_start is null or p_end is null or p_end<=p_start or p_etag is null or length(p_etag)=0) then raise exception 'Invalid calendar booking'; end if;
 if (p_canceled and r.status='canceled') or (not p_canceled and r.status='confirmed' and r.event_etag is not distinct from p_etag
   and r.starts_at is not distinct from p_start and r.ends_at is not distinct from p_end) then return true; end if;
 update public.google_booking_reservations_v1 set status=case when p_canceled then 'canceled' else 'confirmed' end,
  starts_at=case when p_canceled then starts_at else p_start end,ends_at=case when p_canceled then ends_at else p_end end,
  event_etag=coalesce(p_etag,event_etag),revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 if r.attribution_id is not null and not public.confirm_discover_booking_v1(r.attribution_id,'google',r.event_id,clock_timestamp(),
  case when p_canceled then r.starts_at else p_start end,p_canceled) then raise exception 'Could not reconcile booking attribution'; end if;
 if not exists(select 1 from public.google_calendar_watches_v1 where id=p_watch and lease_id=p_worker and lease_until>clock_timestamp() and status='active') then raise exception 'Calendar sweep lease expired'; end if;
 return true;
end $$;
revoke all on function public.request_google_calendar_sync_v1(uuid),public.claim_google_calendar_sweep_v1(uuid),
 public.finish_google_calendar_sweep_v1(uuid,uuid,uuid),public.reconcile_google_calendar_booking_v1(uuid,uuid,uuid,bigint,text,text,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.request_google_calendar_sync_v1(uuid),public.claim_google_calendar_sweep_v1(uuid),
 public.finish_google_calendar_sweep_v1(uuid,uuid,uuid),public.reconcile_google_calendar_booking_v1(uuid,uuid,uuid,bigint,text,text,timestamptz,timestamptz,boolean) to service_role;
commit;
