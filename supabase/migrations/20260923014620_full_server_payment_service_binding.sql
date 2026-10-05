begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Private source predicate shared by the existing attachment trigger and
-- service binder. A null Checkout session alone is never manual provenance.
create function public.full_server_payment_service_consent_v1(p public.purchases,
  p_attempt_key uuid default null,p_charge_id text default null,p_captured_at bigint default null)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare receipt public.full_server_payment_receipts_v1%rowtype;
  source public.server_payment_protocols_v1%rowtype; consent public.product_purchase_consents_v1%rowtype;
begin
  if p.session_id is not null or p.subscription_id is not null or p.payment_intent_id is null then return null; end if;
  select * into receipt from public.full_server_payment_receipts_v1 where payment_intent_id=p.payment_intent_id;
  if not found then return null; end if;
  select * into source from public.server_payment_protocols_v1 where attempt_id=receipt.attempt_id and kind='full';
  select * into consent from public.product_purchase_consents_v1 where id::text=receipt.proof->>'purchaseConsentId';
  if source.attempt_id is null or consent.id is null or consent.terms->>'serviceVersion' is distinct from 'fixed-service-months-v1' or
    p.buyer_id::text is distinct from receipt.proof->>'buyerId' or p.creator_id::text is distinct from receipt.proof->>'creatorId' or
    p.product_id::text is distinct from receipt.proof->>'productId' or p.post_id::text is distinct from receipt.proof->>'postId' or
    p.order_id::text is distinct from receipt.proof->>'orderId' or p.amount_cents::text is distinct from receipt.proof->>'amountCents' or
    p.currency is distinct from 'usd' or source.source->>'purchase_consent_id' is distinct from consent.id::text or
    (p_attempt_key is not null and p_attempt_key::text is distinct from source.source->>'attempt_key') or
    (p_charge_id is not null and p_charge_id is distinct from receipt.charge_id) or
    (p_captured_at is not null and p_captured_at::text is distinct from receipt.proof->>'paidAt') then return null; end if;
  return consent.id;
end $$;
revoke all on function public.full_server_payment_service_consent_v1(public.purchases,uuid,text,bigint)
  from public,anon,authenticated,service_role;

do $patch$
declare source text; needle text;
begin
  source:=replace(pg_get_functiondef('public.attach_fixed_service_consent_v1()'::regprocedure),E'\r\n',E'\n');
  needle:=$old$  select c.id into consent from public.product_checkout_records_v1 attempt$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Original service attachment differs'; end if;
  source:=replace(source,needle,$new$  if new.session_id is null and new.payment_intent_id is not null then
    consent:=public.full_server_payment_service_consent_v1(new);
  else
  select c.id into consent from public.product_checkout_records_v1 attempt$new$);
  needle:=$old$      c.terms->>'serviceVersion'='fixed-service-months-v1';$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Original service attachment end differs'; end if;
  execute replace(source,needle,needle||E'\n  end if;');

  source:=replace(pg_get_functiondef('public.bind_fixed_service_one_time_v1(uuid,uuid,uuid,text,text,bigint,bigint,text)'::regprocedure),E'\r\n',E'\n');
  needle:=$old$    not exists(select 1 from public.product_checkout_records_v1 attempt where attempt.attempt_key=p_attempt_key and
      attempt.purchase_consent_id=c.id and attempt.stripe_checkout_session_id=p.session_id and attempt.order_id=p.order_id)$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Original service capture binding differs'; end if;
  execute replace(source,needle,$new$    not (exists(select 1 from public.product_checkout_records_v1 attempt where attempt.attempt_key=p_attempt_key and
      attempt.purchase_consent_id=c.id and attempt.stripe_checkout_session_id=p.session_id and attempt.order_id=p.order_id) or
      (p.session_id is null and p_attempt_key is not null and coalesce(
        public.full_server_payment_service_consent_v1(p,p_attempt_key,p_charge_id,p_captured_at)=c.id,false)))$new$);
end $patch$;
commit;
