begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Admit manual terminal evidence into the existing stop-proof/archive engine.
-- No hosted Checkout Session is invented and no financial hold is cleared.
create function public.record_full_manual_release_proof_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; a public.product_checkout_attempts%rowtype;
  original jsonb; terminal jsonb; saved public.product_checkout_stop_proofs_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key for update;
  if not found or s.kind is distinct from 'full' or a.checkout_kind is distinct from 'full' or
    a.status is distinct from 'creating' or a.original_request_protocol is not null or a.original_request is not null or
    a.stripe_checkout_session_id is not null or a.stripe_checkout_url is not null or
    s.source is distinct from jsonb_build_object('id',a.id,'buyer_id',a.buyer_id,'creator_id',a.creator_id,'product_id',a.product_id,
      'post_id',a.post_id,'purchase_identity',a.purchase_identity,'attempt_key',a.attempt_key,'order_id',a.order_id,
      'terms_fingerprint',a.terms_fingerprint,'purchase_consent_id',a.purchase_consent_id) then
    raise exception 'Owned original full manual selection required'; end if;
  original:=public.read_server_payment_cancellation_source_v1(p_attempt_id,p_buyer_id,p_context);
  if original is null or original#>>'{contract,kind}' is distinct from 'full' or
    original->'contract' is distinct from public.read_full_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context) then
    raise exception 'Original full manual source needs reconciliation'; end if;
  perform pg_advisory_xact_lock(hashtextextended(original->>'payment_intent_id',73591));
  if exists(select 1 from public.full_server_payment_receipts_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.full_server_payment_refund_events_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.full_server_payment_dispute_events_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.full_server_payment_refund_object_events_v1 where attempt_id=p_attempt_id) then
    raise exception 'Original full manual financial state requires review'; end if;
  if jsonb_typeof(p_proof) is distinct from 'object' or
    p_proof-array['version','manualPayment','amountCents','currency','paymentIntent','observedAt']<>'{}'::jsonb or
    p_proof->>'version' is distinct from 'full-manual-payment-stop-v1' or
    p_proof->'amountCents' is distinct from original#>'{contract,amountCents}' or p_proof->>'currency' is distinct from 'usd' or
    p_proof->'observedAt' is distinct from p_proof#>'{manualPayment,observedAt}' or
    p_proof->'paymentIntent' is distinct from jsonb_build_object('id',original->>'payment_intent_id','status','canceled','amountReceived',0,'amountCapturable',0) then
    raise exception 'Original full manual terminal proof differs'; end if;
  terminal:=public.record_server_payment_terminal_v1(p_attempt_id,p_buyer_id,p_context,p_proof->'manualPayment');
  if terminal-'observedAt' is distinct from (p_proof->'manualPayment')-'observedAt' then
    raise exception 'Original full manual terminal proof changed'; end if;
  select * into saved from public.product_checkout_stop_proofs_v1 where attempt_id=p_attempt_id;
  if found then
    if saved.proof-'observedAt'-'manualPayment' is distinct from p_proof-'observedAt'-'manualPayment' or
      (saved.proof->'manualPayment')-'observedAt' is distinct from terminal-'observedAt' then
      raise exception 'Original manual release proof cannot change'; end if;
    return to_jsonb(saved);
  end if;
  insert into public.product_checkout_stop_proofs_v1(attempt_id,proof) values(p_attempt_id,p_proof) returning * into saved;
  return to_jsonb(saved);
end $$;
revoke all on function public.record_full_manual_release_proof_v1(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_full_manual_release_proof_v1(uuid,uuid,uuid,jsonb,jsonb) to service_role;

do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.record_product_checkout_stop_proof_v1(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
  needle:=$old$ if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh terminal checkout proof required'; end if;$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Original stop proof entry differs'; end if;
  execute replace(source,needle,needle||$new$
 if exists(select 1 from public.server_payment_protocols_v1 where attempt_id=p_attempt_id) then
   return public.record_full_manual_release_proof_v1(p_attempt_id,p_buyer_id,p_attempt_key,p_context,p_proof);
 end if;$new$);

  source:=pg_get_functiondef('public.release_product_checkout_stop_v1(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
  needle:=$old$(a.original_request#>>'{params,line_items,0,price_data,unit_amount}')::bigint$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Original release amount check differs'; end if;
  execute replace(source,needle,$new$(case when p_proof->>'version'='full-manual-payment-stop-v1'
    then (p_proof->>'amountCents')::bigint else (a.original_request#>>'{params,line_items,0,price_data,unit_amount}')::bigint end)$new$);

  source:=pg_get_functiondef('public.guard_server_payment_attempt_v1()'::regprocedure);
  needle:=$old$  if tg_op='DELETE' then$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Original manual deletion guard differs'; end if;
  execute replace(source,needle,needle||$new$
    if saved.kind='full' and old.checkout_kind='full' and exists(
      select 1 from public.product_checkout_releases_v1 h
      join public.product_checkout_stop_proofs_v1 p on p.attempt_id=h.attempt_id
      join public.server_payment_intent_terminal_v1 t on t.attempt_id=h.attempt_id
      join public.server_payment_stops_v1 stop on stop.attempt_id=h.attempt_id
      where h.attempt_id=old.id and h.buyer_id=saved.buyer_id and h.context=saved.context and
        h.attempt_key=old.attempt_key and h.original_attempt=to_jsonb(old) and
        p.proof->>'version'='full-manual-payment-stop-v1' and
        (p.proof->'manualPayment')-'observedAt'=t.proof-'observedAt') then return old; end if;$new$);
end $patch$;

-- Recovery reads only the original archive; a newer selection is never read,
-- stopped, canceled, deleted or used as evidence for the old release.
create function public.read_full_manual_release_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; h public.product_checkout_releases_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if s.kind is distinct from 'full' or s.source->>'attempt_key' is distinct from p_attempt_key::text then
    raise exception 'Owned original manual release required'; end if;
  select * into h from public.product_checkout_releases_v1 where attempt_id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key;
  if not found then return null; end if;
  if h.context is distinct from p_context or h.product_id is distinct from s.product_id or
    h.original_attempt->>'id' is distinct from p_attempt_id::text or
    h.original_attempt->>'buyer_id' is distinct from p_buyer_id::text or
    h.original_attempt->>'attempt_key' is distinct from p_attempt_key::text or
    not exists(select 1 from public.product_checkout_stop_proofs_v1 p
      join public.server_payment_intent_terminal_v1 t on t.attempt_id=p.attempt_id
      join public.server_payment_stops_v1 stop on stop.attempt_id=p.attempt_id
      where p.attempt_id=p_attempt_id and p.proof->>'version'='full-manual-payment-stop-v1' and
        (p.proof->'manualPayment')-'observedAt'=t.proof-'observedAt') then
    raise exception 'Original manual release archive differs'; end if;
  return jsonb_build_object('attempt_id',h.attempt_id,'product_id',h.product_id,'released_at',h.released_at);
end $$;
revoke all on function public.read_full_manual_release_v1(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_full_manual_release_v1(uuid,uuid,uuid,jsonb) to service_role;
commit;
