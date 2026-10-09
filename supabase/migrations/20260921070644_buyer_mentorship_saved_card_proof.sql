begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_saved_card_proofs_v1 (
  setup_id uuid primary key references public.buyer_mentorship_card_setup_bindings_v1(setup_id),
  session_id text not null unique,
  setup_intent_id text not null unique,
  payment_method_id text not null,
  billing_country text not null check(billing_country='US'),
  verified_at timestamptz not null default clock_timestamp()
);
alter table public.buyer_mentorship_saved_card_proofs_v1 enable row level security;
revoke all on public.buyer_mentorship_saved_card_proofs_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_saved_card_proofs_v1 to service_role;

-- Trusted caller retrieves and inspects the bound Checkout and its SetupIntent,
-- then supplies that observed linkage and fresh provider objects. Neither a
-- redirect nor metadata by itself is proof. No card/default/billing mutation.
create function public.record_buyer_mentorship_saved_card_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_setup_id uuid,
  p_basis jsonb,p_session_id text,p_setup_intent jsonb,p_payment_method jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare saved jsonb; ctx jsonb; s public.buyer_mentorship_card_setup_requests_v1%rowtype;
  proof public.buyer_mentorship_saved_card_proofs_v1%rowtype; setup_intent_id text; pm text; params jsonb;
begin
  saved:=public.read_buyer_mentorship_card_setup_v1(p_request_id,p_buyer_id,p_context,p_setup_id);
  select * into s from public.buyer_mentorship_card_setup_requests_v1 where id=p_setup_id;
  ctx:=public.read_buyer_mentorship_recovery_action_context_v1(p_request_id,p_buyer_id,p_context,s.invoice_id,'payment_method_required');
  if ctx is distinct from p_basis then raise exception 'Buyer recovery changed during saved-card inspection'; end if;
  params:=s.request->'params';setup_intent_id:=p_setup_intent->>'id';pm:=p_payment_method->>'id';
  if p_session_id is null or saved#>>'{binding,session_id}' is distinct from p_session_id or
    setup_intent_id is null or setup_intent_id !~ '^seti_[A-Za-z0-9]+$' or pm is null or pm !~ '^pm_[A-Za-z0-9]+$' or
    p_setup_intent->>'object' is distinct from 'setup_intent' or p_setup_intent->>'status' is distinct from 'succeeded' or
    p_setup_intent->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    p_setup_intent->'customer' is distinct from params->'customer' or p_setup_intent->'metadata' is distinct from params->'metadata' or
    p_setup_intent->>'payment_method' is distinct from pm or p_setup_intent->>'usage' is distinct from 'off_session' or
    p_setup_intent->'on_behalf_of' is distinct from 'null'::jsonb or
    p_setup_intent->'payment_method_types' is distinct from '["card"]'::jsonb or
    p_setup_intent->>'created' is null or (p_setup_intent->>'created')::bigint<extract(epoch from s.created_at)::bigint or
    (p_setup_intent->>'created')::bigint>s.expires_at or (p_setup_intent->>'created')::numeric>extract(epoch from clock_timestamp()) or
    p_payment_method->>'object' is distinct from 'payment_method' or p_payment_method->>'type' is distinct from 'card' or
    p_payment_method->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    p_payment_method->'customer' is distinct from params->'customer' or
    p_payment_method#>>'{billing_details,address,country}' is distinct from 'US' then
    raise exception 'Buyer saved-card evidence differs'; end if;
  insert into public.buyer_mentorship_saved_card_proofs_v1(setup_id,session_id,setup_intent_id,payment_method_id,billing_country)
    values(s.id,p_session_id,setup_intent_id,pm,'US') on conflict(setup_id) do nothing;
  select * into proof from public.buyer_mentorship_saved_card_proofs_v1 where setup_id=s.id;
  if proof.session_id is distinct from p_session_id or proof.setup_intent_id is distinct from setup_intent_id or
    proof.payment_method_id is distinct from pm then raise exception 'Original saved-card proof cannot change'; end if;
  return jsonb_build_object('status','card_saved_payment_not_attempted','setupId',s.id,'paymentAllowed',false,'proof',to_jsonb(proof));
end $$;
revoke all on function public.record_buyer_mentorship_saved_card_v1(uuid,uuid,jsonb,uuid,jsonb,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_buyer_mentorship_saved_card_v1(uuid,uuid,jsonb,uuid,jsonb,text,jsonb,jsonb) to service_role;
commit;
