-- UNAPPLIED. Requires SQL020, SQL077, SQL095 and corrected SQL096.
-- Extends existing consent and service access; no new payment ledger.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $$ begin
  if current_user<>'postgres' or to_regclass('public.product_purchase_consents_v1') is null or
    to_regclass('public.fixed_purchase_service_contracts_v1') is null then
    raise exception 'Fixed one-time service prerequisites differ'; end if;
end $$;

alter table public.purchases add column fixed_service_consent_id uuid references public.product_purchase_consents_v1(id);
alter table public.fixed_purchase_service_contracts_v1 alter column agreement_id drop not null;
alter table public.fixed_purchase_service_contracts_v1
  add column consent_id uuid references public.product_purchase_consents_v1(id),
  add column payment_intent_id text unique,
  add column charge_id text unique,
  add constraint fixed_service_source_v1 check(
    (agreement_id is not null and consent_id is null and payment_intent_id is null and charge_id is null) or
    (agreement_id is null and consent_id is not null and payment_intent_id is not null and charge_id is not null));

-- SQL077 still validates the full price/identity/policy snapshot. This trigger
-- adds service terms without changing older accepted rows or their fingerprints.
create function public.guard_fixed_service_consent_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare months integer;
begin
  select fixed_service_months into months from public.products where id=new.product_id for share;
  if months is null then
    if new.terms ?| array['serviceMonths','serviceVersion','serviceDescription'] then
      raise exception 'Unexpected fixed service consent'; end if;
  elsif new.terms->'serviceMonths' is distinct from to_jsonb(months) or
    new.terms->>'serviceVersion' is distinct from 'fixed-service-months-v1' or
    new.terms->>'serviceDescription' is distinct from public.fixed_service_description_v1(months) then
    raise exception 'Fixed service consent does not match the current offer';
  end if;
  return new;
end $$;
create trigger fixed_service_consent_v1 before insert on public.product_purchase_consents_v1
  for each row execute function public.guard_fixed_service_consent_v1();

-- Validate every NEW attempt/rotation. Updating the binding of an already
-- issued session preserves the original promise even if the catalog changes.
create or replace function public.guard_fixed_service_one_time_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare c public.product_purchase_consents_v1%rowtype; months integer;
begin
  if tg_op='UPDATE' and new.attempt_key=old.attempt_key then
    if new.purchase_consent_id is distinct from old.purchase_consent_id and exists(
      select 1 from public.product_purchase_consents_v1 where id=old.purchase_consent_id and terms ? 'serviceMonths') then
      raise exception 'Issued checkout consent is immutable'; end if;
    return new;
  end if;
  select fixed_service_months into months from public.products where id=new.product_id for share;
  select * into c from public.product_purchase_consents_v1 where id=new.purchase_consent_id;
  if months is not null and (c.id is null or c.terms->'serviceMonths' is distinct from to_jsonb(months) or
    c.terms->>'serviceVersion' is distinct from 'fixed-service-months-v1') then
    raise exception 'Timed checkout requires the current accepted service terms'; end if;
  if months is null and c.terms ? 'serviceMonths' then raise exception 'Service terms changed; review again'; end if;
  return new;
end $$;
drop trigger fixed_service_one_time_v1 on public.product_checkout_attempts;
create trigger fixed_service_one_time_v1 before insert or update on public.product_checkout_attempts
  for each row execute function public.guard_fixed_service_one_time_v1();

-- Persist only the promise associated with the issued session. Never derive a
-- historical purchase's duration from today's product. No dates exist yet.
create function public.attach_fixed_service_consent_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare consent uuid;
begin
  if tg_op='UPDATE' and (exists(select 1 from public.fixed_purchase_service_contracts_v1 where purchase_id=old.id) or
      old.status not in ('pending','processing','failed') or old.access_granted or old.earnings_credited_at is not null) then
    if new.fixed_service_consent_id is distinct from old.fixed_service_consent_id then
      raise exception 'Existing purchase service promise is immutable'; end if;
    return new;
  end if;
  select c.id into consent from public.product_checkout_attempts attempt
    join public.product_purchase_consents_v1 c on c.id=attempt.purchase_consent_id
    where attempt.stripe_checkout_session_id=new.session_id and attempt.buyer_id=new.buyer_id and
      attempt.creator_id=new.creator_id and attempt.product_id=new.product_id and attempt.post_id is not distinct from new.post_id and
      c.terms->>'serviceVersion'='fixed-service-months-v1';
  if new.fixed_service_consent_id is not null and new.fixed_service_consent_id is distinct from consent and
    (tg_op='INSERT' or new.session_id is not distinct from old.session_id) then
    raise exception 'Purchase service consent binding differs'; end if;
  new.fixed_service_consent_id:=consent;
  return new;
end $$;
create trigger attach_fixed_service_consent_v1 before insert or update on public.purchases
  for each row execute function public.attach_fixed_service_consent_v1();

create or replace function public.mask_fixed_service_access_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  update public.fixed_purchase_service_contracts_v1
    set financial_access=coalesce(new.access_granted,false),access_updated_at=clock_timestamp() where purchase_id=new.id;
  if found or new.fixed_service_consent_id is not null then new.access_granted:=false; end if;
  return new;
end $$;
drop trigger fixed_service_access_v1 on public.purchases;
create trigger fixed_service_access_v1 before insert or update of access_granted on public.purchases
  for each row execute function public.mask_fixed_service_access_v1();

create function public.bind_fixed_service_one_time_v1(p_purchase_id uuid,p_consent_id uuid,p_attempt_key uuid,
  p_payment_intent_id text,p_charge_id text,p_captured_at bigint,p_amount_cents bigint,p_currency text)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare p public.purchases%rowtype; c public.product_purchase_consents_v1%rowtype;
  saved public.fixed_purchase_service_contracts_v1%rowtype; months integer;
begin
  select * into p from public.purchases where id=p_purchase_id for update;
  select * into c from public.product_purchase_consents_v1 where id=p_consent_id;
  if p.id is null or c.id is null or p.fixed_service_consent_id is distinct from c.id or
    p.buyer_id is distinct from c.buyer_id or p.creator_id is distinct from c.creator_id or
    p.product_id is distinct from c.product_id or p.post_id is distinct from c.post_id or p.subscription_id is not null or
    p.payment_intent_id is distinct from p_payment_intent_id or p.amount_cents is distinct from p_amount_cents or
    p_currency is distinct from 'usd' or p.currency is distinct from p_currency or
    c.terms->>'amountCents' is distinct from p_amount_cents::text or
    c.terms->>'serviceVersion' is distinct from 'fixed-service-months-v1' or
    p_captured_at is null or p_captured_at<floor(extract(epoch from c.accepted_at)) or
    p_captured_at>extract(epoch from clock_timestamp()) or p_charge_id is null or p_charge_id !~ '^ch_[A-Za-z0-9]+$' or
    p_payment_intent_id is null or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$' or
    not exists(select 1 from public.product_checkout_attempts attempt where attempt.attempt_key=p_attempt_key and
      attempt.purchase_consent_id=c.id and attempt.stripe_checkout_session_id=p.session_id and attempt.order_id=p.order_id) then
    raise exception 'Captured one-time service binding differs'; end if;
  months:=(c.terms->>'serviceMonths')::integer;
  select * into saved from public.fixed_purchase_service_contracts_v1 where purchase_id=p.id;
  if found then
    if saved.consent_id is distinct from c.id or saved.payment_intent_id is distinct from p_payment_intent_id or
      saved.charge_id is distinct from p_charge_id or saved.service_start_at is distinct from p_captured_at or
      saved.service_months is distinct from months then raise exception 'Fixed service capture replay differs'; end if;
    return true; -- Never reset dates or a later financial revocation.
  end if;
  if p.status<>'paid' or p.is_refund or p.is_suspect or p.earnings_credited_at is null or
    not exists(select 1 from public.payment_fee_ledger l where l.purchase_id=p.id and l.stripe_payment_intent_id=p_payment_intent_id and
      l.stripe_charge_id=p_charge_id and l.gross_amount_cents=p_amount_cents and l.status='paid' and
      coalesce(l.refunded_amount_cents,0)=0 and coalesce(l.earnings_reversed_cents,0)=0 and
      (l.dispute_status is null or l.dispute_status in ('won','warning_closed'))) then
    raise exception 'Credited one-time capture required'; end if;
  insert into public.fixed_purchase_service_contracts_v1(purchase_id,consent_id,payment_intent_id,charge_id,version,
    service_months,service_start_at,service_end_at,financial_access)
    values(p.id,c.id,p_payment_intent_id,p_charge_id,'fixed-service-months-v1',months,p_captured_at,
      public.fixed_service_end_v1(p_captured_at,months),true);
  return true;
end $$;

-- Keep the existing installment reader unchanged and private behind the shared
-- entry point. A missing one-time capture can never fall through to legacy access.
alter function public.read_fixed_service_entitlement_v1(uuid,uuid) rename to read_fixed_service_context_entitlement_v1;
revoke all on function public.read_fixed_service_context_entitlement_v1(uuid,uuid) from public,anon,authenticated,service_role;
create function public.read_fixed_service_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p public.purchases%rowtype; c public.fixed_purchase_service_contracts_v1%rowtype;
  financial boolean:=false; seconds integer:=0; at_time numeric:=extract(epoch from clock_timestamp());
begin
  select * into p from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id;
  if p.id is null or p.fixed_service_consent_id is null then
    return public.read_fixed_service_context_entitlement_v1(p_purchase_id,p_buyer_id); end if;
  select * into c from public.fixed_purchase_service_contracts_v1 where purchase_id=p.id and consent_id=p.fixed_service_consent_id;
  financial:=coalesce(c.financial_access and c.payment_intent_id=p.payment_intent_id and p.status='paid' and
    not p.is_refund and not p.is_suspect and p.earnings_credited_at is not null and
    exists(select 1 from public.payment_fee_ledger l where l.purchase_id=p.id and l.stripe_payment_intent_id=c.payment_intent_id and
      l.stripe_charge_id=c.charge_id and l.status='paid' and coalesce(l.refunded_amount_cents,0)=0 and
      coalesce(l.earnings_reversed_cents,0)=0 and (l.dispute_status is null or l.dispute_status in ('won','warning_closed'))) and
    not exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=c.payment_intent_id and refunded_amount_cents>0) and
    not exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=c.payment_intent_id and status not in ('won','warning_closed')) and
    not exists(select 1 from public.refund_operations where stripe_payment_intent_id=c.payment_intent_id and status not in ('failed','completed')),false);
  if financial and at_time>=c.service_start_at then seconds:=floor(least(3600,greatest(0,c.service_end_at-at_time)))::integer; end if;
  return jsonb_build_object('applicable',true,'serviceMonths',c.service_months,'serviceStartAt',c.service_start_at,
    'serviceEndAt',c.service_end_at,'financialAccess',financial,'allowed',seconds>0,'maxAgeSeconds',seconds);
end $$;

revoke all on function public.guard_fixed_service_consent_v1(),public.attach_fixed_service_consent_v1(),
  public.bind_fixed_service_one_time_v1(uuid,uuid,uuid,text,text,bigint,bigint,text),
  public.read_fixed_service_entitlement_v1(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.bind_fixed_service_one_time_v1(uuid,uuid,uuid,text,text,bigint,bigint,text),
  public.read_fixed_service_entitlement_v1(uuid,uuid) to service_role;
commit;
