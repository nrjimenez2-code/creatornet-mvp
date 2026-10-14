begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_retry_admissions_v1 (
  quote_id uuid primary key references public.buyer_mentorship_retry_consents_v1(quote_id),
  reservation_id uuid not null,
  payment_number integer not null,
  invoice_id text not null unique,
  payment_intent_id text not null unique,
  payment_method_id text not null,
  request jsonb not null,
  idempotency_key text not null unique,
  admitted_at timestamptz not null default clock_timestamp(),
  dispatch_before timestamptz not null,
  unique(reservation_id,payment_number),
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_payment_admissions_v1(reservation_id,payment_number)
);
alter table public.buyer_mentorship_retry_admissions_v1 enable row level security;
revoke all on public.buyer_mentorship_retry_admissions_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_retry_admissions_v1 to service_role;

-- Internal only: caller must freshly verify the original unpaid invoice/PI/link,
-- fees, provider history, unchanged subscription and verified replacement card.
-- p_basis is the shared recovery snapshot surrounding those provider reads.
-- Lost RPC acknowledgement consumes admission: subsequent calls reconcile only.
create function public.admit_buyer_mentorship_retry_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_quote_id uuid,p_basis jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.buyer_mentorship_retry_quotes_v1%rowtype; consent public.buyer_mentorship_retry_consents_v1%rowtype;
  admission public.buyer_mentorship_retry_admissions_v1%rowtype; card public.buyer_mentorship_saved_card_proofs_v1%rowtype;
  saved jsonb; ctx jsonb; expected jsonb;
begin
  select * into q from public.buyer_mentorship_retry_quotes_v1 where id=p_quote_id and buyer_id=p_buyer_id;
  if not found then raise exception 'Owned buyer retry unavailable'; end if;
  saved:=public.read_buyer_mentorship_card_setup_v1(p_request_id,p_buyer_id,p_context,q.setup_id);
  if saved#>>'{setup,reservation_id}' is distinct from q.reservation_id::text then raise exception 'Buyer retry owner differs'; end if;
  -- The shared owner read already holds the debit-stop buyer/product lock.
  select * into admission from public.buyer_mentorship_retry_admissions_v1 where reservation_id=q.reservation_id and payment_number=q.payment_number;
  if found then return jsonb_build_object('status','reconcile_admitted','admission',to_jsonb(admission)); end if;
  ctx:=public.read_buyer_mentorship_recovery_action_context_v1(p_request_id,p_buyer_id,p_context,q.invoice_id,'payment_method_required');
  select * into consent from public.buyer_mentorship_retry_consents_v1 where quote_id=q.id;
  select * into card from public.buyer_mentorship_saved_card_proofs_v1 where setup_id=q.setup_id;
  if ctx is distinct from p_basis or ctx is distinct from q.recovery_basis or consent.quote_id is null or
    clock_timestamp()<consent.confirmed_at or clock_timestamp()>=to_timestamp(q.expires_at) or
    card.setup_intent_id is distinct from q.setup_intent_id or card.payment_method_id is distinct from q.replacement_payment_method_id or
    card.session_id is distinct from saved#>>'{binding,session_id}' or card.billing_country is distinct from 'US' or
    ctx->>'paymentIntentId' is distinct from q.original_payment_intent_id then raise exception 'Buyer retry admission requires fresh authorization'; end if;
  expected:=jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/invoices/'||q.invoice_id||'/pay',
    'params',jsonb_build_object('payment_method',q.replacement_payment_method_id,'off_session',false));
  if p_request is distinct from expected then raise exception 'Buyer retry request differs'; end if;
  insert into public.buyer_mentorship_retry_admissions_v1(quote_id,reservation_id,payment_number,invoice_id,payment_intent_id,payment_method_id,
    request,idempotency_key,dispatch_before) values(q.id,q.reservation_id,q.payment_number,q.invoice_id,q.original_payment_intent_id,
    q.replacement_payment_method_id,expected,'cn-buyer-retry-v1:'||q.id::text,least(clock_timestamp()+interval '25 seconds',to_timestamp(q.expires_at))) returning * into admission;
  return jsonb_build_object('status','dispatch_once','admission',to_jsonb(admission));
end $$;
revoke all on function public.admit_buyer_mentorship_retry_v1(uuid,uuid,jsonb,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.admit_buyer_mentorship_retry_v1(uuid,uuid,jsonb,uuid,jsonb,jsonb) to service_role;
commit;
