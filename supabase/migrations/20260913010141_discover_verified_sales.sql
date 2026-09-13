-- Captured ledger receipts are authoritative across one-time, installment and membership flows.
begin;
alter table public.discover_events_v1 add column if not exists valid boolean not null default true;
create unique index if not exists discover_sale_entity_v1 on public.discover_events_v1(entity_key) where kind in ('purchase','mentorship_purchase');
create or replace function public.reconcile_discover_sale_v1(p_ledger uuid)
returns void language plpgsql set search_path='' as $$
declare l public.payment_fee_ledger; p public.purchases; b public.bookings;
 buyer uuid; source_post uuid; product uuid; sale_kind text; sale_key text; net bigint; first_paid timestamptz;
 cat text[]; topic text[]; sale_offer text; source_offer text; source public.discover_booking_attribution_v1; audience_key text; previous public.discover_events_v1;
begin
 select * into l from public.payment_fee_ledger where id=p_ledger;
 if not found then return; end if;
 if l.purchase_id is not null then select * into p from public.purchases where id=l.purchase_id; end if;
 buyer:=coalesce(p.buyer_user_id,p.buyer_id); source_post:=p.post_id; product:=p.product_id;
 if l.booking_payment_id is not null then
   select bk.* into b from public.booking_payments bp join public.bookings bk on bk.id=bp.booking_id
   where bp.id=l.booking_payment_id and bk.creator_id=l.creator_id;
   buyer:=coalesce(buyer,b.buyer_id); source_post:=coalesce(b.post_id,source_post);
   if product is null then select product_id into product from public.booking_payments where id=l.booking_payment_id; end if;
 elsif p.booking_id is not null then
   select * into b from public.bookings where id=p.booking_id and buyer_id=buyer and creator_id=l.creator_id;
   source_post:=coalesce(b.post_id,source_post);
 end if;
 if buyer is null or buyer=l.creator_id then return; end if;
 sale_key:=case when l.purchase_id is not null then 'purchase:'||l.purchase_id::text
  when l.booking_payment_id is not null then 'booking-payment:'||l.booking_payment_id::text
  else 'ledger:'||l.id::text end;
 select coalesce(sum(greatest(0,gross_amount_cents-refunded_amount_cents)) filter(
    where status='paid' and disputed_amount_cents=0),0),min(created_at)
 into net,first_paid from public.payment_fee_ledger
 where (l.purchase_id is not null and purchase_id=l.purchase_id)
 or (l.purchase_id is null and l.booking_payment_id is not null and booking_payment_id=l.booking_payment_id)
 or (l.purchase_id is null and l.booking_payment_id is null and id=l.id);
 -- Explicit booking linkage wins. Otherwise use the newest verified scheduled call
 -- for this buyer/creator within the conversion window, before the first capture.
 select * into source from public.discover_booking_attribution_v1 a
 where a.user_id=buyer and a.creator_id=l.creator_id and a.verified_at is not null
  and a.canceled_at is null and a.created_at<=first_paid and a.created_at>=first_paid-interval '90 days'
  and (b.id is null or a.post_id=b.post_id)
 order by a.created_at desc,a.id desc limit 1;
 select * into previous from public.discover_events_v1
 where (entity_key=sale_key or (l.booking_payment_id is not null and entity_key='booking-payment:'||l.booking_payment_id::text))
 and kind in ('purchase','mentorship_purchase') order by (entity_key=sale_key) desc limit 1;
 source_post:=coalesce(source.post_id,previous.post_id,source_post);
 if source_post is null then return; end if;
 select public.canonical_interests_v1(interests),coalesce(topics,'{}') into cat,topic
 from public.posts where id=source_post and creator_id=l.creator_id;
 if not found then
  select categories,topics into cat,topic from public.discover_events_v1
   where post_id=source_post and creator_id=l.creator_id order by occurred_at desc limit 1;
  if not found then return;end if;
 end if;
 select case when type='mentorship' and (source.id is not null or previous.kind='mentorship_purchase') then 'mentorship_purchase' else 'purchase' end
 into sale_kind from public.products where id=product or product_id=product order by (id=product) desc limit 1;
 sale_kind:=coalesce(sale_kind,'purchase');
 select type into sale_offer from public.products where id=product or product_id=product order by (id=product) desc limit 1;
 select audience,offer_type into audience_key,source_offer from public.discover_events_v1 where actor='user:'||buyer::text
 and post_id=source_post and kind='exposure' and occurred_at<=first_paid order by occurred_at desc limit 1;
 -- One commercial milestone per purchase, including renewals; revenue uses all net receipts.
 insert into public.discover_events_v1(actor,user_id,post_id,creator_id,kind,entity_key,categories,topics,
  audience,offer_type,amount_cents,currency,occurred_at,valid)
 values('user:'||buyer::text,buyer,source_post,l.creator_id,sale_kind,sale_key,cat,topic,
  coalesce(audience_key,previous.audience,'general'),coalesce(source_offer,previous.offer_type,sale_offer,'none'),net,l.currency,first_paid,net>0)
 on conflict(entity_key) where kind in ('purchase','mentorship_purchase') do update set
  amount_cents=excluded.amount_cents,valid=excluded.valid,post_id=excluded.post_id,kind=excluded.kind,
  audience=excluded.audience,offer_type=excluded.offer_type,
  categories=case when discover_events_v1.post_id<>excluded.post_id then excluded.categories else discover_events_v1.categories end,
  topics=case when discover_events_v1.post_id<>excluded.post_id then excluded.topics else discover_events_v1.topics end;
 -- A later purchase binding replaces the earlier booking-payment projection.
 if l.purchase_id is not null and l.booking_payment_id is not null then
  delete from public.discover_events_v1 where entity_key='booking-payment:'||l.booking_payment_id::text
   and kind in ('purchase','mentorship_purchase');
 end if;
end $$;
revoke all on function public.reconcile_discover_sale_v1(uuid) from public,anon,authenticated;
grant execute on function public.reconcile_discover_sale_v1(uuid) to service_role;
create or replace function public.discover_ledger_changed_v1()
returns trigger language plpgsql set search_path='' as $$
begin perform public.reconcile_discover_sale_v1(new.id);return new;end $$;
revoke all on function public.discover_ledger_changed_v1() from public,anon,authenticated;
drop trigger if exists discover_ledger_changed_v1 on public.payment_fee_ledger;
create trigger discover_ledger_changed_v1 after insert or update on public.payment_fee_ledger
 for each row execute function public.discover_ledger_changed_v1();
alter table public.discover_booking_attribution_v1 add column if not exists provider_event_at timestamptz;
create or replace function public.confirm_discover_booking_v1(p_attribution uuid,p_provider text,p_booking text,
 p_event_at timestamptz,p_scheduled_at timestamptz,p_canceled boolean)
returns boolean language plpgsql set search_path='' as $$
 declare a public.discover_booking_attribution_v1; p public.posts; ledger_id uuid; cohort text; offer text;
begin
 select * into a from public.discover_booking_attribution_v1 where id=p_attribution for update;
 if not found or p_provider not in ('calendly','calcom') or p_event_at is null then return false; end if;
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
-- The backend verifies both the signed anonymous token and authenticated user.
-- A browser identity may be claimed once; later accounts cannot take its history.
create or replace function public.link_discover_identity_v1(p_anonymous uuid,p_user uuid)
returns boolean language plpgsql set search_path='' as $$
declare owner_id uuid; receipt uuid;
begin
 if p_anonymous is null or p_user is null then return false;end if;
 insert into public.discover_identity_links_v1(anonymous_id,user_id) values(p_anonymous,p_user)
 on conflict do nothing returning user_id into owner_id;
 if owner_id is null then
  select user_id into owner_id from public.discover_identity_links_v1 where anonymous_id=p_anonymous;
  return owner_id=p_user;
 end if;
 update public.discover_events_v1 set actor='user:'||p_user::text,user_id=p_user
  where actor='anon:'||p_anonymous::text and user_id is null;
 update public.discover_sessions_v1 set actor='user:'||p_user::text,user_id=p_user
  where actor='anon:'||p_anonymous::text and user_id is null;
 for receipt in select l.id from public.payment_fee_ledger l
  left join public.purchases pu on pu.id=l.purchase_id
  left join public.booking_payments bp on bp.id=l.booking_payment_id
  left join public.bookings bk on bk.id=bp.booking_id
  where coalesce(pu.buyer_user_id,pu.buyer_id,bk.buyer_id)=p_user and l.created_at>=now()-interval '90 days'
 loop perform public.reconcile_discover_sale_v1(receipt);end loop;
 return true;
end $$;
revoke all on function public.link_discover_identity_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.link_discover_identity_v1(uuid,uuid) to service_role;
commit;
