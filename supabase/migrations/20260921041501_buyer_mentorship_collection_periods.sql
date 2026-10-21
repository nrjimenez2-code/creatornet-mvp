begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_collection_periods_v1 (
  reservation_id uuid not null references public.buyer_mentorship_first_receipts_v1(reservation_id),
  payment_number integer not null check(payment_number between 2 and 24),
  due_at bigint not null check(due_at>0),
  period_end bigint not null check(period_end>due_at),
  amount_cents bigint not null check(amount_cents>=50),
  fee_schedule jsonb not null check(jsonb_typeof(fee_schedule)='object'),
  invoice_id text unique check(invoice_id ~ '^in_[A-Za-z0-9]+$'),
  admitted_at timestamptz,
  counted_at timestamptz,
  primary key(reservation_id,payment_number),
  check(admitted_at is null or invoice_id is not null),
  check(counted_at is null or admitted_at is not null)
);
alter table public.buyer_mentorship_collection_periods_v1 enable row level security;
revoke all on public.buyer_mentorship_collection_periods_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_collection_periods_v1 to service_role;

-- Materialization is an immutable calendar/amount record, never debit admission.
-- The collection hold remains set and no provider call is performed here.
create function public.initialize_buyer_mentorship_periods_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  a public.buyer_mentorship_activation_operations_v1%rowtype; p public.buyer_mentorship_collection_periods_v1%rowtype;
  n integer; count integer; total bigint; regular bigint; renewal bigint; due bigint; ending bigint; amount bigint;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer periods unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  select * into a from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id and completed_at is not null;
  if f.reservation_id is null or a.reservation_id is null then raise exception 'Buyer periods require completed original activation'; end if;
  count:=(r.terms->>'paymentCount')::integer; total:=(r.terms->>'amountCents')::bigint;regular:=total/count;
  renewal:=public.fixed_service_end_v1((f.proof->>'paidAt')::bigint,1);
  if a.request#>'{params,trial_end}' is distinct from to_jsonb(renewal) then raise exception 'Buyer activation calendar differs'; end if;
  for n in 2..count loop
    due:=case when n=2 then renewal else public.fixed_service_end_v1(renewal,n-2) end;
    ending:=public.fixed_service_end_v1(renewal,n-1);
    amount:=case when n=count then regular+mod(total,count) else regular end;
    insert into public.buyer_mentorship_collection_periods_v1(reservation_id,payment_number,due_at,period_end,amount_cents,fee_schedule)
      values(r.id,n,due,ending,amount,r.terms->'renewalFeeSchedule') on conflict(reservation_id,payment_number) do nothing;
    select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=n;
    if p.due_at<>due or p.period_end<>ending or p.amount_cents<>amount or p.fee_schedule is distinct from r.terms->'renewalFeeSchedule' then
      raise exception 'Original buyer period differs'; end if;
  end loop;
  if (select count(*) from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id)<>count-1 then raise exception 'Buyer period count differs'; end if;
  return jsonb_build_object('reservationId',r.id,'periodCount',count-1,'collectionAllowed',false);
end $$;
revoke all on function public.initialize_buyer_mentorship_periods_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.initialize_buyer_mentorship_periods_v1(uuid,uuid,jsonb) to service_role;
commit;
