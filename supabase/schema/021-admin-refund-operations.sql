-- 021 — durable, admin-controlled customer refunds and fee allocation.
--
-- Apply after 019 and 020, before deploying the matching application code.
-- Stripe remains the authority for external refund state; this table reserves
-- cumulative amounts, records responsibility, and makes interrupted multi-step
-- refunds safe to resume without creating duplicate Stripe objects.

begin;

create table if not exists public.refund_operations (
  id uuid primary key,
  payment_fee_ledger_id uuid not null
    references public.payment_fee_ledger(id) on delete restrict,
  order_id uuid references public.orders(id) on delete set null,
  purchase_id uuid references public.purchases(id) on delete set null,
  booking_id uuid references public.bookings(id) on delete set null,
  booking_payment_id uuid references public.booking_payments(id) on delete set null,
  creator_id uuid not null references public.profiles(id) on delete restrict,

  stripe_payment_intent_id text not null,
  stripe_charge_id text not null,
  stripe_application_fee_id text not null,
  stripe_refund_id text,
  stripe_application_fee_refund_id text,

  requested_refund_amount_cents bigint not null,
  customer_refund_amount_cents bigint not null,
  currency text not null,
  reason_code text not null,
  responsibility text not null,

  gross_amount_cents bigint not null,
  platform_fee_cents bigint not null,
  processing_fee_cents bigint not null,
  creator_net_cents bigint not null,
  actual_stripe_processing_fee_cents bigint,

  refunded_before_cents bigint not null,
  cumulative_customer_refund_target_cents bigint not null,
  remaining_refundable_cents bigint not null,
  creator_earnings_reversal_cents bigint not null,
  creator_balance_impact_cents bigint not null,
  platform_fee_refund_amount_cents bigint not null,
  processing_fee_allocation_cents bigint not null,
  allocation_rounding_cents bigint not null,
  application_fee_refunded_before_cents bigint not null,
  application_fee_refund_amount_cents bigint not null,
  application_fee_refund_target_cents bigint not null,
  stripe_application_fee_refund_amount_cents bigint,

  idempotency_key text not null,
  initiated_by uuid not null references public.profiles(id) on delete restrict,
  internal_notes text,
  status text not null default 'pending',
  stripe_refund_status text,
  connected_balance_negative boolean,
  last_error text,
  reconciliation_info jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  processing_token uuid,
  processing_claimed_at timestamptz,
  webhook_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint refund_operations_reason_check check (
    reason_code in (
      'creator_non_delivery',
      'creator_missed_session',
      'material_misrepresentation',
      'creator_discretionary',
      'duplicate_charge',
      'platform_technical_error',
      'incorrect_platform_billing',
      'platform_goodwill',
      'legally_required'
    )
  ),
  constraint refund_operations_responsibility_check
    check (responsibility in ('creator', 'platform')),
  constraint refund_operations_reason_responsibility_check check (
    (reason_code in (
      'creator_non_delivery',
      'creator_missed_session',
      'material_misrepresentation',
      'creator_discretionary'
    ) and responsibility = 'creator')
    or
    (reason_code in (
      'duplicate_charge',
      'platform_technical_error',
      'incorrect_platform_billing',
      'platform_goodwill'
    ) and responsibility = 'platform')
    or reason_code = 'legally_required'
  ),
  constraint refund_operations_status_check check (
    status in (
      'pending',
      'stripe_refund_created',
      'application_fee_adjusted',
      'completed',
      'needs_reconciliation',
      'failed'
    )
  ),
  constraint refund_operations_currency_check
    check (currency ~ '^[a-z]{3}$'),
  constraint refund_operations_notes_check
    check (internal_notes is null or char_length(internal_notes) <= 2000),
  constraint refund_operations_amounts_check check (
    gross_amount_cents > 0 and
    platform_fee_cents >= 0 and
    processing_fee_cents >= 0 and
    creator_net_cents >= 0 and
    platform_fee_cents + processing_fee_cents + creator_net_cents = gross_amount_cents and
    requested_refund_amount_cents > 0 and
    customer_refund_amount_cents = requested_refund_amount_cents and
    refunded_before_cents >= 0 and
    cumulative_customer_refund_target_cents = refunded_before_cents + requested_refund_amount_cents and
    cumulative_customer_refund_target_cents <= gross_amount_cents and
    remaining_refundable_cents = gross_amount_cents - cumulative_customer_refund_target_cents and
    creator_earnings_reversal_cents >= 0 and
    creator_balance_impact_cents >= 0 and
    platform_fee_refund_amount_cents >= 0 and
    processing_fee_allocation_cents >= 0 and
    allocation_rounding_cents between -2 and 2 and
    application_fee_refunded_before_cents >= 0 and
    application_fee_refund_amount_cents >= 0 and
    application_fee_refund_target_cents =
      application_fee_refunded_before_cents + application_fee_refund_amount_cents and
    application_fee_refund_target_cents <= platform_fee_cents + processing_fee_cents and
    creator_balance_impact_cents =
      requested_refund_amount_cents - application_fee_refund_amount_cents and
    (actual_stripe_processing_fee_cents is null or actual_stripe_processing_fee_cents >= 0) and
    (stripe_application_fee_refund_amount_cents is null or stripe_application_fee_refund_amount_cents >= 0)
  )
);

create unique index if not exists refund_operations_idempotency_uidx
  on public.refund_operations(idempotency_key);
create unique index if not exists refund_operations_stripe_refund_uidx
  on public.refund_operations(stripe_refund_id)
  where stripe_refund_id is not null;
create unique index if not exists refund_operations_fee_refund_uidx
  on public.refund_operations(stripe_application_fee_refund_id)
  where stripe_application_fee_refund_id is not null;
create index if not exists refund_operations_ledger_created_idx
  on public.refund_operations(payment_fee_ledger_id, created_at desc);
create index if not exists refund_operations_status_updated_idx
  on public.refund_operations(status, updated_at);

comment on table public.refund_operations is
  'Server-only durable state for admin-approved Stripe refunds and application-fee allocation.';

alter table public.refund_operations enable row level security;
revoke all on table public.refund_operations from public, anon, authenticated;
grant select, insert, update, delete on table public.refund_operations to service_role;

-- Atomically reserve a cumulative refund amount while the immutable payment
-- ledger row is locked. The caller supplies current Stripe cumulative amounts;
-- existing operations provide the durable high-water mark for concurrent and
-- interrupted requests. Positive values use half-up integer-cent rounding,
-- matching PostgreSQL round(numeric).
create or replace function public.create_refund_operation(
  p_operation_id uuid,
  p_payment_fee_ledger_id uuid,
  p_requested_refund_amount_cents bigint,
  p_reason_code text,
  p_responsibility text,
  p_internal_notes text,
  p_idempotency_key text,
  p_initiated_by uuid,
  p_stripe_charge_id text,
  p_stripe_application_fee_id text,
  p_stripe_refunded_amount_cents bigint,
  p_stripe_application_fee_refunded_cents bigint,
  p_actual_stripe_processing_fee_cents bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.refund_operations%rowtype;
  v_ledger public.payment_fee_ledger%rowtype;
  v_booking_id uuid;
  v_previous_refunded bigint;
  v_new_refunded bigint;
  v_previous_app_fee_refunded bigint;
  v_total_fee_before bigint;
  v_total_fee_after bigint;
  v_platform_before bigint;
  v_platform_after bigint;
  v_platform_delta bigint;
  v_processing_before bigint;
  v_processing_after bigint;
  v_processing_delta bigint;
  v_creator_before bigint;
  v_creator_after bigint;
  v_creator_delta bigint;
  v_rounding bigint;
  v_app_fee_delta bigint;
  v_row public.refund_operations%rowtype;
begin
  if p_operation_id is null
     or p_payment_fee_ledger_id is null
     or p_initiated_by is null
     or p_requested_refund_amount_cents is null
     or p_requested_refund_amount_cents <= 0
     or p_idempotency_key is null
     or char_length(p_idempotency_key) < 8
     or char_length(p_idempotency_key) > 200
     or p_stripe_charge_id is null
     or p_stripe_application_fee_id is null
     or p_stripe_refunded_amount_cents is null
     or p_stripe_refunded_amount_cents < 0
     or p_stripe_application_fee_refunded_cents is null
     or p_stripe_application_fee_refunded_cents < 0 then
    raise exception 'invalid refund operation input';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_initiated_by and role = 'admin'
  ) then
    raise exception 'initiating user is not an administrator';
  end if;

  -- Serialize retries carrying the same browser-generated idempotency key.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  select * into v_existing
  from public.refund_operations
  where idempotency_key = p_idempotency_key;
  if found then
    return to_jsonb(v_existing);
  end if;

  select * into v_ledger
  from public.payment_fee_ledger
  where id = p_payment_fee_ledger_id
  for update;

  if not found then
    raise exception 'payment ledger row not found';
  end if;
  if v_ledger.status not in ('paid', 'refunded')
     or v_ledger.gross_amount_cents <= 0
     or v_ledger.stripe_payment_intent_id is null then
    raise exception 'payment is not refundable';
  end if;
  if v_ledger.platform_fee_cents
       + v_ledger.processing_fee_cents
       + v_ledger.creator_net_cents
       <> v_ledger.gross_amount_cents then
    raise exception 'immutable payment split is invalid';
  end if;
  if lower(v_ledger.currency) !~ '^[a-z]{3}$' then
    raise exception 'payment currency is invalid';
  end if;
  if p_stripe_refunded_amount_cents > v_ledger.gross_amount_cents then
    raise exception 'Stripe refunded amount exceeds payment gross';
  end if;
  if p_stripe_application_fee_refunded_cents
       > v_ledger.total_creator_deduction_cents then
    raise exception 'Stripe application-fee refund exceeds collected fee';
  end if;
  if p_internal_notes is not null and char_length(p_internal_notes) > 2000 then
    raise exception 'internal notes are too long';
  end if;

  if not (
    (p_reason_code in (
      'creator_non_delivery', 'creator_missed_session',
      'material_misrepresentation', 'creator_discretionary'
    ) and p_responsibility = 'creator')
    or
    (p_reason_code in (
      'duplicate_charge', 'platform_technical_error',
      'incorrect_platform_billing', 'platform_goodwill'
    ) and p_responsibility = 'platform')
    or
    (p_reason_code = 'legally_required' and p_responsibility in ('creator', 'platform'))
  ) then
    raise exception 'refund reason and responsibility do not match';
  end if;

  select greatest(
    coalesce(v_ledger.refunded_amount_cents, 0),
    p_stripe_refunded_amount_cents,
    coalesce(max(cumulative_customer_refund_target_cents), 0)
  ) into v_previous_refunded
  from public.refund_operations
  where payment_fee_ledger_id = p_payment_fee_ledger_id
    and status <> 'failed';

  v_new_refunded := v_previous_refunded + p_requested_refund_amount_cents;
  if v_new_refunded > v_ledger.gross_amount_cents then
    raise exception 'refund exceeds remaining refundable amount';
  end if;

  select greatest(
    p_stripe_application_fee_refunded_cents,
    coalesce(max(application_fee_refund_target_cents), 0)
  ) into v_previous_app_fee_refunded
  from public.refund_operations
  where payment_fee_ledger_id = p_payment_fee_ledger_id
    and status <> 'failed';

  -- First apportion the combined application fee against cumulative refunds,
  -- then split that monotonic target between processing and platform. This
  -- prevents a one-cent refund from independently rounding both components up.
  v_total_fee_before := round(
    v_ledger.total_creator_deduction_cents::numeric * v_previous_refunded::numeric
      / v_ledger.gross_amount_cents::numeric
  );
  v_total_fee_after := round(
    v_ledger.total_creator_deduction_cents::numeric * v_new_refunded::numeric
      / v_ledger.gross_amount_cents::numeric
  );
  if v_ledger.total_creator_deduction_cents = 0 then
    v_processing_before := 0;
    v_processing_after := 0;
  else
    v_processing_before := round(
      v_ledger.processing_fee_cents::numeric * v_total_fee_before::numeric
        / v_ledger.total_creator_deduction_cents::numeric
    );
    v_processing_after := round(
      v_ledger.processing_fee_cents::numeric * v_total_fee_after::numeric
        / v_ledger.total_creator_deduction_cents::numeric
    );
  end if;
  v_platform_before := v_total_fee_before - v_processing_before;
  v_platform_after := v_total_fee_after - v_processing_after;
  v_platform_delta := v_platform_after - v_platform_before;
  v_processing_delta := v_processing_after - v_processing_before;

  v_creator_before := round(
    v_ledger.creator_net_cents::numeric * v_previous_refunded::numeric
      / v_ledger.gross_amount_cents::numeric
  );
  v_creator_after := round(
    v_ledger.creator_net_cents::numeric * v_new_refunded::numeric
      / v_ledger.gross_amount_cents::numeric
  );
  v_creator_delta := v_creator_after - v_creator_before;
  v_rounding := p_requested_refund_amount_cents
    - v_platform_delta - v_processing_delta - v_creator_delta;

  v_app_fee_delta := v_platform_delta
    + case when p_responsibility = 'platform' then v_processing_delta else 0 end;

  if v_previous_app_fee_refunded + v_app_fee_delta
       > v_ledger.total_creator_deduction_cents then
    raise exception 'application-fee refund target exceeds collected fee';
  end if;

  if v_ledger.booking_payment_id is not null then
    select booking_id into v_booking_id
    from public.booking_payments
    where id = v_ledger.booking_payment_id;
  end if;

  insert into public.refund_operations (
    id,
    payment_fee_ledger_id,
    order_id,
    purchase_id,
    booking_id,
    booking_payment_id,
    creator_id,
    stripe_payment_intent_id,
    stripe_charge_id,
    stripe_application_fee_id,
    requested_refund_amount_cents,
    customer_refund_amount_cents,
    currency,
    reason_code,
    responsibility,
    gross_amount_cents,
    platform_fee_cents,
    processing_fee_cents,
    creator_net_cents,
    actual_stripe_processing_fee_cents,
    refunded_before_cents,
    cumulative_customer_refund_target_cents,
    remaining_refundable_cents,
    creator_earnings_reversal_cents,
    creator_balance_impact_cents,
    platform_fee_refund_amount_cents,
    processing_fee_allocation_cents,
    allocation_rounding_cents,
    application_fee_refunded_before_cents,
    application_fee_refund_amount_cents,
    application_fee_refund_target_cents,
    idempotency_key,
    initiated_by,
    internal_notes
  ) values (
    p_operation_id,
    v_ledger.id,
    v_ledger.order_id,
    v_ledger.purchase_id,
    v_booking_id,
    v_ledger.booking_payment_id,
    v_ledger.creator_id,
    v_ledger.stripe_payment_intent_id,
    p_stripe_charge_id,
    p_stripe_application_fee_id,
    p_requested_refund_amount_cents,
    p_requested_refund_amount_cents,
    lower(v_ledger.currency),
    p_reason_code,
    p_responsibility,
    v_ledger.gross_amount_cents,
    v_ledger.platform_fee_cents,
    v_ledger.processing_fee_cents,
    v_ledger.creator_net_cents,
    coalesce(p_actual_stripe_processing_fee_cents, v_ledger.actual_stripe_fee_cents),
    v_previous_refunded,
    v_new_refunded,
    v_ledger.gross_amount_cents - v_new_refunded,
    v_creator_delta,
    p_requested_refund_amount_cents - v_app_fee_delta,
    v_platform_delta,
    v_processing_delta,
    v_rounding,
    v_previous_app_fee_refunded,
    v_app_fee_delta,
    v_previous_app_fee_refunded + v_app_fee_delta,
    p_idempotency_key,
    p_initiated_by,
    nullif(btrim(p_internal_notes), '')
  ) returning * into v_row;

  insert into public.admin_actions (
    actor_id, action, target_table, target_id, reason
  ) values (
    p_initiated_by,
    'create_refund',
    'refund_operations',
    v_row.id,
    p_reason_code || ':' || p_responsibility
  );

  return to_jsonb(v_row);
end;
$$;

-- One processor owns an operation at a time. A dead worker's lease can be
-- reclaimed, while completed and definitively failed operations stay closed.
create or replace function public.claim_refund_operation(
  p_operation_id uuid,
  p_processing_token uuid,
  p_lease_seconds integer default 300
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.refund_operations%rowtype;
begin
  if p_operation_id is null
     or p_processing_token is null
     or p_lease_seconds < 30
     or p_lease_seconds > 900 then
    raise exception 'invalid refund claim input';
  end if;

  select * into v_row
  from public.refund_operations
  where id = p_operation_id
  for update;

  if not found then return 'missing'; end if;
  if v_row.status = 'completed' then return 'completed'; end if;
  if v_row.status = 'failed' then return 'failed'; end if;

  -- Claims for different operations on the same payment must serialize too.
  -- Otherwise both workers could read the same application-fee amount from
  -- Stripe and each create a cumulative adjustment from that stale baseline.
  perform pg_advisory_xact_lock(
    hashtextextended(v_row.payment_fee_ledger_id::text, 1)
  );
  if exists (
    select 1
    from public.refund_operations other
    where other.payment_fee_ledger_id = v_row.payment_fee_ledger_id
      and other.id <> v_row.id
      and other.processing_token is not null
      and other.processing_claimed_at is not null
      and other.processing_claimed_at >
        now() - make_interval(secs => p_lease_seconds)
  ) then
    return 'busy';
  end if;
  if v_row.processing_token is not null
     and v_row.processing_claimed_at is not null
     and v_row.processing_claimed_at >
       now() - make_interval(secs => p_lease_seconds) then
    return 'busy';
  end if;

  update public.refund_operations
  set processing_token = p_processing_token,
      processing_claimed_at = now(),
      attempt_count = attempt_count + 1,
      updated_at = now()
  where id = p_operation_id;

  return 'claimed';
end;
$$;

revoke all on function public.create_refund_operation(
  uuid, uuid, bigint, text, text, text, text, uuid, text, text, bigint, bigint, bigint
) from public, anon, authenticated;
revoke all on function public.claim_refund_operation(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.create_refund_operation(
  uuid, uuid, bigint, text, text, text, text, uuid, text, text, bigint, bigint, bigint
) to service_role;
grant execute on function public.claim_refund_operation(uuid, uuid, integer)
  to service_role;

commit;
