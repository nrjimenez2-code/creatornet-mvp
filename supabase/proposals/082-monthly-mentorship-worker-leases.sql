-- UNAPPLIED. Locked steps 1/5/10. Private bounded worker leases, no new ledger.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or to_regprocedure('public.guard_monthly_mentorship_collection_receipt_v1()') is null then
    raise exception 'Monthly worker prerequisites differ'; end if;
end;
$preflight$;
alter table public.monthly_mentorship_agreements_v1
  add column billing_next_attempt_at timestamptz not null default clock_timestamp(),
  add column billing_work_token uuid,
  add column billing_lease_until timestamptz,
  add column billing_worker_status text,
  add column billing_last_attempt_at timestamptz;
create index monthly_mentorship_worker_due_v1 on public.monthly_mentorship_agreements_v1(billing_next_attempt_at,id)
  where anchor_at is not null and financial_hold_at is null and renewal_stopped_at is null and debit_revoked_at is null;

create function public.lease_monthly_mentorship_work_v1(p_context jsonb,p_limit integer default 6)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v record; v_token uuid; v_now timestamptz:=clock_timestamp(); v_result jsonb:='[]'::jsonb;
begin
  if p_limit is null or p_limit<1 or p_limit>6 or jsonb_typeof(p_context) is distinct from 'object' then
    raise exception 'Monthly worker request differs'; end if;
  for v in select a.id,a.buyer_id,a.creator_id,not exists(select 1 from public.monthly_mentorship_operations_v1 o
      where o.agreement_id=a.id and o.kind='activate' and o.scope_key='initial' and o.status='complete') needs_activation
    from public.monthly_mentorship_agreements_v1 a
    where a.terms->'paymentContext'=p_context and a.covered_months>=1 and a.anchor_at is not null and
      a.financial_hold_at is null and a.renewal_stopped_at is null and a.debit_revoked_at is null and
      a.billing_next_attempt_at<=v_now and (a.billing_lease_until is null or a.billing_lease_until<=v_now) and
      (not exists(select 1 from public.monthly_mentorship_operations_v1 o where o.agreement_id=a.id and o.kind='activate' and o.status='complete') or
       ((a.auto_renew or a.covered_months<a.minimum_months) and
         public.monthly_mentorship_boundary_v1(a.anchor_at,a.covered_months)<=extract(epoch from v_now)::bigint))
    order by a.billing_next_attempt_at,a.id limit p_limit for update of a skip locked
  loop
    v_token:=gen_random_uuid();
    update public.monthly_mentorship_agreements_v1 set billing_work_token=v_token,billing_lease_until=v_now+interval '75 seconds',
      billing_next_attempt_at=v_now+interval '75 seconds',billing_worker_status='running',billing_last_attempt_at=v_now where id=v.id;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v.id,'buyer_id',v.buyer_id,'creator_id',v.creator_id,
      'lease_token',v_token,'needs_activation',v.needs_activation));
  end loop;
  return v_result;
end;
$$;

create function public.finish_monthly_mentorship_work_v1(p_id uuid,p_token uuid,p_context jsonb,p_status text)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_next timestamptz; v_now timestamptz:=clock_timestamp();
begin
  if p_status is null or p_status not in ('activated_held','recorded','already_recorded','nothing_due','awaiting_invoice','payment_pending','stopped','retry_required') then
    raise exception 'Monthly worker result differs'; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  if not found or a.billing_work_token is distinct from p_token or p_token is null or
    a.terms->'paymentContext' is distinct from p_context then return false; end if;
  if p_status='stopped' or (not a.auto_renew and a.covered_months>=a.minimum_months and exists(
      select 1 from public.monthly_mentorship_operations_v1 o where o.agreement_id=a.id and o.kind='activate' and o.status='complete')) then
    v_next:='infinity'::timestamptz;
  elsif p_status in ('activated_held','recorded','already_recorded','nothing_due') then
    v_next:=greatest(v_now+interval '5 seconds',to_timestamp(public.monthly_mentorship_boundary_v1(a.anchor_at,a.covered_months)));
  else v_next:=v_now+case when p_status='retry_required' then interval '15 minutes' else interval '5 minutes' end;
  end if;
  update public.monthly_mentorship_agreements_v1 set billing_work_token=null,billing_lease_until=null,
    billing_next_attempt_at=v_next,billing_worker_status=p_status where id=p_id;
  return true;
end;
$$;
revoke all on function public.lease_monthly_mentorship_work_v1(jsonb,integer),public.finish_monthly_mentorship_work_v1(uuid,uuid,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.lease_monthly_mentorship_work_v1(jsonb,integer),public.finish_monthly_mentorship_work_v1(uuid,uuid,jsonb,text) to service_role;
commit;
