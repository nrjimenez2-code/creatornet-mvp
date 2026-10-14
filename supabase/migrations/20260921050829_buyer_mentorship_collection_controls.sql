begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.buyer_mentorship_billing_state_v1 add column collection_enabled_at timestamptz;
grant update(collection_hold_at,collection_enabled_at,debit_revoked_at) on public.buyer_mentorship_billing_state_v1 to service_role;

-- The initial hold may be released once only. A later operational/financial
-- hold or revoked debit cannot be undone by replaying first-payment activation.
create function public.guard_buyer_mentorship_collection_controls_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if (old.collection_enabled_at is not null and new.collection_enabled_at is distinct from old.collection_enabled_at) or
    (old.debit_revoked_at is not null and new.debit_revoked_at is distinct from old.debit_revoked_at) or
    (old.collection_hold_at is not null and new.collection_hold_at is null and
      (old.collection_enabled_at is not null or new.collection_enabled_at is null or new.debit_revoked_at is not null or new.financial_hold_at is not null)) then
    raise exception 'Buyer collection controls cannot reopen stopped billing'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_collection_controls_v1 before update on public.buyer_mentorship_billing_state_v1
  for each row execute function public.guard_buyer_mentorship_collection_controls_v1();
revoke all on function public.guard_buyer_mentorship_collection_controls_v1() from public,anon,authenticated;

-- Caller reuses the full activation subscription/card/capture verifier before
-- presenting current readback here. Stripe keep_as_draft is NEVER removed.
create function public.enable_buyer_mentorship_collection_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_subscription jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  a public.buyer_mentorship_activation_operations_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype; params jsonb;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer collection unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  if not found then raise exception 'Buyer collection requires captured receipt'; end if;
  perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id,73591));
  select * into a from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id and completed_at is not null;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id for update;
  params:=a.request->'params';
  if a.reservation_id is null or b.reservation_id is null or b.debit_revoked_at is not null or b.financial_hold_at is not null or
    (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb or
    p_subscription->>'object' is distinct from 'subscription' or p_subscription->>'id' is distinct from f.proof->>'subscriptionId' or
    p_subscription->>'customer' is distinct from f.proof->>'customerId' or p_subscription->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    coalesce(p_subscription->>'status','') not in ('trialing','active') or p_subscription->>'ended_at' is not null or
    p_subscription->'cancel_at_period_end' is distinct from 'false'::jsonb or
    p_subscription->'trial_end' is distinct from params->'trial_end' or p_subscription->'billing_cycle_anchor' is distinct from params->'trial_end' or
    p_subscription->'cancel_at' is distinct from params->'cancel_at' or
    p_subscription->'default_payment_method' is distinct from params->'default_payment_method' or
    p_subscription#>>'{pause_collection,behavior}' is distinct from 'keep_as_draft' or p_subscription#>>'{pause_collection,resumes_at}' is not null or
    p_subscription#>>'{metadata,installment_activation_version}' is distinct from 'buyer-first-paid-v1' or
    p_subscription#>>'{items,data,0,id}' is distinct from a.item_id then raise exception 'Buyer collection activation proof differs'; end if;
  if b.collection_enabled_at is not null then
    if b.collection_hold_at is not null then raise exception 'Buyer collection was held after activation'; end if;
    return jsonb_build_object('status','collection_enabled','reservationId',r.id,'enabledAt',b.collection_enabled_at);
  end if;
  if b.collection_hold_at is null or b.paid_count<>1 or b.next_payment_at is distinct from (params->>'trial_end')::bigint or
    clock_timestamp()>=to_timestamp(b.next_payment_at) or
    exists(select 1 from public.buyer_mentorship_payment_admissions_v1 where reservation_id=r.id) then
    raise exception 'Buyer initial collection release requires review'; end if;
  -- Reuse the original immutable calendar materializer and all its checks.
  perform public.initialize_buyer_mentorship_periods_v1(p_request_id,p_buyer_id,p_context);
  update public.buyer_mentorship_billing_state_v1 set collection_hold_at=null,collection_enabled_at=clock_timestamp(),revision=revision+1
    where reservation_id=r.id returning * into b;
  return jsonb_build_object('status','collection_enabled','reservationId',r.id,'enabledAt',b.collection_enabled_at);
end $$;
revoke all on function public.enable_buyer_mentorship_collection_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.enable_buyer_mentorship_collection_v1(uuid,uuid,jsonb,jsonb) to service_role;

-- Linearizes against debit admission using the SAME buyer/product lock.
-- Previously admitted debits remain unresolved: return them to reconciliation,
-- never promise cancellation or accept a payoff while their outcome is unknown.
create function public.revoke_buyer_mentorship_debit_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype; pending jsonb;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer debit unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id for update;
  if not found then raise exception 'Buyer debit state unavailable'; end if;
  if b.debit_revoked_at is null then
    update public.buyer_mentorship_billing_state_v1 set debit_revoked_at=clock_timestamp(),revision=revision+1 where reservation_id=r.id returning * into b;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('invoiceId',a.invoice_id,'paymentIntentId',a.payment_intent_id,'paymentNumber',a.payment_number)
    order by a.payment_number),'[]'::jsonb) into pending from public.buyer_mentorship_payment_admissions_v1 a
    join public.buyer_mentorship_collection_periods_v1 p using(reservation_id,payment_number)
    where a.reservation_id=r.id and p.counted_at is null;
  return jsonb_build_object('status',case when jsonb_array_length(pending)>0 then 'admitted_payment_pending' else 'new_debits_stopped' end,
    'reservationId',r.id,'revokedAt',b.debit_revoked_at,'pending',pending);
end $$;
revoke all on function public.revoke_buyer_mentorship_debit_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.revoke_buyer_mentorship_debit_v1(uuid,uuid,jsonb) to service_role;
commit;
