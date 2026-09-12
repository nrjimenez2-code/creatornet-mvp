-- UNAPPLIED. Locked steps 2/5/8/10: owned management and existing-exit recovery.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regprocedure('public.record_monthly_mentorship_payment_event_v1(uuid,uuid,jsonb,text,text,text,jsonb)') is null then
    raise exception 'Monthly management prerequisites differ'; end if;
end; $preflight$;
alter table public.monthly_mentorship_exit_requests_v1
  add column provider_next_attempt_at timestamptz not null default clock_timestamp(),
  add column provider_work_token uuid,
  add column provider_lease_until timestamptz,
  add column provider_last_attempt_at timestamptz,
  add column provider_worker_attempts integer not null default 0,
  add column provider_worker_status text check(provider_worker_status in ('running','provider_stopped','provider_review_required','retry_required'));
create index monthly_exit_recovery_due_v1 on public.monthly_mentorship_exit_requests_v1(provider_next_attempt_at,agreement_id)
  where status<>'provider_stopped';
create index monthly_buyer_management_v1 on public.monthly_mentorship_agreements_v1(buyer_id,accepted_at desc,id desc);
create index monthly_creator_management_v1 on public.monthly_mentorship_agreements_v1(creator_id,accepted_at desc,id desc);

create function public.lease_monthly_mentorship_exit_work_v1(p_context jsonb,p_limit integer default 6)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a record; e public.monthly_mentorship_exit_requests_v1%rowtype; v_token uuid;
  v_now timestamptz:=clock_timestamp(); v_result jsonb:='[]'::jsonb;
begin
  if p_limit is null or p_limit<1 or p_limit>6 or jsonb_typeof(p_context) is distinct from 'object' then
    raise exception 'Monthly exit worker request differs'; end if;
  -- Every exit path locks its agreement before its exit row. One request per
  -- agreement per lease avoids racing two cancellations for the same provider.
  for a in select m.id,m.buyer_id,m.renewal_stopped_at,m.debit_revoked_at from public.monthly_mentorship_agreements_v1 m
    where m.terms->'paymentContext'=p_context and not exists(select 1 from public.monthly_mentorship_exit_requests_v1 active
      where active.agreement_id=m.id and active.status<>'provider_stopped' and active.provider_lease_until>v_now) and
      exists(select 1 from public.monthly_mentorship_exit_requests_v1 r
      where r.agreement_id=m.id and r.status<>'provider_stopped' and r.provider_next_attempt_at<=v_now and
        (r.provider_lease_until is null or r.provider_lease_until<=v_now) and
        ((r.kind='stop_renewal' and m.renewal_stopped_at is not null) or (r.kind='revoke_debits' and m.debit_revoked_at is not null)))
    order by (select min(r.provider_next_attempt_at) from public.monthly_mentorship_exit_requests_v1 r
      where r.agreement_id=m.id and r.status<>'provider_stopped'),m.id limit p_limit for update of m skip locked
  loop
    select * into e from public.monthly_mentorship_exit_requests_v1 r where r.agreement_id=a.id and r.status<>'provider_stopped' and
      r.provider_next_attempt_at<=v_now and (r.provider_lease_until is null or r.provider_lease_until<=v_now)
      and ((r.kind='stop_renewal' and a.renewal_stopped_at is not null) or (r.kind='revoke_debits' and a.debit_revoked_at is not null))
      order by r.requested_at,r.id limit 1 for update;
    if found then
      v_token:=gen_random_uuid();
      update public.monthly_mentorship_exit_requests_v1 set provider_work_token=v_token,provider_lease_until=v_now+interval '75 seconds',
        provider_next_attempt_at=v_now+interval '75 seconds',provider_last_attempt_at=v_now,
        provider_worker_attempts=provider_worker_attempts+1,provider_worker_status='running' where id=e.id;
      v_result:=v_result||jsonb_build_array(jsonb_build_object('membership_id',a.id,'buyer_id',a.buyer_id,'request_id',e.id,'lease_token',v_token));
    end if;
  end loop;
  return v_result;
end;
$$;
create function public.finish_monthly_mentorship_exit_work_v1(p_request_id uuid,p_token uuid,p_context jsonb,p_status text)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; e public.monthly_mentorship_exit_requests_v1%rowtype; v_id uuid; v_status text;
begin
  select agreement_id into v_id from public.monthly_mentorship_exit_requests_v1 where id=p_request_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Monthly exit completion context differs'; end if;
  select * into e from public.monthly_mentorship_exit_requests_v1 where id=p_request_id for update;
  if p_token is null or e.provider_work_token is distinct from p_token then return false; end if;
  if p_status is null or p_status not in ('provider_stopped','provider_review_required','retry_required') then
    raise exception 'Monthly exit worker result differs'; end if;
  if p_status='provider_stopped' and e.status<>'provider_stopped' then raise exception 'Monthly provider stop is not recorded'; end if;
  v_status:=case when e.status='provider_stopped' then 'provider_stopped' else p_status end;
  update public.monthly_mentorship_exit_requests_v1 set provider_work_token=null,provider_lease_until=null,provider_worker_status=v_status,
    provider_next_attempt_at=case v_status when 'provider_stopped' then 'infinity'::timestamptz
      when 'provider_review_required' then clock_timestamp()+interval '15 minutes' else clock_timestamp()+interval '2 minutes' end
    where id=e.id;
  -- No consent, retry identity, billing stop, revision, receipt or balance is changed.
  return true;
end;
$$;
create function public.read_monthly_mentorship_exit_status_v1(p_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_requests jsonb; v_stopped boolean;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Monthly exit status owner differs'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'status',e.status,'requestedAt',e.requested_at,
    'providerCompletedAt',e.provider_completed_at,'lastAttemptAt',e.provider_last_attempt_at,'workerStatus',e.provider_worker_status,
    'attempts',e.provider_worker_attempts,'nextAttemptAt',case when isfinite(e.provider_next_attempt_at) and e.status<>'provider_stopped'
      then e.provider_next_attempt_at end) order by e.requested_at,e.id),'[]'::jsonb) into v_requests
    from public.monthly_mentorship_exit_requests_v1 e where e.agreement_id=a.id;
  v_stopped:=exists(select 1 from public.monthly_mentorship_exit_requests_v1 e where e.agreement_id=a.id and e.status='provider_stopped') or
    exists(select 1 from public.monthly_mentorship_lifecycle_v1 e where e.agreement_id=a.id and e.outcome='provider_stopped');
  return jsonb_build_object('membershipId',a.id,'billingBlocked',a.renewal_stopped_at is not null or a.debit_revoked_at is not null,
    'providerStopped',v_stopped,'requests',v_requests);
end;
$$;
create function public.read_monthly_mentorship_management_v1(p_actor_id uuid,p_view text,p_context jsonb,
  p_after timestamptz default null,p_after_id uuid default null,p_limit integer default 12)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_items jsonb:='[]'::jsonb; v_count integer:=0;
  v_last_at timestamptz; v_last_id uuid; v_next jsonb; v_payoff jsonb; v_access jsonb; v_quote jsonb; v_exit jsonb;
begin
  if p_actor_id is null or p_view is null or p_view not in ('buyer','creator') or p_limit is null or p_limit<1 or p_limit>12 or
    jsonb_typeof(p_context) is distinct from 'object' or (p_after is null)<>(p_after_id is null) or
    (p_after is not null and not isfinite(p_after)) then raise exception 'Monthly management request differs'; end if;
  for a in select * from public.monthly_mentorship_agreements_v1 m where
    (case p_view when 'buyer' then m.buyer_id=p_actor_id else m.creator_id=p_actor_id end) and m.terms->'paymentContext'=p_context and
    (p_after is null or (m.accepted_at,m.id)<(p_after,p_after_id)) order by m.accepted_at desc,m.id desc limit p_limit+1
  loop
    v_count:=v_count+1;
    if v_count>p_limit then v_next:=jsonb_build_object('acceptedAt',v_last_at,'id',v_last_id); exit; end if;
    v_payoff:=null;
    select jsonb_build_object('id',pf.id,'status',pf.status) into v_payoff from public.monthly_mentorship_payoffs_v1 pf
      where pf.agreement_id=a.id and pf.status<>'abandoned' order by pf.accepted_at desc,pf.id desc limit 1;
    v_access:=public.read_monthly_mentorship_entitlement_v1(a.purchase_id,a.buyer_id);
    v_quote:=public.read_monthly_mentorship_exit_quote_v1(a.id,a.buyer_id,p_context);
    v_exit:=public.read_monthly_mentorship_exit_status_v1(a.id,a.buyer_id,p_context);
    v_items:=v_items||jsonb_build_array(jsonb_build_object('id',a.id,'acceptedAt',a.accepted_at,'title',a.terms->>'title',
      'postId',a.post_id,'productId',a.product_id,'counterpartyId',case p_view when 'buyer' then a.creator_id else a.buyer_id end,
      'monthlyPriceCents',a.monthly_price_cents,'minimumMonths',a.minimum_months,'autoRenew',a.auto_renew,
      'firstPaymentRecorded',a.covered_months>0,'billingReview',a.billing_review_at is not null,
      'quote',v_quote,'access',v_access,'exitStatus',v_exit,'payoff',v_payoff));
    v_last_at:=a.accepted_at; v_last_id:=a.id;
  end loop;
  return jsonb_build_object('view',p_view,'items',v_items,'nextCursor',v_next);
end;
$$;
revoke all on function public.lease_monthly_mentorship_exit_work_v1(jsonb,integer),
  public.finish_monthly_mentorship_exit_work_v1(uuid,uuid,jsonb,text),
  public.read_monthly_mentorship_exit_status_v1(uuid,uuid,jsonb),
  public.read_monthly_mentorship_management_v1(uuid,text,jsonb,timestamptz,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.lease_monthly_mentorship_exit_work_v1(jsonb,integer),
  public.finish_monthly_mentorship_exit_work_v1(uuid,uuid,jsonb,text),
  public.read_monthly_mentorship_exit_status_v1(uuid,uuid,jsonb),
  public.read_monthly_mentorship_management_v1(uuid,text,jsonb,timestamptz,uuid,integer) to service_role;
commit;
