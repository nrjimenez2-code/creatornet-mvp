begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.product_checkout_stop_proofs_v1 (
 attempt_id uuid primary key references public.product_checkout_attempts(id),
 proof jsonb not null check(jsonb_typeof(proof)='object'),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table public.product_checkout_stop_proofs_v1 enable row level security;
revoke all on public.product_checkout_stop_proofs_v1 from public,anon,authenticated,service_role;
grant select,insert on public.product_checkout_stop_proofs_v1 to service_role;

create function public.record_product_checkout_stop_proof_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.product_checkout_attempts%rowtype; saved public.product_checkout_stop_proofs_v1%rowtype;
 now_seconds bigint; intent jsonb;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh terminal checkout proof required'; end if;
 select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key;
 if not found then raise exception 'Owned original proof unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.buyer_id::text||':'||a.product_id::text,72913));
 select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key for update;
 if not found or a.original_request_protocol is distinct from 'product-checkout-original-v1' or a.checkout_kind is distinct from 'full' or
  a.original_stop_requested_at is null or p_context is null or a.original_request_context is distinct from p_context or
  a.original_request is null or a.stripe_checkout_session_id is null or a.status is distinct from 'open' then
  raise exception 'Original stop state requires reconciliation'; end if;
 if p_proof is null or jsonb_typeof(p_proof) is distinct from 'object' or
  p_proof-array['version','sessionId','checkoutStatus','paymentStatus','amountCents','currency','paymentIntent','observedAt']<>'{}'::jsonb or
  p_proof->>'version' is distinct from 'product-unpaid-stop-v1' or p_proof->>'sessionId' is distinct from a.stripe_checkout_session_id or
  p_proof->>'checkoutStatus' is distinct from 'expired' or p_proof->>'paymentStatus' is distinct from 'unpaid' or
  p_proof->>'currency' is distinct from 'usd' or jsonb_typeof(p_proof->'amountCents') is distinct from 'number' or
  coalesce(p_proof->>'amountCents','')!~'^[0-9]{1,8}$' or
  p_proof->'amountCents' is distinct from a.original_request#>'{params,line_items,0,price_data,unit_amount}' or
  jsonb_typeof(p_proof->'observedAt') is distinct from 'number' or coalesce(p_proof->>'observedAt','')!~'^[0-9]{1,12}$' then
  raise exception 'Terminal checkout proof differs'; end if;
 if (p_proof->>'amountCents')::bigint<50 then raise exception 'Invalid original amount'; end if;
 now_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
 if (p_proof->>'observedAt')::bigint<now_seconds-30 or (p_proof->>'observedAt')::bigint>now_seconds+5 then
  raise exception 'Terminal checkout proof is stale'; end if;
 intent:=p_proof->'paymentIntent';
 if intent is distinct from 'null'::jsonb then
  if intent is null or jsonb_typeof(intent) is distinct from 'object' or
   intent-array['id','status','amountReceived','amountCapturable']<>'{}'::jsonb or
   coalesce(intent->>'id','')!~'^pi_[A-Za-z0-9]+$' or intent->>'status' is distinct from 'canceled' or
   intent->'amountReceived' is distinct from '0'::jsonb or intent->'amountCapturable' is distinct from '0'::jsonb then
   raise exception 'Original payment intent is not terminal unpaid'; end if;
 end if;
 -- The server verifies provider objects. SQL rejects contradicting financial
 -- state; storing terminal observation itself grants no deletion or release.
 if exists(select 1 from public.orders where id=a.order_id and
   (buyer_id is distinct from a.buyer_id or coalesce(status,'') not in ('created','canceled') or
    (stripe_checkout_session_id is not null and stripe_checkout_session_id<>a.stripe_checkout_session_id) or
    (stripe_payment_intent_id is not null and stripe_payment_intent_id is distinct from intent->>'id'))) or
  exists(select 1 from public.purchases where session_id=a.stripe_checkout_session_id and
   (buyer_id is distinct from a.buyer_id or coalesce(status,'') not in ('pending','processing','failed','canceled') or
    (payment_intent_id is not null and payment_intent_id is distinct from intent->>'id') or
    access_granted is true or earnings_credited_at is not null or is_refund is true or is_suspect is true)) then
  raise exception 'Recorded financial state requires reconciliation'; end if;
 select * into saved from public.product_checkout_stop_proofs_v1 where attempt_id=a.id;
 if found then
  if saved.proof-'observedAt' is distinct from p_proof-'observedAt' then raise exception 'Original terminal checkout proof changed'; end if;
  return to_jsonb(saved);
 end if;
 insert into public.product_checkout_stop_proofs_v1(attempt_id,proof) values(a.id,p_proof) returning * into saved;
 return to_jsonb(saved);
end $$;
revoke all on function public.record_product_checkout_stop_proof_v1(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_product_checkout_stop_proof_v1(uuid,uuid,uuid,jsonb,jsonb) to service_role;
commit;
