-- 019 — separate CreatorNet's 12% platform fee from creator-funded processing.
--
-- Deployment order matters: apply this migration before deploying application
-- code that writes the new columns. Existing rows are backfilled as the legacy
-- 12%-only schedule; no historical financial amount is recomputed.

-- Keep schema, ACL, and SECURITY DEFINER changes indivisible. This is important
-- both for the intentionally fallible duplicate-payment preflight index and so
-- no financial function exists with PostgreSQL's default PUBLIC EXECUTE grant.
begin;

alter table public.orders
  add column if not exists processing_fee bigint not null default 0,
  add column if not exists total_creator_deduction bigint not null default 0,
  add column if not exists fee_schedule_version text not null default 'platform-only-v1',
  add column if not exists stripe_charge_id text,
  add column if not exists stripe_balance_transaction_id text,
  add column if not exists actual_stripe_fee bigint,
  add column if not exists processing_fee_variance bigint,
  add column if not exists refunded_amount bigint not null default 0;

update public.orders
set total_creator_deduction = platform_fee
where total_creator_deduction = 0 and platform_fee > 0;

alter table public.booking_payments
  add column if not exists processing_fee_cents bigint not null default 0,
  add column if not exists total_creator_deduction_cents bigint not null default 0,
  add column if not exists creator_net_cents bigint,
  add column if not exists fee_schedule_version text not null default 'platform-only-v1',
  add column if not exists stripe_charge_id text,
  add column if not exists stripe_balance_transaction_id text,
  add column if not exists actual_stripe_fee_cents bigint,
  add column if not exists processing_fee_variance_cents bigint;

-- A booking may have only one chargeable payment path at a time. Without this
-- database-level guard, two simultaneous "generate link" requests can create
-- two Checkout Sessions for the same booking and charge the buyer twice. An
-- expired link leaves the index automatically and can be replaced. If this
-- statement finds historical duplicates it intentionally fails the migration;
-- reconcile/expire the extra Stripe sessions rather than guessing which is safe.
create unique index if not exists booking_payments_one_live_path_per_booking_uidx
  on public.booking_payments(booking_id)
  where status in ('pending', 'link_sent', 'completed');

-- Historical booking rows keep creator_net_cents null. Older installment rows
-- stored a plan-level platform fee beside a per-installment amount, so deriving
-- and persisting a new per-payment net here would rewrite history from
-- mismatched units. The UI safely derives the known legacy 12% view at render
-- time; every new payment writes an exact immutable split.

alter table public.purchases
  -- Migration 018 was applied directly before this versioned migration. Keep
  -- its accounting claim columns as idempotent prerequisites so a restored or
  -- staging database cannot accept 019 and then fail inside the refund RPC.
  add column if not exists earnings_credited_at timestamptz,
  add column if not exists earnings_credited_cents integer,
  add column if not exists platform_fee_cents bigint,
  add column if not exists processing_fee_cents bigint,
  add column if not exists total_creator_deduction_cents bigint,
  add column if not exists creator_net_cents bigint,
  add column if not exists fee_schedule_version text,
  add column if not exists refunded_amount_cents bigint not null default 0,
  add column if not exists earnings_reversed_cents bigint not null default 0,
  add column if not exists platform_fee_refund_attribution_cents bigint not null default 0,
  add column if not exists processing_fee_refund_attribution_cents bigint not null default 0,
  add column if not exists refund_allocation_rounding_cents bigint not null default 0;

-- Buyers still need their existing order/purchase rows for library and access
-- screens, but not the creator's fee split. RLS limits which rows they see; this
-- column ACL limits what they can select from those rows. Build the safe grant
-- from the deployed schema so unrelated legacy columns remain readable.
revoke select on table public.orders from anon, authenticated;
revoke select on table public.purchases from anon, authenticated;

do $column_acl$
declare
  v_columns text;
begin
  select string_agg(format('%I', column_name), ', ' order by ordinal_position)
  into v_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'orders'
    and column_name not in (
      'platform_fee',
      'processing_fee',
      'total_creator_deduction',
      'creator_amount',
      'stripe_charge_id',
      'stripe_balance_transaction_id',
      'actual_stripe_fee',
      'processing_fee_variance'
    );
  execute format(
    'grant select (%s) on table public.orders to anon, authenticated',
    v_columns
  );

  select string_agg(format('%I', column_name), ', ' order by ordinal_position)
  into v_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'purchases'
    and column_name not in (
      'platform_fee_cents',
      'processing_fee_cents',
      'total_creator_deduction_cents',
      'creator_net_cents',
      'fee_schedule_version',
      'refunded_amount_cents',
      'earnings_reversed_cents',
      'platform_fee_refund_attribution_cents',
      'processing_fee_refund_attribution_cents',
      'refund_allocation_rounding_cents'
    );
  execute format(
    'grant select (%s) on table public.purchases to anon, authenticated',
    v_columns
  );
end;
$column_acl$;

create table if not exists public.payment_fee_ledger (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  booking_payment_id uuid references public.booking_payments(id) on delete set null,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  stripe_invoice_id text,
  stripe_charge_id text,
  stripe_balance_transaction_id text,
  gross_amount_cents bigint not null,
  platform_fee_cents bigint not null,
  processing_fee_cents bigint not null,
  total_creator_deduction_cents bigint not null,
  creator_net_cents bigint not null,
  actual_stripe_fee_cents bigint,
  processing_fee_variance_cents bigint,
  refunded_amount_cents bigint not null default 0,
  earnings_reversed_cents bigint not null default 0,
  platform_fee_refund_attribution_cents bigint not null default 0,
  processing_fee_refund_attribution_cents bigint not null default 0,
  refund_allocation_rounding_cents bigint not null default 0,
  stripe_dispute_id text,
  disputed_amount_cents bigint not null default 0,
  dispute_status text,
  currency text not null,
  fee_schedule_version text not null,
  status text not null default 'paid',
  earnings_credited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_fee_ledger_status_check
    check (status in ('pending', 'paid', 'failed', 'refunded')),
  constraint payment_fee_ledger_amounts_nonnegative_check
    check (
      gross_amount_cents >= 0 and
      platform_fee_cents >= 0 and
      processing_fee_cents >= 0 and
      total_creator_deduction_cents >= 0 and
      creator_net_cents >= 0 and
      refunded_amount_cents >= 0 and
      earnings_reversed_cents >= 0 and
      platform_fee_refund_attribution_cents >= 0 and
      processing_fee_refund_attribution_cents >= 0 and
      disputed_amount_cents >= 0
    ),
  constraint payment_fee_ledger_split_check
    check (
      platform_fee_cents + processing_fee_cents = total_creator_deduction_cents and
      total_creator_deduction_cents + creator_net_cents = gross_amount_cents
    ),
  constraint payment_fee_ledger_refund_check
    check (
      refunded_amount_cents <= gross_amount_cents and
      disputed_amount_cents <= gross_amount_cents and
      earnings_reversed_cents <= creator_net_cents and
      platform_fee_refund_attribution_cents <= platform_fee_cents and
      processing_fee_refund_attribution_cents <= processing_fee_cents and
      refund_allocation_rounding_cents between -2 and 2 and
      earnings_reversed_cents
        + platform_fee_refund_attribution_cents
        + processing_fee_refund_attribution_cents
        + refund_allocation_rounding_cents = refunded_amount_cents
    )
  );

create unique index if not exists payment_fee_ledger_dispute_uidx
  on public.payment_fee_ledger(stripe_dispute_id)
  where stripe_dispute_id is not null;

create unique index if not exists payment_fee_ledger_checkout_session_uidx
  on public.payment_fee_ledger(stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
create unique index if not exists payment_fee_ledger_payment_intent_uidx
  on public.payment_fee_ledger(stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create unique index if not exists payment_fee_ledger_invoice_uidx
  on public.payment_fee_ledger(stripe_invoice_id)
  where stripe_invoice_id is not null;
create index if not exists payment_fee_ledger_creator_created_idx
  on public.payment_fee_ledger(creator_id, created_at desc);
create index if not exists payment_fee_ledger_booking_payment_idx
  on public.payment_fee_ledger(booking_payment_id)
  where booking_payment_id is not null;

alter table public.payment_fee_ledger enable row level security;
revoke all on table public.payment_fee_ledger from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_fee_ledger to service_role;

-- A primary-key insert by itself cannot distinguish "currently processing" from
-- "already completed". Track an explicit lease so a concurrent delivery gets a
-- retryable response instead of a false-success acknowledgement, while a worker
-- that died can be reclaimed after the lease expires. Existing rows were written
-- by the old completed-event guard and are therefore backfilled as completed.
alter table public.stripe_events
  add column if not exists status text not null default 'completed',
  add column if not exists claimed_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists claim_token uuid;

alter table public.stripe_events
  alter column created_at set default now();

update public.stripe_events
set
  claimed_at = coalesce(claimed_at, created_at),
  completed_at = coalesce(completed_at, created_at)
where status = 'completed';

-- If an earlier draft of this migration was applied, fence any lease that was
-- already in progress before installing the token-required constraint. The
-- random token deliberately has no application owner; that row can only be
-- reclaimed after its normal lease expires, never completed by a new worker.
update public.stripe_events
set
  claimed_at = coalesce(claimed_at, created_at, now()),
  claim_token = coalesce(claim_token, gen_random_uuid())
where status = 'processing';

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stripe_events_status_check'
      and conrelid = 'public.stripe_events'::regclass
  ) then
    alter table public.stripe_events
      add constraint stripe_events_status_check
      check (status in ('processing', 'completed'));
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stripe_events_processing_claim_check'
      and conrelid = 'public.stripe_events'::regclass
  ) then
    alter table public.stripe_events
      add constraint stripe_events_processing_claim_check
      check (status <> 'processing' or claim_token is not null);
  end if;
end;
$migration$;

create unique index if not exists stripe_events_claim_token_uidx
  on public.stripe_events(claim_token)
  where claim_token is not null;

alter table public.stripe_events enable row level security;
revoke all on table public.stripe_events from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_events to service_role;

-- A retried pre-release draft of 019 may have installed tokenless overloads.
-- Drop them inside this transaction so no stale worker can bypass the fenced
-- signatures below and no SECURITY DEFINER overload remains callable.
drop function if exists public.claim_stripe_event(text, text, integer);
drop function if exists public.complete_stripe_event(text);
drop function if exists public.release_stripe_event(text);

create or replace function public.claim_stripe_event(
  p_event_id text,
  p_event_type text,
  p_lease_seconds integer,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_claimed_at timestamptz;
begin
  if nullif(trim(p_event_id), '') is null then
    raise exception 'event id is required';
  end if;
  if nullif(trim(p_event_type), '') is null then
    raise exception 'event type is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'event lease must be between 30 and 3600 seconds';
  end if;
  if p_claim_token is null then
    raise exception 'event claim token is required';
  end if;

  insert into public.stripe_events (
    id, type, created_at, status, claimed_at, completed_at, claim_token
  )
  values (
    p_event_id, p_event_type, now(), 'processing', now(), null, p_claim_token
  )
  on conflict (id) do nothing;

  if found then
    return 'new';
  end if;

  select status, claimed_at
  into v_status, v_claimed_at
  from public.stripe_events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'event claim row disappeared for %', p_event_id;
  end if;
  if v_status = 'completed' then
    return 'duplicate';
  end if;
  if v_claimed_at is not null
     and v_claimed_at >= now() - make_interval(secs => p_lease_seconds) then
    return 'busy';
  end if;

  update public.stripe_events
  set
    type = p_event_type,
    status = 'processing',
    claimed_at = now(),
    completed_at = null,
    claim_token = p_claim_token
  where id = p_event_id;

  return 'new';
end;
$$;

create or replace function public.complete_stripe_event(
  p_event_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_completed boolean;
begin
  if nullif(trim(p_event_id), '') is null or p_claim_token is null then
    raise exception 'event id and claim token are required';
  end if;

  update public.stripe_events
  set status = 'completed', completed_at = now()
  where id = p_event_id
    and status = 'processing'
    and claim_token = p_claim_token
  returning true into v_completed;

  return coalesce(v_completed, false);
end;
$$;

create or replace function public.release_stripe_event(
  p_event_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released boolean;
begin
  if nullif(trim(p_event_id), '') is null or p_claim_token is null then
    raise exception 'event id and claim token are required';
  end if;

  delete from public.stripe_events
  where id = p_event_id
    and status = 'processing'
    and claim_token = p_claim_token
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

-- Stripe does not guarantee webhook delivery order. Keep the latest cumulative
-- refund reported for a PaymentIntent even when charge.refunded arrives before
-- checkout.session.completed/invoice.payment_succeeded has linked CreatorNet's
-- purchase and ledger rows. A later success event reconciles this durable state.
create table if not exists public.payment_refund_state (
  stripe_payment_intent_id text primary key,
  stripe_charge_id text not null,
  charge_amount_cents bigint not null,
  refunded_amount_cents bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_refund_state_amounts_check
    check (
      charge_amount_cents >= 0 and
      refunded_amount_cents >= 0 and
      refunded_amount_cents <= charge_amount_cents
    )
);

alter table public.payment_refund_state enable row level security;
revoke all on table public.payment_refund_state from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_refund_state to service_role;

-- Disputes are accounting/audit state only in this release. Nothing here debits
-- a creator or decides who is financially responsible. Stripe events can arrive
-- out of order, so retain the newest event-created timestamp for each dispute.
create table if not exists public.payment_dispute_state (
  stripe_dispute_id text primary key,
  stripe_payment_intent_id text not null,
  stripe_charge_id text not null,
  disputed_amount_cents bigint not null,
  currency text not null,
  status text not null,
  stripe_event_created bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_dispute_state_amount_check
    check (disputed_amount_cents >= 0)
);

create index if not exists payment_dispute_state_payment_intent_idx
  on public.payment_dispute_state(stripe_payment_intent_id);

alter table public.payment_dispute_state enable row level security;
revoke all on table public.payment_dispute_state from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_dispute_state to service_role;

create or replace function public.record_payment_dispute_state(
  p_dispute_id text,
  p_payment_intent_id text,
  p_charge_id text,
  p_disputed_amount_cents bigint,
  p_currency text,
  p_status text,
  p_event_created bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recorded boolean;
begin
  if nullif(trim(p_dispute_id), '') is null
     or nullif(trim(p_payment_intent_id), '') is null
     or nullif(trim(p_charge_id), '') is null then
    raise exception 'dispute, payment intent, and charge ids are required';
  end if;
  if p_disputed_amount_cents is null or p_disputed_amount_cents < 0 then
    raise exception 'disputed amount must be nonnegative';
  end if;
  if nullif(trim(p_currency), '') is null or nullif(trim(p_status), '') is null then
    raise exception 'dispute currency and status are required';
  end if;
  if p_event_created is null or p_event_created < 0 then
    raise exception 'Stripe event-created time is invalid';
  end if;

  insert into public.payment_dispute_state (
    stripe_dispute_id,
    stripe_payment_intent_id,
    stripe_charge_id,
    disputed_amount_cents,
    currency,
    status,
    stripe_event_created
  )
  values (
    p_dispute_id,
    p_payment_intent_id,
    p_charge_id,
    p_disputed_amount_cents,
    lower(p_currency),
    p_status,
    p_event_created
  )
  on conflict (stripe_dispute_id) do update
  set
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    stripe_charge_id = excluded.stripe_charge_id,
    disputed_amount_cents = excluded.disputed_amount_cents,
    currency = excluded.currency,
    status = excluded.status,
    stripe_event_created = excluded.stripe_event_created,
    updated_at = now()
  where excluded.stripe_event_created >= payment_dispute_state.stripe_event_created
  returning true into v_recorded;

  return coalesce(v_recorded, false);
end;
$$;

-- Atomically retain only forward-moving cumulative refund state. Replayed
-- events and an older event arriving after a newer one cannot reduce the
-- recorded refund.
create or replace function public.record_payment_refund_state(
  p_payment_intent_id text,
  p_charge_id text,
  p_charge_amount_cents bigint,
  p_refunded_amount_cents bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refunded bigint;
begin
  if nullif(trim(p_payment_intent_id), '') is null then
    raise exception 'payment intent id is required';
  end if;
  if nullif(trim(p_charge_id), '') is null then
    raise exception 'charge id is required';
  end if;
  if p_charge_amount_cents is null or p_charge_amount_cents < 0 then
    raise exception 'charge amount must be nonnegative';
  end if;
  if p_refunded_amount_cents is null
     or p_refunded_amount_cents < 0
     or p_refunded_amount_cents > p_charge_amount_cents then
    raise exception 'refunded amount must be between zero and the charge amount';
  end if;

  insert into public.payment_refund_state (
    stripe_payment_intent_id,
    stripe_charge_id,
    charge_amount_cents,
    refunded_amount_cents
  )
  values (
    p_payment_intent_id,
    p_charge_id,
    p_charge_amount_cents,
    p_refunded_amount_cents
  )
  on conflict (stripe_payment_intent_id) do update
  set
    stripe_charge_id = excluded.stripe_charge_id,
    charge_amount_cents = greatest(
      payment_refund_state.charge_amount_cents,
      excluded.charge_amount_cents
    ),
    refunded_amount_cents = least(
      greatest(
        payment_refund_state.charge_amount_cents,
        excluded.charge_amount_cents
      ),
      greatest(
        payment_refund_state.refunded_amount_cents,
        excluded.refunded_amount_cents
      )
    ),
    updated_at = now()
  returning refunded_amount_cents into v_refunded;

  return v_refunded;
end;
$$;

-- Recurring invoices do not have a separate purchases row per charge. This RPC
-- gives each paid ledger row one atomic internal earnings credit.
create or replace function public.credit_payment_fee_ledger_earnings(p_ledger_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator_id uuid;
  v_creator_net bigint;
  v_already_reversed bigint;
  v_purchase_id uuid;
begin
  select creator_id, creator_net_cents, earnings_reversed_cents, purchase_id
  into v_creator_id, v_creator_net, v_already_reversed, v_purchase_id
  from public.payment_fee_ledger
  where id = p_ledger_id
    and stripe_invoice_id is not null
    -- A charge.refunded delivery can arrive before invoice.payment_succeeded.
    -- It still represents an invoice that was successfully paid before Stripe
    -- could refund it, so claim the invoice exactly once even if refund
    -- reconciliation already moved the ledger to refunded.
    and status in ('paid', 'refunded')
    and earnings_credited_at is null
  for update;

  if not found then
    return false;
  end if;

  update public.profiles
  -- A partial charge.refunded can race between ledger insertion and this
  -- credit. In that order the refund RPC has already stored the proportional
  -- reversal but did not debit an uncredited balance. Credit only the remaining
  -- net so the later reconciliation replay is correctly a no-op.
  set total_earnings_cents = coalesce(total_earnings_cents, 0)
    + greatest(0, v_creator_net - coalesce(v_already_reversed, 0))
  where id = v_creator_id;

  if not found then
    raise exception 'creator profile not found for payment fee ledger %', p_ledger_id;
  end if;

  if v_purchase_id is null then
    raise exception 'purchase is missing for recurring payment fee ledger %', p_ledger_id;
  end if;

  -- The ledger claim and installment progress advance in the same database
  -- transaction. If the webhook retries after a later step fails, the existing
  -- earnings_credited_at claim prevents paid_count from incrementing twice.
  update public.purchases
  set
    paid_count = coalesce(paid_count, 0) + 1,
    access_granted = true,
    status = case
      when coalesce(paid_count, 0) + 1 >= greatest(coalesce(target_months, 1), 1)
        then 'complete'
      else 'active'
    end
  where id = v_purchase_id
    and subscription_id is not null
    and coalesce(status, 'pending') <> 'refunded';

  if not found then
    raise exception 'eligible purchase not found for payment fee ledger %', p_ledger_id;
  end if;

  update public.payment_fee_ledger
  set earnings_credited_at = now(), updated_at = now()
  where id = p_ledger_id;

  return true;
end;
$$;

-- Apply the cumulative refunded gross reported by Stripe. Replays and
-- out-of-order lower totals are no-ops; partial refunds reverse creator net
-- proportionally from the exact amount originally credited.
create or replace function public.apply_purchase_refund_earnings(
  p_purchase_id uuid,
  p_refunded_gross_cents bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator_id uuid;
  v_gross bigint;
  v_credited bigint;
  v_previous_refunded bigint;
  v_previous_reversed bigint;
  v_platform_fee bigint;
  v_processing_fee bigint;
  v_refunded bigint;
  v_target_reversed bigint;
  v_platform_attribution bigint;
  v_processing_attribution bigint;
  v_rounding_adjustment bigint;
  v_delta bigint;
  v_subscription_id text;
begin
  select
    creator_id,
    coalesce(amount_cents, 0),
    earnings_credited_cents,
    coalesce(refunded_amount_cents, 0),
    coalesce(earnings_reversed_cents, 0),
    coalesce(platform_fee_cents, 0),
    coalesce(processing_fee_cents, 0),
    subscription_id
  into
    v_creator_id,
    v_gross,
    v_credited,
    v_previous_refunded,
    v_previous_reversed,
    v_platform_fee,
    v_processing_fee,
    v_subscription_id
  from public.purchases
  where id = p_purchase_id
  for update;

  -- Recurring installments are credited and reversed per invoice by the fee
  -- ledger RPC. Never revoke the whole subscription purchase from this
  -- one-time-purchase function.
  if not found
     or v_subscription_id is not null
     or v_creator_id is null
     or v_gross <= 0
     or v_credited is null then
    return 0;
  end if;

  v_refunded := least(v_gross, greatest(v_previous_refunded, p_refunded_gross_cents, 0));
  v_target_reversed := round((v_credited::numeric * v_refunded::numeric) / v_gross::numeric);
  v_platform_attribution := round((v_platform_fee::numeric * v_refunded::numeric) / v_gross::numeric);
  v_processing_attribution := round((v_processing_fee::numeric * v_refunded::numeric) / v_gross::numeric);
  -- Keep each economic component proportionally rounded and preserve the tiny
  -- deterministic residual explicitly. This makes the refund allocation sum to
  -- the refunded gross without making an attribution non-monotonic across
  -- cumulative partial-refund events.
  v_rounding_adjustment := v_refunded
    - v_target_reversed
    - v_platform_attribution
    - v_processing_attribution;
  v_delta := greatest(0, v_target_reversed - v_previous_reversed);

  if v_delta > 0 then
    update public.profiles
    set total_earnings_cents = greatest(0, coalesce(total_earnings_cents, 0) - v_delta)
    where id = v_creator_id;
  end if;

  update public.purchases
  set
    refunded_amount_cents = v_refunded,
    earnings_reversed_cents = v_target_reversed,
    platform_fee_refund_attribution_cents = v_platform_attribution,
    processing_fee_refund_attribution_cents = v_processing_attribution,
    refund_allocation_rounding_cents = v_rounding_adjustment,
    status = case when v_refunded >= v_gross then 'refunded' else status end,
    access_granted = case when v_refunded >= v_gross then false else access_granted end
  where id = p_purchase_id;

  return v_delta;
end;
$$;

create or replace function public.apply_payment_fee_ledger_refund(
  p_ledger_id uuid,
  p_refunded_gross_cents bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator_id uuid;
  v_gross bigint;
  v_creator_net bigint;
  v_previous_refunded bigint;
  v_previous_reversed bigint;
  v_platform_fee bigint;
  v_processing_fee bigint;
  v_was_credited boolean;
  v_refunded bigint;
  v_target_reversed bigint;
  v_platform_attribution bigint;
  v_processing_attribution bigint;
  v_rounding_adjustment bigint;
  v_delta bigint;
begin
  select
    creator_id,
    gross_amount_cents,
    creator_net_cents,
    refunded_amount_cents,
    earnings_reversed_cents,
    platform_fee_cents,
    processing_fee_cents,
    earnings_credited_at is not null
  into
    v_creator_id,
    v_gross,
    v_creator_net,
    v_previous_refunded,
    v_previous_reversed,
    v_platform_fee,
    v_processing_fee,
    v_was_credited
  from public.payment_fee_ledger
  where id = p_ledger_id
  for update;

  if not found or v_gross <= 0 then
    return 0;
  end if;

  v_refunded := least(v_gross, greatest(v_previous_refunded, p_refunded_gross_cents, 0));
  v_target_reversed := round((v_creator_net::numeric * v_refunded::numeric) / v_gross::numeric);
  v_platform_attribution := round((v_platform_fee::numeric * v_refunded::numeric) / v_gross::numeric);
  v_processing_attribution := round((v_processing_fee::numeric * v_refunded::numeric) / v_gross::numeric);
  v_rounding_adjustment := v_refunded
    - v_target_reversed
    - v_platform_attribution
    - v_processing_attribution;
  v_delta := greatest(0, v_target_reversed - v_previous_reversed);

  -- Recurring invoice earnings are credited by the ledger RPC and therefore
  -- reversed here. One-time purchase earnings are credited/reversed by the
  -- purchases RPC; those ledger rows have no earnings_credited_at, so this
  -- function mirrors the refund for reporting without debiting twice.
  if v_delta > 0 and v_was_credited then
    update public.profiles
    set total_earnings_cents = greatest(0, coalesce(total_earnings_cents, 0) - v_delta)
    where id = v_creator_id;
  end if;

  update public.payment_fee_ledger
  set
    refunded_amount_cents = v_refunded,
    earnings_reversed_cents = v_target_reversed,
    platform_fee_refund_attribution_cents = v_platform_attribution,
    processing_fee_refund_attribution_cents = v_processing_attribution,
    refund_allocation_rounding_cents = v_rounding_adjustment,
    status = case when v_refunded >= v_gross then 'refunded' else status end,
    updated_at = now()
  where id = p_ledger_id;

  return case when v_was_credited then v_delta else 0 end;
end;
$$;

revoke all on function public.credit_payment_fee_ledger_earnings(uuid)
  from public, anon, authenticated;
revoke all on function public.apply_purchase_refund_earnings(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.apply_payment_fee_ledger_refund(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.record_payment_refund_state(text, text, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.record_payment_dispute_state(text, text, text, bigint, text, text, bigint)
  from public, anon, authenticated;
revoke all on function public.claim_stripe_event(text, text, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_stripe_event(text, uuid)
  from public, anon, authenticated;
revoke all on function public.release_stripe_event(text, uuid)
  from public, anon, authenticated;

grant execute on function public.credit_payment_fee_ledger_earnings(uuid) to service_role;
grant execute on function public.apply_purchase_refund_earnings(uuid, bigint) to service_role;
grant execute on function public.apply_payment_fee_ledger_refund(uuid, bigint) to service_role;
grant execute on function public.record_payment_refund_state(text, text, bigint, bigint)
  to service_role;
grant execute on function public.record_payment_dispute_state(text, text, text, bigint, text, text, bigint)
  to service_role;
grant execute on function public.claim_stripe_event(text, text, integer, uuid) to service_role;
grant execute on function public.complete_stripe_event(text, uuid) to service_role;
grant execute on function public.release_stripe_event(text, uuid) to service_role;

commit;
