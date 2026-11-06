begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_card_setup_dispatches_v1 (
  setup_id uuid primary key references public.buyer_mentorship_card_setup_requests_v1(id),
  first_dispatch_at timestamptz not null default clock_timestamp()
);
create table public.buyer_mentorship_card_setup_bindings_v1 (
  setup_id uuid primary key references public.buyer_mentorship_card_setup_dispatches_v1(setup_id),
  session_id text not null unique,
  bound_at timestamptz not null default clock_timestamp()
);
alter table public.buyer_mentorship_card_setup_dispatches_v1 enable row level security;
alter table public.buyer_mentorship_card_setup_bindings_v1 enable row level security;
revoke all on public.buyer_mentorship_card_setup_dispatches_v1,public.buyer_mentorship_card_setup_bindings_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_card_setup_dispatches_v1,public.buyer_mentorship_card_setup_bindings_v1 to service_role;

-- Ownership-only read remains available after stop/expiry for original recovery.
create function public.read_buyer_mentorship_card_setup_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_setup_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; s public.buyer_mentorship_card_setup_requests_v1%rowtype;
  d public.buyer_mentorship_card_setup_dispatches_v1%rowtype; b public.buyer_mentorship_card_setup_bindings_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer card setup unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into s from public.buyer_mentorship_card_setup_requests_v1 where id=p_setup_id and reservation_id=r.id and buyer_id=p_buyer_id;
  if not found then raise exception 'Original buyer card setup unavailable'; end if;
  select * into d from public.buyer_mentorship_card_setup_dispatches_v1 where setup_id=s.id;
  select * into b from public.buyer_mentorship_card_setup_bindings_v1 where setup_id=s.id;
  return jsonb_build_object('setup',to_jsonb(s),'dispatch',case when d.setup_id is null then null else to_jsonb(d) end,
    'binding',case when b.setup_id is null then null else to_jsonb(b) end,'paymentAllowed',false);
end $$;

create function public.admit_buyer_mentorship_card_setup_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_setup_id uuid,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare saved jsonb; ctx jsonb; s public.buyer_mentorship_card_setup_requests_v1%rowtype; d public.buyer_mentorship_card_setup_dispatches_v1%rowtype;
begin
  saved:=public.read_buyer_mentorship_card_setup_v1(p_request_id,p_buyer_id,p_context,p_setup_id);
  select * into s from public.buyer_mentorship_card_setup_requests_v1 where id=p_setup_id;
  if s.request is distinct from p_request then raise exception 'Original buyer setup parameters changed'; end if;
  -- Bound requests must be retrieved, never dispatched again.
  if saved->'binding' is distinct from 'null'::jsonb then return saved||jsonb_build_object('dispatchAllowed',false); end if;
  ctx:=public.read_buyer_mentorship_recovery_action_context_v1(p_request_id,p_buyer_id,p_context,s.invoice_id,'payment_method_required');
  if clock_timestamp()<s.created_at or clock_timestamp()>to_timestamp(s.expires_at)-interval '31 minutes' or
    clock_timestamp()<to_timestamp((s.authorization_snapshot->>'periodStart')::bigint) or
    clock_timestamp()>=to_timestamp((s.authorization_snapshot->>'periodEnd')::bigint) then
    raise exception 'Original buyer setup dispatch window expired'; end if;
  insert into public.buyer_mentorship_card_setup_dispatches_v1(setup_id) values(s.id) on conflict do nothing;
  select * into d from public.buyer_mentorship_card_setup_dispatches_v1 where setup_id=s.id;
  return saved||jsonb_build_object('dispatch',to_jsonb(d),'context',ctx,'dispatchAllowed',true,
    'dispatchBefore',least(clock_timestamp()+interval '30 seconds',to_timestamp(s.expires_at)-interval '31 minutes',
      to_timestamp((s.authorization_snapshot->>'periodEnd')::bigint)));
end $$;

-- Persist only identity read back from the original request. This deliberately
-- remains possible after debit stop; it neither publishes nor verifies a card.
create function public.bind_buyer_mentorship_card_setup_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_setup_id uuid,p_session jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare saved jsonb; s public.buyer_mentorship_card_setup_requests_v1%rowtype; params jsonb; session_id text; b public.buyer_mentorship_card_setup_bindings_v1%rowtype;
begin
  saved:=public.read_buyer_mentorship_card_setup_v1(p_request_id,p_buyer_id,p_context,p_setup_id);
  if saved->'dispatch'='null'::jsonb then raise exception 'Buyer setup was never admitted'; end if;
  select * into s from public.buyer_mentorship_card_setup_requests_v1 where id=p_setup_id;
  params:=s.request->'params';session_id:=p_session->>'id';
  if session_id is null or session_id !~ '^cs_[A-Za-z0-9_]+$' or
    ((p_context->>'mode'='test') is distinct from (left(session_id,8)='cs_test_')) or
    p_session->>'object' is distinct from 'checkout.session' or p_session->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    p_session->>'mode' is distinct from 'setup' or p_session->>'ui_mode' is distinct from 'hosted' or
    p_session->'customer' is distinct from params->'customer' or p_session->'client_reference_id' is distinct from params->'client_reference_id' or
    p_session->'metadata' is distinct from params->'metadata' or p_session->'payment_method_types' is distinct from params->'payment_method_types' or
    p_session->>'billing_address_collection' is distinct from 'required' or
    p_session->'expires_at' is distinct from params->'expires_at' or
    p_session->'success_url' is distinct from params->'success_url' or p_session->'cancel_url' is distinct from params->'cancel_url' or
    p_session->>'payment_status' is distinct from 'no_payment_required' or
    coalesce(p_session->>'status','') not in ('open','complete','expired') or
    p_session->'payment_intent' is distinct from 'null'::jsonb or p_session->'subscription' is distinct from 'null'::jsonb or
    p_session->'invoice' is distinct from 'null'::jsonb or
    not coalesce(p_session->'amount_total'='null'::jsonb or p_session->'amount_total'='0'::jsonb,false) or
    p_session->>'created' is null or (p_session->>'created')::bigint<extract(epoch from s.created_at)::bigint or
    (p_session->>'created')::bigint>s.expires_at then raise exception 'Buyer setup session differs from original request'; end if;
  insert into public.buyer_mentorship_card_setup_bindings_v1(setup_id,session_id) values(s.id,session_id) on conflict(setup_id) do nothing;
  select * into b from public.buyer_mentorship_card_setup_bindings_v1 where setup_id=s.id;
  if b.session_id is distinct from session_id then raise exception 'Original buyer setup session cannot change'; end if;
  return public.read_buyer_mentorship_card_setup_v1(p_request_id,p_buyer_id,p_context,p_setup_id);
end $$;
revoke all on function public.read_buyer_mentorship_card_setup_v1(uuid,uuid,jsonb,uuid),public.admit_buyer_mentorship_card_setup_v1(uuid,uuid,jsonb,uuid,jsonb),public.bind_buyer_mentorship_card_setup_v1(uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_card_setup_v1(uuid,uuid,jsonb,uuid),public.admit_buyer_mentorship_card_setup_v1(uuid,uuid,jsonb,uuid,jsonb),public.bind_buyer_mentorship_card_setup_v1(uuid,uuid,jsonb,uuid,jsonb) to service_role;
commit;
