begin;

-- Read/reconcile an ALREADY admitted renewal. No retry admission, new charge,
-- invoice void, debt waiver, refund, entitlement edit, or automatic unhold.
alter table public.exact_installment_collection_holds
  drop constraint exact_installment_collection_holds_reason_check,
  drop constraint exact_installment_collection_holds_source_check;
alter table public.exact_installment_collection_holds
  add constraint exact_installment_collection_holds_reason_check check(reason in
    ('admin_refund','cancellation_review','verified_refund','verified_dispute','subscription_review','invoice_recovery')),
  add constraint exact_installment_collection_holds_source_check check(
    (reason='admin_refund' and requested_by is not null and refund_operation_id is not null and request_id=refund_operation_id and
      stripe_event_id is null and stripe_payment_intent_id is null and stripe_object_id is null) or
    (reason='cancellation_review' and requested_by is not null and refund_operation_id is null and
      stripe_event_id is null and stripe_payment_intent_id is null and stripe_object_id is null) or
    (reason='verified_refund' and requested_by is null and refund_operation_id is null and stripe_event_id is not null and
      stripe_payment_intent_id is not null and stripe_object_id is null) or
    (reason='verified_dispute' and requested_by is null and refund_operation_id is null and stripe_event_id is not null and
      stripe_payment_intent_id is not null and stripe_object_id is not null and stripe_object_id ~ '^du_[a-zA-Z0-9]+$') or
    (reason='subscription_review' and requested_by is null and refund_operation_id is null and stripe_event_id is not null and
      stripe_payment_intent_id is null and stripe_object_id is not null and stripe_object_id ~ '^sub_[a-zA-Z0-9]+$') or
    (reason='invoice_recovery' and requested_by is null and refund_operation_id is null and stripe_event_id is null and
      stripe_payment_intent_id is not null and stripe_object_id is not null and stripe_object_id ~ '^in_[a-zA-Z0-9]+$'));
create unique index exact_installment_invoice_recovery_hold on public.exact_installment_collection_holds(stripe_object_id)
  where reason='invoice_recovery';

create table public.exact_installment_payment_recoveries (
  stripe_invoice_id text primary key references public.exact_installment_invoice_claims(stripe_invoice_id) on delete restrict,
  agreement_id uuid not null references public.exact_installment_agreements on delete restrict,
  stripe_payment_intent_id text not null unique check(stripe_payment_intent_id ~ '^pi_[a-zA-Z0-9]+$'),
  revision bigint not null default 0 check(revision>=0),
  outcome text check(outcome in ('action_required','payment_method_required','payment_pending','terminal_unpaid','paid_accounted','review_required')),
  stripe_event_id text check(stripe_event_id ~ '^evt_[a-zA-Z0-9]+$'),
  evidence jsonb check(jsonb_typeof(evidence)='object'),
  observed_at timestamptz,
  check((revision=0)=(outcome is null)),
  check((outcome is null)=(observed_at is null))
);
alter table public.exact_installment_payment_recoveries enable row level security;
revoke all on public.exact_installment_payment_recoveries from public,anon,authenticated,service_role;
grant select on public.exact_installment_payment_recoveries to service_role;

create function public.exact_installment_recovery_basis(p_agreement_id uuid,p_invoice_id text)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('agreementStatus',a.status,'claimStatus',c.status,'paymentIntentId',c.stripe_payment_intent_id,
    'dispatchStartedAt',c.dispatch_started_at,'receiptCountedAt',r.counted_at,'ledgerId',r.ledger_id)
  from public.exact_installment_agreements a join public.exact_installment_invoice_claims c on c.agreement_id=a.id
    left join public.exact_installment_receipts r on r.agreement_id=c.agreement_id and r.payment_number=c.payment_number
  where a.id=p_agreement_id and c.stripe_invoice_id=p_invoice_id;
$$;

create function public.begin_exact_installment_recovery(p_agreement_id uuid,p_invoice_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.exact_installment_invoice_claims%rowtype; a public.exact_installment_agreements%rowtype;
  r public.exact_installment_payment_recoveries%rowtype; p public.exact_installment_periods%rowtype;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found then raise exception 'recovery agreement missing'; end if;
  select * into c from public.exact_installment_invoice_claims where agreement_id=a.id and stripe_invoice_id=p_invoice_id for update;
  if not found or c.status not in ('dispatching','paid') or c.dispatch_started_at is null or c.stripe_payment_intent_id is null then
    raise exception 'recovery requires original admitted payment'; end if;
  select * into p from public.exact_installment_periods where agreement_id=a.id and payment_number=c.payment_number;
  insert into public.exact_installment_payment_recoveries(stripe_invoice_id,agreement_id,stripe_payment_intent_id)
    values(c.stripe_invoice_id,a.id,c.stripe_payment_intent_id) on conflict(stripe_invoice_id) do nothing;
  select * into r from public.exact_installment_payment_recoveries where stripe_invoice_id=c.stripe_invoice_id;
  if r.agreement_id is distinct from a.id or r.stripe_payment_intent_id is distinct from c.stripe_payment_intent_id then
    raise exception 'recovery identity changed'; end if;
  insert into public.exact_installment_collection_holds(agreement_id,reason,request_id,stripe_object_id,stripe_payment_intent_id)
    values(a.id,'invoice_recovery',gen_random_uuid(),c.stripe_invoice_id,c.stripe_payment_intent_id)
    on conflict(stripe_object_id) where reason='invoice_recovery' do nothing;
  if not exists(select 1 from public.exact_installment_collection_holds where reason='invoice_recovery' and agreement_id=a.id and
    stripe_object_id=c.stripe_invoice_id and stripe_payment_intent_id=c.stripe_payment_intent_id) then raise exception 'recovery hold differs'; end if;
  return jsonb_build_object('revision',r.revision,'basis',public.exact_installment_recovery_basis(a.id,c.stripe_invoice_id),
    'paymentIntentId',c.stripe_payment_intent_id,'subscriptionId',a.stripe_subscription_id,
    'periodStart',p.due_at,'periodEnd',p.period_end,'dispatchStartedAt',floor(extract(epoch from c.dispatch_started_at))::bigint);
end;
$$;

create function public.finish_exact_installment_recovery(p_agreement_id uuid,p_invoice_id text,p_payment_intent_id text,
  p_revision bigint,p_basis jsonb,p_outcome text,p_event_id text,p_evidence jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.exact_installment_payment_recoveries%rowtype;
begin
  perform 1 from public.exact_installment_agreements where id=p_agreement_id for update;
  select * into r from public.exact_installment_payment_recoveries where agreement_id=p_agreement_id and stripe_invoice_id=p_invoice_id for update;
  if not found or r.stripe_payment_intent_id is distinct from p_payment_intent_id or p_revision is null or p_revision<0 or
    p_event_id is null or p_event_id !~ '^evt_[a-zA-Z0-9]+$' or p_outcome is null or p_outcome not in
      ('action_required','payment_method_required','payment_pending','terminal_unpaid','paid_accounted','review_required') or
    p_evidence is null or jsonb_typeof(p_evidence)<>'object' then raise exception 'invalid recovery observation'; end if;
  if r.revision<>p_revision or p_basis is distinct from public.exact_installment_recovery_basis(p_agreement_id,p_invoice_id) then return false; end if;
  if r.outcome in ('terminal_unpaid','paid_accounted') and r.outcome<>p_outcome then return false; end if;
  if not exists(select 1 from public.exact_installment_collection_holds where agreement_id=p_agreement_id and reason='invoice_recovery' and
    stripe_object_id=p_invoice_id and stripe_payment_intent_id=p_payment_intent_id) then raise exception 'recovery hold missing'; end if;
  if p_outcome='paid_accounted' then
    if not exists(select 1 from public.exact_installment_receipts x join public.payment_fee_ledger l on l.id=x.ledger_id
      where x.agreement_id=p_agreement_id and x.stripe_invoice_id=p_invoice_id and x.stripe_payment_intent_id=p_payment_intent_id and
        x.counted_at is not null and l.earnings_credited_at is not null and l.stripe_invoice_id=p_invoice_id and
        l.stripe_payment_intent_id=p_payment_intent_id and l.gross_amount_cents=x.amount_cents and
        l.total_creator_deduction_cents=x.application_fee_cents and p_evidence->>'invoiceStatus'='paid' and
        p_evidence->>'paymentStatus'='succeeded' and p_evidence->>'amountReceived'=x.amount_cents::text and
        p_evidence->>'amountCapturable'='0') then raise exception 'recovered payment not accounted'; end if;
  elsif exists(select 1 from public.exact_installment_receipts where agreement_id=p_agreement_id and stripe_payment_intent_id=p_payment_intent_id) then
    raise exception 'unpaid recovery conflicts with receipt';
  end if;
  if p_outcome='terminal_unpaid' and (
    p_evidence->>'invoiceStatus'='void' and p_evidence->>'paymentStatus'='canceled' and
    p_evidence->>'amountReceived'='0' and p_evidence->>'amountCapturable'='0' and
    coalesce((p_evidence->>'canceledAt')::bigint,0)>=floor(extract(epoch from (p_basis->>'dispatchStartedAt')::timestamptz)) and
    coalesce((p_evidence->>'voidedAt')::bigint,0)>=floor(extract(epoch from (p_basis->>'dispatchStartedAt')::timestamptz)) and
    (p_evidence->>'canceledAt')::bigint<=extract(epoch from now()) and (p_evidence->>'voidedAt')::bigint<=extract(epoch from now())) is not true then
    raise exception 'terminal unpaid evidence missing'; end if;
  if p_outcome in ('action_required','payment_method_required') and
    (p_evidence->>'invoiceStatus'='open' and p_evidence->>'amountReceived'='0' and p_evidence->>'amountCapturable'='0' and
      p_evidence->>'paymentStatus'=case when p_outcome='action_required' then 'requires_action' else 'requires_payment_method' end) is not true then
    raise exception 'unpaid recovery classification differs'; end if;
  -- Persist only the reviewed fields. Never retain client_secret, hosted URL,
  -- card data, provider error text, or arbitrary webhook metadata.
  update public.exact_installment_payment_recoveries set revision=revision+1,outcome=p_outcome,stripe_event_id=p_event_id,
    evidence=jsonb_build_object('invoiceStatus',p_evidence->'invoiceStatus','paymentStatus',p_evidence->'paymentStatus',
      'amountReceived',p_evidence->'amountReceived','amountCapturable',p_evidence->'amountCapturable',
      'canceledAt',p_evidence->'canceledAt','voidedAt',p_evidence->'voidedAt'),observed_at=now()
    where stripe_invoice_id=p_invoice_id;
  -- The original dispatch remains consumed. No payment retry, invoice state,
  -- access, accounting, stop authorization, or release of a review hold occurs.
  return true;
end;
$$;

-- An already voided invoice with its original canceled PI is terminal. That
-- proof can unblock a separately authorized stop/refund, NEVER a fresh debit.
create function public.exact_installment_recovery_is_terminal(p_agreement_id uuid,p_invoice_id text,p_payment_intent_id text)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.exact_installment_payment_recoveries where agreement_id=p_agreement_id and
    stripe_invoice_id=p_invoice_id and stripe_payment_intent_id=p_payment_intent_id and outcome='terminal_unpaid' and
    evidence->>'invoiceStatus'='void' and evidence->>'paymentStatus'='canceled' and
    evidence->>'amountReceived'='0' and evidence->>'amountCapturable'='0') and
    not exists(select 1 from public.exact_installment_receipts where agreement_id=p_agreement_id and stripe_payment_intent_id=p_payment_intent_id);
$$;

create or replace function public.exact_installment_stop_is_quiescent(p_agreement_id uuid)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  select not exists(select 1 from public.exact_installment_operations where agreement_id=p_agreement_id and status<>'complete')
    and not exists(select 1 from public.exact_installment_activations where agreement_id=p_agreement_id and status<>'complete')
    and not exists(select 1 from public.exact_installment_invoice_claims c where c.agreement_id=p_agreement_id and
      ((c.status in ('preparing','prepared') and c.lease_until>now()) or
       (c.dispatch_started_at is not null and not public.exact_installment_recovery_is_terminal(c.agreement_id,c.stripe_invoice_id,c.stripe_payment_intent_id) and
        (c.status<>'paid' or not exists(
         select 1 from public.exact_installment_receipts r join public.payment_fee_ledger l on l.id=r.ledger_id
         where r.agreement_id=c.agreement_id and r.payment_number=c.payment_number and
           r.stripe_invoice_id=c.stripe_invoice_id and r.stripe_payment_intent_id=c.stripe_payment_intent_id and
           r.counted_at is not null and l.earnings_credited_at is not null and
           l.stripe_payment_intent_id=r.stripe_payment_intent_id and l.stripe_invoice_id=r.stripe_invoice_id)))))
    and not exists(select 1 from public.exact_installment_receipts r left join public.payment_fee_ledger l on l.id=r.ledger_id
      join public.exact_installment_agreements a on a.id=r.agreement_id where r.agreement_id=p_agreement_id and
        (r.counted_at is null or l.earnings_credited_at is null or l.purchase_id is distinct from a.purchase_id or
         l.stripe_payment_intent_id is distinct from r.stripe_payment_intent_id or
         l.stripe_invoice_id is distinct from r.stripe_invoice_id or l.booking_payment_id is distinct from a.booking_payment_id or
         l.creator_id::text is distinct from a.terms->>'creatorId' or l.gross_amount_cents is distinct from r.amount_cents or
         l.total_creator_deduction_cents is distinct from r.application_fee_cents or l.currency is distinct from 'usd' or
         l.status not in ('paid','refunded')));
$$;

-- Retain ALL 045 receipt/admin/claim validation. Only an otherwise-blocked
-- result gets the additional terminal-invoice check while the locks remain held.
alter function public.admit_exact_installment_admin_refund(uuid,uuid) rename to admit_exact_installment_admin_refund_before_recovery;
create function public.admit_exact_installment_admin_refund(p_operation_id uuid,p_processing_token uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare result text; a uuid;
begin
  result:=public.admit_exact_installment_admin_refund_before_recovery(p_operation_id,p_processing_token);
  if result<>'reconciliation_required' then return result; end if;
  select r.agreement_id into a from public.refund_operations o join public.exact_installment_receipts r
    on r.stripe_payment_intent_id=o.stripe_payment_intent_id where o.id=p_operation_id;
  if a is not null and public.exact_installment_stop_is_quiescent(a) then return 'held'; end if;
  return 'reconciliation_required';
end;
$$;

revoke all on function public.exact_installment_recovery_basis(uuid,text),public.exact_installment_recovery_is_terminal(uuid,text,text),
  public.exact_installment_stop_is_quiescent(uuid),public.admit_exact_installment_admin_refund_before_recovery(uuid,uuid),
  public.admit_exact_installment_admin_refund(uuid,uuid),public.begin_exact_installment_recovery(uuid,text),
  public.finish_exact_installment_recovery(uuid,text,text,bigint,jsonb,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.begin_exact_installment_recovery(uuid,text),
  public.admit_exact_installment_admin_refund(uuid,uuid),
  public.finish_exact_installment_recovery(uuid,text,text,bigint,jsonb,text,text,jsonb) to service_role;
commit;
