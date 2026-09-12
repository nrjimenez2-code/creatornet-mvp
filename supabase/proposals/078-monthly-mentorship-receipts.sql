-- UNAPPLIED. Locked plan steps 1/2/4/5/7/8: owned monthly service state.
-- This does not initiate Stripe operations, install a scheduler, or enable checkout.
-- The provider adapter must independently verify capture/account/customer/fees
-- and reconcile known refunds/disputes before calling the service-only receipt RPC.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regclass('public.product_purchase_consents_v1') is null or
    to_regprocedure('public.valid_monthly_mentorship_terms_v1(text,jsonb)') is null or
    to_regclass('public.monthly_mentorship_agreements_v1') is not null then
    raise exception 'Monthly receipt prerequisites differ'; end if;
end;
$preflight$;

create function public.monthly_mentorship_boundary_v1(p_anchor bigint,p_months integer)
returns bigint language plpgsql immutable set search_path=pg_catalog as $$
begin
  if p_anchor is null or p_anchor<=0 or p_months is null or p_months<0 then raise exception 'Invalid membership period'; end if;
  return extract(epoch from ((to_timestamp(p_anchor) at time zone 'UTC')+make_interval(months=>p_months)) at time zone 'UTC')::bigint;
end;
$$;
create function public.valid_monthly_fee_snapshot_v1(p jsonb,p_gross integer)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare v_processing bigint;
begin
  if p is null or jsonb_typeof(p)<>'object' or p_gross<50 or
    jsonb_typeof(p->'processingFeeEnabled') is distinct from 'boolean' or
    not coalesce((p->>'processingFeeBasisPoints') ~ '^\d+$',false) or
    not coalesce((p->>'processingFeeFixedCents') ~ '^\d+$',false) or
    (p->>'processingFeeBasisPoints')::bigint>10000 or length(coalesce(p->>'feeScheduleVersion',''))=0 then return false; end if;
  v_processing := case when (p->>'processingFeeEnabled')::boolean then
    round(p_gross::numeric*(p->>'processingFeeBasisPoints')::numeric/10000)::bigint+(p->>'processingFeeFixedCents')::bigint else 0 end;
  return coalesce(p->>'grossAmountCents'=p_gross::text and
    p->>'platformFeeCents'=round(p_gross::numeric*1200/10000)::bigint::text and
    p->>'processingFeeCents'=v_processing::text and
    (p->>'totalCreatorDeductionCents')::bigint=round(p_gross::numeric*1200/10000)::bigint+v_processing and
    (p->>'creatorNetCents')::bigint=p_gross-(p->>'totalCreatorDeductionCents')::bigint and
    (p->>'creatorNetCents')::bigint>=0 and ((p->>'processingFeeEnabled')::boolean or
      ((p->>'processingFeeBasisPoints')::bigint=0 and (p->>'processingFeeFixedCents')::bigint=0)),false);
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;

create table public.monthly_mentorship_agreements_v1 (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.purchases(id) deferrable initially deferred,
  buyer_id uuid not null references public.profiles(id), creator_id uuid not null references public.profiles(id),
  product_id uuid not null references public.products(id), post_id uuid not null references public.posts(id),
  terms jsonb not null, fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
  monthly_price_cents integer not null check(monthly_price_cents between 50 and 99999999),
  minimum_months integer not null check(minimum_months between 1 and 24), auto_renew boolean not null,
  accepted_at timestamptz not null default clock_timestamp(),
  stripe_customer_id text unique, stripe_subscription_id text unique, stripe_checkout_session_id text unique,
  anchor_at bigint, covered_months integer not null default 0 check(covered_months>=0),
  revision bigint not null default 0, financial_hold_at timestamptz, renewal_stopped_at timestamptz, debit_revoked_at timestamptz,
  unique(buyer_id,product_id), check(buyer_id<>creator_id),
  check(monthly_price_cents::bigint*minimum_months<=99999999),
  check((anchor_at is null and covered_months=0) or anchor_at>0)
);
alter table public.purchases add column monthly_mentorship_id uuid unique references public.monthly_mentorship_agreements_v1(id);
create table public.monthly_mentorship_receipts_v1 (
  agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  month_number integer not null check(month_number>=1),
  ledger_id uuid not null unique references public.payment_fee_ledger(id),
  period_start bigint not null, period_end bigint not null check(period_end>period_start),
  provider_proof jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
  primary key(agreement_id,month_number)
);
alter table public.monthly_mentorship_agreements_v1 enable row level security;
alter table public.monthly_mentorship_receipts_v1 enable row level security;
revoke all on public.monthly_mentorship_agreements_v1,public.monthly_mentorship_receipts_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_agreements_v1,public.monthly_mentorship_receipts_v1 to service_role;

create function public.guard_monthly_mentorship_purchase_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
begin
  if tg_op='UPDATE' and old.monthly_mentorship_id is not null and new.monthly_mentorship_id is distinct from old.monthly_mentorship_id then
    raise exception 'Monthly purchase identity cannot be replaced'; end if;
  if new.monthly_mentorship_id is null then
    if exists(select 1 from public.products where id=new.product_id and membership_terms is not null) then
      raise exception 'Monthly offer requires its owned membership purchase'; end if;
    return new;
  end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=new.monthly_mentorship_id;
  if not found or a.purchase_id is distinct from new.id or a.buyer_id is distinct from new.buyer_id or
    a.creator_id is distinct from new.creator_id or a.product_id is distinct from new.product_id or a.post_id is distinct from new.post_id or
    new.kind is distinct from 'monthly_mentorship_v1' or new.access_granted is distinct from false or
    new.earnings_credited_at is not null or coalesce(new.paid_count,0)<>0 or new.target_months is not null or
    new.subscription_id is distinct from a.stripe_subscription_id then
    raise exception 'Monthly service cannot use legacy ownership, entitlement, or installment credit'; end if;
  return new;
end;
$$;
create trigger guard_monthly_mentorship_purchase_v1 before insert or update on public.purchases
for each row execute function public.guard_monthly_mentorship_purchase_v1();

create function public.reserve_monthly_mentorship_v1(p_buyer_id uuid,p_product_id uuid,p_post_id uuid,
  p_terms jsonb,p_fingerprint text,p_accepted boolean) returns uuid
language plpgsql security definer set search_path=pg_catalog as $$
declare p public.products%rowtype; v_id uuid; v_purchase uuid:=gen_random_uuid(); a public.monthly_mentorship_agreements_v1%rowtype;
begin
  if p_accepted is distinct from true or p_buyer_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Explicit current membership acceptance is required'; end if;
  select * into p from public.products where id=p_product_id for share;
  if not found or p.membership_terms is null or not public.valid_monthly_mentorship_terms_v1(p.type,p.membership_terms) or
    p.creator_id is null or p.creator_id=p_buyer_id or p.currency is distinct from 'usd' or p.price_cents is distinct from p.amount_cents or
    p_terms->>'version' is distinct from 'monthly-mentorship-purchase-v1' or p_terms->>'kind' is distinct from 'monthly_mentorship' or
    p_terms->>'buyerId' is distinct from p_buyer_id::text or p_terms->>'creatorId' is distinct from p.creator_id::text or
    p_terms->>'productId' is distinct from p_product_id::text or p_terms->>'postId' is distinct from p_post_id::text or
    p_terms->>'title' is distinct from p.title or p_terms->>'description' is distinct from coalesce(p.description,'') or
    p_terms->>'currency' is distinct from 'usd' or p_terms->>'monthlyPriceCents' is distinct from p.price_cents::text or
    p_terms->>'minimumMonths' is distinct from p.membership_terms->>'minimumMonths' or
    p_terms->>'autoRenew' is distinct from p.membership_terms->>'autoRenew' or
    p_terms->>'minimumTotalCents' is distinct from (p.price_cents::bigint*(p.membership_terms->>'minimumMonths')::integer)::text or
    p_terms->>'policyVersion' is distinct from 'creatornet-purchase-2026-09-09-v1' or
    p_terms#>>'{policy,version}' is distinct from 'creatornet-purchase-2026-09-09-v1' or
    not public.valid_monthly_fee_snapshot_v1(p_terms->'firstMonthFees',p.price_cents) or
    not public.valid_monthly_fee_snapshot_v1(p_terms->'recurringMonthFees',p.price_cents) or
    not coalesce(p_terms#>>'{paymentContext,stripeAccountId}' ~ '^acct_[A-Za-z0-9]+$',false) or
    not coalesce(p_terms#>>'{paymentContext,mode}' in ('test','live'),false) or
    p_terms#>>'{paymentContext,apiVersion}' is distinct from '2025-10-29.clover' or
    not coalesce(p_terms#>>'{paymentContext,supabaseProjectRef}' ~ '^[a-z0-9]{20}$',false) or
    not coalesce(p_terms#>>'{paymentContext,siteOrigin}' ~ '^https://[^/?#@]+$',false) then
    raise exception 'Monthly consent does not match the owned current offer'; end if;
  if not exists(select 1 from public.posts where id=p_post_id and creator_id=p.creator_id and product_id=p.id) then
    raise exception 'Post does not sell the monthly offer'; end if;
  if not exists(select 1 from public.profiles where id=p.creator_id and stripe_account_id=p_terms->>'destinationId' and
    stripe_account_id ~ '^acct_[A-Za-z0-9]+$') then raise exception 'Monthly creator payout binding differs'; end if;
  insert into public.monthly_mentorship_agreements_v1(purchase_id,buyer_id,creator_id,product_id,post_id,terms,fingerprint,
    monthly_price_cents,minimum_months,auto_renew)
    values(v_purchase,p_buyer_id,p.creator_id,p.id,p_post_id,p_terms,p_fingerprint,p.price_cents,
      (p.membership_terms->>'minimumMonths')::integer,(p.membership_terms->>'autoRenew')::boolean)
    on conflict(buyer_id,product_id) do nothing returning id into v_id;
  if v_id is null then
    select * into a from public.monthly_mentorship_agreements_v1 where buyer_id=p_buyer_id and product_id=p.id;
    if a.id is null or a.fingerprint is distinct from p_fingerprint or a.terms is distinct from p_terms or a.post_id is distinct from p_post_id then
      raise exception 'Existing monthly agreement differs; it cannot be reinterpreted'; end if;
    return a.id;
  end if;
  insert into public.purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,amount_cents,currency,status,kind,
    product_type,title,access_granted,monthly_mentorship_id)
    values(v_purchase,p_buyer_id,p_buyer_id,p.creator_id,p.id,p_post_id,p.price_cents,'usd','pending','monthly_mentorship_v1',
      'mentorship',p.title,false,v_id);
  return v_id;
end;
$$;

create function public.bind_monthly_mentorship_provider_v1(p_id uuid,p_customer_id text,p_subscription_id text,p_session_id text)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
begin
  if not coalesce(p_customer_id ~ '^cus_[A-Za-z0-9]+$',false) or not coalesce(p_subscription_id ~ '^sub_[A-Za-z0-9]+$',false) or
    not coalesce(p_session_id ~ '^cs_[A-Za-z0-9_]+$',false) then raise exception 'Invalid monthly provider binding'; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  if not found then raise exception 'Monthly agreement not found'; end if;
  if a.stripe_subscription_id is not null then
    if a.stripe_subscription_id is distinct from p_subscription_id or a.stripe_customer_id is distinct from p_customer_id or
      a.stripe_checkout_session_id is distinct from p_session_id then raise exception 'Monthly provider binding differs'; end if;
    return false;
  end if;
  if a.covered_months<>0 or a.financial_hold_at is not null or a.renewal_stopped_at is not null or a.debit_revoked_at is not null then
    raise exception 'Monthly billing is not eligible for binding'; end if;
  update public.monthly_mentorship_agreements_v1 set stripe_customer_id=p_customer_id,stripe_subscription_id=p_subscription_id,
    stripe_checkout_session_id=p_session_id,revision=revision+1 where id=p_id;
  update public.purchases set subscription_id=p_subscription_id,session_id=p_session_id where id=a.purchase_id;
  return true;
end;
$$;

create function public.record_monthly_mentorship_receipt_v1(p_id uuid,p_ledger_id uuid,p_month integer,p_start bigint,p_end bigint,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; l public.payment_fee_ledger%rowtype;
  r public.monthly_mentorship_receipts_v1%rowtype; v_anchor bigint; v_fees jsonb;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  if not found or a.stripe_subscription_id is null then raise exception 'Monthly provider binding is required'; end if;
  select * into r from public.monthly_mentorship_receipts_v1 where ledger_id=p_ledger_id;
  if found then
    if r.agreement_id is distinct from p_id or r.month_number is distinct from p_month or r.period_start is distinct from p_start or
      r.period_end is distinct from p_end or r.provider_proof is distinct from p_proof then raise exception 'Monthly receipt replay differs'; end if;
    return false;
  end if;
  if p_month is null or p_month<>a.covered_months+1 or p_start is null or p_end is null or p_start<=0 or
    (not a.auto_renew and p_month>a.minimum_months) then raise exception 'Monthly receipt is not the next agreed service period'; end if;
  v_anchor:=coalesce(a.anchor_at,p_start);
  if p_start<>public.monthly_mentorship_boundary_v1(v_anchor,p_month-1) or p_end<>public.monthly_mentorship_boundary_v1(v_anchor,p_month) or
    p_start>extract(epoch from clock_timestamp())::bigint then raise exception 'Monthly provider service period differs'; end if;
  select * into l from public.payment_fee_ledger where id=p_ledger_id for update;
  v_fees:=case when p_month=1 then a.terms->'firstMonthFees' else a.terms->'recurringMonthFees' end;
  if not found or l.purchase_id is distinct from a.purchase_id or l.creator_id is distinct from a.creator_id or
    l.currency is distinct from 'usd' or l.status not in ('paid','refunded') or l.earnings_credited_at is not null or
    l.gross_amount_cents<>a.monthly_price_cents or l.platform_fee_cents::text is distinct from v_fees->>'platformFeeCents' or
    l.processing_fee_cents::text is distinct from v_fees->>'processingFeeCents' or
    l.total_creator_deduction_cents::text is distinct from v_fees->>'totalCreatorDeductionCents' or
    l.creator_net_cents::text is distinct from v_fees->>'creatorNetCents' or l.fee_schedule_version is distinct from v_fees->>'feeScheduleVersion' or
    not coalesce(l.stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$',false) or not coalesce(l.stripe_charge_id ~ '^ch_[A-Za-z0-9]+$',false) or
    (p_month=1 and l.stripe_checkout_session_id is distinct from a.stripe_checkout_session_id) or
    (p_month>1 and not coalesce(l.stripe_invoice_id ~ '^in_[A-Za-z0-9]+$',false)) or
    p_proof->>'version' is distinct from 'monthly-mentorship-payment-proof-v1' or
    p_proof->'paymentContext' is distinct from a.terms->'paymentContext' or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    p_proof->>'checkoutSessionId' is distinct from a.stripe_checkout_session_id or
    p_proof->>'destinationId' is distinct from a.terms->>'destinationId' or
    p_proof->>'paymentIntentId' is distinct from l.stripe_payment_intent_id or p_proof->>'chargeId' is distinct from l.stripe_charge_id or
    p_proof->>'invoiceId' is distinct from l.stripe_invoice_id or p_proof->>'capturedAmountCents' is distinct from a.monthly_price_cents::text or
    p_proof->>'applicationFeeAmountCents' is distinct from l.total_creator_deduction_cents::text or
    p_proof->>'paymentStatus' is distinct from 'succeeded' then raise exception 'Monthly captured-payment evidence differs'; end if;
  insert into public.monthly_mentorship_receipts_v1(agreement_id,month_number,ledger_id,period_start,period_end,provider_proof)
    values(p_id,p_month,p_ledger_id,p_start,p_end,p_proof);
  -- The same ledger credit marker and creator cent balance as the existing
  -- accounting engine; no separate money balance or installment counter.
  update public.profiles set total_earnings_cents=coalesce(total_earnings_cents,0)+greatest(0,l.creator_net_cents-l.earnings_reversed_cents)
    where id=a.creator_id;
  if not found then raise exception 'Monthly creator profile missing'; end if;
  update public.payment_fee_ledger set earnings_credited_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_ledger_id;
  update public.monthly_mentorship_agreements_v1 set anchor_at=v_anchor,covered_months=p_month,revision=revision+1 where id=p_id;
  -- Never overwrite refunded status, earlier first-access evidence or the
  -- legacy false access bit. Entitlement is calculated independently below.
  update public.purchases set status=case when status='pending' then 'active' else status end,
    first_access_at=coalesce(first_access_at,clock_timestamp()),paid_at=coalesce(paid_at,clock_timestamp()) where id=a.purchase_id;
  return true;
end;
$$;

create function public.read_monthly_mentorship_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p public.purchases%rowtype; a public.monthly_mentorship_agreements_v1%rowtype;
  v_until bigint; v_now numeric:=extract(epoch from clock_timestamp()); v_seconds integer;
begin
  select * into p from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id;
  if not found then return jsonb_build_object('allowed',false,'maxAgeSeconds',0); end if;
  if p.monthly_mentorship_id is null then
    return jsonb_build_object('allowed',p.access_granted and p.status<>'refunded','maxAgeSeconds',case when p.access_granted and p.status<>'refunded' then 3600 else 0 end);
  end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=p.monthly_mentorship_id and purchase_id=p.id and buyer_id=p_buyer_id;
  if not found or a.financial_hold_at is not null or p.status='refunded' then return jsonb_build_object('allowed',false,'maxAgeSeconds',0); end if;
  select r.period_end into v_until from public.monthly_mentorship_receipts_v1 r join public.payment_fee_ledger l on l.id=r.ledger_id
    where r.agreement_id=a.id and r.period_start<=v_now and r.period_end>v_now and l.purchase_id=p.id and l.creator_id=a.creator_id and
      l.earnings_credited_at is not null and l.status='paid' and l.refunded_amount_cents<l.gross_amount_cents and
      (l.dispute_status is null or l.dispute_status in ('won','warning_closed')) order by r.month_number desc limit 1;
  v_seconds:=greatest(0,least(3600,floor(coalesce(v_until,v_now)-v_now)::integer));
  return jsonb_build_object('allowed',v_seconds>0,'maxAgeSeconds',v_seconds,'paidThrough',v_until);
end;
$$;

revoke all on function public.monthly_mentorship_boundary_v1(bigint,integer),public.valid_monthly_fee_snapshot_v1(jsonb,integer),
  public.guard_monthly_mentorship_purchase_v1(),public.reserve_monthly_mentorship_v1(uuid,uuid,uuid,jsonb,text,boolean),
  public.bind_monthly_mentorship_provider_v1(uuid,text,text,text),public.record_monthly_mentorship_receipt_v1(uuid,uuid,integer,bigint,bigint,jsonb),
  public.read_monthly_mentorship_entitlement_v1(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.reserve_monthly_mentorship_v1(uuid,uuid,uuid,jsonb,text,boolean),
  public.bind_monthly_mentorship_provider_v1(uuid,text,text,text),public.record_monthly_mentorship_receipt_v1(uuid,uuid,integer,bigint,bigint,jsonb),
  public.read_monthly_mentorship_entitlement_v1(uuid,uuid) to service_role;
commit;
