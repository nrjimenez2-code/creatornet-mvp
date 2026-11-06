begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Freeze full-payment source economics before any manual intent admission.
-- The existing order/consent validator remains the authority for money.
create table public.full_server_payment_sources_v1 (
  attempt_id uuid primary key references public.server_payment_protocols_v1(attempt_id),
  contract jsonb not null check(jsonb_typeof(contract)='object'),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.full_server_payment_sources_v1 enable row level security;
revoke all on public.full_server_payment_sources_v1 from public,anon,authenticated,service_role;
grant select on public.full_server_payment_sources_v1 to service_role;

do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.validate_server_payment_contract_v1(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  needle:=$old$  if s.kind='full' then
    select * into consent$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Manual source validator differs'; end if;
  execute replace(source,needle,$new$  if s.kind='full' then
    if not exists(select 1 from public.full_server_payment_sources_v1 where attempt_id=s.attempt_id and contract=p_contract) then
      raise exception 'Original full-payment source snapshot required'; end if;
    select * into consent$new$);
end $patch$;

create function public.read_full_server_payment_contract_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; c jsonb;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if s.kind<>'full' then raise exception 'Original full-payment selection required'; end if;
  select contract into c from public.full_server_payment_sources_v1 where attempt_id=s.attempt_id;
  return c;
end $$;

create function public.save_full_server_payment_contract_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_contract jsonb,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; saved jsonb;
  a public.product_checkout_attempts%rowtype; consent public.product_purchase_consents_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if s.kind<>'full' then raise exception 'Original full-payment selection required'; end if;
  select contract into saved from public.full_server_payment_sources_v1 where attempt_id=s.attempt_id;
  if found then
    if saved is distinct from p_contract then raise exception 'Original full-payment snapshot cannot change'; end if;
    return saved;
  end if;
  if exists(select 1 from public.server_payment_intent_operations_v1 where attempt_id=s.attempt_id) then
    raise exception 'Existing manual intent requires original source reconciliation'; end if;
  select * into a from public.product_checkout_attempts where id=s.attempt_id;
  select * into consent from public.product_purchase_consents_v1 where id=a.purchase_consent_id;
  if consent.id is null or length(coalesce(consent.terms->>'version','')) not between 1 and 200 or
    p_contract#>>'{sourceMetadata,purchase_consent_id}' is distinct from consent.id::text or
    p_contract#>>'{sourceMetadata,purchase_policy_version}' is distinct from consent.terms->>'version' or
    p_contract#>>'{sourceMetadata,post_id}' is distinct from coalesce(a.post_id::text,'') or
    p_contract#>>'{sourceMetadata,fixed_service_version}' is distinct from consent.terms->>'serviceVersion' then
    raise exception 'Original full-payment consent metadata differs'; end if;
  -- Insert and validate in one transaction. Invalid or stale source rolls back
  -- the insertion; no money is admitted and no new identity is allocated.
  insert into public.full_server_payment_sources_v1(attempt_id,contract) values(s.attempt_id,p_contract);
  perform public.validate_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context,p_contract,p_request);
  return p_contract;
end $$;
revoke all on function public.read_full_server_payment_contract_v1(uuid,uuid,jsonb),
  public.save_full_server_payment_contract_v1(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.read_full_server_payment_contract_v1(uuid,uuid,jsonb),
  public.save_full_server_payment_contract_v1(uuid,uuid,jsonb,jsonb,jsonb) to service_role;
commit;
