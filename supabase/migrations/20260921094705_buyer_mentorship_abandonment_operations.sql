begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Admission for original expiry / DELETE only. No charge, replacement object,
-- receipt, waiver, purchase release or provider success is inferred here.
create table public.buyer_mentorship_abandonment_operations_v1 (
  reservation_id uuid not null references public.buyer_mentorship_abandonment_holds_v1(reservation_id),
  step text not null check(step in ('checkout.expire','subscription.cancel')),
  request jsonb not null,
  idempotency_key text,
  first_dispatch_at timestamptz not null,
  lease_token uuid not null,
  lease_until timestamptz not null,
  primary key(reservation_id,step),
  check((step='checkout.expire' and idempotency_key is not null) or
    (step='subscription.cancel' and idempotency_key is null))
);
alter table public.buyer_mentorship_abandonment_operations_v1 enable row level security;
revoke all on public.buyer_mentorship_abandonment_operations_v1 from public,anon,authenticated,service_role;
grant select,insert,update on public.buyer_mentorship_abandonment_operations_v1 to service_role;
create function public.guard_buyer_mentorship_abandonment_operation_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.reservation_id is distinct from old.reservation_id or new.step is distinct from old.step or
    new.request is distinct from old.request or new.idempotency_key is distinct from old.idempotency_key or
    new.first_dispatch_at is distinct from old.first_dispatch_at then raise exception 'Original stop operation is immutable'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_abandonment_operation_v1 before update on public.buyer_mentorship_abandonment_operations_v1
  for each row execute function public.guard_buyer_mentorship_abandonment_operation_v1();

create function public.claim_buyer_mentorship_abandonment_operation_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_step text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  o public.buyer_mentorship_abandonment_operations_v1%rowtype;
  original public.buyer_mentorship_bootstrap_operations_v1%rowtype;
  expected jsonb; key text; current_time_value timestamptz;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_step is null or
    p_step not in ('checkout.expire','subscription.cancel') then raise exception 'Invalid stop operation'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned stop reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  if not exists(select 1 from public.buyer_mentorship_abandonment_holds_v1 where reservation_id=r.id) then
    raise exception 'Durable buyer stop intent required'; end if;
  -- A late capture is accounted normally but cannot be treated as unpaid
  -- abandonment. Its policy/receipt reconciliation must precede further writes.
  if exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id) then
    return jsonb_build_object('status','reconciliation_required'); end if;
  select * into original from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and
    step=case p_step when 'checkout.expire' then 'checkout.create' else 'subscription.create' end and bound_at is not null;
  if not found then raise exception 'Original stop target unavailable'; end if;
  expected:=jsonb_build_object('apiVersion','2025-10-29.clover',
    'method',case p_step when 'checkout.expire' then 'POST' else 'DELETE' end,
    'path',case p_step when 'checkout.expire' then '/v1/checkout/sessions/'||original.result_id||'/expire'
      else '/v1/subscriptions/'||original.result_id end,
    'params',case p_step when 'checkout.expire' then '{}'::jsonb else '{"invoice_now":false,"prorate":false}'::jsonb end);
  key:=case p_step when 'checkout.expire' then 'buyer-mentorship-installments-v1:'||r.id::text||':expire-approved-stop-v1' else null end;
  current_time_value:=clock_timestamp();
  -- Serialize expiry and cancellation too, not merely retries of one step.
  if exists(select 1 from public.buyer_mentorship_abandonment_operations_v1
    where reservation_id=r.id and step<>p_step and lease_until>current_time_value) then
    return jsonb_build_object('status','busy'); end if;
  select * into o from public.buyer_mentorship_abandonment_operations_v1 where reservation_id=r.id and step=p_step for update;
  if found then
    if o.request is distinct from expected or o.idempotency_key is distinct from key then raise exception 'Original stop target changed'; end if;
    if o.lease_until>current_time_value then return jsonb_build_object('status','busy','operation',to_jsonb(o)); end if;
    -- Expiry POST must never silently acquire a new key after provider pruning.
    -- DELETE recovery uses freshly verified terminal state of the same object.
    if p_step='checkout.expire' and o.first_dispatch_at<=current_time_value-interval '23 hours' then
      return jsonb_build_object('status','reconciliation_required','operation',to_jsonb(o)); end if;
    update public.buyer_mentorship_abandonment_operations_v1 set lease_token=gen_random_uuid(),lease_until=current_time_value+interval '75 seconds'
      where reservation_id=r.id and step=p_step returning * into o;
  else
    insert into public.buyer_mentorship_abandonment_operations_v1 values(r.id,p_step,expected,key,current_time_value,
      gen_random_uuid(),current_time_value+interval '75 seconds') returning * into o;
  end if;
  return jsonb_build_object('status','dispatch','operation',to_jsonb(o),'dispatch_before',
    case p_step when 'checkout.expire' then least(current_time_value+interval '30 seconds',o.first_dispatch_at+interval '23 hours')
      else current_time_value+interval '30 seconds' end);
end $$;
revoke all on function public.guard_buyer_mentorship_abandonment_operation_v1(),
  public.claim_buyer_mentorship_abandonment_operation_v1(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.claim_buyer_mentorship_abandonment_operation_v1(uuid,uuid,jsonb,text) to service_role;
commit;
