begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_payment_recoveries_v1 (
  reservation_id uuid not null,
  payment_number integer not null,
  invoice_id text not null unique,
  payment_intent_id text not null unique,
  revision bigint not null default 0,
  outcome text check(outcome in ('action_required','payment_method_required','payment_pending','terminal_unpaid','paid_accounted','review_required')),
  evidence jsonb,
  last_event_id text check(last_event_id ~ '^evt_[A-Za-z0-9]+$'),
  observed_at timestamptz,
  primary key(reservation_id,payment_number),
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_payment_admissions_v1(reservation_id,payment_number)
);
alter table public.buyer_mentorship_payment_recoveries_v1 enable row level security;
revoke all on public.buyer_mentorship_payment_recoveries_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_payment_recoveries_v1 to service_role;
grant update(revision,outcome,evidence,last_event_id,observed_at) on public.buyer_mentorship_payment_recoveries_v1 to service_role;

create function public.begin_buyer_mentorship_payment_recovery_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_invoice_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; a public.buyer_mentorship_payment_admissions_v1%rowtype;
  p public.buyer_mentorship_collection_periods_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype;
  recovery public.buyer_mentorship_payment_recoveries_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer recovery unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into a from public.buyer_mentorship_payment_admissions_v1 where reservation_id=r.id and invoice_id=p_invoice_id;
  if not found then raise exception 'Buyer recovery requires original admission'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.payment_intent_id,73591));
  select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=a.payment_number;
  if p.invoice_id is distinct from a.invoice_id or p.admitted_at is distinct from a.admitted_at then raise exception 'Buyer recovery period differs'; end if;
  insert into public.buyer_mentorship_payment_recoveries_v1(reservation_id,payment_number,invoice_id,payment_intent_id)
    values(r.id,a.payment_number,a.invoice_id,a.payment_intent_id) on conflict(reservation_id,payment_number) do nothing;
  select * into recovery from public.buyer_mentorship_payment_recoveries_v1 where reservation_id=r.id and payment_number=a.payment_number;
  if recovery.invoice_id is distinct from a.invoice_id or recovery.payment_intent_id is distinct from a.payment_intent_id then raise exception 'Original buyer recovery differs'; end if;
  update public.buyer_mentorship_billing_state_v1 set collection_hold_at=clock_timestamp(),revision=revision+1
    where reservation_id=r.id and collection_hold_at is null;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  if not found then raise exception 'Buyer recovery billing state unavailable'; end if;
  return jsonb_build_object('reservationId',r.id,'paymentIntentId',a.payment_intent_id,'paymentNumber',a.payment_number,
    'revision',b.revision,'recoveryRevision',recovery.revision,'paidCount',b.paid_count,'countedAt',p.counted_at);
end $$;
revoke all on function public.begin_buyer_mentorship_payment_recovery_v1(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.begin_buyer_mentorship_payment_recovery_v1(uuid,uuid,jsonb,text) to service_role;

create function public.finish_buyer_mentorship_payment_recovery_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_invoice_id text,
  p_read jsonb,p_outcome text,p_evidence jsonb,p_event_id text default null)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare current_read jsonb; receipt jsonb;
begin
  current_read:=public.begin_buyer_mentorship_payment_recovery_v1(p_request_id,p_buyer_id,p_context,p_invoice_id);
  if p_read is distinct from current_read then return false; end if;
  if p_evidence is null or jsonb_typeof(p_evidence)<>'object' or octet_length(p_evidence::text)>5000 or p_outcome is null or
    p_outcome not in ('action_required','payment_method_required','payment_pending','terminal_unpaid','paid_accounted','review_required') then
    raise exception 'Invalid buyer recovery evidence'; end if;
  if p_outcome='paid_accounted' then
    receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,current_read->>'paymentIntentId');
    if receipt is null or receipt->>'invoiceId' is distinct from p_invoice_id or current_read->'countedAt'='null'::jsonb or
      p_evidence->>'invoiceStatus' is distinct from 'paid' or p_evidence->>'paymentStatus' is distinct from 'succeeded' or
      p_evidence->'amountReceived' is distinct from receipt#>'{proof,amountCents}' or p_evidence->'amountCapturable' is distinct from '0'::jsonb then
      raise exception 'Buyer recovery requires accounted receipt'; end if;
  else
    if current_read->'countedAt' is distinct from 'null'::jsonb or p_evidence->'amountReceived' is distinct from '0'::jsonb or
      coalesce(p_evidence->>'amountCapturable','') !~ '^[0-9]+$' then raise exception 'Buyer recovery cannot replace captured payment'; end if;
    if p_outcome in ('action_required','payment_method_required') and
      (p_evidence->>'invoiceStatus' is distinct from 'open' or p_evidence->'amountCapturable' is distinct from '0'::jsonb or
       p_evidence->>'paymentStatus' is distinct from case when p_outcome='action_required' then 'requires_action' else 'requires_payment_method' end) then
      raise exception 'Buyer recovery action evidence differs'; end if;
    if p_outcome='terminal_unpaid' and (p_evidence->>'invoiceStatus' is distinct from 'void' or
      p_evidence->>'paymentStatus' is distinct from 'canceled' or p_evidence->'amountCapturable' is distinct from '0'::jsonb) then
      raise exception 'Buyer recovery terminal evidence differs'; end if;
  end if;
  update public.buyer_mentorship_payment_recoveries_v1 set revision=revision+1,outcome=p_outcome,evidence=p_evidence,
    last_event_id=coalesce(p_event_id,last_event_id),observed_at=clock_timestamp()
    where reservation_id=(current_read->>'reservationId')::uuid and payment_number=(current_read->>'paymentNumber')::integer;
  return true;
end $$;
revoke all on function public.finish_buyer_mentorship_payment_recovery_v1(uuid,uuid,jsonb,text,jsonb,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_buyer_mentorship_payment_recovery_v1(uuid,uuid,jsonb,text,jsonb,text,jsonb,text) to service_role;
commit;
