begin;
-- One attributed intent belongs to one durable reservation across its full lifecycle.
create unique index google_booking_attribution_unique_v1 on public.google_booking_reservations_v1(attribution_id) where attribution_id is not null;
create function public.validate_google_booking_attribution_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
declare a public.discover_booking_attribution_v1; owner_id uuid;
begin
  if new.attribution_id is null then return new; end if;
  select creator_id into owner_id from public.scheduling_connections_v1 where id=new.connection_id and provider='google';
  select * into a from public.discover_booking_attribution_v1 where id=new.attribution_id;
  if not found or owner_id is null or a.user_id is distinct from new.buyer_id
    or a.creator_id is distinct from owner_id or a.post_id is distinct from new.original_post_id
    or (a.provider is not null and a.provider<>'google')
    or (a.provider_booking_id is not null and a.provider_booking_id is distinct from new.event_id) then
    raise exception 'Google booking attribution mismatch';
  end if;
  return new;
end $$;
revoke all on function public.validate_google_booking_attribution_v1() from public,anon,authenticated;
grant execute on function public.validate_google_booking_attribution_v1() to service_role;
create trigger google_booking_attribution_guard_v1 before insert or update of attribution_id,buyer_id,connection_id,original_post_id
on public.google_booking_reservations_v1 for each row execute function public.validate_google_booking_attribution_v1();

create or replace function public.confirm_discover_booking_v1(p_attribution uuid,p_provider text,p_booking text,
 p_event_at timestamptz,p_scheduled_at timestamptz,p_canceled boolean)
returns boolean language plpgsql set search_path='' as $$
 declare a public.discover_booking_attribution_v1; p public.posts; ledger_id uuid; cohort text; offer text;
begin
 select * into a from public.discover_booking_attribution_v1 where id=p_attribution for update;
 if not found or p_provider not in ('calendly','calcom','google') or p_event_at is null then return false; end if;
 if a.provider_event_at is not null and p_event_at<a.provider_event_at then return false; end if;
 if p_canceled and a.provider_booking_id is not null and a.provider_booking_id<>p_booking then return false; end if;
 if not p_canceled and p_scheduled_at is null then return false; end if;
 select * into p from public.posts where id=a.post_id;
 if not found then
  select categories,topics into p.interests,p.topics from public.discover_events_v1
   where post_id=a.post_id and creator_id=a.creator_id and kind='booking_setup_complete'
   order by occurred_at desc limit 1;
 end if;
 select audience into cohort from public.discover_events_v1 where actor='user:'||a.user_id::text and post_id=a.post_id
  and kind='exposure' order by occurred_at desc limit 1;
 select type into offer from public.products where id=p.product_id or product_id=p.product_id order by (id=p.product_id) desc limit 1;
 update public.discover_booking_attribution_v1 set provider=p_provider,provider_booking_id=p_booking,
  provider_event_at=p_event_at,scheduled_at=coalesce(p_scheduled_at,scheduled_at),
  verified_at=case when p_canceled then verified_at else coalesce(verified_at,now()) end,
  canceled_at=case when p_canceled then p_event_at else null end where id=a.id;
 if p_canceled then
  update public.discover_events_v1 set valid=false where kind='booking_scheduled' and entity_key=a.id::text;
 else
  insert into public.discover_events_v1(actor,user_id,post_id,creator_id,kind,entity_key,categories,topics,offer_type,audience)
  values('user:'||a.user_id::text,a.user_id,a.post_id,a.creator_id,'booking_scheduled',a.id::text,
   public.canonical_interests_v1(p.interests),coalesce(p.topics,'{}'),coalesce(offer,'free_call'),coalesce(cohort,'general'))
  on conflict(kind,entity_key) do update set valid=true;
 end if;
 if p_canceled then
  insert into public.discover_events_v1(actor,user_id,post_id,creator_id,kind,entity_key,categories,topics,offer_type,audience)
  values('user:'||a.user_id::text,a.user_id,a.post_id,a.creator_id,'booking_canceled',p_provider||':'||p_booking,
   public.canonical_interests_v1(p.interests),coalesce(p.topics,'{}'),coalesce(offer,'free_call'),coalesce(cohort,'general')) on conflict do nothing;
 end if;
 -- Delayed provider notifications can repair an already captured sale's origin.
 for ledger_id in select l.id from public.payment_fee_ledger l
  left join public.purchases pu on pu.id=l.purchase_id
  left join public.booking_payments bp on bp.id=l.booking_payment_id
  left join public.bookings bk on bk.id=bp.booking_id
  where coalesce(pu.buyer_user_id,pu.buyer_id,bk.buyer_id)=a.user_id and l.creator_id=a.creator_id
  and l.created_at between a.created_at and a.created_at+interval '90 days'
 loop perform public.reconcile_discover_sale_v1(ledger_id);end loop;
 return true;
end $$;
revoke all on function public.confirm_discover_booking_v1(uuid,text,text,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.confirm_discover_booking_v1(uuid,text,text,timestamptz,timestamptz,boolean) to service_role;

create or replace function public.complete_google_booking_job_v1(
  p_job uuid, p_worker uuid, p_event_id text, p_event_etag text,
  p_start timestamptz default null, p_end timestamptz default null
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare job public.google_booking_jobs_v1; reservation public.google_booking_reservations_v1;
  attribution public.discover_booking_attribution_v1; owner_id uuid;
begin
  select * into job from public.google_booking_jobs_v1 where id=p_job and lease_id=p_worker and status='processing' and lease_until>clock_timestamp() for update;
  if not found or job.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
  select * into reservation from public.google_booking_reservations_v1 where id=job.reservation_id for update;
  if reservation.revision<>job.revision then raise exception 'Booking revision changed'; end if;
  if reservation.status is distinct from (case job.action when 'create' then 'creating' when 'reschedule' then 'rescheduling' else 'canceling' end) then
    raise exception 'Booking operation no longer matches its reservation';
  end if;
  if job.action='cancel' and reservation.event_id is null then raise exception 'Cancellation has no confirmed event'; end if;
  if reservation.attribution_id is not null then
    select creator_id into owner_id from public.scheduling_connections_v1 where id=reservation.connection_id and provider='google';
    select * into attribution from public.discover_booking_attribution_v1 where id=reservation.attribution_id for update;
    if not found or owner_id is null or attribution.user_id is distinct from reservation.buyer_id
      or attribution.creator_id is distinct from owner_id or attribution.post_id is distinct from reservation.original_post_id
      or (attribution.provider is not null and attribution.provider<>'google')
      or (attribution.provider_booking_id is not null and attribution.provider_booking_id is distinct from coalesce(reservation.event_id,p_event_id)) then
      raise exception 'Google booking attribution mismatch';
    end if;
  end if;
  if job.action<>'cancel' then
    if p_event_id is null or length(p_event_id)=0 or p_event_etag is null or length(p_event_etag)=0
      or p_start is distinct from coalesce(reservation.desired_starts_at,reservation.starts_at)
      or p_end is distinct from coalesce(reservation.desired_ends_at,reservation.ends_at) then raise exception 'Calendar event does not match the reserved time'; end if;
    if reservation.event_id is not null and reservation.event_id<>p_event_id then raise exception 'Calendar event identity changed'; end if;
    update public.google_booking_reservations_v1 set status='confirmed',event_id=p_event_id,event_etag=p_event_etag,
      starts_at=p_start,ends_at=p_end,desired_starts_at=null,desired_ends_at=null,updated_at=now() where id=reservation.id;
  else
    update public.google_booking_reservations_v1 set status='canceled',desired_starts_at=null,desired_ends_at=null,updated_at=now() where id=reservation.id;
  end if;
  if reservation.attribution_id is not null then
    if not public.confirm_discover_booking_v1(reservation.attribution_id,'google',coalesce(reservation.event_id,p_event_id),
      clock_timestamp(),case when job.action='cancel' then reservation.starts_at else p_start end,job.action='cancel') then
      raise exception 'Could not commit Google booking attribution';
    end if;
  end if;
  if job.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired'; end if;
  update public.google_booking_jobs_v1 set status='complete',lease_id=null,lease_until=null,last_error_code=null where id=p_job;
  return reservation.id;
end $$;


commit;
