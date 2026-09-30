begin;

alter table public.posts
  add column if not exists tips_enabled boolean not null default false;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'posts_tip_only_check'
      and conrelid = 'public.posts'::regclass
  ) then
    alter table public.posts add constraint posts_tip_only_check check (
      not tips_enabled or (
        nullif(btrim(video_url), '') is not null and
        product_id is null and offering_id is null and premium_path is null and
        coalesce(price_cents, 0) = 0 and allow_booking is false and
        booking_url is null and coalesce(cta_type, 'none') = 'none' and
        fulfillment_url is null and display_price is null and booking_url_override is null
      )
    );
  end if;
end;
$migration$;

-- posts already grants authenticated owners UPDATE, so a table constraint alone
-- cannot enforce the server-side Connect check for toggling this new column.
create or replace function public.guard_post_tips_enabled_write()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if (tg_op = 'INSERT' and new.tips_enabled) or
     (tg_op = 'UPDATE' and new.tips_enabled is distinct from old.tips_enabled) then
    if current_user not in ('service_role', 'postgres') then
      raise exception 'tips_enabled must be changed through the server' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists posts_tips_enabled_write_guard on public.posts;
create trigger posts_tips_enabled_write_guard
  before insert or update of tips_enabled on public.posts
  for each row execute function public.guard_post_tips_enabled_write();

create index if not exists posts_tips_enabled_idx
  on public.posts(created_at desc) where tips_enabled = true;

create table if not exists public.tips (
  id uuid primary key default gen_random_uuid(),
  tipper_id uuid not null references public.profiles(id) on delete restrict,
  creator_id uuid not null references public.profiles(id) on delete restrict,
  post_id uuid not null references public.posts(id) on delete restrict,
  client_request_key uuid not null,
  terms_fingerprint text not null,
  gross_amount_cents bigint not null,
  platform_fee_cents bigint not null,
  processing_fee_cents bigint not null,
  total_creator_deduction_cents bigint not null,
  creator_net_cents bigint not null,
  processing_fee_enabled boolean not null default false,
  processing_fee_basis_points integer not null default 0,
  processing_fee_fixed_cents integer not null default 0,
  fee_schedule_version text not null,
  currency text not null default 'usd',
  status text not null default 'creating',
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_balance_transaction_id text,
  stripe_destination_account_id text not null,
  failure_code text,
  earnings_credited_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  canceled_at timestamptz,
  refunded_amount_cents bigint not null default 0,
  refund_updated_at timestamptz,
  dispute_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tips_not_self_check check (tipper_id <> creator_id),
  constraint tips_status_check check (status in ('creating','open','processing','paid','failed','canceled')),
  constraint tips_currency_check check (currency = 'usd'),
  constraint tips_gross_range_check check (gross_amount_cents between 500 and 50000),
  constraint tips_amounts_check check (
    platform_fee_cents >= 0 and processing_fee_cents >= 0 and
    total_creator_deduction_cents >= 0 and creator_net_cents >= 0 and
    refunded_amount_cents >= 0 and refunded_amount_cents <= gross_amount_cents and
    platform_fee_cents + processing_fee_cents = total_creator_deduction_cents and
    total_creator_deduction_cents + creator_net_cents = gross_amount_cents
  ),
  constraint tips_processing_schedule_check check (
    (processing_fee_enabled or (processing_fee_basis_points = 0 and processing_fee_fixed_cents = 0)) and
    processing_fee_basis_points between 0 and 10000 and
    processing_fee_fixed_cents >= 0 and nullif(trim(fee_schedule_version), '') is not null
  ),
  unique (tipper_id, client_request_key)
);

create unique index if not exists tips_checkout_session_uidx
  on public.tips(stripe_checkout_session_id) where stripe_checkout_session_id is not null;
create unique index if not exists tips_payment_intent_uidx
  on public.tips(stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists tips_creator_created_idx on public.tips(creator_id, created_at desc);
create index if not exists tips_tipper_created_idx on public.tips(tipper_id, created_at desc);
create index if not exists tips_post_created_idx on public.tips(post_id, created_at desc);
create index if not exists tips_status_updated_idx on public.tips(status, updated_at);

alter table public.payment_fee_ledger add column if not exists tip_id uuid;
do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_fee_ledger_tip_id_fkey'
      and conrelid = 'public.payment_fee_ledger'::regclass
  ) then
    alter table public.payment_fee_ledger
      add constraint payment_fee_ledger_tip_id_fkey
      foreign key (tip_id) references public.tips(id) on delete restrict;
  end if;
end;
$migration$;
create unique index if not exists payment_fee_ledger_tip_uidx
  on public.payment_fee_ledger(tip_id) where tip_id is not null;
do $migration$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payment_fee_ledger_tip_exclusive_check'
      and conrelid = 'public.payment_fee_ledger'::regclass
  ) then
    alter table public.payment_fee_ledger add constraint payment_fee_ledger_tip_exclusive_check
      check (tip_id is null or (purchase_id is null and order_id is null and
        booking_payment_id is null and stripe_invoice_id is null));
  end if;
end;
$migration$;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  kind text not null,
  tip_id uuid references public.tips(id) on delete restrict,
  post_id uuid references public.posts(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_kind_check check (kind in ('tip_received')),
  constraint notifications_tip_shape_check check (kind <> 'tip_received' or tip_id is not null)
);
create unique index if not exists notifications_tip_recipient_uidx
  on public.notifications(kind, recipient_id, tip_id) where tip_id is not null;
create index if not exists notifications_recipient_created_idx
  on public.notifications(recipient_id, created_at desc);
create index if not exists notifications_recipient_unread_idx
  on public.notifications(recipient_id, created_at desc) where read_at is null;
create index if not exists notifications_actor_idx
  on public.notifications(actor_id) where actor_id is not null;
create index if not exists notifications_post_idx
  on public.notifications(post_id) where post_id is not null;
create index if not exists notifications_tip_idx
  on public.notifications(tip_id) where tip_id is not null;

create table if not exists public.tip_dispute_recoveries (
  stripe_dispute_id text primary key,
  tip_id uuid not null references public.tips(id) on delete restrict,
  stripe_payment_intent_id text not null,
  stripe_charge_id text not null,
  stripe_transfer_id text,
  disputed_amount_cents bigint not null,
  reversal_id text,
  reversal_amount_cents bigint not null default 0,
  reversal_status text not null default 'pending',
  reversal_error_code text,
  reversal_updated_at timestamptz,
  restoration_transfer_id text,
  restoration_status text,
  restoration_error_code text,
  restoration_updated_at timestamptz,
  stripe_event_created bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tip_dispute_recoveries_amount_check check (disputed_amount_cents > 0),
  constraint tip_dispute_recoveries_reversal_amount_check
    check (reversal_amount_cents >= 0 and reversal_amount_cents <= disputed_amount_cents),
  constraint tip_dispute_recoveries_reversal_status_check
    check (reversal_status in ('pending','succeeded','failed')),
  constraint tip_dispute_recoveries_restoration_status_check
    check (restoration_status is null or restoration_status in ('pending','succeeded','failed'))
);
create index if not exists tip_dispute_recoveries_tip_idx
  on public.tip_dispute_recoveries(tip_id, updated_at desc);

alter table public.tips enable row level security;
alter table public.notifications enable row level security;
alter table public.tip_dispute_recoveries enable row level security;
revoke all on table public.tips from public, anon, authenticated;
revoke all on table public.notifications from public, anon, authenticated;
revoke all on table public.tip_dispute_recoveries from public, anon, authenticated;
grant select, insert, update, delete on table public.tips to service_role;
grant select, insert, update, delete on table public.notifications to service_role;
grant select, insert, update, delete on table public.tip_dispute_recoveries to service_role;

create or replace function public.create_or_get_video_tip(
  p_id uuid,
  p_tipper_id uuid,
  p_creator_id uuid,
  p_post_id uuid,
  p_client_request_key uuid,
  p_terms_fingerprint text,
  p_gross_amount_cents bigint,
  p_platform_fee_cents bigint,
  p_processing_fee_cents bigint,
  p_total_creator_deduction_cents bigint,
  p_creator_net_cents bigint,
  p_processing_fee_enabled boolean,
  p_processing_fee_basis_points integer,
  p_processing_fee_fixed_cents integer,
  p_fee_schedule_version text,
  p_currency text,
  p_destination_account_id text
)
returns public.tips
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tip public.tips%rowtype;
  v_open_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_tipper_id::text), hashtext(p_post_id::text));
  if not exists (
    select 1 from public.tips where tipper_id = p_tipper_id and client_request_key = p_client_request_key
  ) then
    select count(*) into v_open_count from public.tips
    where tipper_id = p_tipper_id and post_id = p_post_id
      and status in ('creating','open','processing');
    if v_open_count >= 3 then
      raise exception 'too many open tip attempts' using errcode = 'CN021';
    end if;
  end if;
  insert into public.tips (
    id, tipper_id, creator_id, post_id, client_request_key, terms_fingerprint,
    gross_amount_cents, platform_fee_cents, processing_fee_cents,
    total_creator_deduction_cents, creator_net_cents, processing_fee_enabled,
    processing_fee_basis_points, processing_fee_fixed_cents, fee_schedule_version,
    currency, status, stripe_destination_account_id
  ) values (
    p_id, p_tipper_id, p_creator_id, p_post_id, p_client_request_key, p_terms_fingerprint,
    p_gross_amount_cents, p_platform_fee_cents, p_processing_fee_cents,
    p_total_creator_deduction_cents, p_creator_net_cents, p_processing_fee_enabled,
    p_processing_fee_basis_points, p_processing_fee_fixed_cents, p_fee_schedule_version,
    p_currency, 'creating', p_destination_account_id
  )
  on conflict (tipper_id, client_request_key) do nothing;

  select * into v_tip from public.tips
  where tipper_id = p_tipper_id and client_request_key = p_client_request_key;
  if not found then raise exception 'tip attempt was not created'; end if;
  return v_tip;
end;
$$;

create or replace function public.bind_video_tip_checkout(
  p_tip_id uuid,
  p_session_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bound boolean;
begin
  if p_tip_id is null or p_session_id !~ '^cs_[A-Za-z0-9_]+' then
    raise exception 'invalid tip checkout binding';
  end if;
  update public.tips set
    stripe_checkout_session_id = p_session_id,
    status = 'open',
    updated_at = now()
  where id = p_tip_id
    and status in ('creating','open')
    and (stripe_checkout_session_id is null or stripe_checkout_session_id = p_session_id)
  returning true into v_bound;
  return coalesce(v_bound, false);
end;
$$;

create or replace function public.finalize_video_tip(
  p_tip_id uuid,
  p_session_id text,
  p_payment_intent_id text,
  p_charge_id text,
  p_balance_transaction_id text,
  p_actual_stripe_fee_cents bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tip public.tips%rowtype;
  v_existing_ledger public.payment_fee_ledger%rowtype;
  v_ledger_id uuid;
  v_now timestamptz := now();
  v_credited boolean := false;
begin
  select * into v_tip from public.tips where id = p_tip_id for update;
  if not found then raise exception 'tip not found'; end if;
  if p_session_id !~ '^cs_[A-Za-z0-9_]+' or
     p_payment_intent_id !~ '^pi_[A-Za-z0-9_]+' or
     p_charge_id !~ '^ch_[A-Za-z0-9_]+' or
     (p_balance_transaction_id is not null and p_balance_transaction_id !~ '^txn_[A-Za-z0-9_]+') or
     (p_balance_transaction_id is null) <> (p_actual_stripe_fee_cents is null) or
     p_actual_stripe_fee_cents < 0 then
    raise exception 'invalid Stripe payment proof';
  end if;
  if v_tip.stripe_checkout_session_id is not null and v_tip.stripe_checkout_session_id <> p_session_id then
    raise exception 'tip checkout session differs';
  end if;
  if v_tip.stripe_payment_intent_id is not null and v_tip.stripe_payment_intent_id <> p_payment_intent_id then
    raise exception 'tip PaymentIntent differs';
  end if;
  if v_tip.stripe_charge_id is not null and v_tip.stripe_charge_id <> p_charge_id then
    raise exception 'tip charge differs';
  end if;
  if v_tip.stripe_balance_transaction_id is not null and p_balance_transaction_id is not null and
     v_tip.stripe_balance_transaction_id <> p_balance_transaction_id then
    raise exception 'tip balance transaction differs';
  end if;

  select * into v_existing_ledger from public.payment_fee_ledger
    where tip_id = v_tip.id for update;
  if found and (
    v_existing_ledger.creator_id is distinct from v_tip.creator_id or
    v_existing_ledger.stripe_checkout_session_id is distinct from p_session_id or
    v_existing_ledger.stripe_payment_intent_id is distinct from p_payment_intent_id or
    v_existing_ledger.stripe_charge_id is distinct from p_charge_id or
    (v_existing_ledger.stripe_balance_transaction_id is not null and p_balance_transaction_id is not null and
     v_existing_ledger.stripe_balance_transaction_id <> p_balance_transaction_id) or
    (v_existing_ledger.actual_stripe_fee_cents is not null and p_actual_stripe_fee_cents is not null and
     v_existing_ledger.actual_stripe_fee_cents <> p_actual_stripe_fee_cents) or
    v_existing_ledger.gross_amount_cents is distinct from v_tip.gross_amount_cents or
    v_existing_ledger.platform_fee_cents is distinct from v_tip.platform_fee_cents or
    v_existing_ledger.processing_fee_cents is distinct from v_tip.processing_fee_cents or
    v_existing_ledger.total_creator_deduction_cents is distinct from v_tip.total_creator_deduction_cents or
    v_existing_ledger.creator_net_cents is distinct from v_tip.creator_net_cents or
    v_existing_ledger.currency is distinct from v_tip.currency or
    v_existing_ledger.fee_schedule_version is distinct from v_tip.fee_schedule_version
  ) then
    raise exception 'tip ledger differs from frozen terms';
  end if;

  insert into public.payment_fee_ledger (
    creator_id, tip_id, stripe_checkout_session_id, stripe_payment_intent_id,
    stripe_charge_id, stripe_balance_transaction_id, gross_amount_cents,
    platform_fee_cents, processing_fee_cents, total_creator_deduction_cents,
    creator_net_cents, actual_stripe_fee_cents, processing_fee_variance_cents,
    currency, fee_schedule_version, status, created_at, updated_at
  ) values (
    v_tip.creator_id, v_tip.id, p_session_id, p_payment_intent_id,
    p_charge_id, p_balance_transaction_id, v_tip.gross_amount_cents,
    v_tip.platform_fee_cents, v_tip.processing_fee_cents, v_tip.total_creator_deduction_cents,
    v_tip.creator_net_cents, p_actual_stripe_fee_cents,
    case when p_actual_stripe_fee_cents is null then null else v_tip.processing_fee_cents - p_actual_stripe_fee_cents end,
    v_tip.currency, v_tip.fee_schedule_version, 'paid', v_now, v_now
  )
  on conflict (tip_id) where tip_id is not null do update set
    stripe_checkout_session_id = excluded.stripe_checkout_session_id,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    stripe_charge_id = excluded.stripe_charge_id,
    stripe_balance_transaction_id = coalesce(excluded.stripe_balance_transaction_id, public.payment_fee_ledger.stripe_balance_transaction_id),
    actual_stripe_fee_cents = coalesce(excluded.actual_stripe_fee_cents, public.payment_fee_ledger.actual_stripe_fee_cents),
    processing_fee_variance_cents = coalesce(excluded.processing_fee_variance_cents, public.payment_fee_ledger.processing_fee_variance_cents),
    updated_at = v_now
  returning id into v_ledger_id;

  if v_tip.earnings_credited_at is null then
    update public.profiles
      set total_earnings_cents = coalesce(total_earnings_cents, 0) + v_tip.creator_net_cents
      where id = v_tip.creator_id;
    update public.payment_fee_ledger
      set earnings_credited_at = coalesce(earnings_credited_at, v_now), updated_at = v_now
      where id = v_ledger_id;
    v_credited := true;
  end if;

  update public.tips set
    stripe_checkout_session_id = p_session_id,
    stripe_payment_intent_id = p_payment_intent_id,
    stripe_charge_id = p_charge_id,
    stripe_balance_transaction_id = coalesce(p_balance_transaction_id, stripe_balance_transaction_id),
    status = 'paid', failure_code = null,
    earnings_credited_at = coalesce(earnings_credited_at, v_now),
    paid_at = coalesce(paid_at, v_now), updated_at = v_now
  where id = v_tip.id;

  insert into public.notifications(recipient_id, actor_id, kind, tip_id, post_id, created_at)
  values (v_tip.creator_id, v_tip.tipper_id, 'tip_received', v_tip.id, v_tip.post_id, v_now)
  on conflict (kind, recipient_id, tip_id) where tip_id is not null do nothing;

  return v_credited;
end;
$$;

create or replace function public.apply_video_tip_refund(
  p_tip_id uuid,
  p_refunded_amount_cents bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refunded bigint;
  v_gross bigint;
begin
  select gross_amount_cents, refunded_amount_cents
    into v_gross, v_refunded from public.tips where id = p_tip_id for update;
  if not found then return 0; end if;
  v_refunded := least(v_gross, greatest(v_refunded, p_refunded_amount_cents, 0));
  update public.tips set refunded_amount_cents = v_refunded,
    refund_updated_at = now(), updated_at = now() where id = p_tip_id;
  return v_refunded;
end;
$$;

create or replace function public.record_tip_dispute_recovery(
  p_dispute_id text,
  p_tip_id uuid,
  p_payment_intent_id text,
  p_charge_id text,
  p_transfer_id text,
  p_disputed_amount_cents bigint,
  p_event_created bigint,
  p_reversal_amount_cents bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_written boolean;
  v_existing public.tip_dispute_recoveries%rowtype;
begin
  select * into v_existing from public.tip_dispute_recoveries where stripe_dispute_id = p_dispute_id;
  if found and (
    v_existing.tip_id <> p_tip_id or
    v_existing.stripe_payment_intent_id <> p_payment_intent_id or
    v_existing.stripe_charge_id <> p_charge_id or
    v_existing.stripe_transfer_id <> p_transfer_id
  ) then
    raise exception 'tip dispute provider linkage differs';
  end if;
  insert into public.tip_dispute_recoveries (
    stripe_dispute_id, tip_id, stripe_payment_intent_id, stripe_charge_id,
    stripe_transfer_id, disputed_amount_cents, stripe_event_created, reversal_amount_cents
  ) values (
    p_dispute_id, p_tip_id, p_payment_intent_id, p_charge_id,
    p_transfer_id, p_disputed_amount_cents, p_event_created, p_reversal_amount_cents
  )
  on conflict (stripe_dispute_id) do update set
    tip_id = excluded.tip_id,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    stripe_charge_id = excluded.stripe_charge_id,
    stripe_transfer_id = excluded.stripe_transfer_id,
    disputed_amount_cents = greatest(public.tip_dispute_recoveries.disputed_amount_cents, excluded.disputed_amount_cents),
    stripe_event_created = excluded.stripe_event_created,
    updated_at = now()
  where public.tip_dispute_recoveries.stripe_event_created <= excluded.stripe_event_created
    and public.tip_dispute_recoveries.tip_id = excluded.tip_id
    and public.tip_dispute_recoveries.stripe_payment_intent_id = excluded.stripe_payment_intent_id
    and public.tip_dispute_recoveries.stripe_charge_id = excluded.stripe_charge_id
    and public.tip_dispute_recoveries.stripe_transfer_id = excluded.stripe_transfer_id
  returning true into v_written;
  return coalesce(v_written, false);
end;
$$;

create or replace function public.record_tip_dispute_recovery_progress(
  p_dispute_id text,
  p_event_created bigint,
  p_kind text,
  p_status text,
  p_provider_id text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_written boolean := false;
begin
  if p_kind not in ('reversal','restoration') or p_status not in ('pending','succeeded','failed') then
    raise exception 'invalid tip dispute recovery progress';
  end if;
  if p_status = 'succeeded' and p_kind = 'restoration' and p_provider_id is null then
    raise exception 'tip dispute restoration transfer identity is missing';
  end if;
  if p_status = 'succeeded' and p_kind = 'reversal' and p_provider_id is null and exists (
    select 1 from public.tip_dispute_recoveries where stripe_dispute_id = p_dispute_id
      and reversal_amount_cents > 0
  ) then
    raise exception 'tip dispute reversal identity is missing';
  end if;
  if p_kind = 'reversal' then
    update public.tip_dispute_recoveries set
      reversal_id = case when p_status = 'succeeded' then coalesce(reversal_id, p_provider_id) else reversal_id end,
      reversal_status = case when reversal_status = 'succeeded' then reversal_status else p_status end,
      reversal_error_code = case when reversal_status = 'succeeded' or p_status = 'succeeded' then null else p_error_code end,
      reversal_updated_at = now(), updated_at = now()
    where stripe_dispute_id = p_dispute_id and stripe_event_created <= p_event_created
      and (reversal_id is null or reversal_id = p_provider_id)
    returning true into v_written;
  else
    update public.tip_dispute_recoveries set
      restoration_transfer_id = case when p_status = 'succeeded' then coalesce(restoration_transfer_id, p_provider_id) else restoration_transfer_id end,
      restoration_status = case when restoration_status = 'succeeded' then restoration_status else p_status end,
      restoration_error_code = case when restoration_status = 'succeeded' or p_status = 'succeeded' then null else p_error_code end,
      restoration_updated_at = now(), updated_at = now()
    where stripe_dispute_id = p_dispute_id and stripe_event_created <= p_event_created
      and (restoration_transfer_id is null or restoration_transfer_id = p_provider_id)
    returning true into v_written;
  end if;
  return coalesce(v_written, false);
end;
$$;

revoke all on function public.bind_video_tip_checkout(uuid, text) from public, anon, authenticated;
revoke all on function public.create_or_get_video_tip(uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, bigint, bigint, boolean, integer, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.finalize_video_tip(uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.apply_video_tip_refund(uuid, bigint) from public, anon, authenticated;
revoke all on function public.record_tip_dispute_recovery(text, uuid, text, text, text, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.record_tip_dispute_recovery_progress(text, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.bind_video_tip_checkout(uuid, text) to service_role;
grant execute on function public.create_or_get_video_tip(uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, bigint, bigint, boolean, integer, integer, text, text, text) to service_role;
grant execute on function public.finalize_video_tip(uuid, text, text, text, text, bigint) to service_role;
grant execute on function public.apply_video_tip_refund(uuid, bigint) to service_role;
grant execute on function public.record_tip_dispute_recovery(text, uuid, text, text, text, bigint, bigint, bigint) to service_role;
grant execute on function public.record_tip_dispute_recovery_progress(text, bigint, text, text, text, text) to service_role;

-- Keep the active batched Discover transport aware of the new public boolean.
create or replace function public.discover_inventory_batch_v1(p_ids uuid[])
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
 if p_ids is null or cardinality(p_ids)>200 then
  raise exception 'Invalid inventory batch' using errcode='22023';
 end if;
 with selected_posts as (
  select id,creator_id,product_id,offering_id,title,content,caption,interests,topics,hashtags,
   created_at,video_url,poster_url,price_cents,allow_booking,booking_url,tips_enabled,likes_count,
   comments_count,shares_count,purchase_count,active,hidden_at,removed_at
  from public.posts where id=any(p_ids)
 ), selected_profiles as (
  select id,full_name,username,avatar_url,banned_at,stripe_account_id,stripe_onboarding_complete
  from public.profiles where id in(select creator_id from selected_posts)
 ), primary_products as (
  select id,product_id,creator_id,title,description,type,price_cents,amount_cents,active
  from public.products where id in(select product_id from selected_posts)
 ), legacy_products as (
  select id,product_id,creator_id,title,description,type,price_cents,amount_cents,active
  from public.products where product_id in(select product_id from selected_posts)
 ), selected_offerings as (
  select id,creator_id,title,type,product_metadata,is_active
  from public.offerings where id in(select offering_id from selected_posts)
 )
 select jsonb_build_object(
  'posts',coalesce((select jsonb_agg(to_jsonb(p)) from selected_posts p),'[]'::jsonb),
  'profiles',coalesce((select jsonb_agg(to_jsonb(p)) from selected_profiles p),'[]'::jsonb),
  'primaryProducts',coalesce((select jsonb_agg(to_jsonb(p)) from primary_products p),'[]'::jsonb),
  'legacyProducts',coalesce((select jsonb_agg(to_jsonb(p)) from legacy_products p),'[]'::jsonb),
  'offerings',coalesce((select jsonb_agg(to_jsonb(p)) from selected_offerings p),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.discover_inventory_batch_v1(uuid[]) from public,anon,authenticated;
grant execute on function public.discover_inventory_batch_v1(uuid[]) to service_role;

commit;
