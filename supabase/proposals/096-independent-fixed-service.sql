-- UNAPPLIED. Independent fixed-purchase service months for prospective
-- context-v2 installments. Existing durations/requests are not inferred or
-- rewritten. This is access state on the existing financial engine.
-- New timed one-time offers remain fenced pending their full integration.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Fixed service requires reviewed owner and READ COMMITTED'; end if;
  if to_regclass('public.product_checkout_attempts') is null or not exists(select 1 from pg_attribute
    where attrelid=to_regclass('public.exact_context_first_receipts_v2') and attname='purchase_consent_version' and not attisdropped) then
    raise exception 'Fixed service requires reviewed Checkout and SQL095 prerequisites'; end if;
  if to_regclass('public.fixed_purchase_service_contracts_v1') is not null or exists(select 1 from pg_attribute
    where attrelid=to_regclass('public.products') and attname='fixed_service_months' and not attisdropped) then
    raise exception 'Fixed service collision; no adoption'; end if;
end;
$preflight$;

create function public.fixed_service_end_v1(p_anchor bigint,p_months integer)
returns bigint language plpgsql immutable set search_path=pg_catalog as $$
declare origin timestamp; target timestamp; last_day integer; result bigint;
begin
  if p_anchor is null or p_anchor not between 1 and 253402300799 or p_months is null or p_months<1 then
    raise exception 'Invalid fixed service duration'; end if;
  origin:=to_timestamp(p_anchor) at time zone 'UTC';
  target:=date_trunc('month',origin)+make_interval(months=>p_months);
  last_day:=extract(day from target+interval '1 month - 1 day')::integer;
  target:=target+make_interval(days=>least(extract(day from origin)::integer,last_day)-1)+(origin-date_trunc('day',origin));
  result:=extract(epoch from target at time zone 'UTC')::bigint;
  if result<=p_anchor or result>253402300799 then raise exception 'Service duration exceeds supported dates'; end if;
  return result;
end;
$$;
create function public.fixed_service_description_v1(p_months integer)
returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
  if p_months is null or p_months<1 then raise exception 'Invalid fixed service duration'; end if;
  return 'Service: '||p_months::text||' calendar '||case when p_months=1 then 'month' else 'months' end||
    ' from the first captured payment, independent of payment count.';
end;
$$;
alter table public.products add column fixed_service_months integer
  check(fixed_service_months is null or (fixed_service_months>0 and type in ('video','course','mentorship')));
create function public.guard_fixed_service_product_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if new.fixed_service_months is not null then
    if to_jsonb(new)->'membership_terms' is not null and to_jsonb(new)->'membership_terms'<>'null'::jsonb then
      raise exception 'Monthly membership and fixed service duration are different offers'; end if;
    perform public.fixed_service_end_v1(floor(extract(epoch from clock_timestamp()))::bigint+86400,new.fixed_service_months);
  end if;
  return new;
end;
$$;
create trigger fixed_service_product_v1 before insert or update on public.products
  for each row execute function public.guard_fixed_service_product_v1();

-- Access state, NOT a second payment ledger. Every payment, fee, refund and
-- balance remains in the existing agreement/receipt/fee-ledger machinery.
create table public.fixed_purchase_service_contracts_v1 (
  purchase_id uuid primary key references public.purchases(id) on delete restrict,
  agreement_id uuid not null unique references public.exact_installment_agreements(id) on delete restrict,
  version text not null check(version='fixed-service-months-v1'),
  service_months integer not null check(service_months>0),
  service_start_at bigint not null check(service_start_at>0),
  service_end_at bigint not null,
  financial_access boolean not null default false,
  recorded_at timestamptz not null default clock_timestamp(),
  access_updated_at timestamptz not null default clock_timestamp(),
  check(service_end_at=public.fixed_service_end_v1(service_start_at,service_months))
);
alter table public.fixed_purchase_service_contracts_v1 enable row level security;
revoke all on public.fixed_purchase_service_contracts_v1 from public,anon,authenticated,service_role;
create function public.guard_fixed_service_contract_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' and (to_jsonb(new)-'financial_access'-'access_updated_at') is not distinct from
    (to_jsonb(old)-'financial_access'-'access_updated_at') then return new; end if;
  raise exception 'Fixed service contract terms are immutable';
end;
$$;
create trigger fixed_service_contract_immutable before update or delete on public.fixed_purchase_service_contracts_v1
  for each row execute function public.guard_fixed_service_contract_v1();
create trigger fixed_service_contract_no_truncate before truncate on public.fixed_purchase_service_contracts_v1
  for each statement execute function public.guard_fixed_service_contract_v1();

create function public.bind_fixed_service_context_v1(p_agreement_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare a public.exact_installment_agreements%rowtype; p public.purchases%rowtype;
  r public.exact_context_first_receipts_v2%rowtype; c public.fixed_purchase_service_contracts_v1%rowtype;
  months integer; end_at bigint;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.terms->>'version' is distinct from 'exact-cents-context-v2' or not(a.terms ? 'serviceMonths') or
    a.terms->>'purchaseConsentVersion' is distinct from 'fixed-total-purchase-consent-v1' then
    raise exception 'Owned duration-bearing context agreement required'; end if;
  select receipt.* into r from public.exact_context_first_receipts_v2 receipt
    join public.exact_context_accounting_links_v2 link on link.reservation_id=receipt.reservation_id
    where link.agreement_id=a.id and link.booking_payment_id=a.booking_payment_id;
  select * into p from public.purchases where id=a.purchase_id;
  if r.reservation_id is distinct from a.id or r.purchase_consent_version is distinct from 'fixed-total-purchase-consent-v1' or
    r.session_id is distinct from a.stripe_checkout_session_id or p.id is null or
    p.buyer_id::text is distinct from a.terms->>'buyerId' or p.creator_id::text is distinct from a.terms->>'creatorId' or
    p.product_id::text is distinct from a.terms->>'productId' or p.post_id::text is distinct from a.terms->>'postId' or
    p.booking_id::text is distinct from a.terms->>'bookingId' or p.session_id is distinct from r.session_id or
    p.subscription_id is distinct from a.stripe_subscription_id or
    not exists(select 1 from public.exact_installment_receipts where agreement_id=a.id and payment_number=1 and
      stripe_payment_intent_id=r.payment_intent_id and paid_at=to_timestamp(r.paid_at)) then
    raise exception 'Captured fixed service purchase binding differs'; end if;
  months:=(a.terms->>'serviceMonths')::integer; end_at:=public.fixed_service_end_v1(r.paid_at,months);
  select * into c from public.fixed_purchase_service_contracts_v1 where purchase_id=p.id or agreement_id=a.id;
  if found then
    if c.purchase_id is distinct from p.id or c.agreement_id is distinct from a.id or c.service_months is distinct from months or
      c.service_start_at is distinct from r.paid_at or c.service_end_at is distinct from end_at then
      raise exception 'Existing fixed service contract differs'; end if;
    return;
  end if;
  if a.first_fulfilled_at is not null or p.status not in ('pending','processing') or coalesce(p.paid_count,0)<>0 or
    p.access_granted is distinct from false or exists(select 1 from public.exact_installment_receipts
      where agreement_id=a.id and (counted_at is not null or ledger_id is not null)) then
    raise exception 'An existing paid purchase cannot acquire a new service limit'; end if;
  insert into public.fixed_purchase_service_contracts_v1(purchase_id,agreement_id,version,service_months,service_start_at,service_end_at)
    values(p.id,a.id,'fixed-service-months-v1',months,r.paid_at,end_at);
end;
$$;

create function public.mask_fixed_service_access_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  -- Fire ONLY when existing accounting explicitly assigns access_granted.
  -- An unrelated purchase update must not erase the preserved access decision.
  update public.fixed_purchase_service_contracts_v1
    set financial_access=coalesce(new.access_granted,false),access_updated_at=clock_timestamp() where purchase_id=old.id;
  if found then new.access_granted:=false; end if;
  return new;
end;
$$;
create trigger fixed_service_access_v1 before update of access_granted on public.purchases
  for each row execute function public.mask_fixed_service_access_v1();
create function public.fixed_purchase_financial_access_v1(p_purchase_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog as $$
declare value boolean;
begin
  select financial_access into value from public.fixed_purchase_service_contracts_v1 where purchase_id=p_purchase_id;
  if found then return value; end if;
  if exists(select 1 from public.exact_installment_agreements where purchase_id=p_purchase_id and terms ? 'serviceMonths') then return false; end if;
  select access_granted into value from public.purchases where id=p_purchase_id;
  return value;
end;
$$;

create function public.read_fixed_service_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p public.purchases%rowtype; c public.fixed_purchase_service_contracts_v1%rowtype;
  a public.exact_installment_agreements%rowtype; r public.exact_installment_receipts%rowtype;
  financial boolean:=false; seconds integer:=0; at_time numeric:=extract(epoch from clock_timestamp());
begin
  select * into p from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id;
  if not found then return jsonb_build_object('applicable',false,'allowed',false,'maxAgeSeconds',0); end if;
  select * into c from public.fixed_purchase_service_contracts_v1 where purchase_id=p.id;
  if not found then
    if exists(select 1 from public.exact_installment_agreements where purchase_id=p.id and terms ? 'serviceMonths') then
      return jsonb_build_object('applicable',true,'allowed',false,'financialAccess',false,'maxAgeSeconds',0);
    end if;
    return jsonb_build_object('applicable',false,'allowed',p.access_granted and p.status<>'refunded',
      'maxAgeSeconds',case when p.access_granted and p.status<>'refunded' then 3600 else 0 end);
  end if;
  select * into a from public.exact_installment_agreements where id=c.agreement_id and purchase_id=p.id;
  select * into r from public.exact_installment_receipts where agreement_id=a.id and payment_number=1;
  financial:=coalesce(c.financial_access and a.purchase_seeded_at is not null and a.first_fulfilled_at is not null and
    a.terms->>'version'='exact-cents-context-v2' and (a.terms->>'serviceMonths')::integer=c.service_months and
    a.terms->>'buyerId'=p_buyer_id::text and a.terms->>'creatorId'=p.creator_id::text and
    a.terms->>'productId'=p.product_id::text and a.terms->>'postId'=p.post_id::text and
    a.terms->>'bookingId'=p.booking_id::text and a.stripe_checkout_session_id=p.session_id and
    a.stripe_subscription_id=p.subscription_id and p.status in ('active','complete') and not p.is_refund and not p.is_suspect and
    r.paid_at=to_timestamp(c.service_start_at) and r.counted_at is not null and
    exists(select 1 from public.payment_fee_ledger where id=r.ledger_id and purchase_id=p.id and earnings_credited_at is not null and status='paid') and
    not exists(select 1 from public.exact_installment_receipts rec join public.payment_fee_ledger l on l.id=rec.ledger_id
      where rec.agreement_id=a.id and (l.status<>'paid' or l.refunded_amount_cents>0 or l.earnings_reversed_cents>0 or
        l.dispute_status is not null and l.dispute_status not in ('won','warning_closed'))) and
    not exists(select 1 from public.exact_installment_receipts rec join public.payment_refund_state state
      on state.stripe_payment_intent_id=rec.stripe_payment_intent_id where rec.agreement_id=a.id and state.refunded_amount_cents>0) and
    not exists(select 1 from public.exact_installment_receipts rec join public.payment_dispute_state state
      on state.stripe_payment_intent_id=rec.stripe_payment_intent_id where rec.agreement_id=a.id and state.status not in ('won','warning_closed')) and
    not exists(select 1 from public.exact_installment_receipts rec join public.refund_operations op
      on op.stripe_payment_intent_id=rec.stripe_payment_intent_id where rec.agreement_id=a.id and op.status not in ('failed','completed')),false);
  if financial and at_time>=c.service_start_at then
    seconds:=floor(least(3600,greatest(0,c.service_end_at-at_time)))::integer;
  end if;
  return jsonb_build_object('applicable',true,'agreementId',c.agreement_id,'serviceMonths',c.service_months,
    'serviceStartAt',c.service_start_at,'serviceEndAt',c.service_end_at,'financialAccess',financial,
    'allowed',seconds>0,'maxAgeSeconds',seconds);
end;
$$;

-- Until the ONE-TIME duration consent/capture integration is finished, a new
-- timed product must not silently enter the permanent-access Checkout path.
-- Existing attempts retain their earlier promise; this fence is INSERT-only.
create function public.guard_fixed_service_one_time_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if exists(select 1 from public.products where id=new.product_id and fixed_service_months is not null) then
    raise exception 'Timed one-time checkout requires its service contract integration'; end if;
  return new;
end;
$$;
create trigger fixed_service_one_time_v1 before insert on public.product_checkout_attempts
  for each row execute function public.guard_fixed_service_one_time_v1();

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
    if saved.terms ? 'serviceMonths' then
      terms:=terms||jsonb_build_object('serviceMonths',product.fixed_service_months);
    end if;
    if saved.context is distinct from p_context or saved.terms is distinct from terms or
      saved.status is distinct from 'reserved_not_issuable' then raise exception 'Existing context reservation differs'; end if;
    return saved;
  end if;
  -- New reservations only. No UPDATE or acceptance backfill for old buyers.
  terms:=terms||jsonb_build_object('purchaseConsentVersion','fixed-total-purchase-consent-v1');
  if product.fixed_service_months is not null then
    perform public.fixed_service_end_v1(floor(extract(epoch from clock_timestamp()))::bigint+86400,product.fixed_service_months);
    terms:=terms||jsonb_build_object('serviceMonths',product.fixed_service_months);
  end if;
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
  if jsonb_typeof(t) is distinct from 'object' or (select count(*) from jsonb_object_keys(t))<>(13+case when t ? 'purchaseConsentVersion' then 1 else 0 end+case when t ? 'serviceMonths' then 1 else 0 end) or
    (t ? 'serviceMonths' and (not(t ? 'purchaseConsentVersion') or jsonb_typeof(t->'serviceMonths') is distinct from 'number' or
      (t->>'serviceMonths')::numeric<>trunc((t->>'serviceMonths')::numeric) or
      (t->>'serviceMonths')::numeric not between 1 and 2147483647 or
      product.fixed_service_months is distinct from (t->>'serviceMonths')::numeric)) or
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
  v_terms_hash:=public.exact_customer_hex_tuple_hash_v2(array[case when t ? 'serviceMonths' then 'cn-exact-v2-terms-service-v1' when t ? 'purchaseConsentVersion' then 'cn-exact-v2-terms-consent-v1' else 'cn-exact-v2-terms-v1' end,t->>'version',t->>'currency',
    t->>'bookingId',t->>'productId',t->>'postId',t->>'buyerId',t->>'creatorId',t->>'destinationId',t->>'title',
    (t->>'totalCents')::numeric::bigint::text,(t->>'paymentCount')::numeric::integer::text,
    first_fee->>'enabled',(first_fee->>'basisPoints')::numeric::integer::text,(first_fee->>'fixedCents')::numeric::bigint::text,first_fee->>'version',
    renewal_fee->>'enabled',(renewal_fee->>'basisPoints')::numeric::integer::text,(renewal_fee->>'fixedCents')::numeric::bigint::text,renewal_fee->>'version']||case when t ? 'purchaseConsentVersion' then array[t->>'purchaseConsentVersion'] else array[]::text[] end||case when t ? 'serviceMonths' then array[(t->>'serviceMonths')::numeric::integer::text] else array[]::text[] end);
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
  if r.terms ? 'serviceMonths' then
    perform public.fixed_service_end_v1(anchor+86400,(r.terms->>'serviceMonths')::integer);
    params:=jsonb_set(params,'{custom_text,submit,message}',to_jsonb(description||' '||
      public.fixed_service_description_v1((r.terms->>'serviceMonths')::integer)||' This is a fixed-price purchase, not a cancel-anytime membership. I agree to pay the full price on the schedule shown and authorize use of my saved card for those installments. Ending automatic debits or stopping use does not by itself erase the unpaid balance. The payment schedule does not set the service duration. Refund rights and rights provided by law still apply.'));
  end if;
  insert into public.exact_context_checkout_attempts_v2(id,reservation_id,claimed_at,request,idempotency_key)
    values(step_id,r.id,at_time,jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/checkout/sessions','params',params),
      'cn-exact-v2-checkout:'||step_id::text||':'||op.context_hash||':'||op.terms_hash);
  return public.read_exact_context_checkout_v2(r.id,p_actor_id,p_context)||jsonb_build_object('claimed',true);
end;
$$;

create or replace function public.credit_exact_context_first_payment_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype;
  receipt public.exact_context_first_receipts_v2%rowtype; link public.exact_context_accounting_links_v2%rowtype;
  a public.exact_installment_agreements%rowtype; b public.bookings%rowtype;
  op public.exact_installment_context_customer_operations_v2%rowtype;
  customer_id text; sub_id text; payment_id uuid; purchase_id uuid; ledger_id uuid; platform bigint; credited boolean;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Context credit requires READ COMMITTED'; end if;
  select * into op from public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'first_credit');
  -- Compare the exact nine fresh server-verified fields to saved evidence.
  perform public.record_exact_context_first_receipt_v2(p_reservation_id,p_actor_id,p_context,p_receipt);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into receipt from public.exact_context_first_receipts_v2 where reservation_id=r.id;
  select binding.customer_id into customer_id from public.exact_context_customer_bindings_v2 binding where binding.operation_id=op.id;
  select binding.provider_id into sub_id from public.exact_context_held_results_v2 binding
    join public.exact_context_held_steps_v2 attempt on attempt.id=binding.step_id
    where attempt.reservation_id=r.id and attempt.stage='subscription';
  if customer_id is null or sub_id is null then raise exception 'Context provider bindings missing'; end if;
  select * into link from public.exact_context_accounting_links_v2 where reservation_id=r.id;
  if found then
    select * into a from public.exact_installment_agreements where id=link.agreement_id for update;
  else
    -- New admission shares 058's booking lock. A competing committed bridge is
    -- reconciled on a new call, never by acquiring the reversed existing lock.
    select * into b from public.bookings where id=r.booking_id for update;
    if not found or b.status is distinct from 'booked' or b.creator_id is distinct from p_actor_id or
      b.buyer_id::text is distinct from r.terms->>'buyerId' or b.post_id::text is distinct from r.terms->>'postId' then
      raise exception 'Context credit booking changed'; end if;
    if exists(select 1 from public.exact_context_accounting_links_v2 where reservation_id=r.id) then
      raise exception 'Context accounting changed; reconcile existing link'; end if;
    if exists(select 1 from public.booking_payments where booking_id=r.booking_id) or
      exists(select 1 from public.exact_installment_agreements where id=r.id or terms->>'bookingId'=r.booking_id::text) or
      exists(select 1 from public.exact_installment_receipts where stripe_payment_intent_id=receipt.payment_intent_id) or
      exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=receipt.payment_intent_id) or
      exists(select 1 from public.purchases where buyer_id=b.buyer_id and
        (post_id=b.post_id or product_id=(r.terms->>'productId')::uuid)) then
      raise exception 'Existing financial evidence cannot be adopted by context credit'; end if;
    payment_id:=gen_random_uuid(); platform:=round(receipt.amount_cents::numeric*1200/10000)::bigint;
    insert into public.exact_context_accounting_links_v2(reservation_id,agreement_id,booking_payment_id) values(r.id,r.id,payment_id);
    insert into public.booking_payments(id,booking_id,product_id,buyer_id,closer_user_id,plan_type,status,currency,
      installment_months,amount_total_cents,installment_amount_cents,platform_fee_cents,processing_fee_cents,
      total_creator_deduction_cents,creator_net_cents,fee_schedule_version,installment_collection_version)
      values(payment_id,r.booking_id,(r.terms->>'productId')::uuid,(r.terms->>'buyerId')::uuid,p_actor_id,'installment','pending','usd',
        (r.terms->>'paymentCount')::integer,(r.terms->>'totalCents')::bigint,receipt.amount_cents,platform,receipt.application_fee_cents-platform,
        receipt.application_fee_cents,receipt.amount_cents-receipt.application_fee_cents,r.terms#>>'{firstPaymentFeeSchedule,version}','exact-cents-context-v2');
    -- Keep the real v2 version; never fabricate v1 terms or a Preview origin.
    insert into public.exact_installment_agreements(id,booking_payment_id,terms,status,stripe_customer_id,stripe_subscription_id,
      stripe_checkout_session_id,created_at)
      values(r.id,payment_id,r.terms||jsonb_build_object('bookingPaymentId',payment_id),'awaiting_first',customer_id,sub_id,receipt.session_id,r.created_at)
      returning * into a;
    purchase_id:=public.seed_exact_installment_purchase(a.id);
    perform public.record_exact_installment_first_receipt(a.id,receipt.session_id,receipt.payment_intent_id,receipt.amount_cents,
      receipt.application_fee_cents,to_timestamp(receipt.paid_at));
    select * into link from public.exact_context_accounting_links_v2 where reservation_id=r.id;
  end if;
  if a.id is null or a.id is distinct from r.id or a.booking_payment_id is distinct from link.booking_payment_id or
    a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',link.booking_payment_id) or
    a.stripe_checkout_session_id is distinct from receipt.session_id or
    a.stripe_customer_id is distinct from customer_id or a.stripe_subscription_id is distinct from sub_id or
    exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id) or
    not exists(select 1 from public.exact_installment_receipts where agreement_id=a.id and payment_number=1 and
      stripe_payment_intent_id=receipt.payment_intent_id and amount_cents=receipt.amount_cents and
      application_fee_cents=receipt.application_fee_cents and paid_at=to_timestamp(receipt.paid_at)) then
    raise exception 'Context accounting identity or collection hold requires review'; end if;
  if r.terms ? 'serviceMonths' then perform public.bind_fixed_service_context_v1(a.id); end if;
  -- Monotonic refund evidence is shared with the existing refund path. Never
  -- replace a positive observed refund with zero merely because a read was old.
  if public.record_payment_refund_state(receipt.payment_intent_id,receipt.charge_id,receipt.amount_cents,0)<>0 then
    raise exception 'Context payment has a refund; credit requires review'; end if;
  credited:=public.credit_exact_installment_receipt(a.id,1,receipt.charge_id,receipt.balance_transaction_id,receipt.actual_stripe_fee_cents);
  perform public.reconcile_exact_installment_dispute_audit(receipt.payment_intent_id);
  perform public.fulfill_exact_installment_first_payment(a.id);
  select ag.purchase_id into purchase_id from public.exact_installment_agreements ag where ag.id=a.id;
  select rec.ledger_id into ledger_id from public.exact_installment_receipts rec where rec.agreement_id=a.id and rec.payment_number=1;
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=r.id;
  return jsonb_build_object('reservation_id',r.id,'agreement_id',a.id,'purchase_id',purchase_id,'ledger_id',ledger_id,
    'credited',credited,'first_payment_fulfilled',true);
end;
$$;

create or replace function public.assert_exact_installment_activation_ready(p_agreement_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  r public.exact_installment_receipts%rowtype;
  l public.payment_fee_ledger%rowtype;
  p public.purchases%rowtype;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status <> 'awaiting_first' or a.purchase_id is null then raise exception 'activation agreement not ready'; end if;
  select * into r from public.exact_installment_receipts where agreement_id=a.id and payment_number=1;
  if not found or r.counted_at is null or r.ledger_id is null or r.paid_at > now() then
    raise exception 'credited first receipt required'; end if;
  select * into l from public.payment_fee_ledger where id=r.ledger_id for update;
  if not found or l.purchase_id is distinct from a.purchase_id or
     l.creator_id::text is distinct from a.terms->>'creatorId' or l.booking_payment_id is distinct from a.booking_payment_id or
     l.stripe_payment_intent_id is distinct from r.stripe_payment_intent_id or l.earnings_credited_at is null or
     l.status <> 'paid' or l.refunded_amount_cents <> 0 or l.earnings_reversed_cents <> 0 or
     (l.dispute_status is not null and l.dispute_status <> 'won') then raise exception 'first ledger requires review'; end if;
  select * into p from public.purchases where id=a.purchase_id for update;
  if not found or p.status <> 'active' or not public.fixed_purchase_financial_access_v1(p.id) or p.paid_count <> 1 or
     p.subscription_id is distinct from a.stripe_subscription_id or
     p.session_id is distinct from a.stripe_checkout_session_id or p.creator_id::text is distinct from a.terms->>'creatorId' or
     p.buyer_id::text is distinct from a.terms->>'buyerId' or p.post_id::text is distinct from a.terms->>'postId' or
     p.product_id::text is distinct from a.terms->>'productId' or p.booking_id::text is distinct from a.terms->>'bookingId' or
     p.target_months is distinct from (a.terms->>'paymentCount')::integer or
     p.payment_intent_id is distinct from r.stripe_payment_intent_id then raise exception 'activation purchase not ready'; end if;
  if not exists (select 1 from public.bookings where id=(a.terms->>'bookingId')::uuid and
       buyer_id::text=a.terms->>'buyerId' and creator_id::text=a.terms->>'creatorId' and post_id::text=a.terms->>'postId' and
       status::text in ('booked','completed')) or
     not exists (select 1 from public.booking_payments where id=a.booking_payment_id and
       booking_id::text=a.terms->>'bookingId' and buyer_id::text=a.terms->>'buyerId' and product_id::text=a.terms->>'productId' and
       status::text in ('pending','link_sent','completed')) or
     exists (select 1 from public.payment_refund_state where stripe_payment_intent_id=r.stripe_payment_intent_id and refunded_amount_cents>0) or
     exists (select 1 from public.payment_dispute_state where stripe_payment_intent_id=r.stripe_payment_intent_id and status<>'won') or
     exists (select 1 from public.refund_operations where stripe_payment_intent_id=r.stripe_payment_intent_id and
       (status<>'failed' or stripe_refund_id is not null)) then raise exception 'activation reconciliation required'; end if;
end;
$$;

create or replace function public.assert_exact_installment_renewal_ready(p_agreement_id uuid,p_number integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  p public.purchases%rowtype;
  period public.exact_installment_periods%rowtype;
  n integer;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status<>'active' or a.purchase_id is null then raise exception 'renewal agreement not active'; end if;
  if exists(select 1 from public.exact_installment_collection_holds where agreement_id=p_agreement_id) then
    raise exception 'installment collection is held for review'; end if;
  select * into period from public.exact_installment_periods
    where agreement_id=a.id and payment_number=p_number;
  if not found or extract(epoch from now())<period.due_at or extract(epoch from now())>=period.period_end then
    raise exception 'renewal is outside its authorized period'; end if;
  if not exists(select 1 from public.exact_installment_activations where agreement_id=a.id and status='complete') then
    raise exception 'activation not complete'; end if;
  perform 1 from public.payment_fee_ledger l join public.exact_installment_receipts r on r.ledger_id=l.id
    where r.agreement_id=a.id order by r.payment_number for update of l;
  select * into p from public.purchases where id=a.purchase_id for update;
  n:=(a.terms->>'paymentCount')::integer;
  if not found or p.status<>'active' or public.fixed_purchase_financial_access_v1(p.id) is distinct from true or
    p.paid_count is distinct from p_number-1 or p.target_months is distinct from n or
    p.subscription_id is distinct from a.stripe_subscription_id or p.session_id is distinct from a.stripe_checkout_session_id or
    p.buyer_id::text is distinct from a.terms->>'buyerId' or p.creator_id::text is distinct from a.terms->>'creatorId' or
    p.booking_id::text is distinct from a.terms->>'bookingId' or p.post_id::text is distinct from a.terms->>'postId' or
    p.product_id::text is distinct from a.terms->>'productId' or lower(p.currency) is distinct from 'usd' then
    raise exception 'renewal purchase not ready'; end if;
  if (select count(*) from public.exact_installment_receipts where agreement_id=a.id and counted_at is not null)<>p_number-1 or
    (select count(*) from public.exact_installment_receipts r join public.payment_fee_ledger l on l.id=r.ledger_id
      where r.agreement_id=a.id and r.payment_number<p_number and r.counted_at is not null and
        l.earnings_credited_at is not null and l.purchase_id=a.purchase_id and
        l.creator_id::text=a.terms->>'creatorId' and l.booking_payment_id=a.booking_payment_id and
        l.stripe_payment_intent_id=r.stripe_payment_intent_id and l.status='paid' and
        l.refunded_amount_cents=0 and l.earnings_reversed_cents=0 and
        (l.dispute_status is null or l.dispute_status='won'))<>p_number-1 then
    raise exception 'prior receipts or ledgers require review'; end if;
  if exists(select 1 from public.exact_installment_receipts r where r.agreement_id=a.id and (
    exists(select 1 from public.payment_refund_state f where f.stripe_payment_intent_id=r.stripe_payment_intent_id and f.refunded_amount_cents>0) or
    exists(select 1 from public.payment_dispute_state d where d.stripe_payment_intent_id=r.stripe_payment_intent_id and d.status<>'won') or
    exists(select 1 from public.refund_operations o where o.stripe_payment_intent_id=r.stripe_payment_intent_id and
      (o.status<>'failed' or o.stripe_refund_id is not null)))) or
    not exists(select 1 from public.bookings where id=(a.terms->>'bookingId')::uuid and
      buyer_id=p.buyer_id and creator_id=p.creator_id and post_id=p.post_id and status::text in ('booked','completed')) or
    not exists(select 1 from public.booking_payments where id=a.booking_payment_id and
      booking_id=p.booking_id and buyer_id=p.buyer_id and product_id=p.product_id and status::text in ('pending','link_sent','completed')) then
    raise exception 'renewal reconciliation required'; end if;
end;
$$;

create or replace function public.fulfill_exact_installment_first_payment(p_agreement_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  p public.purchases%rowtype;
  r public.exact_installment_receipts%rowtype;
  l public.payment_fee_ledger%rowtype;
  bp public.booking_payments%rowtype;
  b public.bookings%rowtype;
  product public.products%rowtype;
  delivery_kind text;
  delivery_url text;
begin
  perform public.guard_exact_context_sql_entry_v2(p_agreement_id,'fulfill_exact_installment_first_payment');
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status not in ('awaiting_first','active','complete') or a.purchase_seeded_at is null then
    raise exception 'exact purchase not ready for delivery';
  end if;
  select * into r from public.exact_installment_receipts where agreement_id=a.id and payment_number=1;
  select * into l from public.payment_fee_ledger where id=r.ledger_id for update;
  select * into p from public.purchases where id=a.purchase_id for update;
  if p.id is null or r.counted_at is null or l.id is null or l.earnings_credited_at is null or
     l.purchase_id is distinct from p.id or l.booking_payment_id is distinct from a.booking_payment_id or
     l.stripe_payment_intent_id is distinct from r.stripe_payment_intent_id or
     p.status not in ('active','complete') or not public.fixed_purchase_financial_access_v1(p.id) or coalesce(p.paid_count,0)<1 or
     p.paid_count>(a.terms->>'paymentCount')::integer or
     p.target_months is distinct from (a.terms->>'paymentCount')::integer or lower(p.currency) is distinct from 'usd' or
     p.is_refund or p.is_suspect or l.status is distinct from 'paid' or
     (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')) or
     coalesce(l.refunded_amount_cents,0)>0 or coalesce(l.earnings_reversed_cents,0)>0 or
     p.session_id is distinct from a.stripe_checkout_session_id or
     p.subscription_id is distinct from a.stripe_subscription_id or
     p.buyer_id::text is distinct from a.terms->>'buyerId' or
     p.creator_id::text is distinct from a.terms->>'creatorId' or
     p.post_id::text is distinct from a.terms->>'postId' or
     p.product_id::text is distinct from a.terms->>'productId' or
     p.booking_id::text is distinct from a.terms->>'bookingId' or
     exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=r.stripe_payment_intent_id and refunded_amount_cents>0) or
     exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=r.stripe_payment_intent_id and status not in ('won','warning_closed')) or
     exists(select 1 from public.refund_operations where stripe_payment_intent_id=r.stripe_payment_intent_id and status not in ('failed','completed')) then
    raise exception 'verified unrefunded first credit required for delivery';
  end if;
  select * into bp from public.booking_payments where id=a.booking_payment_id for update;
  select * into b from public.bookings where id=(a.terms->>'bookingId')::uuid for update;
  if bp.id is null or b.id is null or bp.booking_id<>b.id or
     bp.status::text not in ('pending','link_sent','completed') or b.status not in ('booked','completed') or
     bp.stripe_checkout_session_id is distinct from a.stripe_checkout_session_id or
     bp.stripe_subscription_id is distinct from a.stripe_subscription_id or
     b.buyer_id is distinct from p.buyer_id or b.creator_id is distinct from p.creator_id or b.post_id is distinct from p.post_id then
    raise exception 'booking no longer eligible for completion';
  end if;
  if a.first_fulfilled_at is not null then return; end if;
  select * into product from public.products where id=p.product_id;
  if not found or product.creator_id is distinct from p.creator_id then raise exception 'delivery product mismatch'; end if;
  delivery_url := coalesce(nullif(trim(product.discord_invite_url),''),nullif(trim(product.whop_listing_url),''));
  delivery_kind := case when nullif(trim(product.discord_invite_url),'') is not null then 'discord'
    when nullif(trim(product.whop_listing_url),'') is not null then 'whop' else null end;
  if delivery_url is not null and delivery_url !~ '^https://[^[:space:]/?#]+(/[^[:space:]]*)?$' then
    raise exception 'delivery URL requires review';
  end if;
  if p.fulfillment_url is not null or p.fulfillment is not null or p.fulfillment_payload is not null then
    raise exception 'unexpected preexisting delivery; do not overwrite';
  end if;
  -- A native video has no external URL; its existing access-controlled player
  -- uses this same purchase/access grant. No fabricated invite is substituted.
  update public.purchases set fulfillment=delivery_kind,fulfillment_url=delivery_url,
    fulfillment_payload=case when delivery_url is not null then jsonb_build_object('source','product',
      'product_id',product.product_id,'title',product.title,'note','creator-supplied fulfillment link') else null end,
    paid_at=coalesce(paid_at,r.paid_at) where id=p.id;
  update public.booking_payments set status='completed',completed_at=coalesce(completed_at,r.paid_at),
    stripe_payment_intent_id=r.stripe_payment_intent_id,updated_at=now() where id=bp.id;
  update public.bookings set status='completed' where id=b.id;
  update public.exact_installment_agreements set first_fulfilled_at=now(),updated_at=now() where id=a.id;
end;
$$;
do $permissions$
declare signature text; oid_value oid; role_name text;
begin
  foreach signature in array array['public.fixed_service_end_v1(bigint,integer)',
    'public.fixed_service_description_v1(integer)',
    'public.guard_fixed_service_product_v1()',
    'public.guard_fixed_service_contract_v1()',
    'public.bind_fixed_service_context_v1(uuid)',
    'public.mask_fixed_service_access_v1()',
    'public.fixed_purchase_financial_access_v1(uuid)',
    'public.guard_fixed_service_one_time_v1()',
    'public.read_fixed_service_entitlement_v1(uuid,uuid)',
    'public.reserve_exact_installment_context_v2(uuid,uuid,integer,jsonb,jsonb,jsonb)',
    'public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)',
    'public.claim_exact_context_checkout_v2(uuid,uuid,jsonb)',
    'public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb)',
    'public.assert_exact_installment_activation_ready(uuid)',
    'public.assert_exact_installment_renewal_ready(uuid,integer)',
    'public.fulfill_exact_installment_first_payment(uuid)'] loop
    oid_value:=to_regprocedure(signature);
    if oid_value is null then raise exception 'Fixed service function missing'; end if;
    execute format('revoke all on function %s from public,anon,authenticated,service_role',oid_value::regprocedure);
  end loop;
  foreach signature in array array['public.read_fixed_service_entitlement_v1(uuid,uuid)',
    'public.reserve_exact_installment_context_v2(uuid,uuid,integer,jsonb,jsonb,jsonb)',
    'public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)',
    'public.claim_exact_context_checkout_v2(uuid,uuid,jsonb)',
    'public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb)',
    'public.assert_exact_installment_activation_ready(uuid)',
    'public.assert_exact_installment_renewal_ready(uuid,integer)',
    'public.fulfill_exact_installment_first_payment(uuid)'] loop
    oid_value:=to_regprocedure(signature);
    execute format('grant execute on function %s to service_role',oid_value::regprocedure);
    if has_function_privilege('anon',oid_value,'EXECUTE') or has_function_privilege('authenticated',oid_value,'EXECUTE') then
      raise exception 'Fixed service function is exposed'; end if;
  end loop;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.fixed_purchase_service_contracts_v1','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or
      exists(select 1 from pg_attribute where attrelid='public.fixed_purchase_service_contracts_v1'::regclass and attnum>0 and not attisdropped and
        (has_column_privilege(role_name,attrelid,attnum,'SELECT') or has_column_privilege(role_name,attrelid,attnum,'INSERT') or
         has_column_privilege(role_name,attrelid,attnum,'UPDATE') or has_column_privilege(role_name,attrelid,attnum,'REFERENCES'))) then
      raise exception 'Fixed service contract ACL differs'; end if;
  end loop;
end;
$permissions$;
commit;
