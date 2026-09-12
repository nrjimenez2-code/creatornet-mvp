-- UNAPPLIED. Locked plan steps 1/5/8. Durable provider operation identities.
-- No Stripe calls occur in SQL. A result without its provider ID cannot be
-- recreated after the conservative 20-hour idempotency window.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or to_regclass('public.monthly_mentorship_agreements_v1') is null or
    to_regclass('public.monthly_mentorship_operations_v1') is not null then raise exception 'Monthly journal prerequisites differ'; end if;
end;
$preflight$;
create table public.monthly_mentorship_operations_v1 (
  id uuid primary key default gen_random_uuid(), agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  kind text not null check(kind in ('customer','product','subscription','hold','checkout','activate','collect')),
  scope_key text not null, request jsonb not null check(jsonb_typeof(request)='object'),
  agreement_revision bigint not null, dispatched_at timestamptz not null default clock_timestamp(),
  provider_id text, provider_request_id text, completed_at timestamptz,
  status text not null default 'dispatched' check(status in ('dispatched','complete','review_required')),
  unique(agreement_id,kind,scope_key),
  check((status='complete' and provider_id is not null and provider_request_id is not null and completed_at is not null) or
    (status<>'complete' and provider_id is null and provider_request_id is null and completed_at is null))
);
alter table public.monthly_mentorship_operations_v1 enable row level security;
revoke all on public.monthly_mentorship_operations_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_operations_v1 to service_role;

create function public.claim_monthly_mentorship_operation_v1(p_agreement_id uuid,p_actor_id uuid,p_kind text,p_scope text,
  p_revision bigint,p_context jsonb,p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype; v_prior text;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_agreement_id for update;
  if not found or p_context is distinct from a.terms->'paymentContext' or
    p_actor_id is distinct from (case when p_kind='collect' then a.creator_id else a.buyer_id end) or
    p_kind is null or p_kind not in ('customer','product','subscription','hold','checkout','activate','collect') or
    p_request is null or jsonb_typeof(p_request)<>'object' or p_request->>'method' is distinct from 'POST' or
    not coalesce(p_request->>'path' ~ '^/v1/[A-Za-z0-9_/]+$',false) or jsonb_typeof(p_request->'params') is distinct from 'object' or
    p_request-array['method','path','params']<>'{}'::jsonb then raise exception 'Monthly operation identity or request differs'; end if;
  if (p_kind<>'collect' and p_scope is distinct from 'initial') or
    (p_kind='collect' and not coalesce(p_scope ~ '^[1-9][0-9]{0,8}$',false)) then raise exception 'Monthly operation scope differs'; end if;
  if not (case p_kind when 'customer' then p_request->>'path'='/v1/customers'
    when 'product' then p_request->>'path'='/v1/products'
    when 'subscription' then p_request->>'path'='/v1/subscriptions'
    when 'checkout' then p_request->>'path'='/v1/checkout/sessions'
    when 'collect' then p_request->>'path' ~ '^/v1/invoices/in_[A-Za-z0-9]+/pay$'
    else p_request->>'path' ~ '^/v1/subscriptions/sub_[A-Za-z0-9]+$' end) then
    raise exception 'Monthly operation provider path differs'; end if;
  select * into o from public.monthly_mentorship_operations_v1 where agreement_id=p_agreement_id and kind=p_kind and scope_key=p_scope for update;
  if found then
    if o.request is distinct from p_request then raise exception 'Monthly operation retry parameters differ'; end if;
    if o.status='complete' then return to_jsonb(o); end if;
    if o.dispatched_at<=clock_timestamp()-interval '20 hours' then
      update public.monthly_mentorship_operations_v1 set status='review_required' where id=o.id returning * into o;
      return to_jsonb(o);
    end if;
  end if;
  if a.revision is distinct from p_revision or a.financial_hold_at is not null or a.renewal_stopped_at is not null or
    a.debit_revoked_at is not null then raise exception 'Monthly operation requires fresh eligible agreement state'; end if;
  if p_kind in ('customer','product','subscription','hold','checkout') and (a.covered_months<>0 or a.stripe_subscription_id is not null) then
    raise exception 'Monthly bootstrap is already bound or paid'; end if;
  if p_kind in ('activate','collect') and (a.covered_months<1 or a.stripe_subscription_id is null or exists(
    select 1 from public.monthly_mentorship_receipts_v1 r join public.payment_fee_ledger l on l.id=r.ledger_id
      where r.agreement_id=a.id and (l.status<>'paid' or l.refunded_amount_cents<>0 or
        (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed'))))) then
    raise exception 'Monthly collection requires settled receipt-backed state'; end if;
  if p_kind='collect' and (p_scope::integer<>a.covered_months+1 or (not a.auto_renew and p_scope::integer>a.minimum_months) or
    public.monthly_mentorship_boundary_v1(a.anchor_at,p_scope::integer-1)>extract(epoch from clock_timestamp())::bigint or
    public.monthly_mentorship_boundary_v1(a.anchor_at,p_scope::integer)<=extract(epoch from clock_timestamp())::bigint) then
    raise exception 'Monthly collection is not the current unpaid service period'; end if;
  v_prior:=case p_kind when 'product' then 'customer' when 'subscription' then 'product' when 'hold' then 'subscription'
    when 'checkout' then 'hold' when 'activate' then 'checkout' when 'collect' then 'activate' else null end;
  if v_prior is not null and not exists(select 1 from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind=v_prior and scope_key='initial' and status='complete') then
    raise exception 'Prior monthly operation is not complete'; end if;
  if o.id is null then
    insert into public.monthly_mentorship_operations_v1(agreement_id,kind,scope_key,request,agreement_revision)
      values(a.id,p_kind,p_scope,p_request,a.revision) returning * into o;
  end if;
  return to_jsonb(o);
end;
$$;

create function public.complete_monthly_mentorship_operation_v1(p_operation_id uuid,p_context jsonb,p_provider_id text,p_request_id text)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype; v_agreement uuid; v_prefix text;
begin
  select agreement_id into v_agreement from public.monthly_mentorship_operations_v1 where id=p_operation_id;
  if not found then raise exception 'Monthly operation not found'; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_agreement for update;
  select * into o from public.monthly_mentorship_operations_v1 where id=p_operation_id for update;
  if p_context is distinct from a.terms->'paymentContext' or not coalesce(p_request_id ~ '^req_[A-Za-z0-9]+$',false) then
    raise exception 'Monthly provider completion context differs'; end if;
  v_prefix:=case o.kind when 'customer' then 'cus' when 'product' then 'prod' when 'checkout' then 'cs' when 'collect' then 'in' else 'sub' end;
  if not coalesce(p_provider_id ~ ('^'||v_prefix||'_[A-Za-z0-9_]+$'),false) then raise exception 'Monthly provider object kind differs'; end if;
  if o.status='complete' then
    if o.provider_id is distinct from p_provider_id then raise exception 'Monthly provider result differs'; end if;
    return false;
  end if;
  if o.status<>'dispatched' or o.dispatched_at<=clock_timestamp()-interval '20 hours' then
    raise exception 'Monthly provider result requires reconciliation'; end if;
  -- Completion records an observed external result even if a concurrent stop
  -- happened after dispatch. It never reauthorizes collection, access or credit.
  update public.monthly_mentorship_operations_v1 set provider_id=p_provider_id,provider_request_id=p_request_id,
    completed_at=clock_timestamp(),status='complete' where id=o.id;
  return true;
end;
$$;
revoke all on function public.claim_monthly_mentorship_operation_v1(uuid,uuid,text,text,bigint,jsonb,jsonb),
  public.complete_monthly_mentorship_operation_v1(uuid,jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_monthly_mentorship_operation_v1(uuid,uuid,text,text,bigint,jsonb,jsonb),
  public.complete_monthly_mentorship_operation_v1(uuid,jsonb,text,text) to service_role;
commit;
