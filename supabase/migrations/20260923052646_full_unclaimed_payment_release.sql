begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- No provider claim exists: archive the exact reservation under the same lock
-- used by claim_server_payment_intent_v1. A claimed-but-unbound operation is
-- never admitted here. Stop survives removal of active coordination.
create function public.release_unclaimed_full_payment_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; a public.product_checkout_attempts%rowtype;
  h public.product_checkout_releases_v1%rowtype; o public.orders%rowtype; order_snapshot jsonb; terms jsonb; proof jsonb;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if s.kind is distinct from 'full' or s.source->>'attempt_key' is distinct from p_attempt_key::text or
    not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Owned current full payment required'; end if;
  select * into h from public.product_checkout_releases_v1 where attempt_id=p_attempt_id;
  if found then return public.read_full_manual_release_v1(p_attempt_id,p_buyer_id,p_attempt_key,p_context); end if;
  if exists(select 1 from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id) then return null; end if;
  select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key for update;
  if not found or a.product_id is distinct from s.product_id or a.checkout_kind is distinct from 'full' or
    a.status is distinct from 'creating' or a.original_request is not null or a.original_request_protocol is not null or
    a.stripe_checkout_session_id is not null or a.stripe_checkout_url is not null or
    s.source is distinct from jsonb_build_object('id',a.id,'buyer_id',a.buyer_id,'creator_id',a.creator_id,'product_id',a.product_id,
      'post_id',a.post_id,'purchase_identity',a.purchase_identity,'attempt_key',a.attempt_key,'order_id',a.order_id,
      'terms_fingerprint',a.terms_fingerprint,'purchase_consent_id',a.purchase_consent_id) then
    raise exception 'Original full reservation differs'; end if;
  if exists(select 1 from public.full_server_payment_receipts_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.full_server_payment_refund_events_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.full_server_payment_dispute_events_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.full_server_payment_refund_object_events_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.product_checkout_stop_proofs_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.product_checkout_stop_operations_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.payment_fee_ledger where order_id=a.order_id) or
    exists(select 1 from public.refund_operations where order_id=a.order_id) or
    exists(select 1 from public.purchases where buyer_id=a.buyer_id and (product_id=a.product_id or post_id=a.post_id)) then
    raise exception 'Original financial or operational state requires reconciliation'; end if;
  select c.terms into terms from public.product_purchase_consents_v1 c where c.id=a.purchase_consent_id;
  if terms->>'buyerId' is distinct from a.buyer_id::text or terms->>'creatorId' is distinct from a.creator_id::text or
    terms->>'productId' is distinct from a.product_id::text or terms->>'postId' is distinct from a.post_id::text or
    terms->>'kind' is distinct from 'one_time' or terms->>'currency' is distinct from 'usd' or
    coalesce((terms->>'amountCents')::bigint,0)<50 then raise exception 'Original accepted terms differ'; end if;
  select * into o from public.orders where id=a.order_id for update;
  if found then
    if o.buyer_id is distinct from a.buyer_id or o.creator_id is distinct from a.creator_id or o.post_id is distinct from a.post_id or
      o.amount_cents is distinct from (terms->>'amountCents')::bigint or o.currency is distinct from 'usd' or
      coalesce(o.status,'') not in ('created','canceled') or o.stripe_checkout_session_id is not null or o.stripe_payment_intent_id is not null then
      raise exception 'Original unclaimed order differs'; end if;
    order_snapshot:=to_jsonb(o);
  else order_snapshot:='null'::jsonb;
  end if;
  perform public.request_server_payment_stop_v1(p_attempt_id,p_buyer_id,p_context);
  proof:=jsonb_build_object('version','full-manual-unclaimed-stop-v1','attemptId',a.id,'orderId',a.order_id,'intentOperationAbsent',true);
  insert into public.product_checkout_stop_proofs_v1(attempt_id,proof) values(a.id,proof);
  insert into public.product_checkout_releases_v1(attempt_id,buyer_id,product_id,attempt_key,context,original_attempt,original_order,original_purchases)
    values(a.id,a.buyer_id,a.product_id,a.attempt_key,p_context,to_jsonb(a),order_snapshot,'[]'::jsonb) returning * into h;
  if order_snapshot<>'null'::jsonb then update public.orders set status='canceled' where id=a.order_id; end if;
  delete from public.product_checkout_attempts where id=a.id;
  return jsonb_build_object('attempt_id',h.attempt_id,'product_id',h.product_id,'released_at',h.released_at);
end $$;
revoke all on function public.release_unclaimed_full_payment_v1(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.release_unclaimed_full_payment_v1(uuid,uuid,uuid,jsonb) to service_role;

do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.guard_server_payment_attempt_v1()'::regprocedure);
  needle:=$old$  if tg_op='DELETE' then$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Manual deletion guard differs'; end if;
  execute replace(source,needle,$new$  if tg_op='INSERT' and exists(select 1 from public.product_checkout_releases_v1 where attempt_id=new.id) then
    raise exception 'Released full payment cannot recreate its attempt'; end if;
$new$||needle||$new$
    if saved.kind='full' and exists(select 1 from public.product_checkout_releases_v1 h
      join public.product_checkout_stop_proofs_v1 p on p.attempt_id=h.attempt_id
      join public.server_payment_stops_v1 stop on stop.attempt_id=h.attempt_id
      where h.attempt_id=old.id and h.buyer_id=saved.buyer_id and h.context=saved.context and h.attempt_key=old.attempt_key and
        h.original_attempt=to_jsonb(old) and p.proof=jsonb_build_object('version','full-manual-unclaimed-stop-v1',
          'attemptId',old.id,'orderId',old.order_id,'intentOperationAbsent',true)) and
      not exists(select 1 from public.server_payment_intent_operations_v1 where attempt_id=old.id) then return old; end if;$new$);

  source:=pg_get_functiondef('public.read_full_manual_release_v1(uuid,uuid,uuid,jsonb)'::regprocedure);
  needle:=$old$    not exists(select 1 from public.product_checkout_stop_proofs_v1 p$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Manual release read differs'; end if;
  execute replace(source,needle,$new$    not exists(select 1 from public.product_checkout_stop_proofs_v1 p
      join public.server_payment_stops_v1 stop on stop.attempt_id=p.attempt_id
      where p.attempt_id=p_attempt_id and p.proof=jsonb_build_object('version','full-manual-unclaimed-stop-v1',
        'attemptId',p_attempt_id,'orderId',(s.source->>'order_id')::uuid,'intentOperationAbsent',true) and
        not exists(select 1 from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id)) and
    not exists(select 1 from public.product_checkout_stop_proofs_v1 p$new$);
end $patch$;

-- Acceptance inserts its order after reserving. A delayed insert must not
-- recreate that order after an absent-order release committed.
create function public.guard_unclaimed_full_order_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype;
begin
  select * into s from public.server_payment_protocols_v1 where kind='full' and source->>'order_id'=new.id::text;
  if not found then return new; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh original order required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.buyer_id::text||':'||s.product_id::text,72913));
  if exists(select 1 from public.product_checkout_releases_v1 where attempt_id=s.attempt_id) then
    raise exception 'Released full payment cannot recreate its order'; end if;
  return new;
end $$;
revoke all on function public.guard_unclaimed_full_order_v1() from public,anon,authenticated;
create trigger guard_unclaimed_full_order_v1 before insert on public.orders
  for each row execute function public.guard_unclaimed_full_order_v1();
commit;
