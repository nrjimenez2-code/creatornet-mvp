-- UNAPPLIED. Prospective fixed-total purchase consent; original 058/059/062
-- source, existing hashes, requests and acceptance history are not rewritten.
-- Apply only with the matching application, reviewed policies and configured
-- Stripe merchant Terms URL. This does not add or infer service duration.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Fixed purchase consent requires reviewed owner and READ COMMITTED'; end if;
  if to_regprocedure('public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb)') is null then
    raise exception 'Fixed purchase consent requires reviewed context accounting prerequisites'; end if;
  if exists(select 1 from pg_attribute where attrelid=to_regclass('public.exact_context_first_receipts_v2')
    and attname='purchase_consent_version' and not attisdropped) then
    raise exception 'Fixed purchase consent already installed; no rewrite'; end if;
end;
$preflight$;
alter table public.exact_context_first_receipts_v2 add column purchase_consent_version text
  check(purchase_consent_version is null or purchase_consent_version='fixed-total-purchase-consent-v1');
-- The existing immutable receipt stores the server-verified accepted version.
-- Its reservation and Checkout attempt retain identities, full text, amounts,
-- schedule, context and terms hash. recorded_at is observation time, NOT a
-- fabricated timestamp of the buyer's click. No IP or unrelated PII is collected.
create or replace function public.reserve_exact_installment_context_v2(p_booking_id uuid,p_actor_id uuid,p_count integer,
  p_context jsonb,p_first_fee jsonb,p_renewal_fee jsonb)
returns public.exact_installment_context_reservations_v2
language plpgsql security definer set search_path=pg_catalog as $$
declare
  b public.bookings%rowtype;
  product public.products%rowtype;
  profile public.profiles%rowtype;
  saved public.exact_installment_context_reservations_v2%rowtype;
  terms jsonb;
  schedule jsonb;
  gross bigint;
  scheduled_amount bigint;
  deduction bigint;
begin
  if current_setting('transaction_isolation') <> 'read committed' or p_booking_id is null or p_actor_id is null or
    p_count is null or p_count not between 2 and 24 then raise exception 'Invalid context reservation admission'; end if;
  if not public.valid_exact_payment_context_v2(p_context) or not exists(
    select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Explicit owner-provisioned context pin required'; end if;
  select * into b from public.bookings where id=p_booking_id for update;
  if not found or b.creator_id is distinct from p_actor_id or b.buyer_id is null or
    b.buyer_id=b.creator_id or b.status is distinct from 'booked' then raise exception 'Owned unpaid booking required'; end if;
  -- Never adopt any legacy row, including canceled/refunded evidence. Checking
  -- again after the common booking lock is essential to the reciprocal fence.
  if exists(select 1 from public.booking_payments where booking_id=b.id) or
    exists(select 1 from public.exact_installment_agreements ag where ag.terms->>'bookingId'=b.id::text) then
    raise exception 'Existing legacy payment/agreement cannot be adopted'; end if;
  select p.* into product from public.products p join public.posts post on post.id=b.post_id
    and post.product_id=p.id and post.creator_id=b.creator_id where p.creator_id=b.creator_id for share of p,post;
  if not found or product.type not in ('video','course','mentorship') or product.is_active is distinct from true or
    product.amount_cents is null or product.amount_cents<50 or lower(trim(product.currency)) is distinct from 'usd' or
    coalesce(length(trim(product.title)),0) not between 1 and 200 then raise exception 'Active owned USD product required'; end if;
  if exists(select 1 from public.purchases where buyer_id=b.buyer_id and (post_id=b.post_id or product_id=product.id)) then
    raise exception 'Existing purchase cannot be adopted'; end if;
  select * into profile from public.profiles where id=b.creator_id for share;
  if not found or profile.stripe_onboarding_complete is distinct from true or profile.stripe_account_id is null or
    profile.stripe_account_id !~ '^acct_[A-Za-z0-9]{1,100}$' then raise exception 'Creator destination not ready'; end if;
  gross:=product.amount_cents;
  if gross/p_count<50 or gross/p_count+gross%p_count>99999999 then raise exception 'Invalid agreed amounts'; end if;
  foreach schedule in array array[p_first_fee,p_renewal_fee] loop
    if jsonb_typeof(schedule) is distinct from 'object' or (select count(*) from jsonb_object_keys(schedule))<>4 or
      not(schedule ?& array['enabled','basisPoints','fixedCents','version']) or
      jsonb_typeof(schedule->'enabled') is distinct from 'boolean' or
      jsonb_typeof(schedule->'basisPoints') is distinct from 'number' or
      jsonb_typeof(schedule->'fixedCents') is distinct from 'number' or
      jsonb_typeof(schedule->'version') is distinct from 'string' or
      coalesce(schedule->>'basisPoints','') !~ '^\d+$' or coalesce(schedule->>'fixedCents','') !~ '^\d+$' or
      (schedule->>'basisPoints')::bigint not between 0 and 10000 or
      (schedule->>'fixedCents')::bigint not between 0 and 99999999 or
      coalesce(length(trim(schedule->>'version')),0) not between 1 and 200 or
      schedule->>'version' is distinct from trim(schedule->>'version') then raise exception 'Invalid fee snapshot'; end if;
    foreach scheduled_amount in array array[gross/p_count,gross/p_count+gross%p_count] loop
      deduction:=round(scheduled_amount::numeric*1200/10000)::bigint;
      if (schedule->>'enabled')::boolean then deduction:=deduction+
        round(scheduled_amount::numeric*(schedule->>'basisPoints')::integer/10000)::bigint+(schedule->>'fixedCents')::bigint; end if;
      if deduction>scheduled_amount then raise exception 'Fee exceeds installment'; end if;
    end loop;
  end loop;
  terms:=jsonb_build_object('version','exact-cents-context-v2','currency','usd','bookingId',b.id,'productId',product.id,
    'postId',b.post_id,'buyerId',b.buyer_id,'creatorId',b.creator_id,'destinationId',profile.stripe_account_id,
    'title',trim(product.title),'totalCents',gross,'paymentCount',p_count,
    'firstPaymentFeeSchedule',p_first_fee,'renewalFeeSchedule',p_renewal_fee);
  select * into saved from public.exact_installment_context_reservations_v2 where booking_id=b.id;
  if found then
    -- Repeats preserve the saved contract, including the absence of a version.
    if saved.terms ? 'purchaseConsentVersion' then
      terms:=terms||jsonb_build_object('purchaseConsentVersion','fixed-total-purchase-consent-v1');
    end if;
    if saved.context is distinct from p_context or saved.terms is distinct from terms or
      saved.status is distinct from 'reserved_not_issuable' then raise exception 'Existing context reservation differs'; end if;
    return saved;
  end if;
  -- New reservations only. No UPDATE or acceptance backfill for old buyers.
  terms:=terms||jsonb_build_object('purchaseConsentVersion','fixed-total-purchase-consent-v1');
  insert into public.exact_installment_context_reservations_v2(booking_id,context,terms)
    values(b.id,p_context,terms) returning * into saved;
  return saved;
end;
$$;

create or replace function public.plan_exact_customer_operation_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns public.exact_installment_context_customer_operations_v2
language plpgsql security definer set search_path=pg_catalog as $$
declare
  reservation public.exact_installment_context_reservations_v2%rowtype;
  booking public.bookings%rowtype;
  product public.products%rowtype;
  planned public.exact_installment_context_customer_operations_v2%rowtype;
  t jsonb;
  first_fee jsonb;
  renewal_fee jsonb;
  v_context_hash text;
  v_terms_hash text;
  v_request_hash text;
  v_key text;
  v_metadata jsonb;
  v_request jsonb;
  v_booking_id uuid;
begin
  if p_reservation_id is null or p_actor_id is null or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Invalid customer v2 planning admission'; end if;
  if not public.valid_exact_payment_context_v2(p_context) or not exists(select 1 from public.exact_installment_context_pin_v2
    where singleton and context=p_context) then raise exception 'Explicit owner-provisioned context pin required'; end if;
  select * into reservation from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  if not found or reservation.context is distinct from p_context or reservation.status is distinct from 'reserved_not_issuable' or
    reservation.terms->>'creatorId' is distinct from p_actor_id::text then raise exception 'Owned blocked v2 reservation required'; end if;
  v_booking_id:=reservation.booking_id;
  -- Match 058's admission order: read the immutable booking identity, lock the
  -- booking, then lock/re-read the reservation and revalidate its exact binding.
  -- Recheck ALL admission facts before returning even an existing plan.
  select * into booking from public.bookings where id=v_booking_id for update;
  if not found then raise exception 'Current owned unpaid booking required'; end if;
  select * into reservation from public.exact_installment_context_reservations_v2 where id=p_reservation_id for update;
  if not found or reservation.booking_id is distinct from booking.id or reservation.context is distinct from p_context or
    reservation.status is distinct from 'reserved_not_issuable' or reservation.terms->>'creatorId' is distinct from p_actor_id::text then
    raise exception 'Owned blocked v2 reservation changed'; end if;
  t:=reservation.terms;
  if not found or booking.status is distinct from 'booked' or booking.creator_id is distinct from p_actor_id or
    t->>'bookingId' is distinct from booking.id::text or t->>'buyerId' is distinct from booking.buyer_id::text or
    t->>'postId' is distinct from booking.post_id::text or booking.buyer_id is null or booking.buyer_id=booking.creator_id then
    raise exception 'Current owned unpaid booking required'; end if;
  select p.* into product from public.products p join public.posts post on post.id=booking.post_id and post.product_id=p.id
    and post.creator_id=booking.creator_id where p.creator_id=booking.creator_id for share of p,post;
  if not found or product.id::text is distinct from t->>'productId' or product.is_active is distinct from true or
    product.type not in ('video','course','mentorship') or lower(trim(product.currency)) is distinct from 'usd' or
    t->>'currency' is distinct from 'usd' or t->>'version' is distinct from 'exact-cents-context-v2' or
    product.amount_cents is distinct from (t->>'totalCents')::numeric or trim(product.title) is distinct from t->>'title' then
    raise exception 'Current product no longer matches reservation'; end if;
  perform 1 from public.profiles where id=booking.creator_id and stripe_onboarding_complete=true and
    stripe_account_id=t->>'destinationId' for share;
  if not found then raise exception 'Current creator destination differs'; end if;
  if exists(select 1 from public.booking_payments where booking_id=booking.id) or
    exists(select 1 from public.exact_installment_agreements a where a.terms->>'bookingId'=booking.id::text) or
    exists(select 1 from public.purchases where buyer_id=booking.buyer_id and (post_id=booking.post_id or product_id=product.id)) then
    raise exception 'Existing financial evidence cannot be adopted'; end if;
  first_fee:=t->'firstPaymentFeeSchedule'; renewal_fee:=t->'renewalFeeSchedule';
  -- 058 constructs these scalar types. Check integers before decimal framing so
  -- an owner-inserted malformed snapshot cannot silently round into a hash.
  if jsonb_typeof(t) is distinct from 'object' or (select count(*) from jsonb_object_keys(t))<>(13+case when t ? 'purchaseConsentVersion' then 1 else 0 end) or
    (t ? 'purchaseConsentVersion' and (jsonb_typeof(t->'purchaseConsentVersion') is distinct from 'string' or
      t->>'purchaseConsentVersion' is distinct from 'fixed-total-purchase-consent-v1')) or
    not(t ?& array['version','currency','bookingId','productId','postId','buyerId','creatorId','destinationId','title',
      'totalCents','paymentCount','firstPaymentFeeSchedule','renewalFeeSchedule']) or
    jsonb_typeof(t->'totalCents') is distinct from 'number' or jsonb_typeof(t->'paymentCount') is distinct from 'number' or
    (t->>'totalCents')::numeric<>trunc((t->>'totalCents')::numeric) or
    (t->>'paymentCount')::numeric<>trunc((t->>'paymentCount')::numeric) or
    (t->>'paymentCount')::numeric not between 2 and 24 or
    (t->>'totalCents')::numeric/(t->>'paymentCount')::numeric<50 then raise exception 'Invalid customer v2 terms snapshot'; end if;
  foreach v_metadata in array array[first_fee,renewal_fee] loop
    if jsonb_typeof(v_metadata) is distinct from 'object' or (select count(*) from jsonb_object_keys(v_metadata))<>4 or
      not(v_metadata ?& array['enabled','basisPoints','fixedCents','version']) or
      jsonb_typeof(v_metadata->'enabled') is distinct from 'boolean' or
      jsonb_typeof(v_metadata->'basisPoints') is distinct from 'number' or jsonb_typeof(v_metadata->'fixedCents') is distinct from 'number' or
      jsonb_typeof(v_metadata->'version') is distinct from 'string' or
      (v_metadata->>'basisPoints')::numeric<>trunc((v_metadata->>'basisPoints')::numeric) or
      (v_metadata->>'fixedCents')::numeric<>trunc((v_metadata->>'fixedCents')::numeric) or
      (v_metadata->>'basisPoints')::numeric not between 0 and 10000 or (v_metadata->>'fixedCents')::numeric not between 0 and 99999999 or
      coalesce(length(trim(v_metadata->>'version')),0) not between 1 and 200 or
      v_metadata->>'version' is distinct from trim(v_metadata->>'version') then
      raise exception 'Invalid customer v2 fee snapshot'; end if;
  end loop;
  v_context_hash:=public.exact_customer_hex_tuple_hash_v2(array['cn-exact-v2-context-v1',p_context->>'version',p_context->>'mode',
    p_context->>'platformAccountId',p_context->>'supabaseProjectRef',p_context->>'siteOrigin']);
  v_terms_hash:=public.exact_customer_hex_tuple_hash_v2(array[case when t ? 'purchaseConsentVersion' then 'cn-exact-v2-terms-consent-v1' else 'cn-exact-v2-terms-v1' end,t->>'version',t->>'currency',
    t->>'bookingId',t->>'productId',t->>'postId',t->>'buyerId',t->>'creatorId',t->>'destinationId',t->>'title',
    (t->>'totalCents')::numeric::bigint::text,(t->>'paymentCount')::numeric::integer::text,
    first_fee->>'enabled',(first_fee->>'basisPoints')::numeric::integer::text,(first_fee->>'fixedCents')::numeric::bigint::text,first_fee->>'version',
    renewal_fee->>'enabled',(renewal_fee->>'basisPoints')::numeric::integer::text,(renewal_fee->>'fixedCents')::numeric::bigint::text,renewal_fee->>'version']||case when t ? 'purchaseConsentVersion' then array[t->>'purchaseConsentVersion'] else array[]::text[] end);
  v_metadata:=jsonb_build_object('installment_collection_version','exact-cents-context-v2','installment_plan_id',reservation.id,
    'booking_id',booking.id,'buyer_id',booking.buyer_id,'creator_id',booking.creator_id,
    'context_hash',v_context_hash,'terms_hash',v_terms_hash,'operation_kind','customer.create');
  v_request:=jsonb_build_object('version','exact-context-customer-request-v1','apiVersion','2025-10-29.clover',
    'method','POST','path','/v1/customers','params',jsonb_build_object('metadata',v_metadata));
  v_request_hash:=public.exact_customer_hex_tuple_hash_v2(array['cn-exact-v2-customer-request-v1',
    'exact-context-customer-request-v1','2025-10-29.clover','POST','/v1/customers',
    'installment_collection_version',v_metadata->>'installment_collection_version','installment_plan_id',v_metadata->>'installment_plan_id',
    'booking_id',v_metadata->>'booking_id','buyer_id',v_metadata->>'buyer_id','creator_id',v_metadata->>'creator_id',
    'context_hash',v_context_hash,'terms_hash',v_terms_hash,'operation_kind','customer.create']);
  v_key:='cn-exact-v2-customer:'||public.exact_customer_hex_tuple_hash_v2(array['cn-exact-v2-customer-key-v1',
    'exact_installment_context_reservations_v2','exact_installment_context_customer_operations_v2',reservation.id::text,
    v_context_hash,v_terms_hash,v_request_hash]);
  select * into planned from public.exact_installment_context_customer_operations_v2
    where reservation_id=reservation.id and operation_kind='customer.create';
  if found then
    if planned.context is distinct from p_context or planned.context_hash is distinct from v_context_hash or
      planned.terms_hash is distinct from v_terms_hash or planned.request is distinct from v_request or
      planned.request_hash is distinct from v_request_hash or planned.idempotency_key is distinct from v_key or
      planned.status is distinct from 'planned_not_dispatchable' then raise exception 'Existing customer v2 plan differs'; end if;
    return planned;
  end if;
  insert into public.exact_installment_context_customer_operations_v2(reservation_id,context,context_hash,terms_hash,
    operation_kind,request,request_hash,idempotency_key)
    values(reservation.id,p_context,v_context_hash,v_terms_hash,'customer.create',v_request,v_request_hash,v_key) returning * into planned;
  return planned;
end;
$$;

create or replace function public.claim_exact_context_checkout_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.exact_installment_context_customer_operations_v2%rowtype;
  r public.exact_installment_context_reservations_v2%rowtype; a public.exact_context_checkout_attempts_v2%rowtype;
  customer_id text; subscription_id text; hold_id text; anchor bigint; count_payments integer; total bigint; gross bigint;
  platform bigint; processing bigint; schedule jsonb; meta jsonb; params jsonb; at_time timestamptz;
  step_id uuid:=gen_random_uuid(); description text; remaining text; total_text text; first_text text;
begin
  op:=public.plan_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into a from public.exact_context_checkout_attempts_v2 where reservation_id=r.id;
  if found then return public.read_exact_context_checkout_v2(r.id,p_actor_id,p_context); end if;
  select b.customer_id into customer_id from public.exact_context_customer_bindings_v2 b where operation_id=op.id;
  select s.anchor_seconds into anchor from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
    where s.reservation_id=r.id and s.stage='product';
  select b.provider_id into subscription_id from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
    where s.reservation_id=r.id and s.stage='subscription' and s.anchor_seconds=anchor;
  select b.provider_id into hold_id from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
    where s.reservation_id=r.id and s.stage='hold' and s.anchor_seconds=anchor;
  if customer_id is null or anchor is null or subscription_id is null or hold_id is distinct from subscription_id then
    raise exception 'Bound customer and held subscription required'; end if;
  at_time:=clock_timestamp();
  if at_time<to_timestamp(anchor) or at_time>=to_timestamp(anchor)+interval '24 hours'-interval '31 minutes' then
    raise exception 'Checkout preparation window expired'; end if;
  count_payments:=(r.terms->>'paymentCount')::integer; total:=(r.terms->>'totalCents')::bigint;
  gross:=total/count_payments; schedule:=r.terms->'firstPaymentFeeSchedule';
  platform:=(gross*1200+5000)/10000;
  processing:=case when (schedule->>'enabled')::boolean then
    (gross*(schedule->>'basisPoints')::bigint+5000)/10000+(schedule->>'fixedCents')::bigint else 0 end;
  if platform+processing>gross then raise exception 'Invalid Checkout fee'; end if;
  -- Same exact-cent disclosure as the existing shared TypeScript payload.
  select string_agg('$'||(amount/100)::text||'.'||lpad((amount%100)::text,2,'0'),', ' order by n) into remaining
    from (select n,gross+case when n=count_payments then total%count_payments else 0 end amount from generate_series(2,count_payments) n) x;
  first_text:='$'||(gross/100)::text||'.'||lpad((gross%100)::text,2,'0');
  total_text:='$'||(total/100)::text||'.'||lpad((total%100)::text,2,'0');
  description:=first_text||' today, then '||remaining||' in monthly payments. '||count_payments::text||' payments total: '||
    total_text||' USD. No automatic renewal after the final payment.';
  meta:=jsonb_set(op.request->'params'->'metadata','{operation_kind}','"checkout.create"'::jsonb)||jsonb_build_object(
    'installment_number','1','installment_subscription_id',subscription_id,'post_id',r.terms->>'postId','product_id',r.terms->>'productId',
    'creator_stripe_account_id',r.terms->>'destinationId','plan_type','installment','plan_months',count_payments::text,
    'installment_total_cents',total::text,'fee_gross_cents',gross::text,'platform_fee_cents',platform::text,
    'processing_fee_cents',processing::text,'total_creator_deduction_cents',(platform+processing)::text,'creator_net_cents',(gross-platform-processing)::text,
    'processing_fee_enabled',schedule->>'enabled','processing_fee_bps',case when (schedule->>'enabled')::boolean then schedule->>'basisPoints' else '0' end,
    'processing_fee_fixed_cents',case when (schedule->>'enabled')::boolean then schedule->>'fixedCents' else '0' end,'fee_schedule_version',schedule->>'version');
  params:=jsonb_build_object('mode','payment','adaptive_pricing',jsonb_build_object('enabled',false),'automatic_tax',jsonb_build_object('enabled',false),
    'allow_promotion_codes',false,'invoice_creation',jsonb_build_object('enabled',false),'customer',customer_id,'payment_method_types',jsonb_build_array('card'),
    'line_items',jsonb_build_array(jsonb_build_object('quantity',1,'price_data',jsonb_build_object('currency','usd','unit_amount',gross,
      'product_data',jsonb_build_object('name',r.terms->>'title','description',description)))),
    'payment_intent_data',jsonb_build_object('application_fee_amount',platform+processing,'transfer_data',jsonb_build_object('destination',r.terms->>'destinationId'),
      'setup_future_usage','off_session','metadata',meta),'metadata',meta,
    'consent_collection',jsonb_build_object('payment_method_reuse_agreement',jsonb_build_object('position','auto')),
    'custom_text',jsonb_build_object('submit',jsonb_build_object('message',description||
      ' By paying, you authorize use of this card for these scheduled installments, subject to the applicable cancellation and refund terms.')),
    'success_url',(r.context->>'siteOrigin')||'/success?session_id={CHECKOUT_SESSION_ID}','cancel_url',(r.context->>'siteOrigin')||'/dashboard','expires_at',anchor+86400);
  if r.terms ? 'purchaseConsentVersion' then
    if r.terms->>'purchaseConsentVersion' is distinct from 'fixed-total-purchase-consent-v1' then
      raise exception 'Unknown fixed purchase consent version'; end if;
    params:=jsonb_set(params,'{consent_collection,terms_of_service}','"required"'::jsonb);
    params:=jsonb_set(params,'{custom_text,submit,message}',to_jsonb(description||' This is a fixed-price purchase, not a cancel-anytime membership. I agree to pay the full price on the schedule shown and authorize use of my saved card for those installments. Ending automatic debits or stopping use does not by itself erase the unpaid balance. The payment schedule does not set the service duration. Refund rights and rights provided by law still apply.'));
  end if;
  insert into public.exact_context_checkout_attempts_v2(id,reservation_id,claimed_at,request,idempotency_key)
    values(step_id,r.id,at_time,jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/checkout/sessions','params',params),
      'cn-exact-v2-checkout:'||step_id::text||':'||op.context_hash||':'||op.terms_hash);
  return public.read_exact_context_checkout_v2(r.id,p_actor_id,p_context)||jsonb_build_object('claimed',true);
end;
$$;

create or replace function public.read_exact_context_first_receipt_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare receipt public.exact_context_first_receipts_v2%rowtype;
begin
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into receipt from public.exact_context_first_receipts_v2 where reservation_id=p_reservation_id;
  return case when receipt.reservation_id is null then null
    when receipt.purchase_consent_version is null then to_jsonb(receipt)-'purchase_consent_version'
    else to_jsonb(receipt) end;
end;
$$;

create or replace function public.record_exact_context_first_receipt_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.exact_context_checkout_attempts_v2%rowtype; b public.exact_context_checkout_results_v2%rowtype;
  saved public.exact_context_first_receipts_v2%rowtype; consent_version text;
begin
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select terms->>'purchaseConsentVersion' into consent_version
    from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into a from public.exact_context_checkout_attempts_v2 where reservation_id=p_reservation_id for update;
  select * into b from public.exact_context_checkout_results_v2 where attempt_id=a.id;
  if b.attempt_id is null or jsonb_typeof(p_receipt) is distinct from 'object' then raise exception 'Bound Checkout receipt required'; end if;
  if consent_version is not null and (consent_version is distinct from 'fixed-total-purchase-consent-v1' or
    jsonb_typeof(p_receipt->'purchase_consent_version') is distinct from 'string' or
    p_receipt->>'purchase_consent_version' is distinct from consent_version or
    a.request#>>'{params,consent_collection,terms_of_service}' is distinct from 'required') then
    raise exception 'Verified fixed purchase consent required'; end if;
  if (select count(*) from jsonb_object_keys(p_receipt))<>(9+case when consent_version is null then 0 else 1 end) or
    not(p_receipt ?& array['session_id','payment_intent_id','charge_id',
    'balance_transaction_id','payment_method_id','amount_cents','application_fee_cents','actual_stripe_fee_cents','paid_at']) then
    raise exception 'Exact first receipt fields required'; end if;
  if p_receipt->>'session_id' is distinct from b.session_id or
    jsonb_typeof(p_receipt->'amount_cents') is distinct from 'number' or jsonb_typeof(p_receipt->'application_fee_cents') is distinct from 'number' or
    jsonb_typeof(p_receipt->'actual_stripe_fee_cents') is distinct from 'number' or jsonb_typeof(p_receipt->'paid_at') is distinct from 'number' or
    coalesce(p_receipt->>'amount_cents','') !~ '^\d+$' or coalesce(p_receipt->>'application_fee_cents','') !~ '^\d+$' or
    coalesce(p_receipt->>'actual_stripe_fee_cents','') !~ '^\d+$' or coalesce(p_receipt->>'paid_at','') !~ '^\d+$' or
    (p_receipt->>'amount_cents')::bigint is distinct from (a.request#>>'{params,line_items,0,price_data,unit_amount}')::bigint or
    (p_receipt->>'application_fee_cents')::bigint is distinct from (a.request#>>'{params,payment_intent_data,application_fee_amount}')::bigint or
    (p_receipt->>'paid_at')::bigint<floor(extract(epoch from a.claimed_at)) or
    (p_receipt->>'paid_at')::bigint>floor(extract(epoch from clock_timestamp())) then raise exception 'First receipt binding/amount/time differs'; end if;
  -- This RPC trusts the private server's fresh provider inspection, not metadata
  -- from an HTTP body. The immutable evidence alone cannot grant access/credit.
  select * into saved from public.exact_context_first_receipts_v2 where reservation_id=p_reservation_id;
  if found then
    if ((case when saved.purchase_consent_version is null then to_jsonb(saved)-'purchase_consent_version' else to_jsonb(saved) end)
      -'reservation_id'-'recorded_at') is distinct from p_receipt then raise exception 'First receipt already recorded differently'; end if;
  else
    -- A later accounting connection may have consumed this exact saved receipt.
    -- Re-reading identical evidence is allowed; adopting an old payment into a
    -- NEW context receipt remains forbidden and grants no accounting authority.
    if exists(select 1 from public.exact_installment_receipts where stripe_payment_intent_id=p_receipt->>'payment_intent_id') then
      raise exception 'Old payment cannot be adopted'; end if;
    insert into public.exact_context_first_receipts_v2(reservation_id,session_id,payment_intent_id,charge_id,balance_transaction_id,payment_method_id,
      amount_cents,application_fee_cents,actual_stripe_fee_cents,paid_at,purchase_consent_version)
      values(p_reservation_id,b.session_id,p_receipt->>'payment_intent_id',p_receipt->>'charge_id',p_receipt->>'balance_transaction_id',p_receipt->>'payment_method_id',
        (p_receipt->>'amount_cents')::bigint,(p_receipt->>'application_fee_cents')::bigint,(p_receipt->>'actual_stripe_fee_cents')::bigint,(p_receipt->>'paid_at')::bigint,consent_version);
  end if;
  return public.read_exact_context_first_receipt_v2(p_reservation_id,p_actor_id,p_context);
end;
$$;
do $permissions$
declare signature text; fn oid; role_name text;
begin
  foreach signature in array array['public.reserve_exact_installment_context_v2(uuid,uuid,integer,jsonb,jsonb,jsonb)',
    'public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)',
    'public.claim_exact_context_checkout_v2(uuid,uuid,jsonb)',
    'public.read_exact_context_first_receipt_v2(uuid,uuid,jsonb)',
    'public.record_exact_context_first_receipt_v2(uuid,uuid,jsonb,jsonb)'] loop
    fn:=to_regprocedure(signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn::regprocedure);
    execute format('grant execute on function %s to service_role',fn::regprocedure);
    if not exists(select 1 from pg_proc where oid=fn and prosecdef and
      proowner=(select oid from pg_roles where rolname=current_user) and proconfig=array['search_path=pg_catalog']) or
      has_function_privilege('anon',fn,'EXECUTE') or has_function_privilege('authenticated',fn,'EXECUTE') or
      not has_function_privilege('service_role',fn,'EXECUTE') then
      raise exception 'Fixed purchase consent function permissions differ'; end if;
  end loop;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.exact_context_first_receipts_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or
      has_column_privilege(role_name,'public.exact_context_first_receipts_v2','purchase_consent_version','SELECT') or
      has_column_privilege(role_name,'public.exact_context_first_receipts_v2','purchase_consent_version','INSERT') or
      has_column_privilege(role_name,'public.exact_context_first_receipts_v2','purchase_consent_version','UPDATE') then
      raise exception 'Fixed purchase consent evidence is not private'; end if;
  end loop;
end;
$permissions$;
commit;
