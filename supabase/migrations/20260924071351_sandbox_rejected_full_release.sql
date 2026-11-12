begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Trusted operator evidence only. No buyer-controlled HTTP route invokes this.
-- An HTTP 400 alone or an empty inventory alone is not accepted. This narrow
-- sandbox recovery requires the exact independently reviewed parameter error.
create table public.server_payment_create_rejections_v1 (
  attempt_id uuid primary key references public.server_payment_intent_operations_v1(attempt_id),
  evidence jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.server_payment_create_rejections_v1 enable row level security;
revoke all on public.server_payment_create_rejections_v1 from public,anon,authenticated,service_role;
grant select on public.server_payment_create_rejections_v1 to service_role;
create function public.release_rejected_full_payment_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,p_context jsonb,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; a public.product_checkout_attempts%rowtype;
  h public.product_checkout_releases_v1%rowtype; o public.orders%rowtype; order_snapshot jsonb; terms jsonb; proof jsonb; op public.server_payment_intent_operations_v1%rowtype; rejection public.server_payment_create_rejections_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if s.kind is distinct from 'full' or s.source->>'attempt_key' is distinct from p_attempt_key::text or
    not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Owned current full payment required'; end if;
  select * into h from public.product_checkout_releases_v1 where attempt_id=p_attempt_id;
  if found then return public.read_full_manual_release_v1(p_attempt_id,p_buyer_id,p_attempt_key,p_context); end if;
  select * into op from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id for update;
  if not found or op.bound_at is not null or op.payment_intent_id is not null or op.provider_request_id is not null or
    op.lease_until>=clock_timestamp()-interval '60 seconds' or
    p_context->>'mode' is distinct from 'test' or
    op.request#>>'{apiVersion}' is distinct from '2025-10-29.clover' or
    op.request#>>'{method}' is distinct from 'POST' or op.request#>>'{path}' is distinct from '/v1/payment_intents' or
    op.request#>'{params,confirm}' is distinct from 'false'::jsonb or
    op.request#>>'{params,confirmation_method}' is distinct from 'manual' or
    op.request#>'{params,automatic_payment_methods}' is distinct from '{"enabled":false}'::jsonb or
    op.request#>'{params,payment_method_types}' is not null then
    raise exception 'Exact expired sandbox validation rejection required'; end if;
  if jsonb_typeof(p_evidence) is distinct from 'object' or
    p_evidence-array['version','requestId','idempotencyKey','request','context','error','status','observedAt','reviewedBy','providerInventoryComplete','matchingIntentIds']<>'{}'::jsonb or
    p_evidence->>'version' is distinct from 'operator-reviewed-stripe-create-rejection-v1' or
    coalesce(p_evidence->>'requestId','')!~'^req_[A-Za-z0-9]+$' or
    p_evidence->>'idempotencyKey' is distinct from op.idempotency_key or
    p_evidence->'request' is distinct from op.request or p_evidence->'context' is distinct from p_context or
    p_evidence->'status' is distinct from '400'::jsonb or
    p_evidence->'error' is distinct from jsonb_build_object('type','invalid_request_error','param','automatic_payment_methods',
      'message','You may only specify one of these parameters: automatic_payment_methods, confirmation_method.') or
    p_evidence->'providerInventoryComplete' is distinct from 'true'::jsonb or
    p_evidence->'matchingIntentIds' is distinct from '[]'::jsonb or
    length(coalesce(p_evidence->>'reviewedBy','')) not between 1 and 200 or
    coalesce(p_evidence->>'observedAt','')!~'^[0-9]{10}$' or
    (p_evidence->>'observedAt')::bigint>floor(extract(epoch from clock_timestamp())) or
    (p_evidence->>'observedAt')::bigint<floor(extract(epoch from clock_timestamp()))-120 then
    raise exception 'Fresh independent operator rejection evidence required'; end if;
  if exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.server_payment_intent_cancellations_v1 where attempt_id=p_attempt_id) or
    exists(select 1 from public.server_payment_intent_terminal_v1 where attempt_id=p_attempt_id) then
    raise exception 'Original provider operations require reconciliation'; end if;
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
  insert into public.server_payment_create_rejections_v1(attempt_id,evidence) values(a.id,p_evidence) returning * into rejection;
  proof:=jsonb_build_object('version','full-manual-rejected-stop-v1','attemptId',a.id,'orderId',a.order_id,'rejection',rejection.evidence);
  insert into public.product_checkout_stop_proofs_v1(attempt_id,proof) values(a.id,proof);
  insert into public.product_checkout_releases_v1(attempt_id,buyer_id,product_id,attempt_key,context,original_attempt,original_order,original_purchases)
    values(a.id,a.buyer_id,a.product_id,a.attempt_key,p_context,to_jsonb(a),order_snapshot,'[]'::jsonb) returning * into h;
  if order_snapshot<>'null'::jsonb then update public.orders set status='canceled' where id=a.order_id; end if;
  delete from public.product_checkout_attempts where id=a.id;
  return jsonb_build_object('attempt_id',h.attempt_id,'product_id',h.product_id,'released_at',h.released_at);
end $$;
revoke all on function public.release_rejected_full_payment_v1(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.release_rejected_full_payment_v1(uuid,uuid,uuid,jsonb,jsonb) to service_role;

do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.guard_server_payment_attempt_v1()'::regprocedure);
  needle:=$old$  if tg_op='DELETE' then$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Rejection deletion guard differs'; end if;
  execute replace(source,needle,needle||$new$
    if saved.kind='full' and exists(select 1 from public.product_checkout_releases_v1 h
      join public.product_checkout_stop_proofs_v1 p on p.attempt_id=h.attempt_id
      join public.server_payment_create_rejections_v1 r on r.attempt_id=h.attempt_id
      join public.server_payment_stops_v1 stop on stop.attempt_id=h.attempt_id
      join public.server_payment_intent_operations_v1 op on op.attempt_id=h.attempt_id
      where h.attempt_id=old.id and h.buyer_id=saved.buyer_id and h.context=saved.context and h.attempt_key=old.attempt_key
        and h.original_attempt=to_jsonb(old) and op.bound_at is null and op.request=r.evidence->'request'
        and op.idempotency_key=r.evidence->>'idempotencyKey' and p.proof=jsonb_build_object('version','full-manual-rejected-stop-v1',
          'attemptId',old.id,'orderId',old.order_id,'rejection',r.evidence)) then return old; end if;
$new$);
  source:=pg_get_functiondef('public.read_full_manual_release_v1(uuid,uuid,uuid,jsonb)'::regprocedure);
  needle:=$old$    not exists(select 1 from public.product_checkout_stop_proofs_v1 p$old$;
  -- Earlier migration adds two independent terminal cases. Insert this new
  -- alternative only at the first occurrence, preserving both existing cases.
  if position(needle in source)=0 then raise exception 'Rejection release read differs'; end if;
  source:=overlay(source placing $new$    not exists(select 1 from public.product_checkout_stop_proofs_v1 p
      join public.server_payment_create_rejections_v1 r on r.attempt_id=p.attempt_id
      join public.server_payment_stops_v1 stop on stop.attempt_id=p.attempt_id
      join public.server_payment_intent_operations_v1 op on op.attempt_id=p.attempt_id
      where p.attempt_id=p_attempt_id and op.bound_at is null and op.request=r.evidence->'request'
        and op.idempotency_key=r.evidence->>'idempotencyKey' and p.proof=jsonb_build_object('version','full-manual-rejected-stop-v1',
          'attemptId',p_attempt_id,'orderId',(s.source->>'order_id')::uuid,'rejection',r.evidence)) and
$new$ from position(needle in source) for 0);
  execute source;
end $patch$;
commit;
