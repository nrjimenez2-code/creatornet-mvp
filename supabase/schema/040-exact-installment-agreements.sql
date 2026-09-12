begin;

-- Prospective exact-cents-held-v1 only. This adds private coordination records;
-- it does not migrate old purchases, change earnings RPCs or enable collection.
create table public.exact_installment_agreements (
  id uuid primary key,
  booking_payment_id uuid not null unique references public.booking_payments(id) on delete restrict,
  terms jsonb not null check (jsonb_typeof(terms) = 'object'),
  status text not null default 'preparing'
    check (status in ('preparing', 'awaiting_first', 'active', 'complete', 'canceled', 'review_required')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_checkout_session_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.exact_installment_operations (
  agreement_id uuid not null references public.exact_installment_agreements(id) on delete restrict,
  step text not null check (step in ('customer', 'product', 'subscription', 'hold', 'checkout')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('running', 'complete')),
  claim_token uuid not null,
  lease_until timestamptz not null,
  first_started_at timestamptz not null default now(),
  result_id text,
  primary key (agreement_id, step),
  check ((status = 'complete') = (result_id is not null))
);

create table public.exact_installment_receipts (
  agreement_id uuid not null references public.exact_installment_agreements(id) on delete restrict,
  payment_number integer not null check (payment_number between 1 and 24),
  stripe_payment_intent_id text not null unique,
  stripe_invoice_id text unique,
  amount_cents bigint not null check (amount_cents between 50 and 99999999),
  application_fee_cents bigint not null check (application_fee_cents >= 0 and application_fee_cents <= amount_cents),
  paid_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (agreement_id, payment_number),
  check ((payment_number = 1 and stripe_invoice_id is null) or
         (payment_number > 1 and stripe_invoice_id is not null))
);

-- No client policies and no direct service-role INSERT/UPDATE/DELETE grants:
-- every state mutation below passes through a locked, narrow RPC.
alter table public.exact_installment_agreements enable row level security;
alter table public.exact_installment_operations enable row level security;
alter table public.exact_installment_receipts enable row level security;
revoke all on public.exact_installment_agreements, public.exact_installment_operations,
  public.exact_installment_receipts from public, anon, authenticated, service_role;
grant select on public.exact_installment_agreements, public.exact_installment_operations,
  public.exact_installment_receipts to service_role;

create function public.create_exact_installment_agreement(p_id uuid, p_booking_payment_id uuid,
  p_actor_id uuid, p_terms jsonb)
returns public.exact_installment_agreements
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  bp public.booking_payments%rowtype;
  b public.bookings%rowtype;
  a public.exact_installment_agreements%rowtype;
  n integer;
  gross bigint;
  schedule jsonb;
  scheduled_amount bigint;
  deduction bigint;
begin
  select * into bp from public.booking_payments where id = p_booking_payment_id for update;
  if not found then raise exception 'booking payment missing'; end if;
  select * into b from public.bookings where id = bp.booking_id for update;
  if not found or b.creator_id is distinct from p_actor_id then raise exception 'creator ownership required'; end if;
  if bp.plan_type::text <> 'installment' or bp.status::text not in ('pending', 'link_sent') or
     b.status = 'completed' then raise exception 'booking payment not eligible'; end if;
  if jsonb_typeof(p_terms) is distinct from 'object' or
     p_terms->>'version' is distinct from 'exact-cents-held-v1' or
     p_terms->>'currency' is distinct from 'usd' or lower(bp.currency) <> 'usd' or
     p_terms->>'bookingPaymentId' is distinct from bp.id::text or
     p_terms->>'bookingId' is distinct from b.id::text or
     p_terms->>'buyerId' is distinct from b.buyer_id::text or
     bp.buyer_id is distinct from b.buyer_id or
     p_terms->>'creatorId' is distinct from b.creator_id::text or
     p_terms->>'postId' is distinct from b.post_id::text or
     p_terms->>'productId' is distinct from bp.product_id::text then
    raise exception 'agreement identity mismatch';
  end if;
  if jsonb_typeof(p_terms->'title') is distinct from 'string' or
     coalesce(length(trim(p_terms->>'title')), 0) not between 1 and 200 or
     jsonb_typeof(p_terms->'previewOrigin') is distinct from 'string' or
     coalesce(p_terms->>'previewOrigin', '') !~ '^https://[a-z0-9-]+\.vercel\.app$' or
     jsonb_typeof(p_terms->'paymentCount') is distinct from 'number' or
     jsonb_typeof(p_terms->'totalCents') is distinct from 'number' then
    raise exception 'invalid agreement presentation/amount snapshot';
  end if;
  n := (p_terms->>'paymentCount')::integer;
  gross := (p_terms->>'totalCents')::bigint;
  if n is null or n not between 2 and 24 or n is distinct from bp.installment_months or
     gross is null or gross is distinct from bp.amount_total_cents or gross / n < 50 or
     gross / n + gross % n > 99999999 then raise exception 'invalid agreed amounts'; end if;
  foreach schedule in array array[p_terms->'firstPaymentFeeSchedule', p_terms->'renewalFeeSchedule'] loop
    if jsonb_typeof(schedule) is distinct from 'object' or
       jsonb_typeof(schedule->'enabled') is distinct from 'boolean' or
       jsonb_typeof(schedule->'basisPoints') is distinct from 'number' or
       jsonb_typeof(schedule->'fixedCents') is distinct from 'number' or
       jsonb_typeof(schedule->'version') is distinct from 'string' or
       coalesce(schedule->>'basisPoints', '') !~ '^\d+$' or
       coalesce(schedule->>'fixedCents', '') !~ '^\d+$' or
       (schedule->>'basisPoints')::bigint not between 0 and 10000 or
       (schedule->>'fixedCents')::bigint not between 0 and 99999999 or
       coalesce(length(trim(schedule->>'version')), 0) = 0 then
      raise exception 'invalid fee snapshot';
    end if;
    foreach scheduled_amount in array array[gross / n, gross / n + gross % n] loop
      deduction := round(scheduled_amount::numeric * 1200 / 10000)::bigint;
      if (schedule->>'enabled')::boolean then
        deduction := deduction + round(scheduled_amount::numeric * (schedule->>'basisPoints')::integer / 10000)::bigint
          + (schedule->>'fixedCents')::bigint;
      end if;
      if deduction > scheduled_amount then raise exception 'fee exceeds installment'; end if;
    end loop;
  end loop;
  if not exists (select 1 from public.profiles where id = b.creator_id and
      stripe_account_id = p_terms->>'destinationId' and stripe_onboarding_complete = true) then
    raise exception 'creator destination mismatch';
  end if;
  select * into a from public.exact_installment_agreements where booking_payment_id = bp.id;
  if found then
    if a.terms is distinct from p_terms then raise exception 'existing agreement terms differ'; end if;
    return a;
  end if;
  if bp.stripe_checkout_session_id is not null or bp.stripe_subscription_id is not null or
     bp.link_url is not null then raise exception 'cannot convert an existing payment link'; end if;
  insert into public.exact_installment_agreements(id, booking_payment_id, terms)
  values (p_id, bp.id, p_terms) returning * into a;
  return a;
end;
$$;

create function public.claim_exact_installment_operation(p_agreement_id uuid, p_step text,
  p_request_hash text, p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  op public.exact_installment_operations%rowtype;
begin
  select * into a from public.exact_installment_agreements where id = p_agreement_id for update;
  if not found or a.status <> 'preparing' then raise exception 'agreement not preparing'; end if;
  if p_step not in ('customer', 'product', 'subscription', 'hold', 'checkout') or
     p_step is null or p_claim_token is null or p_request_hash is null or
     p_request_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid operation claim'; end if;
  select * into op from public.exact_installment_operations
    where agreement_id = a.id and step = p_step for update;
  if found then
    if op.request_hash <> p_request_hash then raise exception 'operation parameters changed'; end if;
    if op.status = 'complete' then
      return jsonb_build_object('status', 'complete', 'resultId', op.result_id);
    end if;
    -- Stripe can prune idempotency keys after 24 hours. An ambiguous operation
    -- older than 20 hours needs reconciliation, never a fresh create request.
    if now() >= op.first_started_at + interval '20 hours' then
      update public.exact_installment_agreements set status = 'review_required', updated_at = now() where id = a.id;
      return jsonb_build_object('status', 'review_required');
    end if;
    if op.lease_until > now() then return jsonb_build_object('status', 'busy'); end if;
    update public.exact_installment_operations set claim_token = p_claim_token,
      lease_until = now() + interval '3 minutes'
      where agreement_id = a.id and step = p_step;
  else
    insert into public.exact_installment_operations
      (agreement_id, step, request_hash, status, claim_token, lease_until)
      values (a.id, p_step, p_request_hash, 'running', p_claim_token, now() + interval '3 minutes');
  end if;
  return jsonb_build_object('status', 'new');
end;
$$;

create function public.complete_exact_installment_operation(p_agreement_id uuid, p_step text,
  p_claim_token uuid, p_result_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from public.exact_installment_agreements where id = p_agreement_id and status = 'preparing' for update;
  if not found then raise exception 'agreement not preparing'; end if;
  if p_result_id is null or p_result_id !~ '^[a-zA-Z0-9_]{1,100}$' then raise exception 'invalid Stripe result id'; end if;
  update public.exact_installment_operations set status = 'complete', result_id = p_result_id
  where agreement_id = p_agreement_id and step = p_step and status = 'running'
    and claim_token = p_claim_token and lease_until > now();
  if not found then raise exception 'operation claim lost'; end if;
end;
$$;

create function public.bind_exact_installment_checkout(p_agreement_id uuid, p_customer_id text,
  p_subscription_id text, p_session_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.exact_installment_agreements%rowtype;
begin
  select * into a from public.exact_installment_agreements where id = p_agreement_id for update;
  if not found then raise exception 'agreement missing'; end if;
  if a.status = 'awaiting_first' and a.stripe_customer_id = p_customer_id and
     a.stripe_subscription_id = p_subscription_id and a.stripe_checkout_session_id = p_session_id then return; end if;
  if a.status <> 'preparing' or p_customer_id is null or p_subscription_id is null or p_session_id is null or
     not exists (select 1 from public.exact_installment_operations where agreement_id = a.id and step = 'customer' and status = 'complete' and result_id = p_customer_id) or
     not exists (select 1 from public.exact_installment_operations where agreement_id = a.id and step = 'product' and status = 'complete') or
     not exists (select 1 from public.exact_installment_operations where agreement_id = a.id and step = 'subscription' and status = 'complete' and result_id = p_subscription_id) or
     not exists (select 1 from public.exact_installment_operations where agreement_id = a.id and step = 'hold' and status = 'complete' and result_id = p_subscription_id) or
     not exists (select 1 from public.exact_installment_operations where agreement_id = a.id and step = 'checkout' and status = 'complete' and result_id = p_session_id) then
    raise exception 'bootstrap operations incomplete';
  end if;
  update public.exact_installment_agreements set stripe_customer_id = p_customer_id,
    stripe_subscription_id = p_subscription_id, stripe_checkout_session_id = p_session_id,
    status = 'awaiting_first', updated_at = now() where id = a.id;
end;
$$;

-- Receipt identity only: NO earnings, paid_count, access or fulfillment writes.
-- Call only after retrieving/verifying the actual successful Stripe objects.
-- Until activation/fulfillment is integrated this accepts the first receipt only.
create function public.record_exact_installment_first_receipt(p_agreement_id uuid,
  p_session_id text, p_payment_intent_id text, p_amount_cents bigint,
  p_application_fee_cents bigint, p_paid_at timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  r public.exact_installment_receipts%rowtype;
  gross bigint;
  expected_fee bigint;
  schedule jsonb;
begin
  select * into a from public.exact_installment_agreements where id = p_agreement_id for update;
  if not found or a.status not in ('awaiting_first', 'active', 'complete') or
     a.stripe_checkout_session_id is distinct from p_session_id then raise exception 'agreement/session mismatch'; end if;
  gross := (a.terms->>'totalCents')::bigint / (a.terms->>'paymentCount')::integer;
  schedule := a.terms->'firstPaymentFeeSchedule';
  if jsonb_typeof(schedule) is distinct from 'object' or jsonb_typeof(schedule->'enabled') is distinct from 'boolean' then
    raise exception 'fee snapshot missing';
  end if;
  expected_fee := round(gross::numeric * 1200 / 10000)::bigint;
  if (schedule->>'enabled')::boolean then
    if schedule->>'basisPoints' is null or schedule->>'fixedCents' is null then raise exception 'fee snapshot incomplete'; end if;
    expected_fee := expected_fee + round(gross::numeric * (schedule->>'basisPoints')::integer / 10000)::bigint
      + (schedule->>'fixedCents')::bigint;
  end if;
  if p_amount_cents is distinct from gross or p_application_fee_cents is distinct from expected_fee or
     p_paid_at is null or p_paid_at < date_trunc('second', a.created_at) or p_payment_intent_id is null or
     p_payment_intent_id !~ '^pi_[a-zA-Z0-9]+$' then raise exception 'receipt does not match agreement'; end if;
  select * into r from public.exact_installment_receipts where agreement_id = a.id and payment_number = 1;
  if found then
    if r.stripe_payment_intent_id is distinct from p_payment_intent_id or
       r.amount_cents is distinct from p_amount_cents or r.application_fee_cents is distinct from p_application_fee_cents or
       r.paid_at is distinct from p_paid_at then raise exception 'conflicting first receipt'; end if;
    return false;
  end if;
  insert into public.exact_installment_receipts(agreement_id, payment_number, stripe_payment_intent_id,
    amount_cents, application_fee_cents, paid_at)
    values (a.id, 1, p_payment_intent_id, p_amount_cents, p_application_fee_cents, p_paid_at);
  return true;
end;
$$;

revoke all on function public.create_exact_installment_agreement(uuid, uuid, uuid, jsonb),
  public.claim_exact_installment_operation(uuid, text, text, uuid),
  public.complete_exact_installment_operation(uuid, text, uuid, text),
  public.bind_exact_installment_checkout(uuid, text, text, text),
  public.record_exact_installment_first_receipt(uuid, text, text, bigint, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_exact_installment_agreement(uuid, uuid, uuid, jsonb),
  public.claim_exact_installment_operation(uuid, text, text, uuid),
  public.complete_exact_installment_operation(uuid, text, uuid, text),
  public.bind_exact_installment_checkout(uuid, text, text, text),
  public.record_exact_installment_first_receipt(uuid, text, text, bigint, bigint, timestamptz)
  to service_role;

commit;
