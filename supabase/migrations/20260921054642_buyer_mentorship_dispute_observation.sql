begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_dispute_events_v1 (
  event_id text primary key check(event_id ~ '^evt_[A-Za-z0-9]+$'),
  reservation_id uuid not null references public.buyer_mentorship_first_receipts_v1(reservation_id),
  dispute_id text not null check(dispute_id ~ '^du_[A-Za-z0-9]+$'),
  payment_intent_id text not null check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  charge_id text not null check(charge_id ~ '^ch_[A-Za-z0-9]+$'),
  observed_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz,
  disposition text check(disposition in ('dispute_observed','dispute_review_recorded')),
  details jsonb
);
alter table public.buyer_mentorship_dispute_events_v1 enable row level security;
revoke all on public.buyer_mentorship_dispute_events_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_dispute_events_v1 to service_role;
grant update(applied_at,disposition,details) on public.buyer_mentorship_dispute_events_v1 to service_role;

create function public.hold_buyer_mentorship_dispute_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_dispute_id text,p_payment_intent_id text,p_charge_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; receipt jsonb;
  event public.buyer_mentorship_dispute_events_v1%rowtype; revision bigint;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer dispute unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  perform pg_advisory_xact_lock(hashtextextended(p_payment_intent_id,73591));
  receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,p_payment_intent_id);
  if receipt is null or receipt#>>'{proof,chargeId}' is distinct from p_charge_id then raise exception 'Buyer dispute original receipt unavailable'; end if;
  insert into public.buyer_mentorship_dispute_events_v1(event_id,reservation_id,dispute_id,payment_intent_id,charge_id)
    values(p_event_id,r.id,p_dispute_id,p_payment_intent_id,p_charge_id) on conflict(event_id) do nothing;
  select * into event from public.buyer_mentorship_dispute_events_v1 where event_id=p_event_id;
  if event.reservation_id is distinct from r.id or event.dispute_id is distinct from p_dispute_id or
    event.payment_intent_id is distinct from p_payment_intent_id or event.charge_id is distinct from p_charge_id then
    raise exception 'Original buyer dispute event differs'; end if;
  update public.buyer_mentorship_billing_state_v1 b set financial_hold_at=clock_timestamp(),revision=b.revision+1
    where reservation_id=r.id and financial_hold_at is null;
  select b.revision into revision from public.buyer_mentorship_billing_state_v1 b where reservation_id=r.id;
  if revision is null then raise exception 'Buyer dispute billing state unavailable'; end if;
  return jsonb_build_object('revision',revision,'basis',(select coalesce(jsonb_agg(to_jsonb(d) order by d.stripe_dispute_id),'[]'::jsonb)
    from public.payment_dispute_state d where stripe_payment_intent_id=p_payment_intent_id));
end $$;
revoke all on function public.hold_buyer_mentorship_dispute_v1(uuid,uuid,jsonb,text,text,text,text) from public,anon,authenticated;
grant execute on function public.hold_buyer_mentorship_dispute_v1(uuid,uuid,jsonb,text,text,text,text) to service_role;

-- Existing policy: dispute audit does not debit creator earnings or waive debt.
-- Serialize current provider evidence against competing observations/debit stops.
create function public.apply_buyer_mentorship_dispute_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_dispute_id text,p_payment_intent_id text,p_charge_id text,p_read jsonb,
  p_disputed_cents bigint,p_status text,p_event_created bigint)
returns text language plpgsql security invoker set search_path=pg_catalog as $$
declare current_read jsonb; receipt jsonb; prior public.payment_dispute_state%rowtype; chosen public.payment_dispute_state%rowtype;
  v_disposition text:='dispute_observed';
begin
  if p_disputed_cents is null or p_disputed_cents not between 1 and 99999999 or p_event_created is null or p_event_created<=0 or
    p_status is null or p_status not in ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented') then
    raise exception 'Invalid buyer dispute evidence'; end if;
  current_read:=public.hold_buyer_mentorship_dispute_v1(p_request_id,p_buyer_id,p_context,p_event_id,p_dispute_id,p_payment_intent_id,p_charge_id);
  if p_read is distinct from current_read then return 'reconciliation_required'; end if;
  receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,p_payment_intent_id);
  select * into prior from public.payment_dispute_state where stripe_dispute_id=p_dispute_id;
  if found then
    if prior.stripe_payment_intent_id is distinct from p_payment_intent_id or prior.stripe_charge_id is distinct from p_charge_id or prior.currency is distinct from 'usd' then
      raise exception 'Prior buyer dispute identity differs'; end if;
    if prior.status in ('won','lost','prevented') and prior.status<>p_status then v_disposition:='dispute_review_recorded'; end if;
  end if;
  if v_disposition='dispute_observed' then
    perform public.record_payment_dispute_state(p_dispute_id,p_payment_intent_id,p_charge_id,p_disputed_cents,'usd',p_status,
      greatest(coalesce(prior.stripe_event_created,0),p_event_created));
    select * into chosen from public.payment_dispute_state where stripe_payment_intent_id=p_payment_intent_id
      order by (status not in ('won','warning_closed','prevented')) desc,stripe_event_created desc,stripe_dispute_id limit 1;
    if chosen.stripe_charge_id is distinct from p_charge_id or chosen.currency is distinct from 'usd' then raise exception 'Buyer dispute ledger identity differs'; end if;
    update public.payment_fee_ledger set stripe_dispute_id=chosen.stripe_dispute_id,disputed_amount_cents=chosen.disputed_amount_cents,
      dispute_status=chosen.status,updated_at=clock_timestamp() where id=(receipt->>'ledgerId')::uuid;
  end if;
  update public.buyer_mentorship_dispute_events_v1 set applied_at=clock_timestamp(),disposition=v_disposition,
    details=jsonb_build_object('status',p_status,'disputedCents',p_disputed_cents,'eventCreated',p_event_created) where event_id=p_event_id;
  update public.buyer_mentorship_billing_state_v1 b set revision=b.revision+1 where reservation_id=(receipt->>'reservationId')::uuid;
  return v_disposition;
end $$;
revoke all on function public.apply_buyer_mentorship_dispute_v1(uuid,uuid,jsonb,text,text,text,text,jsonb,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.apply_buyer_mentorship_dispute_v1(uuid,uuid,jsonb,text,text,text,text,jsonb,bigint,text,bigint) to service_role;
commit;
