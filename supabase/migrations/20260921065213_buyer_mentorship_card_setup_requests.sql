begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- One immutable setup request per original admitted installment. Expiry never
-- authorizes replacement of an uncertain request with a fresh provider object.
create table public.buyer_mentorship_card_setup_requests_v1 (
  id uuid primary key,
  reservation_id uuid not null,
  payment_number integer not null,
  buyer_id uuid not null,
  invoice_id text not null,
  original_payment_intent_id text not null,
  authorization_snapshot jsonb not null,
  consent_version text not null check(consent_version='replacement-card-setup-v1'),
  consent_text text not null,
  created_at timestamptz not null,
  expires_at bigint not null,
  request jsonb not null,
  idempotency_key text not null unique,
  unique(reservation_id,payment_number),
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_payment_admissions_v1(reservation_id,payment_number),
  check(expires_at=extract(epoch from created_at)::bigint+3600)
);
alter table public.buyer_mentorship_card_setup_requests_v1 enable row level security;
revoke all on public.buyer_mentorship_card_setup_requests_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_card_setup_requests_v1 to service_role;

create function public.reserve_buyer_mentorship_card_setup_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_invoice_id text,p_setup_id uuid,p_consent jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare ctx jsonb; r public.buyer_mentorship_installment_reservations_v1%rowtype;
  a public.buyer_mentorship_payment_admissions_v1%rowtype; c public.buyer_mentorship_invoice_claims_v1%rowtype;
  s public.buyer_mentorship_card_setup_requests_v1%rowtype; created timestamptz; expiry bigint; metadata jsonb; params jsonb; return_url text;
  consent_text constant text:='Save a replacement card for this installment plan. Saving does not make a payment, replace the currently authorized card, or restart automatic collection. You must separately confirm a payment before CreatorNet attempts it.';
begin
  if p_setup_id is null or p_consent is distinct from '{"accepted":true,"consentVersion":"replacement-card-setup-v1"}'::jsonb then
    raise exception 'Buyer card setup requires explicit consent'; end if;
  -- Takes the SAME buyer/product and original-payment locks as debit stop.
  ctx:=public.read_buyer_mentorship_recovery_action_context_v1(p_request_id,p_buyer_id,p_context,p_invoice_id,'payment_method_required');
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=(ctx->>'reservationId')::uuid;
  select * into a from public.buyer_mentorship_payment_admissions_v1 where reservation_id=r.id and invoice_id=p_invoice_id;
  select * into c from public.buyer_mentorship_invoice_claims_v1 where reservation_id=r.id and payment_number=a.payment_number;
  if c.invoice_id is distinct from a.invoice_id or c.authorization_snapshot is null then raise exception 'Buyer card claim differs'; end if;
  select * into s from public.buyer_mentorship_card_setup_requests_v1 where reservation_id=r.id and payment_number=a.payment_number;
  if found then
    if s.id is distinct from p_setup_id or s.buyer_id is distinct from p_buyer_id or s.invoice_id is distinct from a.invoice_id or
      s.original_payment_intent_id is distinct from a.payment_intent_id or
      s.authorization_snapshot is distinct from c.authorization_snapshot||jsonb_build_object('paymentMethodId',a.payment_method_id) then
      raise exception 'Resume the original buyer card setup request'; end if;
    return jsonb_build_object('setup',to_jsonb(s),'context',ctx,'paymentAllowed',false);
  end if;
  created:=date_trunc('second',clock_timestamp());expiry:=extract(epoch from created)::bigint+3600;
  metadata:=jsonb_build_object('card_setup_version','replacement-card-setup-v1','card_setup_request_id',p_setup_id::text,
    'installment_plan_id',r.id::text,'creatornet_installment_reservation_id',r.id::text,'creatornet_installment_request_id',r.request_id::text);
  return_url:=(p_context->>'siteOrigin')||'/payments/mentorship/'||r.request_id::text;
  params:=jsonb_build_object('mode','setup','ui_mode','hosted','customer',ctx#>>'{dependencies,customerId}',
    'client_reference_id',p_setup_id::text,'payment_method_types',jsonb_build_array('card'),'billing_address_collection','required',
    'expires_at',expiry,'success_url',return_url,'cancel_url',return_url,'metadata',metadata,'setup_intent_data',jsonb_build_object('metadata',metadata),
    'custom_text',jsonb_build_object('submit',jsonb_build_object('message',consent_text)));
  insert into public.buyer_mentorship_card_setup_requests_v1 values(p_setup_id,r.id,a.payment_number,p_buyer_id,a.invoice_id,a.payment_intent_id,
    c.authorization_snapshot||jsonb_build_object('paymentMethodId',a.payment_method_id),'replacement-card-setup-v1',consent_text,created,expiry,
    jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/checkout/sessions','params',params),
    'cn-buyer-card-setup-v1:'||p_setup_id::text) returning * into s;
  return jsonb_build_object('setup',to_jsonb(s),'context',ctx,'paymentAllowed',false);
end $$;
revoke all on function public.reserve_buyer_mentorship_card_setup_v1(uuid,uuid,jsonb,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_buyer_mentorship_card_setup_v1(uuid,uuid,jsonb,text,uuid,jsonb) to service_role;
commit;
