begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Immutable server-observed terminal state. This does not release the active
-- purchase identity; release must still reject newly recorded captures.
create table public.buyer_mentorship_abandonment_proofs_v1 (
  reservation_id uuid primary key references public.buyer_mentorship_abandonment_holds_v1(reservation_id),
  proof jsonb not null check(jsonb_typeof(proof)='object'),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.buyer_mentorship_abandonment_proofs_v1 enable row level security;
revoke all on public.buyer_mentorship_abandonment_proofs_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_abandonment_proofs_v1 to service_role;

create function public.record_buyer_mentorship_abandonment_proof_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  saved public.buyer_mentorship_abandonment_proofs_v1%rowtype;
  subscription_id text; session_id text; current_seconds bigint;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh stop proof required'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned stop reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  if not exists(select 1 from public.buyer_mentorship_abandonment_holds_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id) then
    raise exception 'Unpaid stop state requires reconciliation'; end if;
  select result_id into subscription_id from public.buyer_mentorship_bootstrap_operations_v1
    where reservation_id=r.id and step='subscription.create' and bound_at is not null;
  select result_id into session_id from public.buyer_mentorship_bootstrap_operations_v1
    where reservation_id=r.id and step='checkout.create' and bound_at is not null;
  current_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
  if subscription_id is null or session_id is null or jsonb_typeof(p_proof) is distinct from 'object' or
    p_proof - array['version','subscriptionId','sessionId','canceledAt','checkoutStatus','firstPaymentIntentId','observedAt']<>'{}'::jsonb or
    p_proof->>'version' is distinct from 'buyer-unpaid-stop-v1' or
    p_proof->>'subscriptionId' is distinct from subscription_id or p_proof->>'sessionId' is distinct from session_id or
    p_proof->>'checkoutStatus' is distinct from 'expired' or p_proof->'firstPaymentIntentId' is distinct from 'null'::jsonb or
    jsonb_typeof(p_proof->'canceledAt') is distinct from 'number' or
    jsonb_typeof(p_proof->'observedAt') is distinct from 'number' or
    coalesce(p_proof->>'canceledAt','')!~'^[0-9]{1,12}$' or coalesce(p_proof->>'observedAt','')!~'^[0-9]{1,12}$' then
    raise exception 'Terminal stop proof differs'; end if;
  if (p_proof->>'canceledAt')::bigint<=0 or (p_proof->>'canceledAt')::bigint>(p_proof->>'observedAt')::bigint or
    (p_proof->>'observedAt')::bigint<current_seconds-30 or (p_proof->>'observedAt')::bigint>current_seconds+5 then
    raise exception 'Terminal stop proof is stale'; end if;
  select * into saved from public.buyer_mentorship_abandonment_proofs_v1 where reservation_id=r.id;
  if found then
    if saved.proof-'observedAt' is distinct from p_proof-'observedAt' then raise exception 'Original terminal proof changed'; end if;
    return to_jsonb(saved);
  end if;
  insert into public.buyer_mentorship_abandonment_proofs_v1(reservation_id,proof) values(r.id,p_proof) returning * into saved;
  return to_jsonb(saved);
end $$;
revoke all on function public.record_buyer_mentorship_abandonment_proof_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_buyer_mentorship_abandonment_proof_v1(uuid,uuid,jsonb,jsonb) to service_role;
commit;
