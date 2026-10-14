begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Join the original manual terminal evidence to the existing subscription stop
-- and attempt archive. This does not create a second release/accounting engine.
create function public.read_buyer_mentorship_manual_stop_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  s public.server_payment_protocols_v1%rowtype; original jsonb; preparation jsonb; terminal jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh manual stop source required'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned manual stop unavailable'; end if;
  s:=public.read_server_payment_source_v1(r.attempt_id,p_buyer_id,p_context,false);
  if s.kind is distinct from 'first_installment' or s.reservation_id is distinct from r.id or s.product_id is distinct from r.product_id then
    raise exception 'Original manual installment differs'; end if;
  original:=public.read_server_payment_cancellation_source_v1(r.attempt_id,p_buyer_id,p_context);
  select proof into terminal from public.server_payment_intent_terminal_v1 where attempt_id=r.attempt_id;
  preparation:=public.buyer_mentorship_partial_subscription_v1(r.id);
  if original is null or preparation is null or terminal is null or
    terminal->>'version' is distinct from 'server-payment-intent-terminal-v1' or
    terminal->>'paymentIntentId' is distinct from original->>'payment_intent_id' or
    terminal->>'status' is distinct from 'canceled' or terminal->'amountReceived' is distinct from '0'::jsonb or
    terminal->'amountCapturable' is distinct from '0'::jsonb or
    original#>>'{contract,kind}' is distinct from 'first_installment' or
    original#>>'{contract,customerId}' is distinct from preparation#>>'{bootstrap,customer_id}' or
    original#>>'{contract,sourceMetadata,installment_subscription_id}' is distinct from preparation#>>'{subscription,result_id}' then
    raise exception 'Original manual payment and subscription need terminal reconciliation'; end if;
  return jsonb_build_object('preparation',preparation,'manualPayment',terminal);
end $$;
revoke all on function public.read_buyer_mentorship_manual_stop_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_manual_stop_v1(uuid,uuid,jsonb) to service_role;

-- Extend the existing guarded functions with exact, checked replacements so
-- all their legacy branches, grants and archive behavior remain in one place.
do $patch$
declare source text; needle text; replacement text;
begin
  source:=pg_get_functiondef('public.guard_server_payment_legacy_operation_v1()'::regprocedure);
  needle:=$old$    raise exception 'Server payment requires its own confirmation or terminal release proof';$old$;
  replacement:=$new$    if tg_table_name='buyer_mentorship_abandonment_holds_v1' and tg_op='INSERT' then
      perform public.read_buyer_mentorship_manual_stop_v1(r.request_id,r.buyer_id,r.context);
      return new;
    end if;
    raise exception 'Server payment requires its own confirmation or terminal release proof';$new$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Legacy guard source differs'; end if;
  execute replace(source,needle,replacement);

  source:=pg_get_functiondef('public.record_buyer_mentorship_abandonment_proof_v1(uuid,uuid,jsonb,jsonb)'::regprocedure);
  needle:=$old$  if p_proof->>'version'='buyer-nonpayable-preparation-stop-v1' then$old$;
  replacement:=$new$  if exists(select 1 from public.server_payment_protocols_v1 where attempt_id=r.attempt_id) then
    if p_proof->>'version' is distinct from 'buyer-manual-payment-stop-v1' or
      p_proof-'observedAt'-'canceledAt' is distinct from
      (public.read_buyer_mentorship_manual_stop_v1(p_request_id,p_buyer_id,p_context) || jsonb_build_object(
        'version','buyer-manual-payment-stop-v1',
        'subscriptionId',public.buyer_mentorship_partial_subscription_v1(r.id)#>>'{subscription,result_id}',
        'sessionId',null,'checkoutStatus','not_created','firstPaymentIntentId',null)) or
      jsonb_typeof(p_proof->'observedAt') is distinct from 'number' or
      jsonb_typeof(p_proof->'canceledAt') is distinct from 'number' or
      coalesce(p_proof->>'observedAt','')!~'^[0-9]{1,12}$' or coalesce(p_proof->>'canceledAt','')!~'^[0-9]{1,12}$' then
      raise exception 'Manual payment and subscription terminal proof differs'; end if;
    current_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
    if (p_proof->>'canceledAt')::bigint<=0 or (p_proof->>'canceledAt')::bigint>(p_proof->>'observedAt')::bigint or
      (p_proof->>'observedAt')::bigint<current_seconds-30 or (p_proof->>'observedAt')::bigint>current_seconds+5 then
      raise exception 'Manual subscription terminal proof is stale'; end if;
  elsif p_proof->>'version'='buyer-nonpayable-preparation-stop-v1' then$new$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Stop proof source differs'; end if;
  execute replace(source,needle,replacement);

  source:=pg_get_functiondef('public.guard_server_payment_attempt_v1()'::regprocedure);
  needle:=$old$  if tg_op='DELETE' then raise exception 'Server payment requires its own terminal release proof'; end if;$old$;
  replacement:=$new$  if tg_op='DELETE' then
    if saved.kind='first_installment' and old.checkout_kind='installments' and
      exists(select 1 from public.buyer_mentorship_installment_reservations_v1 r
        join public.buyer_mentorship_attempt_history_v1 h on h.id=r.attempt_id and h.reservation_id=r.id
        join public.buyer_mentorship_abandonment_proofs_v1 p on p.reservation_id=r.id
        where r.id=saved.reservation_id and r.id=old.buyer_installment_reservation_id and r.attempt_id=old.id and
          r.buyer_id=saved.buyer_id and r.context=saved.context and r.released_at is not null and h.original_attempt=to_jsonb(old) and
          p.proof->>'version'='buyer-manual-payment-stop-v1' and
          p.proof-'version'-'subscriptionId'-'sessionId'-'checkoutStatus'-'firstPaymentIntentId'-'canceledAt'-'observedAt'=
            public.read_buyer_mentorship_manual_stop_v1(r.request_id,r.buyer_id,r.context)) then return old; end if;
    raise exception 'Server payment requires its own terminal release proof';
  end if;$new$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Attempt guard source differs'; end if;
  execute replace(source,needle,replacement);
end $patch$;

-- Lost-response recovery reads the archived original only. It never repeats
-- release against a later selection, and does not need an active attempt row.
create function public.read_buyer_mentorship_manual_release_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned manual release unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=r.id;
  if r.released_at is null then return null; end if;
  if not exists(select 1 from public.server_payment_protocols_v1 s
    join public.buyer_mentorship_attempt_history_v1 h on h.id=s.attempt_id and h.reservation_id=s.reservation_id
    join public.buyer_mentorship_abandonment_proofs_v1 p on p.reservation_id=s.reservation_id
    join public.server_payment_intent_terminal_v1 t on t.attempt_id=s.attempt_id
    join public.server_payment_stops_v1 stop on stop.attempt_id=s.attempt_id
    where s.attempt_id=r.attempt_id and s.reservation_id=r.id and s.buyer_id=p_buyer_id and s.context=p_context and s.kind='first_installment' and
      h.original_attempt->>'buyer_id'=p_buyer_id::text and h.original_attempt->>'product_id'=r.product_id::text and
      p.proof->>'version'='buyer-manual-payment-stop-v1' and p.proof->'manualPayment'=t.proof) or
    exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id) then
    raise exception 'Original archived manual release differs'; end if;
  return jsonb_build_object('reservation_id',r.id,'request_id',r.request_id,'released_at',r.released_at);
end $$;
revoke all on function public.read_buyer_mentorship_manual_release_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_manual_release_v1(uuid,uuid,jsonb) to service_role;
commit;
