-- Local candidate. Explicit policy and complete shared-platform coverage are
-- required. No reserve amount, provider setting, or deployment is approved here.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column cash_reservations_enabled boolean not null default false;
create table public.sales_team_cash_policy_v1 (
 singleton boolean primary key default true check(singleton),
 reserve_cents bigint check(reserve_cents between 0 and 9007199254740991),
 refund_cost_reserve_cents bigint check(refund_cost_reserve_cents between 0 and 9007199254740991),
 shared_adapter_sha256 text check(shared_adapter_sha256~'^[a-f0-9]{64}$'),
 evidence jsonb not null default '{}',revision bigint not null default 1 check(revision>0)
);
insert into public.sales_team_cash_policy_v1(singleton) values(true);
create table public.sales_team_cash_epoch_v1(singleton boolean primary key default true check(singleton),epoch bigint not null default 1);
insert into public.sales_team_cash_epoch_v1(singleton) values(true);
create table public.sales_team_cash_reads_v1 (
 id uuid primary key,actor_id uuid not null references public.profiles(id) on delete restrict,
 context jsonb not null,protection jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_cash_observations_v1 (
 read_id uuid primary key references public.sales_team_cash_reads_v1(id) on delete restrict,
 available_cents bigint not null check(available_cents between -9007199254740991 and 9007199254740991),
 proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_cash_reservations_v1 (
 operation_id uuid primary key,request_id uuid not null unique references public.sales_team_refund_requests_v1(id) on delete restrict,
 read_id uuid not null references public.sales_team_cash_observations_v1(read_id) on delete restrict,
 principal_cents bigint not null check(principal_cents>0),cost_reserve_cents bigint not null check(cost_reserve_cents>=0),
 context jsonb not null,created_at timestamptz not null default clock_timestamp(),
 check(principal_cents+cost_reserve_cents between 1 and 9007199254740991)
);
create table public.sales_team_cash_resolutions_v1 (
 operation_id uuid primary key references public.sales_team_cash_reservations_v1(operation_id) on delete restrict,
 check_id uuid references public.sales_team_financial_check_results_v1(check_id) on delete restrict,
 disposition text not null check(disposition in ('unsent','financially_observed')),
 evidence jsonb not null,created_at timestamptz not null default clock_timestamp(),
 check((disposition='unsent')=(check_id is null))
);
-- Intentionally refuses missing integration. Replacing this function is a
-- separate installed-schema/legacy-outflow integration, with its exact source
-- digest bound into the reviewed policy. A boolean or caller-supplied total is
-- never accepted as evidence of complete platform liabilities.
create function creatornet_team_private.shared_platform_cash_liabilities_v1(p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
begin raise exception 'SHARED_PLATFORM_CASH_COVERAGE_REQUIRED';end $$;
create function creatornet_team_private.cash_protection_v1(p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare policy public.sales_team_cash_policy_v1;shared jsonb;team bigint;digest text;begin
 if not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context and actual_pricing_verified and reserves_verified and disclosures_approved) or
  not exists(select 1 from public.sales_team_controls_v1 where singleton and cash_reservations_enabled) then raise exception 'TEAM_CASH_POLICY_REQUIRED';end if;
 select * into policy from public.sales_team_cash_policy_v1 where singleton;
 digest:=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex');
 if policy.reserve_cents is null or policy.refund_cost_reserve_cents is null or policy.shared_adapter_sha256 is distinct from digest or policy.evidence='{}'::jsonb then raise exception 'TEAM_CASH_POLICY_REQUIRED';end if;
 shared:=creatornet_team_private.shared_platform_cash_liabilities_v1(p_context);
 perform creatornet_team_private.financial_shape_v1(shared,'{"protectedCents":"number","sourceRevision":"string"}');
 if (shared->>'protectedCents')::bigint<0 or length(shared->>'sourceRevision') not between 1 and 200 then raise exception 'SHARED_PLATFORM_CASH_COVERAGE_REQUIRED';end if;
 if exists(select 1 from public.sales_team_sale_agreements_v1 a join public.sales_team_receipts_v1 r on r.sale_id=a.id where a.context is distinct from p_context) then raise exception 'TEAM_CASH_CONTEXT_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.sales_team_receipts_v1 r where not exists(select 1 from public.sales_team_creator_balances_v1 c where c.receipt_id=r.id) or not exists(select 1 from public.sales_team_commission_balances_v1 b where b.receipt_id=r.id)) then raise exception 'COMPLETE_TEAM_CASH_LIABILITIES_REQUIRED';end if;
 -- All creators, including held receipts, taxes, processing and payout reserves.
 -- Released money is excluded only through the existing immutable accounting.
 -- Refunds currently require additional free liquidity; they cannot spend another
 -- beneficiary's unpaid balance, including the pending refund's original shares.
 select coalesce(sum(greatest(0,c.creator_proceeds_cents-c.creator_released_cents+c.creator_reversed_cents)+
  greatest(0,b.earned_cents-b.released_cents+b.reversed_cents)+c.processing_reserve_cents+c.payout_cost_reserve_cents+c.tax_reserve_cents),0)
 into team from public.sales_team_creator_balances_v1 c join public.sales_team_commission_balances_v1 b using(receipt_id);
 if team>9007199254740991 then raise exception 'TEAM_CASH_RANGE_REQUIRED';end if;
 return jsonb_build_object('teamCents',team,'shared',shared,'reserveCents',policy.reserve_cents,'refundCostReserveCents',policy.refund_cost_reserve_cents,
  'policyRevision',policy.revision,'adapterSha256',digest,'epoch',(select epoch from public.sales_team_cash_epoch_v1 where singleton));
end $$;
create function public.begin_sales_team_cash_read_v1(p_read_id uuid,p_actor_id uuid,p_context jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare protection jsonb;begin
 if p_read_id is null or not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 protection:=creatornet_team_private.cash_protection_v1(p_context);
 insert into public.sales_team_cash_reads_v1(id,actor_id,context,protection) values(p_read_id,p_actor_id,p_context,protection);
end $$;
create function public.complete_sales_team_cash_read_v1(p_read_id uuid,p_actor_id uuid,p_proof jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.sales_team_cash_reads_v1;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into r from public.sales_team_cash_reads_v1 where id=p_read_id;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"context":"object","availableCents":"number","firstRequestId":"string","secondRequestId":"string","readStartedAt":"number"}');
 if r.id is null or r.actor_id is distinct from p_actor_id or not exists(select 1 from public.profiles where id=p_actor_id and role='admin') or r.context is distinct from p_proof->'context' or
  r.protection is distinct from creatornet_team_private.cash_protection_v1(r.context) or r.created_at<clock_timestamp()-interval '30 seconds' or
  (p_proof->>'readStartedAt')::numeric<extract(epoch from r.created_at)*1000-5 or (p_proof->>'readStartedAt')::numeric>extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'readStartedAt')::numeric<extract(epoch from clock_timestamp()-interval '25 seconds')*1000 or
  p_proof->>'firstRequestId'!~'^req_[A-Za-z0-9]+$' or p_proof->>'secondRequestId'!~'^req_[A-Za-z0-9]+$' then raise exception 'FRESH_PLATFORM_CASH_REQUIRED';end if;
 insert into public.sales_team_cash_observations_v1(read_id,available_cents,proof) values(r.id,(p_proof->>'availableCents')::bigint,p_proof);
end $$;
create function creatornet_team_private.cash_encumbered_v1()
returns numeric language sql stable security invoker set search_path=pg_catalog as $$
 select coalesce(sum(principal_cents::numeric+cost_reserve_cents),0) from public.sales_team_cash_reservations_v1 r
 where not exists(select 1 from public.sales_team_cash_resolutions_v1 resolved where resolved.operation_id=r.operation_id)
$$;
create function creatornet_team_private.cash_available_floor_v1(p_context jsonb,p_epoch jsonb)
returns numeric language sql stable security invoker set search_path=pg_catalog as $$
 select min(o.available_cents)::numeric from public.sales_team_cash_observations_v1 o join public.sales_team_cash_reads_v1 r on r.id=o.read_id
 where r.context=p_context and r.protection->'epoch'=p_epoch and r.created_at>clock_timestamp()-interval '30 seconds'
$$;
alter function public.sales_team_refund_operation_admitted_v1(jsonb,jsonb) rename to sales_team_refund_admitted_before_cash_v1;
create function public.reserve_sales_team_refund_cash_v1(p_actor_id uuid,p_request_id uuid,p_read_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;r public.sales_team_cash_reads_v1;o public.sales_team_cash_observations_v1;protection jsonb;reserved public.sales_team_cash_reservations_v1;scope jsonb;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 if q.id is null or q.requested_by is distinct from p_actor_id or q.context is distinct from p_context then raise exception 'ORIGINAL_TEAM_REFUND_OPERATION_REQUIRED';end if;
 select * into reserved from public.sales_team_cash_reservations_v1 where operation_id=q.operation_id;
 if reserved.operation_id is not null then
  if reserved.request_id<>q.id or reserved.context is distinct from p_context then raise exception 'ORIGINAL_CASH_RESERVATION_CHANGED';end if;
  return to_jsonb(reserved);
 end if;
 if exists(select 1 from public.sales_team_provider_operations_v1 where id=q.operation_id) then raise exception 'ORIGINAL_RECOVERY_REQUIRED';end if;
 scope:=jsonb_build_object('scopeId',q.id,'scopeKey','refund:v1','kind','refund','saleId',q.sale_id,'creatorId',q.creator_id,'actorId',q.requested_by,'workerRunId',null);
 if not public.sales_team_refund_admitted_before_cash_v1(scope,p_context) then raise exception 'TEAM_REFUND_FRESH_INSPECTION_REQUIRED';end if;
 protection:=creatornet_team_private.cash_protection_v1(p_context);
 select * into r from public.sales_team_cash_reads_v1 where id=p_read_id;select * into o from public.sales_team_cash_observations_v1 where read_id=p_read_id;
 if r.id is null or o.read_id is null or r.actor_id is distinct from p_actor_id or r.context is distinct from p_context or r.protection is distinct from protection or r.created_at<clock_timestamp()-interval '30 seconds' then raise exception 'FRESH_PLATFORM_CASH_REQUIRED';end if;
 if not coalesce(creatornet_team_private.cash_available_floor_v1(p_context,protection->'epoch')>= (protection->>'teamCents')::numeric+(protection->'shared'->>'protectedCents')::numeric+(protection->>'reserveCents')::numeric+
  creatornet_team_private.cash_encumbered_v1()+q.amount_cents+(protection->>'refundCostReserveCents')::numeric,false) then raise exception 'PROTECTED_PLATFORM_FUNDS_INSUFFICIENT';end if;
 insert into public.sales_team_cash_reservations_v1(operation_id,request_id,read_id,principal_cents,cost_reserve_cents,context)
 values(q.operation_id,q.id,r.id,q.amount_cents,(protection->>'refundCostReserveCents')::bigint,p_context) returning * into reserved;
 return to_jsonb(reserved);
end $$;
create function public.sales_team_refund_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare protection jsonb;r public.sales_team_cash_reads_v1;o public.sales_team_cash_observations_v1;begin
 if not public.sales_team_refund_admitted_before_cash_v1(p_scope,p_context) then return false;end if;
 select reads.* into r from public.sales_team_cash_reservations_v1 reserved join public.sales_team_cash_reads_v1 reads on reads.id=reserved.read_id
 where reserved.request_id=(p_scope->>'scopeId')::uuid and reserved.context=p_context and not exists(select 1 from public.sales_team_cash_resolutions_v1 resolved where resolved.operation_id=reserved.operation_id);
 if r.id is null or r.created_at<clock_timestamp()-interval '30 seconds' then return false;end if;
 protection:=creatornet_team_private.cash_protection_v1(p_context);
 if r.protection is distinct from protection then return false;end if;
 select * into o from public.sales_team_cash_observations_v1 where read_id=r.id;
 return creatornet_team_private.cash_available_floor_v1(p_context,protection->'epoch')>=(protection->>'teamCents')::numeric+(protection->'shared'->>'protectedCents')::numeric+(protection->>'reserveCents')::numeric+creatornet_team_private.cash_encumbered_v1();
end $$;
-- No unimplemented transfer/surplus adapter can bypass the new cash contract.
-- Existing originals still follow claim's bound/reconciliation branches first.
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_admitted_before_cash_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select case when p_scope->>'kind' in ('transfer','withdrawal','reversal') then false else public.sales_team_operation_admitted_before_cash_v1(p_scope,p_context) end
$$;
create function public.resolve_sales_team_refund_cash_v1(p_actor_id uuid,p_request_id uuid,p_context jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;op public.sales_team_provider_operations_v1;checked record;own jsonb;e jsonb;refs jsonb:='[]';result public.sales_team_refund_request_results_v1;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 if q.id is null or q.context is distinct from p_context or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'ORIGINAL_TEAM_REFUND_OPERATION_REQUIRED';end if;
 if not exists(select 1 from public.sales_team_cash_reservations_v1 where operation_id=q.operation_id) then return false;end if;
 if exists(select 1 from public.sales_team_cash_resolutions_v1 where operation_id=q.operation_id) then return true;end if;
 select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id;select * into result from public.sales_team_refund_request_results_v1 where request_id=q.id;
 if result.status='canceled_before_dispatch' and op.id is null then
  insert into public.sales_team_cash_resolutions_v1(operation_id,disposition,evidence) values(q.operation_id,'unsent',jsonb_build_object('requestId',q.id));
 else
  if op.status is distinct from 'bound' or not public.sales_team_refund_request_resolved_v1(q.id) or exists(select 1 from public.sales_team_receipts_v1 where id=q.receipt_id and (review_hold or dispute_hold)) then return false;end if;
  select c.id,cr.proof into checked from public.sales_team_financial_checks_v1 c join public.sales_team_financial_check_results_v1 cr on cr.check_id=c.id
   join public.sales_team_cash_reservations_v1 reserved on reserved.operation_id=q.operation_id where c.receipt_id=q.receipt_id and c.context=p_context and cr.created_at>=reserved.created_at
   order by cr.created_at desc,c.id desc limit 1;
  if checked.id is null or checked.proof->'balances'->'complete' is distinct from 'true'::jsonb then return false;end if;
  select v into own from jsonb_array_elements(checked.proof->'balances'->'owners'->'refunds') v where v->>'id'=op.provider_id;
  if own is null or own->>'status' not in ('succeeded','failed','canceled') or (own->>'amountCents')::bigint is distinct from q.amount_cents then return false;end if;
  for e in select v from jsonb_array_elements(checked.proof->'balances'->'entries') v where v->>'ownerId'=op.provider_id loop
   if e->>'status'<>'available' or (e->>'availableOn')::numeric>extract(epoch from clock_timestamp()) or not exists(select 1 from public.sales_team_financial_balance_entries_v1 saved where saved.transaction_id=e->>'id' and saved.receipt_id=q.receipt_id and saved.identity=e-'providerRequestId'-'status'-'availableOn') then return false;end if;
   refs:=refs||jsonb_build_array(e->>'id');
  end loop;
  insert into public.sales_team_cash_resolutions_v1(operation_id,check_id,disposition,evidence) values(q.operation_id,checked.id,'financially_observed',jsonb_build_object('refundId',op.provider_id,'status',own->>'status','balanceIds',refs));
 end if;
 -- Every older balance read is invalid after a reservation leaves the total.
 -- A new observation must start after this independently verified debit/return.
 update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;
 return true;
end $$;
alter function public.sales_team_refund_request_json_v1(uuid) rename to sales_team_refund_request_before_cash_v1;
create function public.sales_team_refund_request_json_v1(p_request_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select public.sales_team_refund_request_before_cash_v1(p_request_id)||jsonb_build_object('cashReserved',exists(select 1 from public.sales_team_cash_reservations_v1 where request_id=p_request_id))
$$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_cash_policy_v1','sales_team_cash_epoch_v1','sales_team_cash_reads_v1','sales_team_cash_observations_v1','sales_team_cash_reservations_v1','sales_team_cash_resolutions_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated',name);
  execute format('grant select,insert on public.%I to service_role',name);
  if name not in ('sales_team_cash_policy_v1','sales_team_cash_epoch_v1') then execute format('create trigger immutable_cash_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);end if;
 end loop;
 grant update on public.sales_team_cash_epoch_v1 to service_role;
 for sig in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('begin_sales_team_cash_read_v1','complete_sales_team_cash_read_v1','reserve_sales_team_refund_cash_v1','resolve_sales_team_refund_cash_v1','sales_team_refund_operation_admitted_v1','sales_team_refund_admitted_before_cash_v1','sales_team_operation_admitted_v1','sales_team_operation_admitted_before_cash_v1','sales_team_refund_request_json_v1','sales_team_refund_request_before_cash_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('shared_platform_cash_liabilities_v1','cash_protection_v1','cash_encumbered_v1','cash_available_floor_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
