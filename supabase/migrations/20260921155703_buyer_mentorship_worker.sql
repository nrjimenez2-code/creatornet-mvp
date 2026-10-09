begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Private orchestration only. No new payment, invoice or accounting authority.
create table public.buyer_mentorship_worker_v1 (
  reservation_id uuid primary key references public.buyer_mentorship_first_receipts_v1(reservation_id),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_attempt_at timestamptz,
  last_status text check(last_status in ('running','accounted','nothing_due','waiting_for_invoice','busy','payment_pending','review_required','retry_required')),
  check((lease_token is null)=(lease_until is null))
);
alter table public.buyer_mentorship_worker_v1 enable row level security;
revoke all on public.buyer_mentorship_worker_v1 from public,anon,authenticated,service_role;
grant select,insert,update on public.buyer_mentorship_worker_v1 to service_role;
create index buyer_mentorship_worker_retry_v1 on public.buyer_mentorship_worker_v1(next_attempt_at,reservation_id);
create index buyer_mentorship_worker_due_v1 on public.buyer_mentorship_billing_state_v1(next_payment_at,reservation_id)
  where next_payment_at is not null;

-- Only the first unpaid agreed period. Never skip an unpaid period or infer a
-- new debit from a lease. Admitted invoices survive holds, revocation and expiry.
create view public.buyer_mentorship_due_work_v1 with(security_invoker=true) as
select r.id reservation_id,r.request_id,r.buyer_id,r.context,
  coalesce(p.due_at,b.next_payment_at) due_at,a.invoice_id,
  case when a.invoice_id is not null then 'recover'
    when p.payment_number=b.paid_count+1 and p.due_at=b.next_payment_at and p.admitted_at is null and
      p.period_end>extract(epoch from clock_timestamp()) and b.collection_enabled_at is not null and
      b.collection_hold_at is null and b.financial_hold_at is null and b.debit_revoked_at is null
      then 'collect' else 'review' end action
from public.buyer_mentorship_installment_reservations_v1 r
join public.buyer_mentorship_billing_state_v1 b on b.reservation_id=r.id
left join lateral (select p.* from public.buyer_mentorship_collection_periods_v1 p
  where p.reservation_id=r.id and p.counted_at is null order by p.payment_number limit 1) p on true
left join public.buyer_mentorship_payment_admissions_v1 a on a.reservation_id=p.reservation_id and a.payment_number=p.payment_number
where r.status='reserved' and (a.invoice_id is not null or
  (b.debit_revoked_at is null and b.next_payment_at<=extract(epoch from clock_timestamp())));
revoke all on public.buyer_mentorship_due_work_v1 from public,anon,authenticated,service_role;
grant select on public.buyer_mentorship_due_work_v1 to service_role;

create function public.lease_buyer_mentorship_work_v1(p_context jsonb,p_collect boolean,p_limit integer default 2)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v record; token uuid; result jsonb:='[]'::jsonb; moment timestamptz:=clock_timestamp();
begin
  if current_setting('transaction_isolation')<>'read committed' or jsonb_typeof(p_context) is distinct from 'object' or
    p_collect is null or p_limit is null or p_limit<1 or p_limit>2 then raise exception 'Buyer worker request differs'; end if;
  for v in select d.* from public.buyer_mentorship_due_work_v1 d
    left join public.buyer_mentorship_worker_v1 w on w.reservation_id=d.reservation_id
    where d.context=p_context and (d.action<>'collect' or p_collect) and
      (w.reservation_id is null or w.next_attempt_at<=moment and (w.lease_until is null or w.lease_until<=moment))
    order by coalesce(w.next_attempt_at,to_timestamp(d.due_at)),d.reservation_id limit p_limit
  loop
    token:=gen_random_uuid();
    insert into public.buyer_mentorship_worker_v1(reservation_id,lease_token,lease_until,next_attempt_at,last_attempt_at,last_status)
      values(v.reservation_id,token,moment+interval '75 seconds',moment+interval '75 seconds',moment,'running')
      on conflict(reservation_id) do update set lease_token=excluded.lease_token,lease_until=excluded.lease_until,
        next_attempt_at=excluded.next_attempt_at,last_attempt_at=excluded.last_attempt_at,last_status='running'
      where public.buyer_mentorship_worker_v1.next_attempt_at<=moment and
        (public.buyer_mentorship_worker_v1.lease_until is null or public.buyer_mentorship_worker_v1.lease_until<=moment);
    if found then result:=result||jsonb_build_array(jsonb_build_object('reservation_id',v.reservation_id,'request_id',v.request_id,
      'buyer_id',v.buyer_id,'lease_token',token,'action',v.action,'invoice_id',v.invoice_id)); end if;
  end loop;
  return result;
end $$;

create function public.finish_buyer_mentorship_work_v1(p_reservation_id uuid,p_token uuid,p_context jsonb,p_status text)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if p_status is null or p_status not in ('accounted','nothing_due','waiting_for_invoice','busy','payment_pending','review_required','retry_required')
    then raise exception 'Buyer worker outcome differs'; end if;
  update public.buyer_mentorship_worker_v1 w set lease_token=null,lease_until=null,last_status=p_status,
    next_attempt_at=clock_timestamp()+case when p_status in ('review_required','retry_required') then interval '15 minutes'
      when p_status in ('waiting_for_invoice','payment_pending') then interval '1 minute' else interval '5 seconds' end
    where w.reservation_id=p_reservation_id and p_token is not null and w.lease_token=p_token and w.lease_until>clock_timestamp() and
      exists(select 1 from public.buyer_mentorship_installment_reservations_v1 r where r.id=w.reservation_id and r.context=p_context);
  return found;
end $$;

-- Persistent attention is visible even during backoff or after a future-card
-- handoff needs review. Empty batches must not falsely report healthy billing.
create function public.read_buyer_mentorship_work_summary_v1(p_context jsonb)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select jsonb_build_object('pending',(select count(*) from public.buyer_mentorship_due_work_v1 where context=p_context),
    'attention',(select count(*) from public.buyer_mentorship_installment_reservations_v1 r
      left join public.buyer_mentorship_worker_v1 w on w.reservation_id=r.id
      left join public.buyer_mentorship_due_work_v1 d on d.reservation_id=r.id
      where r.context=p_context and (w.last_status in ('review_required','retry_required') or
        w.last_status='running' and w.lease_until<=clock_timestamp() or d.action='review' or
        to_timestamp(d.due_at)<clock_timestamp()-interval '5 minutes')));
$$;
revoke all on function public.lease_buyer_mentorship_work_v1(jsonb,boolean,integer),
  public.finish_buyer_mentorship_work_v1(uuid,uuid,jsonb,text),public.read_buyer_mentorship_work_summary_v1(jsonb) from public,anon,authenticated;
grant execute on function public.lease_buyer_mentorship_work_v1(jsonb,boolean,integer),
  public.finish_buyer_mentorship_work_v1(uuid,uuid,jsonb,text),public.read_buyer_mentorship_work_summary_v1(jsonb) to service_role;
commit;
