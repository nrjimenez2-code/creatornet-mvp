begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_invoice_operations_v1 (
  reservation_id uuid not null,
  payment_number integer not null,
  step text not null check(step in ('final-cent','configure','finalize')),
  request jsonb not null check(jsonb_typeof(request)='object'),
  idempotency_key text not null unique,
  first_dispatch_at timestamptz not null default clock_timestamp(),
  primary key(reservation_id,payment_number,step),
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_invoice_claims_v1(reservation_id,payment_number)
);
alter table public.buyer_mentorship_invoice_operations_v1 enable row level security;
revoke all on public.buyer_mentorship_invoice_operations_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_invoice_operations_v1 to service_role;

create function public.prepare_buyer_mentorship_invoice_operation_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_payment_number integer,p_token uuid,p_step text,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  b public.buyer_mentorship_billing_state_v1%rowtype; p public.buyer_mentorship_collection_periods_v1%rowtype;
  c public.buyer_mentorship_invoice_claims_v1%rowtype; o public.buyer_mentorship_invoice_operations_v1%rowtype;
  params jsonb; expected jsonb; metadata jsonb; path text; gross bigint; platform bigint; processing bigint; regular bigint;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer invoice operation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id,73591));
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=p_payment_number;
  select * into c from public.buyer_mentorship_invoice_claims_v1 where reservation_id=r.id and payment_number=p_payment_number;
  if c.reservation_id is null or p.reservation_id is null or b.reservation_id is null or c.lease_token is distinct from p_token or
    c.lease_until<=clock_timestamp() or c.first_preparation_at<=clock_timestamp()-interval '23 hours' or
    clock_timestamp()<to_timestamp(p.due_at) or clock_timestamp()>=to_timestamp(p.period_end) or
    b.collection_hold_at is not null or b.financial_hold_at is not null or b.debit_revoked_at is not null or b.paid_count<>p_payment_number-1 or
    p.admitted_at is not null or p.counted_at is not null or p.invoice_id is distinct from c.invoice_id or
    (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb then
    raise exception 'Buyer invoice operation admission requires review'; end if;
  gross:=p.amount_cents;regular:=(r.terms->>'amountCents')::bigint/(r.terms->>'paymentCount')::integer;
  platform:=round(gross::numeric*1200/10000)::bigint;
  processing:=case when (p.fee_schedule->>'enabled')::boolean then round(gross::numeric*(p.fee_schedule->>'basisPoints')::integer/10000)::bigint+(p.fee_schedule->>'fixedCents')::bigint else 0 end;
  if platform+processing>gross then raise exception 'Buyer invoice fee exceeds gross'; end if;
  metadata:=jsonb_build_object('installment_plan_id',r.id::text,'creatornet_installment_reservation_id',r.id::text,'creatornet_installment_request_id',r.request_id::text);
  path:='/v1/invoices/'||c.invoice_id;
  if p_step='final-cent' then
    if p_payment_number<>(r.terms->>'paymentCount')::integer or gross<=regular then raise exception 'Buyer invoice has no final adjustment'; end if;
    params:=jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('amount',gross-regular,'description','Final installment balance adjustment',
      'discountable',false,'period',jsonb_build_object('start',p.due_at,'end',p.period_end),
      'metadata',metadata||jsonb_build_object('installment_adjustment','final-cent-v1'))));
    path:=path||'/add_lines';
  elsif p_step='configure' then
    metadata:=metadata||jsonb_build_object('creatornet_installment_version','buyer-mentorship-installments-v1','terms_fingerprint',r.fingerprint,
      'payment_mode',p_context->>'mode','platform_account_id',p_context->>'platformAccountId','supabase_project_ref',p_context->>'supabaseProjectRef',
      'site_origin',p_context->>'siteOrigin','installment_collection_version','buyer-mentorship-collection-v1','installment_number',p_payment_number::text,
      'fee_gross_cents',gross::text,'platform_fee_cents',platform::text,'processing_fee_cents',processing::text,
      'total_creator_deduction_cents',(platform+processing)::text,'creator_net_cents',(gross-platform-processing)::text,
      'processing_fee_enabled',p.fee_schedule->>'enabled','processing_fee_bps',p.fee_schedule->>'basisPoints',
      'processing_fee_fixed_cents',p.fee_schedule->>'fixedCents','fee_schedule_version',p.fee_schedule->>'version');
    params:=jsonb_build_object('auto_advance',false,'application_fee_amount',platform+processing,
      'transfer_data',jsonb_build_object('destination',r.destination_id),'payment_settings',jsonb_build_object('payment_method_types',jsonb_build_array('card')),'metadata',metadata);
  elsif p_step='finalize' then params:=jsonb_build_object('auto_advance',false);path:=path||'/finalize';
  else raise exception 'Unsupported buyer invoice preparation operation'; end if;
  expected:=jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path',path,'params',params);
  if p_request is distinct from expected then raise exception 'Buyer invoice request differs from original terms'; end if;
  insert into public.buyer_mentorship_invoice_operations_v1(reservation_id,payment_number,step,request,idempotency_key)
    values(r.id,p_payment_number,p_step,expected,c.idempotency_prefix||':'||p_step) on conflict(reservation_id,payment_number,step) do nothing;
  select * into o from public.buyer_mentorship_invoice_operations_v1 where reservation_id=r.id and payment_number=p_payment_number and step=p_step;
  if o.request is distinct from expected or o.idempotency_key is distinct from c.idempotency_prefix||':'||p_step then
    raise exception 'Original buyer invoice operation differs'; end if;
  return jsonb_build_object('operation',to_jsonb(o),'dispatchBefore',least(clock_timestamp()+interval '30 seconds',c.lease_until,
    c.first_preparation_at+interval '23 hours',to_timestamp(p.period_end)),'paymentAllowed',false);
end $$;
revoke all on function public.prepare_buyer_mentorship_invoice_operation_v1(uuid,uuid,jsonb,integer,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_buyer_mentorship_invoice_operation_v1(uuid,uuid,jsonb,integer,uuid,text,jsonb) to service_role;
commit;
