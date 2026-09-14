begin;
alter table public.google_calendar_watches_v1 add column renewal_attempted_at timestamptz;
create index google_calendar_watches_renewal_fairness_v1
 on public.google_calendar_watches_v1(renewal_attempted_at nulls first,expires_at,id) where status='active';

create function public.claim_google_calendar_renewal_v1()
returns table(creator_id uuid) language plpgsql security invoker set search_path='' as $$
declare selected uuid; owner_id uuid;
begin
 select w.id,c.creator_id into selected,owner_id
 from public.google_calendar_watches_v1 w join public.scheduling_connections_v1 c on c.id=w.connection_id
 where w.status='active' and c.status='connected'
 and w.expires_at<clock_timestamp()+interval '1 day'
 and (c.lease_until is null or c.lease_until<clock_timestamp())
 and (w.renewal_attempted_at is null or w.renewal_attempted_at<clock_timestamp()-interval '2 minutes')
 order by w.renewal_attempted_at nulls first,w.expires_at,w.id
 for update of w skip locked limit 1;
 if not found then return; end if;
 -- Persist before external I/O: a timeout or process exit must still yield to other calendars.
 update public.google_calendar_watches_v1 set renewal_attempted_at=clock_timestamp() where id=selected;
 return query select owner_id;
end $$;
revoke all on function public.claim_google_calendar_renewal_v1() from public,anon,authenticated;
grant execute on function public.claim_google_calendar_renewal_v1() to service_role;
commit;
