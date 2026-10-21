begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- A dispute hold survives provider read failures, won events and stale capture
-- replays. This migration does not establish a dispute-responsibility policy.
create table public.full_server_payment_financial_holds_v1 (
  attempt_id uuid primary key references public.server_payment_protocols_v1(attempt_id),
  payment_intent_id text not null unique,
  financial_hold_at timestamptz not null default clock_timestamp(),
  revision bigint not null default 0
);
create table public.full_server_payment_dispute_events_v1 (
  event_id text primary key check(event_id ~ '^evt_[A-Za-z0-9]+$'),
  attempt_id uuid not null references public.full_server_payment_financial_holds_v1(attempt_id),
  dispute_id text not null check(dispute_id ~ '^du_[A-Za-z0-9]+$'),
  charge_id text not null check(charge_id ~ '^ch_[A-Za-z0-9]+$'),
  observed_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz,
  disposition text,
  details jsonb
);
alter table public.full_server_payment_financial_holds_v1 enable row level security;
alter table public.full_server_payment_dispute_events_v1 enable row level security;
revoke all on public.full_server_payment_financial_holds_v1,public.full_server_payment_dispute_events_v1
  from public,anon,authenticated,service_role;
grant select on public.full_server_payment_financial_holds_v1,public.full_server_payment_dispute_events_v1 to service_role;

create function public.hold_full_server_payment_dispute_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_dispute_id text,p_payment_intent_id text,p_charge_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; op public.server_payment_intent_operations_v1%rowtype;
  r public.full_server_payment_receipts_v1%rowtype; e public.full_server_payment_dispute_events_v1%rowtype;
  added integer; current_revision bigint;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into op from public.server_payment_intent_operations_v1 where attempt_id=s.attempt_id;
  if s.kind<>'full' or op.bound_at is null or op.payment_intent_id is distinct from p_payment_intent_id or
    coalesce(p_event_id,'')!~'^evt_[A-Za-z0-9]+$' or coalesce(p_dispute_id,'')!~'^du_[A-Za-z0-9]+$' or
    coalesce(p_charge_id,'')!~'^ch_[A-Za-z0-9]+$' then raise exception 'Original full dispute identity required'; end if;
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id for update;
  perform pg_advisory_xact_lock(hashtextextended(op.payment_intent_id,73591));
  if r.attempt_id is not null and (r.payment_intent_id is distinct from p_payment_intent_id or r.charge_id is distinct from p_charge_id) then
    raise exception 'Original full dispute charge differs'; end if;
  insert into public.full_server_payment_financial_holds_v1(attempt_id,payment_intent_id)
    values(s.attempt_id,op.payment_intent_id) on conflict(attempt_id) do nothing;
  if not exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=s.attempt_id and payment_intent_id=op.payment_intent_id) then
    raise exception 'Original full dispute hold differs'; end if;
  insert into public.full_server_payment_dispute_events_v1(event_id,attempt_id,dispute_id,charge_id)
    values(p_event_id,s.attempt_id,p_dispute_id,p_charge_id) on conflict(event_id) do nothing;
  get diagnostics added=row_count;
  select * into e from public.full_server_payment_dispute_events_v1 where event_id=p_event_id;
  if e.attempt_id is distinct from s.attempt_id or e.dispute_id is distinct from p_dispute_id or e.charge_id is distinct from p_charge_id then
    raise exception 'Original full dispute event differs'; end if;
  update public.full_server_payment_financial_holds_v1 set revision=revision+added where attempt_id=s.attempt_id returning revision into current_revision;
  if r.accounted_at is not null then
    -- This branch validates original accounting only, never credits again.
    perform public.account_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context);
    update public.purchases set access_granted=false where id=r.purchase_id;
  end if;
  return jsonb_build_object('revision',current_revision,
    'disputes',(select coalesce(jsonb_agg(to_jsonb(d) order by d.stripe_dispute_id),'[]'::jsonb) from public.payment_dispute_state d where stripe_payment_intent_id=op.payment_intent_id),
    'refunds',(select coalesce(jsonb_agg(to_jsonb(f) order by f.stripe_payment_intent_id),'[]'::jsonb) from public.payment_refund_state f where stripe_payment_intent_id=op.payment_intent_id));
end $$;

create function public.apply_full_server_payment_dispute_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_dispute_id text,p_proof jsonb,p_read jsonb,p_disputed_cents bigint,p_status text,p_event_created bigint)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare basis jsonb; r public.full_server_payment_receipts_v1%rowtype; prior public.payment_dispute_state%rowtype;
  chosen public.payment_dispute_state%rowtype; v_disposition text:='dispute_observed';
begin
  basis:=public.hold_full_server_payment_dispute_v1(p_attempt_id,p_buyer_id,p_context,p_event_id,p_dispute_id,
    p_proof->>'paymentIntentId',p_proof->>'chargeId');
  if basis is distinct from p_read then return 'reconciliation_required'; end if;
  perform public.record_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context,p_proof);
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=p_attempt_id;
  if p_disputed_cents is null or p_disputed_cents not between 1 and (r.proof->>'amountCents')::bigint or
    p_status is null or p_status not in ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented') or
    p_event_created is null or p_event_created<(r.proof->>'paidAt')::bigint or p_event_created>extract(epoch from clock_timestamp()) then
    raise exception 'Invalid original full dispute observation'; end if;
  select * into prior from public.payment_dispute_state where stripe_dispute_id=p_dispute_id;
  if found then
    if prior.stripe_payment_intent_id is distinct from r.payment_intent_id or prior.stripe_charge_id is distinct from r.charge_id or
      prior.currency is distinct from 'usd' then raise exception 'Prior full dispute identity differs'; end if;
    if prior.status in ('won','lost','prevented') and prior.status<>p_status then v_disposition:='dispute_review_recorded'; end if;
  end if;
  if v_disposition='dispute_observed' then
    perform public.record_payment_dispute_state(p_dispute_id,r.payment_intent_id,r.charge_id,p_disputed_cents,'usd',p_status,
      greatest(coalesce(prior.stripe_event_created,0),p_event_created));
    select * into chosen from public.payment_dispute_state where stripe_payment_intent_id=r.payment_intent_id
      order by (status not in ('won','warning_closed','prevented')) desc,stripe_event_created desc,stripe_dispute_id limit 1;
    if chosen.stripe_charge_id is distinct from r.charge_id or chosen.currency is distinct from 'usd' then
      raise exception 'Original full dispute ledger identity differs'; end if;
    if r.accounted_at is not null then
      update public.payment_fee_ledger set stripe_dispute_id=chosen.stripe_dispute_id,disputed_amount_cents=chosen.disputed_amount_cents,
        dispute_status=chosen.status,updated_at=clock_timestamp() where id=r.ledger_id;
    end if;
  end if;
  update public.full_server_payment_dispute_events_v1 set applied_at=clock_timestamp(),disposition=v_disposition,
    details=jsonb_build_object('status',p_status,'disputedCents',p_disputed_cents,'eventCreated',p_event_created) where event_id=p_event_id;
  update public.full_server_payment_financial_holds_v1 set revision=revision+1 where attempt_id=p_attempt_id;
  return case when r.accounted_at is null then 'dispute_recorded_accounting_review' else v_disposition end;
end $$;

-- Mask direct access restoration as well as stale application-level success.
-- Name orders this before the existing fixed-service access mask trigger.
create function public.mask_full_server_financial_access_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if exists(select 1 from public.full_server_payment_financial_holds_v1 h where h.payment_intent_id=new.payment_intent_id or
    exists(select 1 from public.full_server_payment_receipts_v1 r where r.attempt_id=h.attempt_id and r.purchase_id=new.id)) then
    new.access_granted:=false; end if;
  return new;
end $$;
create trigger a_full_server_financial_access_v1 before insert or update of access_granted on public.purchases
  for each row execute function public.mask_full_server_financial_access_v1();

do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.account_full_server_payment_receipt_v1(uuid,uuid,jsonb)'::regprocedure);
  needle:='  if exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=r.payment_intent_id and';
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Full accounting hold guard differs'; end if;
  execute replace(source,needle,'  if exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=s.attempt_id) or'||E'\n'||
    '    exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=r.payment_intent_id and');
  source:=pg_get_functiondef('public.read_server_payment_source_v1(uuid,uuid,jsonb,boolean)'::regprocedure);
  needle:='  if p_for_dispatch then';
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Full source hold guard differs'; end if;
  execute replace(source,needle,needle||E'\n'||'    if exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=s.attempt_id) then raise exception ''Full payment financial hold''; end if;');
end $patch$;
revoke all on function public.hold_full_server_payment_dispute_v1(uuid,uuid,jsonb,text,text,text,text),
  public.apply_full_server_payment_dispute_v1(uuid,uuid,jsonb,text,text,jsonb,jsonb,bigint,text,bigint),
  public.mask_full_server_financial_access_v1() from public,anon,authenticated;
grant execute on function public.hold_full_server_payment_dispute_v1(uuid,uuid,jsonb,text,text,text,text),
  public.apply_full_server_payment_dispute_v1(uuid,uuid,jsonb,text,text,jsonb,jsonb,bigint,text,bigint) to service_role;
commit;
