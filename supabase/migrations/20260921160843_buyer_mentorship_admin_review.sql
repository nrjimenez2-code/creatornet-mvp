begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Explicit projection: no accepted snapshots, provider evidence, credentials,
-- customer/card data or operation bodies. Admin authorization belongs to the
-- server page before this service-only function is called.
create function public.read_buyer_mentorship_admin_page_v1(p_context jsonb,p_after uuid default null,p_limit integer default 25)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;
begin
  if jsonb_typeof(p_context) is distinct from 'object' or p_limit is null or p_limit<1 or p_limit>25 then
    raise exception 'Buyer billing review request differs'; end if;
  with plans as (
    select r.id,r.request_id,r.context,r.terms->>'title' title,(r.terms->>'amountCents')::bigint amount_cents,
      (r.terms->>'paymentCount')::integer payment_count,(r.terms->>'serviceMonths')::integer service_months,
      b.paid_count,b.next_payment_at,b.service_end_at,b.collection_hold_at,b.financial_hold_at,b.debit_revoked_at,
      w.last_status worker_status,w.next_attempt_at,w.last_attempt_at,w.lease_until,d.action due_action,
      recovery.invoice_id recovery_invoice_id,recovery.payment_number recovery_payment_number,
      recovery.outcome recovery_outcome,recovery.observed_at recovery_observed_at
    from public.buyer_mentorship_installment_reservations_v1 r
    join public.buyer_mentorship_billing_state_v1 b on b.reservation_id=r.id
    left join public.buyer_mentorship_worker_v1 w on w.reservation_id=r.id
    left join public.buyer_mentorship_due_work_v1 d on d.reservation_id=r.id
    left join lateral (select invoice_id,payment_number,outcome,observed_at from public.buyer_mentorship_payment_recoveries_v1
      where reservation_id=r.id order by payment_number desc limit 1) recovery on true
    where r.context=p_context and (p_after is null or r.id>p_after)
    order by r.id limit p_limit+1
  )
  select jsonb_build_object('context',p_context,'observedAt',statement_timestamp(),
    'rows',coalesce((select jsonb_agg(to_jsonb(plans) order by id) from plans),'[]'::jsonb),
    'backlog',public.read_buyer_mentorship_work_summary_v1(p_context),
    'oldestDueAt',(select min(due_at) from public.buyer_mentorship_due_work_v1 where context=p_context)) into result;
  return result;
end $$;
revoke all on function public.read_buyer_mentorship_admin_page_v1(jsonb,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_admin_page_v1(jsonb,uuid,integer) to service_role;
commit;
