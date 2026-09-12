begin;

-- Prospective staging candidate only. No existing links/agreements are adopted,
-- no backfill, Stripe request, fee collection, entitlement or flag change.
alter table public.booking_payments add column installment_collection_version text
  check (installment_collection_version is null or installment_collection_version='exact-cents-held-v1');
create unique index exact_installment_one_booking on public.exact_installment_agreements ((terms->>'bookingId'));

-- Preserve the prospective marker and the first-payment estimate. Receipt
-- accounting lives in the existing ledger/purchase rows, not these estimates.
create function public.guard_exact_installment_checkout_estimate()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old.installment_collection_version='exact-cents-held-v1' and (
    new.installment_collection_version is distinct from old.installment_collection_version or
    new.installment_amount_cents is distinct from old.installment_amount_cents or
    new.platform_fee_cents is distinct from old.platform_fee_cents or new.processing_fee_cents is distinct from old.processing_fee_cents or
    new.total_creator_deduction_cents is distinct from old.total_creator_deduction_cents or
    new.creator_net_cents is distinct from old.creator_net_cents or new.fee_schedule_version is distinct from old.fee_schedule_version) then
    raise exception 'exact checkout estimate is immutable'; end if;
  if old.installment_collection_version is null and new.installment_collection_version is not null then
    raise exception 'existing payment cannot be converted to exact checkout'; end if;
  return new;
end;
$$;
create trigger exact_installment_checkout_estimate before update on public.booking_payments
  for each row execute function public.guard_exact_installment_checkout_estimate();
revoke all on function public.guard_exact_installment_checkout_estimate() from public,anon,authenticated,service_role;

-- All identity, product and price fields are read from the owned booking. The
-- server supplies its configured fee schedules, never browser money values.
-- Payment reservation and agreement creation commit together or neither does.
create function public.reserve_exact_installment_checkout(p_booking_id uuid,p_actor_id uuid,p_count integer,
  p_origin text,p_first_fee jsonb,p_renewal_fee jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  b public.bookings%rowtype;
  product public.products%rowtype;
  profile public.profiles%rowtype;
  payment_id uuid;
  terms jsonb;
  gross bigint;
  platform bigint;
  processing bigint;
begin
  if p_actor_id is null or p_booking_id is null or p_count is null or p_count not between 2 and 24 then
    raise exception 'invalid checkout reservation'; end if;
  -- Existing work uses agreement -> payment -> booking lock order. A concurrent
  -- first reservation is rechecked after the booking lock and asks for retry;
  -- it must not acquire the opposite lock order or overwrite another request.
  select ag.* into a from public.exact_installment_agreements ag where ag.terms->>'bookingId'=p_booking_id::text for update;
  if found then
    if a.terms->>'creatorId' is distinct from p_actor_id::text or a.status not in ('preparing','awaiting_first') then
      raise exception 'existing exact checkout requires review'; end if;
    perform 1 from public.booking_payments where id=a.booking_payment_id for update;
    if not found then raise exception 'reservation payment missing'; end if;
  end if;
  select * into b from public.bookings where id=p_booking_id for update;
  if not found or b.creator_id is distinct from p_actor_id or b.status is distinct from 'booked' then
    raise exception 'owned unpaid booking required'; end if;
  if a.id is null and exists(select 1 from public.exact_installment_agreements ag where ag.terms->>'bookingId'=b.id::text) then
    raise exception 'reservation changed; retry existing agreement'; end if;
  select p.* into product from public.products p join public.posts post on post.id=b.post_id
    and post.product_id=p.id and post.creator_id=b.creator_id where p.creator_id=b.creator_id for share of p,post;
  if not found or product.type not in ('video','course','mentorship') or product.is_active is distinct from true or
    product.amount_cents is null or product.amount_cents<50 or lower(trim(product.currency)) is distinct from 'usd' then
    raise exception 'active owned USD product required'; end if;
  select * into profile from public.profiles where id=b.creator_id for share;
  if not found or profile.stripe_onboarding_complete is distinct from true or profile.stripe_account_id is null or
    profile.stripe_account_id !~ '^acct_[A-Za-z0-9]+$' then raise exception 'creator destination not ready'; end if;
  if a.id is null then
    if exists(select 1 from public.booking_payments where booking_id=b.id) or
      exists(select 1 from public.purchases where buyer_id=b.buyer_id and (post_id=b.post_id or product_id=product.id)) then
      raise exception 'existing payment or purchase cannot be converted'; end if;
    payment_id:=gen_random_uuid();
  else
    payment_id:=a.booking_payment_id;
    if exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id) then
      raise exception 'checkout held for review'; end if;
  end if;
  terms:=jsonb_build_object('version','exact-cents-held-v1','currency','usd','bookingPaymentId',payment_id,
    'bookingId',b.id,'productId',product.id,'postId',b.post_id,'buyerId',b.buyer_id,'creatorId',b.creator_id,
    'destinationId',profile.stripe_account_id,'title',left(trim(product.title),200),'previewOrigin',p_origin,
    'totalCents',product.amount_cents,'paymentCount',p_count,'firstPaymentFeeSchedule',p_first_fee,'renewalFeeSchedule',p_renewal_fee);
  if a.id is not null then
    if a.terms is distinct from terms then raise exception 'existing checkout terms changed'; end if;
    return a.id;
  end if;
  gross:=product.amount_cents/p_count;
  platform:=round(gross::numeric*1200/10000)::bigint;
  processing:=case when (p_first_fee->>'enabled')::boolean then
    round(gross::numeric*(p_first_fee->>'basisPoints')::integer/10000)::bigint+(p_first_fee->>'fixedCents')::bigint else 0 end;
  insert into public.booking_payments(id,booking_id,product_id,buyer_id,closer_user_id,plan_type,status,currency,
    installment_months,amount_total_cents,installment_amount_cents,platform_fee_cents,processing_fee_cents,
    total_creator_deduction_cents,creator_net_cents,fee_schedule_version,installment_collection_version,created_at,updated_at)
  values(payment_id,b.id,product.id,b.buyer_id,p_actor_id,'installment','pending','usd',p_count,product.amount_cents,gross,
    platform,processing,platform+processing,gross-platform-processing,p_first_fee->>'version','exact-cents-held-v1',now(),now());
  -- Reuse all existing schedule/destination/amount validators. An exception
  -- rolls the new payment row back; there is no legacy-only orphan to adopt.
  select * into a from public.create_exact_installment_agreement(gen_random_uuid(),payment_id,p_actor_id,terms);
  return a.id;
end;
$$;

-- Only after current Stripe objects and the immutable Checkout request hash
-- have been verified by the service. Recheck local holds/identities under the
-- same agreement lock immediately before returning any payable URL.
create function public.publish_exact_installment_checkout(p_agreement_id uuid,p_actor_id uuid,p_session_id text,
  p_subscription_id text,p_purchase_id uuid,p_url text,p_expires_at bigint,p_request_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  bp public.booking_payments%rowtype;
  b public.bookings%rowtype;
  p public.purchases%rowtype;
  reused boolean;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.terms->>'creatorId' is distinct from p_actor_id::text or a.status<>'awaiting_first' or
    a.purchase_seeded_at is null or a.first_fulfilled_at is not null or a.purchase_id is distinct from p_purchase_id or
    a.stripe_checkout_session_id is distinct from p_session_id or a.stripe_subscription_id is distinct from p_subscription_id or
    p_request_hash is null or not exists(select 1 from public.exact_installment_operations where agreement_id=a.id
      and step='checkout' and status='complete' and result_id=p_session_id and request_hash=p_request_hash) then
    raise exception 'checkout publication binding differs'; end if;
  if p_session_id is null or p_session_id !~ '^cs_test_[A-Za-z0-9]+$' or p_url is null or length(p_url)>8192 or
    p_url !~ ('^https://checkout\.stripe\.com/c/pay/'||p_session_id||'([?#][^[:space:]]*)?$') or
    p_expires_at is distinct from floor(extract(epoch from a.created_at))::bigint+86400 or
    extract(epoch from now())>=p_expires_at-60 or
    exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id) or
    exists(select 1 from public.exact_installment_receipts where agreement_id=a.id) or
    exists(select 1 from public.exact_installment_billing_stops where agreement_id=a.id) then
    raise exception 'checkout not publishable'; end if;
  select * into bp from public.booking_payments where id=a.booking_payment_id for update;
  select * into b from public.bookings where id=(a.terms->>'bookingId')::uuid for update;
  select * into p from public.purchases where id=a.purchase_id for update;
  if bp.id is null or b.id is null or p.id is null or bp.booking_id is distinct from b.id or
    bp.installment_collection_version is distinct from 'exact-cents-held-v1' or bp.plan_type::text is distinct from 'installment' or
    bp.status::text not in ('pending','link_sent') or b.status is distinct from 'booked' or
    b.creator_id::text is distinct from a.terms->>'creatorId' or b.buyer_id::text is distinct from a.terms->>'buyerId' or
    b.post_id::text is distinct from a.terms->>'postId' or bp.buyer_id is distinct from b.buyer_id or
    bp.product_id::text is distinct from a.terms->>'productId' or bp.stripe_checkout_session_id is distinct from p_session_id or
    bp.stripe_subscription_id is distinct from p_subscription_id or bp.stripe_payment_intent_id is not null or
    bp.amount_total_cents is distinct from (a.terms->>'totalCents')::bigint or
    bp.installment_months is distinct from (a.terms->>'paymentCount')::integer or lower(trim(bp.currency)) is distinct from 'usd' or
    p.buyer_id is distinct from b.buyer_id or p.creator_id is distinct from b.creator_id or p.post_id is distinct from b.post_id or
    p.product_id is distinct from bp.product_id or p.booking_id is distinct from b.id or
    p.session_id is distinct from p_session_id or p.subscription_id is distinct from p_subscription_id or
    p.status is distinct from 'pending' or p.access_granted is distinct from false or p.paid_count is distinct from 0 or
    p.target_months is distinct from bp.installment_months or p.is_refund is distinct from false or p.is_suspect is distinct from false then
    raise exception 'unpaid checkout state changed'; end if;
  if not exists(select 1 from public.profiles where id=b.creator_id and stripe_onboarding_complete=true
      and stripe_account_id=a.terms->>'destinationId') or
    not exists(select 1 from public.products product join public.posts post on post.id=b.post_id and post.product_id=product.id
      and post.creator_id=b.creator_id where product.id=bp.product_id and product.creator_id=b.creator_id and product.is_active=true
      and product.type in ('video','course','mentorship') and product.amount_cents=(a.terms->>'totalCents')::bigint
      and lower(trim(product.currency))='usd') then
    raise exception 'product or destination changed before publication'; end if;
  reused:=bp.link_url is not null;
  if reused and bp.link_url is distinct from p_url then raise exception 'published checkout URL changed'; end if;
  update public.booking_payments set link_url=p_url,status='link_sent',link_sent_at=coalesce(link_sent_at,now()),updated_at=now()
    where id=bp.id returning * into bp;
  return jsonb_build_object('url',p_url,'payment',to_jsonb(bp),'reused',reused);
end;
$$;

revoke all on function public.reserve_exact_installment_checkout(uuid,uuid,integer,text,jsonb,jsonb),
  public.publish_exact_installment_checkout(uuid,uuid,text,text,uuid,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_exact_installment_checkout(uuid,uuid,integer,text,jsonb,jsonb),
  public.publish_exact_installment_checkout(uuid,uuid,text,text,uuid,text,bigint,text) to service_role;
commit;
