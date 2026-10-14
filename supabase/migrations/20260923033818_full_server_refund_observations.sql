begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.full_server_payment_refund_object_events_v1 (
  event_id text primary key check(event_id ~ '^evt_[A-Za-z0-9]+$'),
  attempt_id uuid not null references public.full_server_payment_financial_holds_v1(attempt_id),
  refund_id text not null check(refund_id ~ '^re_[A-Za-z0-9]+$'),
  charge_id text not null check(charge_id ~ '^ch_[A-Za-z0-9]+$'),
  observed_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz, disposition text, details jsonb
);
create table public.full_server_payment_refund_observations_v1 (
  event_id text not null references public.full_server_payment_refund_object_events_v1(event_id),
  observation jsonb not null,
  financial_evidence jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(event_id,observation,financial_evidence)
);
alter table public.full_server_payment_refund_object_events_v1 enable row level security;
alter table public.full_server_payment_refund_observations_v1 enable row level security;
revoke all on public.full_server_payment_refund_object_events_v1,public.full_server_payment_refund_observations_v1 from public,anon,authenticated,service_role;
grant select on public.full_server_payment_refund_object_events_v1,public.full_server_payment_refund_observations_v1 to service_role;

-- Reuse the existing owned pre-read hold protocol, including source/PI locks,
-- immutable event identity, access masking and complete financial read basis.
do $copy$
declare source text;
begin
  source:=pg_get_functiondef('public.hold_full_server_payment_dispute_v1(uuid,uuid,jsonb,text,text,text,text)'::regprocedure);
  if strpos(source,'full_server_payment_dispute_events_v1')=0 or strpos(source,'p_dispute_id')=0 then
    raise exception 'Original owned financial hold protocol differs'; end if;
  source:=replace(source,'hold_full_server_payment_dispute_v1','hold_full_server_payment_refund_object_v1');
  source:=replace(source,'full_server_payment_dispute_events_v1','full_server_payment_refund_object_events_v1');
  source:=replace(source,'dispute_id','refund_id');
  -- The financial basis still reads every actual dispute row and orders by its
  -- original dispute ID; only the owned event locator changes to Refund.
  source:=replace(source,'d.stripe_refund_id','d.stripe_dispute_id');
  source:=replace(source,'''^du_[A-Za-z0-9]+$''','''^re_[A-Za-z0-9]+$''');
  execute source;
end $copy$;
revoke all on function public.hold_full_server_payment_refund_object_v1(uuid,uuid,jsonb,text,text,text,text) from public,anon,authenticated;
grant execute on function public.hold_full_server_payment_refund_object_v1(uuid,uuid,jsonb,text,text,text,text) to service_role;

alter table public.full_server_payment_refund_events_v1 drop constraint full_server_payment_refund_events_v1_observation_kind_check;
alter table public.full_server_payment_refund_events_v1 add constraint full_server_payment_refund_events_v1_observation_kind_check
  check(observation_kind in ('charge.refunded','dispute_charge_readback','refund_object_readback'));

create function public.apply_full_server_payment_refund_object_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_refund_id text,p_proof jsonb,p_read jsonb,p_observation jsonb,p_refunded_cents bigint,p_succeeded_total bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare basis jsonb; r public.full_server_payment_receipts_v1%rowtype; e public.full_server_payment_refund_object_events_v1%rowtype;
  refund public.payment_refund_state%rowtype; applied jsonb; v_disposition text:='refund_observed'; applied_refund boolean:=false;
  status text; amount bigint; created bigint; event_created bigint; value text;
begin
  basis:=public.hold_full_server_payment_refund_object_v1(p_attempt_id,p_buyer_id,p_context,p_event_id,p_refund_id,
    p_proof->>'paymentIntentId',p_proof->>'chargeId');
  if basis is distinct from p_read then return jsonb_build_object('status','reconciliation_required'); end if;
  perform public.record_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context,p_proof);
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=p_attempt_id;
  select * into e from public.full_server_payment_refund_object_events_v1 where event_id=p_event_id;
  if jsonb_typeof(p_observation) is distinct from 'object' or
    p_observation-array['version','eventId','eventCreated','attemptId','paymentIntentId','chargeId','refundId','amountCents','currency','created','status',
      'balanceTransactionId','failureBalanceTransactionId','failureReason','pendingReason']<>'{}'::jsonb or
    p_observation->>'version' is distinct from 'full-server-refund-observation-v1' or p_observation->>'eventId' is distinct from p_event_id or
    p_observation->>'attemptId' is distinct from p_attempt_id::text or p_observation->>'paymentIntentId' is distinct from r.payment_intent_id or
    p_observation->>'chargeId' is distinct from r.charge_id or p_observation->>'refundId' is distinct from p_refund_id or
    p_observation->>'currency' is distinct from 'usd' or jsonb_typeof(p_observation->'amountCents') is distinct from 'number' or
    jsonb_typeof(p_observation->'created') is distinct from 'number' or jsonb_typeof(p_observation->'eventCreated') is distinct from 'number' then
    raise exception 'Original Refund observation identity differs'; end if;
  status:=p_observation->>'status';
  if coalesce(p_observation->>'amountCents','')!~'^[0-9]+$' or coalesce(p_observation->>'created','')!~'^[0-9]+$' or
    coalesce(p_observation->>'eventCreated','')!~'^[0-9]+$' then raise exception 'Original Refund integer evidence required'; end if;
  amount:=(p_observation->>'amountCents')::bigint;created:=(p_observation->>'created')::bigint;event_created:=(p_observation->>'eventCreated')::bigint;
  if status is null or status not in ('pending','requires_action','succeeded','failed','canceled') or
    amount not between 1 and (r.proof->>'amountCents')::bigint or created<(r.proof->>'paidAt')::bigint or
    created>event_created or event_created>extract(epoch from clock_timestamp()) or
    p_refunded_cents is null or p_refunded_cents not between 0 and (r.proof->>'amountCents')::bigint then
    raise exception 'Original Refund economic evidence differs'; end if;
  foreach value in array array['balanceTransactionId','failureBalanceTransactionId'] loop
    if not (p_observation ? value) or (p_observation->value<>'null'::jsonb and
      (jsonb_typeof(p_observation->value)<>'string' or p_observation->>value!~'^txn_[A-Za-z0-9]+$')) then
      raise exception 'Original Refund balance reference differs'; end if;
  end loop;
  foreach value in array array['failureReason','pendingReason'] loop
    if not (p_observation ? value) or (p_observation->value<>'null'::jsonb and
      (jsonb_typeof(p_observation->value)<>'string' or p_observation->>value!~'^[a-z_]{1,100}$')) then
      raise exception 'Original Refund reason differs'; end if;
  end loop;
  if e.details is not null and e.details->>'eventCreated' is distinct from p_observation->>'eventCreated' then
    raise exception 'Original Refund event timestamp differs'; end if;
  if exists(select 1 from public.full_server_payment_refund_observations_v1 h
    join public.full_server_payment_refund_object_events_v1 ev on ev.event_id=h.event_id where ev.refund_id=p_refund_id and
    (ev.attempt_id<>p_attempt_id or ev.charge_id<>r.charge_id or h.observation->>'amountCents' is distinct from p_observation->>'amountCents' or
      h.observation->>'created' is distinct from p_observation->>'created')) then raise exception 'Original Refund history differs'; end if;
  select * into refund from public.payment_refund_state where stripe_payment_intent_id=r.payment_intent_id;
  if found and (refund.stripe_charge_id is distinct from r.charge_id or refund.charge_amount_cents::text is distinct from r.proof->>'amountCents') then
    raise exception 'Original Refund cumulative identity differs'; end if;
  if status in ('failed','canceled','requires_action') or p_refunded_cents<coalesce(refund.refunded_amount_cents,0) or
    exists(select 1 from public.full_server_payment_refund_observations_v1 h
      join public.full_server_payment_refund_object_events_v1 ev on ev.event_id=h.event_id where ev.refund_id=p_refund_id and
      h.observation->>'status' in ('succeeded','failed','canceled') and h.observation->>'status'<>status) then
    v_disposition:='refund_review_recorded'; end if;
  if status<>'succeeded' and p_refunded_cents>0 then v_disposition:='refund_review_recorded'; end if;
  if p_succeeded_total is not null and p_succeeded_total not between 0 and (r.proof->>'amountCents')::bigint then
    raise exception 'Verified succeeded Refund total differs'; end if;
  if status='succeeded' and (p_refunded_cents<amount or p_succeeded_total is distinct from p_refunded_cents) then v_disposition:='refund_review_recorded'; end if;
  if status='succeeded' and v_disposition='refund_observed' then
    if exists(select 1 from public.full_server_payment_refund_events_v1 where event_id=p_event_id and observation_kind<>'refund_object_readback') then
      raise exception 'Original Refund event provenance differs'; end if;
    -- The owned Refund hold already exists; do not invent a disputed charge
    -- flag merely to preserve it. Reuse the original refund engine directly.
    applied:=public.apply_full_server_payment_refund_v1(p_attempt_id,p_buyer_id,p_context,p_event_id,p_proof,p_refunded_cents);
    if applied->>'status' not in ('original_refund_applied','refund_recorded_accounting_review') then raise exception 'Original Refund application incomplete'; end if;
    update public.full_server_payment_refund_events_v1 set observation_kind='refund_object_readback' where event_id=p_event_id;
    applied_refund:=true;
  end if;
  insert into public.full_server_payment_refund_observations_v1(event_id,observation,financial_evidence)
    values(p_event_id,p_observation,jsonb_build_object('chargeRefundedCents',p_refunded_cents,'succeededRefundTotal',p_succeeded_total,
      'disposition',v_disposition,'refundApplied',applied_refund)) on conflict do nothing;
  update public.full_server_payment_refund_object_events_v1 set applied_at=clock_timestamp(),disposition=v_disposition,details=p_observation where event_id=p_event_id;
  update public.full_server_payment_financial_holds_v1 set revision=revision+1 where attempt_id=p_attempt_id;
  return jsonb_build_object('status',case when r.accounted_at is null then 'refund_recorded_accounting_review' else v_disposition end,
    'disposition',v_disposition,'attemptId',p_attempt_id,'paymentIntentId',r.payment_intent_id,'refundStatus',status,
    'refundedCents',p_refunded_cents,'refundApplied',applied_refund);
end $$;
revoke all on function public.apply_full_server_payment_refund_object_v1(uuid,uuid,jsonb,text,text,jsonb,jsonb,jsonb,bigint,bigint) from public,anon,authenticated;
grant execute on function public.apply_full_server_payment_refund_object_v1(uuid,uuid,jsonb,text,text,jsonb,jsonb,jsonb,bigint,bigint) to service_role;

-- Extend admission to the SAME private original-money accounting engine. A
-- verified pending/failed Refund can account real captured money under the
-- permanent financial hold; it cannot claim that the refund succeeded.
do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.account_full_server_financial_receipt_v1(uuid,uuid,jsonb,text,text)'::regprocedure);
  needle:='not in (''refund'',''dispute'')';
  if strpos(source,needle)=0 then raise exception 'Financial accounting admission differs'; end if;
  source:=replace(source,needle,'not in (''refund'',''dispute'',''refund_object'')');
  needle:=E'  else\n    select * into dispute_event';
  if strpos(source,needle)=0 then raise exception 'Financial accounting event branch differs'; end if;
  source:=replace(source,needle,$new$  elsif p_event_kind='refund_object' then
    if not exists(select 1 from public.full_server_payment_refund_object_events_v1 e where e.event_id=p_event_id and
      e.attempt_id=s.attempt_id and e.charge_id=r.charge_id and e.applied_at is not null and
      e.details->>'paymentIntentId'=r.payment_intent_id and e.disposition in ('refund_observed','refund_review_recorded') and
      exists(select 1 from public.full_server_payment_refund_observations_v1 h where h.event_id=e.event_id and h.observation=e.details)) then
      raise exception 'Applied original Refund observation required'; end if;
  else
    select * into dispute_event$new$);
  execute source;
end $patch$;
commit;
