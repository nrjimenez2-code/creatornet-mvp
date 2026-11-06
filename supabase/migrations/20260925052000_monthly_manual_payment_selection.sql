begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

-- Source exclusivity only. This migration grants no payment dispatch,
-- provider binding, receipt, access, earnings, or terminal-release authority.
do $preflight$ begin
  if current_user<>'postgres' or
    to_regclass('public.monthly_mentorship_initial_closures_v1') is null or
    to_regclass('public.monthly_manual_payment_selections_v1') is not null then
    raise exception 'Monthly manual selection prerequisites differ';
  end if;
end $preflight$;

create table public.monthly_manual_payment_selections_v1 (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  buyer_id uuid not null references public.profiles(id),
  kind text not null check(kind in ('first','payoff')),
  payoff_id uuid unique references public.monthly_mentorship_payoffs_v1(id),
  protocol text not null default 'creatornet-us-manual-confirmation-v1'
    check(protocol='creatornet-us-manual-confirmation-v1'),
  context jsonb not null check(jsonb_typeof(context)='object'),
  source jsonb not null check(jsonb_typeof(source)='object'),
  selected_at timestamptz not null default clock_timestamp(),
  check((kind='first' and payoff_id is null) or (kind='payoff' and payoff_id is not null))
);
create unique index monthly_manual_first_selection_v1
  on public.monthly_manual_payment_selections_v1(agreement_id) where kind='first';
alter table public.monthly_manual_payment_selections_v1 enable row level security;
revoke all on public.monthly_manual_payment_selections_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_manual_payment_selections_v1 to service_role;

create function public.select_monthly_manual_payment_v1(
  p_id uuid,p_buyer_id uuid,p_context jsonb,p_kind text,p_payoff_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
  pf public.monthly_mentorship_payoffs_v1%rowtype;
  selected public.monthly_manual_payment_selections_v1%rowtype;
  accepted bigint; expiry bigint; amount bigint; fingerprint text; terms jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_kind is null or
    p_kind not in ('first','payoff') or
    (p_kind='first' and p_payoff_id is not null) or (p_kind='payoff' and p_payoff_id is null) then
    raise exception 'Exact monthly manual source required'; end if;
  -- Same row lock and order used by hosted operation and payoff admission.
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or
    a.terms->'paymentContext' is distinct from p_context then
    raise exception 'Owned monthly manual source unavailable'; end if;
  select * into selected from public.monthly_manual_payment_selections_v1
    where agreement_id=a.id and kind=p_kind and payoff_id is not distinct from p_payoff_id;
  if found then
    if selected.buyer_id is distinct from p_buyer_id or selected.context is distinct from p_context then
      raise exception 'Original monthly manual source differs'; end if;
    -- Idempotent provenance read only, including after expiry or a stop. A
    -- future dispatch adapter must separately recheck current debit authority.
    return to_jsonb(selected);
  end if;
  if a.financial_hold_at is not null or a.debit_revoked_at is not null or
    a.initial_abandon_requested_at is not null or a.initial_abandoned_at is not null then
    raise exception 'Monthly manual source is stopped or under review'; end if;
  if p_kind='first' then
    if a.covered_months<>0 or a.anchor_at is not null or a.renewal_stopped_at is not null or
      a.stripe_checkout_session_id is not null or a.payoff_hold_at is not null or
      exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind in ('checkout','activate','collect')) or
      exists(select 1 from public.monthly_mentorship_receipts_v1 where agreement_id=a.id) or
      exists(select 1 from public.payment_fee_ledger where purchase_id=a.purchase_id) or
      exists(select 1 from public.monthly_mentorship_initial_closures_v1 where agreement_id=a.id) then
      raise exception 'Existing monthly hosted or payment activity requires original recovery'; end if;
    accepted:=floor(extract(epoch from a.accepted_at));expiry:=accepted+23*3600;
    amount:=a.monthly_price_cents;fingerprint:=a.fingerprint;terms:=a.terms;
  else
    select * into pf from public.monthly_mentorship_payoffs_v1
      where id=p_payoff_id and agreement_id=a.id for update;
    if not found or pf.buyer_id is distinct from p_buyer_id or pf.status<>'accepted' or
      pf.checkout_request is not null or pf.checkout_dispatched_at is not null or
      pf.stripe_checkout_session_id is not null or pf.checkout_request_id is not null or
      pf.ledger_id is not null or pf.provider_proof is not null or pf.captured_at is not null or
      pf.abandoned_at is not null or pf.abandonment_proof is not null or
      a.payoff_hold_at is null or a.covered_months<1 or pf.first_unpaid_month<>a.covered_months+1 or
      pf.terms->'paymentContext' is distinct from p_context or
      exists(select 1 from public.monthly_mentorship_operations_v1 o where o.agreement_id=a.id and o.kind='collect'
        and not exists(select 1 from public.monthly_mentorship_receipts_v1 r where r.agreement_id=a.id and r.month_number::text=o.scope_key)) then
      raise exception 'Existing monthly payoff activity requires original recovery'; end if;
    accepted:=floor(extract(epoch from pf.accepted_at));expiry:=least(accepted+23*3600,pf.period_end);
    amount:=pf.amount_cents;fingerprint:=pf.fingerprint;terms:=pf.terms;
  end if;
  if expiry<=floor(extract(epoch from clock_timestamp())) then
    raise exception 'Monthly manual acceptance expired'; end if;
  insert into public.monthly_manual_payment_selections_v1(agreement_id,buyer_id,kind,payoff_id,context,source)
    values(a.id,a.buyer_id,p_kind,p_payoff_id,p_context,jsonb_build_object(
      'agreementId',a.id,'purchaseId',a.purchase_id,'buyerId',a.buyer_id,'creatorId',a.creator_id,
      'productId',a.product_id,'postId',a.post_id,'agreementFingerprint',a.fingerprint,
      'sourceFingerprint',fingerprint,'terms',terms,'amountCents',amount,
      'acceptedAt',accepted,'expiresAt',expiry,'revision',a.revision)) returning * into selected;
  return to_jsonb(selected);
end $$;
revoke all on function public.select_monthly_manual_payment_v1(uuid,uuid,jsonb,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.select_monthly_manual_payment_v1(uuid,uuid,jsonb,text,uuid) to service_role;

create function public.guard_monthly_manual_selection_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  raise exception 'Original monthly manual selection is immutable';
end $$;
create trigger guard_monthly_manual_selection_v1 before update or delete
  on public.monthly_manual_payment_selections_v1 for each row execute function public.guard_monthly_manual_selection_v1();

create function public.guard_monthly_manual_hosted_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare agreement uuid;
begin
  if tg_table_name='monthly_mentorship_operations_v1' then
    if new.kind<>'checkout' and (tg_op='INSERT' or old.kind<>'checkout') then return new; end if;
    agreement:=new.agreement_id;
  elsif tg_table_name='monthly_mentorship_initial_closures_v1' then
    agreement:=new.agreement_id;
  else raise exception 'Unexpected monthly manual guard target'; end if;
  perform 1 from public.monthly_mentorship_agreements_v1 where id=agreement for update;
  if exists(select 1 from public.monthly_manual_payment_selections_v1 where agreement_id=agreement and kind='first') then
    raise exception 'Monthly manual selection requires its own confirmation and terminal recovery'; end if;
  return new;
end $$;
create trigger guard_monthly_manual_hosted_v1 before insert or update on public.monthly_mentorship_operations_v1
  for each row execute function public.guard_monthly_manual_hosted_v1();
create trigger guard_monthly_manual_hosted_v1 before insert or update on public.monthly_mentorship_initial_closures_v1
  for each row execute function public.guard_monthly_manual_hosted_v1();

create function public.guard_monthly_manual_agreement_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if not exists(select 1 from public.monthly_manual_payment_selections_v1 where agreement_id=old.id) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then raise exception 'Original monthly manual agreement cannot be deleted'; end if;
  -- Operational/monitoring fields outside the source stay writable through
  -- their existing guarded APIs, including independent stop/hold signals.
  if new.id is distinct from old.id or new.purchase_id is distinct from old.purchase_id or
      new.buyer_id is distinct from old.buyer_id or new.creator_id is distinct from old.creator_id or
      new.product_id is distinct from old.product_id or new.post_id is distinct from old.post_id or
      new.terms is distinct from old.terms or new.fingerprint is distinct from old.fingerprint or
      new.monthly_price_cents is distinct from old.monthly_price_cents or new.minimum_months is distinct from old.minimum_months or
      new.auto_renew is distinct from old.auto_renew or new.accepted_at is distinct from old.accepted_at then
      raise exception 'Original monthly manual terms cannot change'; end if;
  if exists(select 1 from public.monthly_manual_payment_selections_v1 where agreement_id=old.id and kind='first') and
    (new.stripe_checkout_session_id is not null or new.initial_abandoned_at is distinct from old.initial_abandoned_at) then
    raise exception 'Monthly manual first payment cannot use hosted publication or abandonment'; end if;
  return new;
end $$;
create trigger guard_monthly_manual_agreement_v1 before update or delete on public.monthly_mentorship_agreements_v1
  for each row execute function public.guard_monthly_manual_agreement_v1();

create function public.guard_monthly_manual_payoff_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if not exists(select 1 from public.monthly_manual_payment_selections_v1 where payoff_id=old.id) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then raise exception 'Original manual payoff cannot be deleted'; end if;
  if new.id is distinct from old.id or new.agreement_id is distinct from old.agreement_id or new.buyer_id is distinct from old.buyer_id or
    new.terms is distinct from old.terms or new.fingerprint is distinct from old.fingerprint or new.amount_cents is distinct from old.amount_cents or
    new.remaining_months is distinct from old.remaining_months or new.first_unpaid_month is distinct from old.first_unpaid_month or
    new.period_start is distinct from old.period_start or new.period_end is distinct from old.period_end or new.accepted_at is distinct from old.accepted_at or
    new.checkout_request is not null or new.checkout_dispatched_at is not null or new.stripe_checkout_session_id is not null or
    new.checkout_request_id is not null or new.status='abandoned' or new.abandoned_at is not null or new.abandonment_proof is not null then
    raise exception 'Original manual payoff requires its own confirmation and terminal recovery'; end if;
  return new;
end $$;
create trigger guard_monthly_manual_payoff_v1 before update or delete on public.monthly_mentorship_payoffs_v1
  for each row execute function public.guard_monthly_manual_payoff_v1();

revoke all on function public.guard_monthly_manual_selection_v1(),public.guard_monthly_manual_hosted_v1(),
  public.guard_monthly_manual_agreement_v1(),public.guard_monthly_manual_payoff_v1() from public,anon,authenticated,service_role;
commit;
