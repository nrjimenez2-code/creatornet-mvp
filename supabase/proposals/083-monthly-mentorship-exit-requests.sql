-- UNAPPLIED. Locked steps 2/4/5/8. No charge, refund or balance waiver.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or to_regprocedure('public.finish_monthly_mentorship_work_v1(uuid,uuid,jsonb,text)') is null then
    raise exception 'Monthly exit prerequisites differ'; end if;
end;
$preflight$;
create table public.monthly_mentorship_exit_requests_v1 (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  buyer_id uuid not null references public.profiles(id),
  kind text not null check(kind in ('stop_renewal','revoke_debits')),
  accepted_snapshot jsonb not null,
  requested_at timestamptz not null default clock_timestamp(),
  provider_started_at timestamptz,
  provider_completed_at timestamptz,
  provider_proof jsonb,
  status text not null default 'requested' check(status in ('requested','dispatching','review_required','provider_stopped')),
  unique(agreement_id,kind),
  check((status='provider_stopped' and provider_completed_at is not null and provider_proof is not null) or
    (status<>'provider_stopped' and provider_completed_at is null and provider_proof is null))
);
alter table public.monthly_mentorship_exit_requests_v1 enable row level security;
revoke all on public.monthly_mentorship_exit_requests_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_exit_requests_v1 to service_role;

create function public.read_monthly_mentorship_exit_quote_v1(p_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_reasons jsonb:='[]'::jsonb;
  v_remaining integer; v_paid_through bigint; v_min_end bigint; v_count integer;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Monthly exit ownership differs'; end if;
  v_remaining:=greatest(0,a.minimum_months-a.covered_months);
  v_min_end:=case when a.anchor_at is not null then public.monthly_mentorship_boundary_v1(a.anchor_at,a.minimum_months) end;
  select count(*)::integer into v_count from public.monthly_mentorship_receipts_v1 where agreement_id=a.id;
  if a.covered_months=0 or v_count<>a.covered_months then v_reasons:=v_reasons||'["receipt_state_requires_review"]'::jsonb; end if;
  if a.financial_hold_at is not null then v_reasons:=v_reasons||'["financial_hold"]'::jsonb; end if;
  if exists(select 1 from public.payment_fee_ledger l where l.purchase_id=a.purchase_id and
    (l.status<>'paid' or l.refunded_amount_cents<>0 or
      (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')))) then
    v_reasons:=v_reasons||'["refund_or_payment_review"]'::jsonb; end if;
  if exists(select 1 from public.payment_fee_ledger l where l.purchase_id=a.purchase_id and not exists(
    select 1 from public.monthly_mentorship_receipts_v1 r where r.agreement_id=a.id and r.ledger_id=l.id)) then
    v_reasons:=v_reasons||'["unreconciled_payment"]'::jsonb; end if;
  if exists(select 1 from public.monthly_mentorship_operations_v1 o where o.agreement_id=a.id and o.kind='collect' and not exists(
    select 1 from public.monthly_mentorship_receipts_v1 r where r.agreement_id=a.id and r.month_number::text=o.scope_key)) then
    v_reasons:=v_reasons||'["collection_in_flight_or_review"]'::jsonb; end if;
  if v_remaining>0 and v_min_end<=extract(epoch from clock_timestamp())::bigint then
    v_reasons:=v_reasons||'["elapsed_unpaid_minimum"]'::jsonb; end if;
  select max(r.period_end) into v_paid_through from public.monthly_mentorship_receipts_v1 r
    join public.payment_fee_ledger l on l.id=r.ledger_id where r.agreement_id=a.id and l.purchase_id=a.purchase_id and
      l.status='paid' and l.earnings_credited_at is not null and l.refunded_amount_cents<l.gross_amount_cents and
      (l.dispute_status is null or l.dispute_status in ('won','warning_closed'));
  if a.financial_hold_at is not null then v_paid_through:=null; end if;
  return jsonb_build_object('version','monthly-exit-quote-v1','membershipId',a.id,'revision',a.revision,
    'agreementFingerprint',a.fingerprint,'monthlyPriceCents',a.monthly_price_cents,'minimumMonths',a.minimum_months,
    'minimumTotalCents',a.monthly_price_cents::bigint*a.minimum_months,'coveredMonths',a.covered_months,
    'remainingMonths',v_remaining,'payoffAmountCents',case when v_reasons='[]'::jsonb then v_remaining*a.monthly_price_cents end,
    'paidThrough',v_paid_through,'minimumEnd',v_min_end,'reviewReasons',v_reasons,
    'renewalStopped',a.renewal_stopped_at is not null,'debitsRevoked',a.debit_revoked_at is not null,
    'policyVersion',a.terms->>'policyVersion');
end;
$$;

create function public.request_monthly_mentorship_exit_v1(p_id uuid,p_buyer_id uuid,p_context jsonb,p_kind text,p_quote jsonb,p_accepted boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; e public.monthly_mentorship_exit_requests_v1%rowtype; q jsonb;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context or p_accepted is distinct from true or
    p_kind is null or p_kind not in ('stop_renewal','revoke_debits') then raise exception 'Explicit owned monthly exit request required'; end if;
  select * into e from public.monthly_mentorship_exit_requests_v1 where agreement_id=a.id and kind=p_kind;
  if found then return to_jsonb(e); end if;
  q:=public.read_monthly_mentorship_exit_quote_v1(a.id,p_buyer_id,p_context);
  if p_kind='stop_renewal' then
    if p_quote is distinct from q then raise exception 'Monthly exit quote changed; review again'; end if;
    if q->'reviewReasons'<>'[]'::jsonb or q->>'payoffAmountCents' is distinct from '0' then
      raise exception 'Monthly minimum requires separate confirmed payoff or support review'; end if;
  elsif p_quote is not null then raise exception 'Debit revocation is not payoff acceptance'; end if;
  insert into public.monthly_mentorship_exit_requests_v1(agreement_id,buyer_id,kind,accepted_snapshot)
    values(a.id,p_buyer_id,p_kind,q) returning * into e;
  update public.monthly_mentorship_agreements_v1 set
    renewal_stopped_at=case when p_kind='stop_renewal' then coalesce(renewal_stopped_at,e.requested_at) else renewal_stopped_at end,
    debit_revoked_at=case when p_kind='revoke_debits' then coalesce(debit_revoked_at,e.requested_at) else debit_revoked_at end,
    revision=revision+1,billing_next_attempt_at='infinity' where id=a.id;
  return to_jsonb(e);
end;
$$;

create function public.claim_monthly_mentorship_exit_stop_v1(p_exit_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; e public.monthly_mentorship_exit_requests_v1%rowtype; v_id uuid;
begin
  select agreement_id into v_id from public.monthly_mentorship_exit_requests_v1 where id=p_exit_id and buyer_id=p_buyer_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context then
    raise exception 'Monthly stop ownership differs'; end if;
  select * into e from public.monthly_mentorship_exit_requests_v1 where id=p_exit_id for update;
  if e.status='provider_stopped' then return to_jsonb(e); end if;
  if (e.kind='revoke_debits' and a.debit_revoked_at is null) or (e.kind='stop_renewal' and a.renewal_stopped_at is null) then
    raise exception 'Monthly stop has no durable request'; end if;
  if e.provider_started_at<=clock_timestamp()-interval '20 hours' then
    update public.monthly_mentorship_exit_requests_v1 set status='review_required' where id=e.id returning * into e;
  elsif e.status<>'review_required' then
    update public.monthly_mentorship_exit_requests_v1 set status='dispatching',provider_started_at=coalesce(provider_started_at,clock_timestamp())
      where id=e.id returning * into e;
  end if;
  return to_jsonb(e);
end;
$$;

create function public.record_monthly_mentorship_exit_stop_v1(p_exit_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; e public.monthly_mentorship_exit_requests_v1%rowtype; v_id uuid;
begin
  select agreement_id into v_id from public.monthly_mentorship_exit_requests_v1 where id=p_exit_id and buyer_id=p_buyer_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context then
    raise exception 'Monthly stopped observation owner differs'; end if;
  select * into e from public.monthly_mentorship_exit_requests_v1 where id=p_exit_id for update;
  if p_proof->>'version' is distinct from 'monthly-exit-stop-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    a.stripe_subscription_id is null or p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or p_proof->>'status' is distinct from 'canceled' or
    not coalesce(p_proof->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) then raise exception 'Monthly stopped provider proof differs'; end if;
  if e.status='provider_stopped' then return false; end if;
  update public.monthly_mentorship_exit_requests_v1 set status='provider_stopped',provider_proof=p_proof,
    provider_completed_at=clock_timestamp() where id=e.id;
  -- Paid receipts, access, balances and any in-flight capture are untouched.
  return true;
end;
$$;
revoke all on function public.read_monthly_mentorship_exit_quote_v1(uuid,uuid,jsonb),
  public.request_monthly_mentorship_exit_v1(uuid,uuid,jsonb,text,jsonb,boolean),
  public.claim_monthly_mentorship_exit_stop_v1(uuid,uuid,jsonb),public.record_monthly_mentorship_exit_stop_v1(uuid,uuid,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.read_monthly_mentorship_exit_quote_v1(uuid,uuid,jsonb),
  public.request_monthly_mentorship_exit_v1(uuid,uuid,jsonb,text,jsonb,boolean),
  public.claim_monthly_mentorship_exit_stop_v1(uuid,uuid,jsonb),public.record_monthly_mentorship_exit_stop_v1(uuid,uuid,jsonb,jsonb) to service_role;
commit;
