begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Opt in only newly created full-payment attempts. Legacy unbound attempts may
-- already have reached Stripe and must never be adopted as fresh operations.
alter table public.product_checkout_attempts
  add column original_request_protocol text check(original_request_protocol='product-checkout-original-v1'),
  add column original_request jsonb,
  add column original_request_context jsonb,
  add column original_request_started_at timestamptz,
  add column original_request_lease_token uuid,
  add column original_request_lease_until timestamptz;
alter table public.product_checkout_attempts add constraint product_checkout_original_request_shape check (
  (original_request is null and original_request_context is null and original_request_started_at is null and
    original_request_lease_token is null and original_request_lease_until is null) or
  (original_request_protocol is not null and original_request is not null and original_request_context is not null and
    original_request_started_at is not null and original_request_lease_token is not null and original_request_lease_until is not null));

create function public.guard_product_checkout_original_request_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if tg_op='INSERT' then
    if new.original_request is not null or (new.original_request_protocol is not null and
      (new.checkout_kind is distinct from 'full' or new.status is distinct from 'creating' or new.stripe_checkout_session_id is not null)) then
      raise exception 'Original checkout protocol requires a new full-payment attempt'; end if;
    return new;
  end if;
  if tg_op='DELETE' then
    if old.original_request_protocol is not null then raise exception 'Original checkout requires durable release proof'; end if;
    return old;
  end if;
  if new.original_request_protocol is distinct from old.original_request_protocol then
    raise exception 'Legacy checkout cannot adopt original-request protocol'; end if;
  if old.original_request_protocol is not null then
    if new.id is distinct from old.id or new.buyer_id is distinct from old.buyer_id or
      new.product_id is distinct from old.product_id or new.creator_id is distinct from old.creator_id or
      new.post_id is distinct from old.post_id or new.purchase_identity is distinct from old.purchase_identity or
      new.attempt_key is distinct from old.attempt_key or new.order_id is distinct from old.order_id or
      new.terms_fingerprint is distinct from old.terms_fingerprint or new.checkout_kind is distinct from old.checkout_kind or
      new.purchase_consent_id is distinct from old.purchase_consent_id then
      raise exception 'Original checkout identity is immutable'; end if;
    if old.original_request is not null and (new.original_request is distinct from old.original_request or
      new.original_request_context is distinct from old.original_request_context or
      new.original_request_started_at is distinct from old.original_request_started_at) then
      raise exception 'Original checkout request is immutable'; end if;
    if old.stripe_checkout_session_id is not null and new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id then
      raise exception 'Original checkout session is immutable'; end if;
  end if;
  return new;
end $$;
create trigger guard_product_checkout_original_request_v1 before insert or update or delete on public.product_checkout_attempts
for each row execute function public.guard_product_checkout_original_request_v1();

-- The caller must independently verify this saved context against fresh provider
-- and deployment identities. SQL admission is not payment or provider proof.
create function public.claim_product_checkout_original_request_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,
  p_context jsonb,p_request jsonb default null) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.product_checkout_attempts%rowtype; current_time_value timestamptz; params jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Checkout admission requires read committed'; end if;
  select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key for update;
  if not found or a.original_request_protocol is distinct from 'product-checkout-original-v1' or
    a.checkout_kind is distinct from 'full' then raise exception 'Owned original checkout unavailable'; end if;
  if p_context is null or jsonb_typeof(p_context) is distinct from 'object' or
    p_context->>'version' is distinct from 'exact-payment-context-v1' or
    coalesce(p_context->>'mode','') not in ('test','live') or
    coalesce(p_context->>'platformAccountId','') !~ '^acct_[A-Za-z0-9]+$' or
    coalesce(p_context->>'supabaseProjectRef','') !~ '^[a-z]{20}$' or
    coalesce(p_context->>'siteOrigin','') !~ '^https://[^/]+$' then raise exception 'Invalid checkout context'; end if;
  if a.original_request is null then
    if a.status is distinct from 'creating' or a.stripe_checkout_session_id is not null or p_request is null or
      jsonb_typeof(p_request) is distinct from 'object' or p_request->>'apiVersion' is distinct from '2025-10-29.clover' or
      p_request->>'method' is distinct from 'POST' or p_request->>'path' is distinct from '/v1/checkout/sessions' then
      raise exception 'Original checkout request required'; end if;
    params:=p_request->'params';
    if jsonb_typeof(params) is distinct from 'object' or params->>'mode' is distinct from 'payment' or
      params->'payment_method_types' is distinct from '["card"]'::jsonb or
      params#>>'{metadata,buyer_id}' is distinct from a.buyer_id::text or
      params#>>'{metadata,creator_id}' is distinct from a.creator_id::text or
      params#>>'{metadata,product_id}' is distinct from a.product_id::text or
      params#>>'{metadata,order_id}' is distinct from a.order_id::text or
      params#>>'{metadata,checkout_attempt_key}' is distinct from a.attempt_key::text or
      params#>>'{metadata,checkout_terms_fingerprint}' is distinct from a.terms_fingerprint or
      params#>'{payment_intent_data,metadata}' is distinct from params->'metadata' then
      raise exception 'Original checkout request identity mismatch'; end if;
  else
    if a.original_request_context is distinct from p_context or
      (p_request is not null and a.original_request is distinct from p_request) then raise exception 'Original checkout request changed'; end if;
  end if;
  if a.stripe_checkout_session_id is not null then
    return jsonb_build_object('status','bound','attempt',to_jsonb(a)); end if;
  if a.status is distinct from 'creating' then return jsonb_build_object('status','reconciliation_required'); end if;
  current_time_value:=clock_timestamp();
  if a.original_request_lease_until>current_time_value then return jsonb_build_object('status','busy'); end if;
  if a.original_request_started_at<=current_time_value-interval '23 hours' then
    return jsonb_build_object('status','reconciliation_required'); end if;
  update public.product_checkout_attempts set original_request=coalesce(original_request,p_request),
    original_request_context=coalesce(original_request_context,p_context),
    original_request_started_at=coalesce(original_request_started_at,current_time_value),
    original_request_lease_token=gen_random_uuid(),original_request_lease_until=current_time_value+interval '75 seconds'
    where id=a.id returning * into a;
  return jsonb_build_object('status','dispatch','attempt',to_jsonb(a),
    'idempotency_key','creatornet-product-checkout:'||a.attempt_key,
    'dispatch_before',least(current_time_value+interval '30 seconds',a.original_request_started_at+interval '23 hours'));
end $$;
revoke all on function public.guard_product_checkout_original_request_v1(),
  public.claim_product_checkout_original_request_v1(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.claim_product_checkout_original_request_v1(uuid,uuid,uuid,jsonb,jsonb) to service_role;
-- Preserve exact historical installment snapshots captured before these six
-- nullable full-payment-only columns existed. Never rewrite archived evidence.
create or replace function public.guard_buyer_installment_checkout_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op<>'INSERT' and old.checkout_kind='installments' then
    perform pg_advisory_xact_lock(hashtextextended(old.buyer_id::text||':'||old.product_id::text,72913));
    if tg_op='DELETE' and exists(select 1 from public.buyer_mentorship_installment_reservations_v1 r
      join public.buyer_mentorship_attempt_history_v1 h on h.id=r.attempt_id and h.reservation_id=r.id
      join public.buyer_mentorship_abandonment_proofs_v1 p on p.reservation_id=r.id
      where r.id=old.buyer_installment_reservation_id and r.released_at is not null and (h.original_attempt=to_jsonb(old) or (old.original_request_protocol is null and old.original_request is null and h.original_attempt=to_jsonb(old)-'original_request_protocol'-'original_request'-'original_request_context'-'original_request_started_at'-'original_request_lease_token'-'original_request_lease_until'))) and
      not exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=old.buyer_installment_reservation_id) then return old; end if;
    raise exception 'An accepted installment checkout cannot be rotated or deleted by the full-payment path';
  end if;
  if tg_op='DELETE' then return old; end if;
  if tg_op='UPDATE' and new.checkout_kind is distinct from old.checkout_kind then raise exception 'Checkout payment mode cannot change'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.buyer_id::text||':'||new.product_id::text,72913));
  if new.checkout_kind='installments' and not exists(select 1 from public.buyer_mentorship_installment_reservations_v1 r
    where r.id=new.buyer_installment_reservation_id and r.attempt_id=new.id and r.buyer_id=new.buyer_id and r.creator_id=new.creator_id and
      r.product_id=new.product_id and r.post_id=new.post_id and r.fingerprint=new.terms_fingerprint and r.released_at is null) then
    raise exception 'Installment checkout needs its original buyer acceptance'; end if;
  if new.checkout_kind='full' and exists(select 1 from public.buyer_mentorship_installment_reservations_v1 r
    where r.buyer_id=new.buyer_id and r.product_id=new.product_id and (r.released_at is null or
      exists(select 1 from public.buyer_mentorship_first_receipts_v1 f where f.reservation_id=r.id))) then
    raise exception 'This offer already has an accepted installment checkout'; end if;
  return new;
end $$;
commit;
