-- Local-only candidate. Requests and financial observations are service-owned.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';

create table public.sales_team_worker_runs_v1 (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('settlement','reconciliation','surplus')),
 scheduled_slot timestamptz not null,
 lease_until timestamptz not null,
 status text not null check(status in ('running','complete','review_required')),
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 unique(kind,scheduled_slot)
);
create table public.sales_team_provider_operations_v1 (
 id uuid primary key,
 scope_id uuid not null,
 scope_key text not null check(length(scope_key) between 1 and 200),
 kind text not null check(kind in ('recipient','customer','intent','confirmation','cancellation','transfer','reversal','withdrawal','setup')),
 sale_id uuid references public.sales_team_sale_agreements_v1(id) on delete restrict,
 creator_id uuid references auth.users(id) on delete restrict,
 actor_id uuid references auth.users(id) on delete restrict,
 worker_run_id uuid references public.sales_team_worker_runs_v1(id) on delete restrict,
 context jsonb not null,
 request jsonb not null,
 idempotency_key text not null unique,
 status text not null check(status in ('dispatching','bound','unknown')),
 lease_token uuid,
 lease_until timestamptz,
 first_dispatch_at timestamptz not null default now(),
 provider_id text,
 provider_request_id text,
 bound_at timestamptz,
 created_at timestamptz not null default now(),
 unique(scope_id,kind,scope_key),
 check((provider_id is null and provider_request_id is null and bound_at is null) or
  (provider_id is not null and provider_request_id is not null and bound_at is not null)),
 check(request->>'method'='POST' and request->>'apiVersion' is not null and request->>'path' is not null)
);

create table public.sales_team_payment_obligations_v1 (
 id uuid primary key,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 period_number integer not null check(period_number>=1),
 amount_cents integer not null check(amount_cents between 50 and 99999999),
 due_at timestamptz not null,
 status text not null default 'unpaid' check(status in ('unpaid','admitted','paid','stopped','review_required')),
 intent_operation_id uuid unique references public.sales_team_provider_operations_v1(id) on delete restrict,
 paid_at timestamptz,
 unique(sale_id,period_number)
);
create table public.sales_team_payment_runtime_v1 (
 sale_id uuid primary key references public.sales_team_sale_agreements_v1(id) on delete restrict,
 customer_id text,
 saved_payment_method_id text,
 anchor_at timestamptz,
 stop_requested_at timestamptz,
 canceled_at timestamptz,
 covered_periods integer not null default 0 check(covered_periods>=0),
 financial_hold boolean not null default false,
 updated_at timestamptz not null default now()
);
create table public.sales_team_receipts_v1 (
 id uuid primary key default gen_random_uuid(),
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 obligation_id uuid not null unique references public.sales_team_payment_obligations_v1(id) on delete restrict,
 payment_intent_id text not null unique check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
 charge_id text not null unique check(charge_id ~ '^ch_[A-Za-z0-9]+$'),
 balance_transaction_id text unique,
 subtotal_cents bigint not null check(subtotal_cents>=0),
 tax_cents bigint not null default 0 check(tax_cents>=0),
 processing_cost_cents bigint check(processing_cost_cents>=0),
 refunded_subtotal_cents bigint not null default 0 check(refunded_subtotal_cents between 0 and subtotal_cents),
 confirmed_loss_subtotal_cents bigint not null default 0 check(confirmed_loss_subtotal_cents between 0 and subtotal_cents),
 dispute_hold boolean not null default false,
 review_hold boolean not null default false,
 paid_at timestamptz not null,
 available_on timestamptz,
 source_event_id text not null,
 proof jsonb not null,
 observed_at timestamptz not null default now()
);
create table public.sales_team_commission_balances_v1 (
 receipt_id uuid primary key references public.sales_team_receipts_v1(id) on delete restrict,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 membership_id uuid not null references public.sales_team_memberships_v1(id) on delete restrict,
 earned_cents bigint not null check(earned_cents>=0),
 released_cents bigint not null default 0 check(released_cents>=0),
 reversed_cents bigint not null default 0 check(reversed_cents between 0 and released_cents),
 hold_until timestamptz not null,
 updated_at timestamptz not null default now()
);
create table public.sales_team_cost_allocations_v1 (
 id uuid primary key default gen_random_uuid(),
 provider_cost_id text not null,
 creator_id uuid not null references auth.users(id) on delete restrict,
 cost_kind text not null check(cost_kind in ('processing','connected_account','payout','refund','dispute')),
 amount_cents bigint not null check(amount_cents>=0),
 period_start timestamptz not null,
 period_end timestamptz not null,
 evidence jsonb not null,
 allocated_at timestamptz not null default now(),
 unique(provider_cost_id,creator_id),check(period_end>period_start)
);
create table public.sales_team_financial_ledger_v1 (
 id bigint generated always as identity primary key,
 creator_id uuid not null,
 sale_id uuid references public.sales_team_sale_agreements_v1(id) on delete restrict,
 membership_id uuid references public.sales_team_memberships_v1(id) on delete restrict,
 receipt_id uuid references public.sales_team_receipts_v1(id) on delete restrict,
 entry_kind text not null check(entry_kind in ('platform_revenue','commission_earned','commission_adjustment','processing_reserve','processing_cost','payout_cost_reserve','payout_cost',
  'creator_proceeds','creator_deficit','creator_recovery','platform_processing_credit','tax_reserve','transfer','transfer_reversal','reserve_return','bank_payout')),
 amount_cents bigint not null,
 source_identity text not null,
 evidence jsonb not null,
 created_at timestamptz not null default now(),
 unique(creator_id,entry_kind,source_identity)
);
create table public.sales_team_financial_alerts_v1 (
 id uuid primary key default gen_random_uuid(),
 creator_id uuid,
 sale_id uuid references public.sales_team_sale_agreements_v1(id) on delete restrict,
 operation_id uuid references public.sales_team_provider_operations_v1(id) on delete restrict,
 code text not null,
 source_identity text not null unique,
 status text not null default 'open' check(status in ('open','acknowledged','resolved')),
 evidence jsonb not null,
 created_at timestamptz not null default now(),
 delivered_at timestamptz,
 acknowledged_at timestamptz
);

create function public.sales_team_operation_json_v1(p_operation_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select to_jsonb(o)-'scope_id'-'scope_key'-'sale_id'-'creator_id'-'actor_id'-'worker_run_id'||jsonb_build_object(
  'scopeId',scope_id,'scopeKey',scope_key,'saleId',sale_id,'creatorId',creator_id,'actorId',actor_id,'workerRunId',worker_run_id)
 from public.sales_team_provider_operations_v1 o where id=p_operation_id
$$;

create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare v_sale public.sales_team_sale_agreements_v1;v_kind text:=p_scope->>'kind';v_worker boolean;
begin
 v_worker:=exists(select 1 from public.sales_team_worker_runs_v1 where id=(p_scope->>'workerRunId')::uuid and status='running' and lease_until>clock_timestamp());
 if v_kind in ('transfer','reversal','withdrawal') then
  if not v_worker or not exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled) then return false; end if;
 elsif not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled) then
  -- Cancellation/Stop reconciles an admitted original even after new sales stop.
  if v_kind<>'cancellation' then return false; end if;
 end if;
 if v_kind='recipient' then
  return p_scope->>'scopeId'=p_scope->>'actorId' and exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context and disclosures_approved) and
   (exists(select 1 from public.sales_team_memberships_v1 where user_id=(p_scope->>'actorId')::uuid and status='active' and is_closer and accepted_commission_revision=commission_revision) or
    exists(select 1 from public.sales_team_creator_settings_v1 where creator_id=(p_scope->>'actorId')::uuid));
 elsif v_kind='withdrawal' then
  return exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context and actual_pricing_verified and reserves_verified and disclosures_approved);
 end if;
 select * into v_sale from public.sales_team_sale_agreements_v1 where id=(p_scope->>'saleId')::uuid;
 if v_sale.id is null or v_sale.context is distinct from p_context or v_sale.creator_id::text is distinct from p_scope->>'creatorId' then return false; end if;
 if v_kind in ('transfer','reversal') then return v_worker; end if;
 if not v_worker and v_sale.buyer_id::text is distinct from p_scope->>'actorId' then return false; end if;
 if v_kind<>'cancellation' and exists(select 1 from public.sales_team_payment_runtime_v1 where sale_id=v_sale.id and (stop_requested_at is not null or canceled_at is not null or financial_hold)) then return false; end if;
 return true;
end $$;

create function public.claim_sales_team_provider_operation_v1(p_operation_id uuid,p_scope jsonb,p_context jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_op public.sales_team_provider_operations_v1;v_lock uuid;
begin
 v_lock:=coalesce((p_scope->>'creatorId')::uuid,(p_scope->>'scopeId')::uuid);
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||v_lock::text,0));
 select * into v_op from public.sales_team_provider_operations_v1 where scope_id=(p_scope->>'scopeId')::uuid and kind=p_scope->>'kind' and scope_key=p_scope->>'scopeKey' for update;
 if v_op.id is not null then
  if v_op.id<>p_operation_id or v_op.request is distinct from p_request or v_op.context is distinct from p_context or
   v_op.sale_id is distinct from (p_scope->>'saleId')::uuid or v_op.creator_id is distinct from (p_scope->>'creatorId')::uuid or
   v_op.actor_id is distinct from (p_scope->>'actorId')::uuid then raise exception 'ORIGINAL_PROVIDER_REQUEST_CHANGED'; end if;
  if v_op.provider_id is not null then return jsonb_build_object('status','bound','operation',public.sales_team_operation_json_v1(v_op.id)); end if;
  if v_op.status='dispatching' and v_op.lease_until>clock_timestamp() then return jsonb_build_object('status','busy','operation',public.sales_team_operation_json_v1(v_op.id)); end if;
  return jsonb_build_object('status','reconciliation_required','operation',public.sales_team_operation_json_v1(v_op.id));
 end if;
 if not public.sales_team_operation_admitted_v1(p_scope,p_context) then return jsonb_build_object('status','not_enabled'); end if;
 if p_request->>'method' is distinct from 'POST' or jsonb_typeof(p_request->'params') is distinct from 'object' or
  p_request->>'apiVersion' is distinct from '2026-08-26.dahlia' or coalesce(length(p_request->>'path'),0)<5 then raise exception 'INVALID_PROVIDER_REQUEST'; end if;
 insert into public.sales_team_provider_operations_v1(id,scope_id,scope_key,kind,sale_id,creator_id,actor_id,worker_run_id,context,request,idempotency_key,status,lease_token,lease_until)
 values(p_operation_id,(p_scope->>'scopeId')::uuid,p_scope->>'scopeKey',p_scope->>'kind',(p_scope->>'saleId')::uuid,
  (p_scope->>'creatorId')::uuid,(p_scope->>'actorId')::uuid,(p_scope->>'workerRunId')::uuid,p_context,p_request,'cn-team-v1:'||p_operation_id::text,
  'dispatching',gen_random_uuid(),clock_timestamp()+interval '30 seconds') returning * into v_op;
 return jsonb_build_object('status','dispatch','operation',public.sales_team_operation_json_v1(v_op.id));
end $$;

create function public.assert_sales_team_provider_dispatch_v1(p_operation_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_op public.sales_team_provider_operations_v1;v_scope jsonb;
begin
 select * into v_op from public.sales_team_provider_operations_v1 where id=p_operation_id for update;
 v_scope:=jsonb_build_object('scopeId',v_op.scope_id,'scopeKey',v_op.scope_key,'kind',v_op.kind,'saleId',v_op.sale_id,'creatorId',v_op.creator_id,'actorId',v_op.actor_id,'workerRunId',v_op.worker_run_id);
 if v_op.id is null or v_op.lease_token is distinct from p_lease_token or v_op.lease_until<=clock_timestamp() or v_op.provider_id is not null or
  v_op.status<>'dispatching' or v_op.first_dispatch_at<=clock_timestamp()-interval '23 hours' or
  not public.sales_team_operation_admitted_v1(v_scope,v_op.context) then raise exception 'PROVIDER_DISPATCH_NO_LONGER_ADMITTED'; end if;
 return public.sales_team_operation_json_v1(v_op.id);
end $$;

create function public.mark_sales_team_provider_unknown_v1(p_operation_id uuid,p_lease_token uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare v_op public.sales_team_provider_operations_v1;
begin
 update public.sales_team_provider_operations_v1 set status='unknown',lease_until=null where id=p_operation_id and lease_token=p_lease_token and provider_id is null returning * into v_op;
 if v_op.id is not null then insert into public.sales_team_financial_alerts_v1(creator_id,sale_id,operation_id,code,source_identity,evidence)
  values(v_op.creator_id,v_op.sale_id,v_op.id,'PROVIDER_RESULT_UNKNOWN','operation:'||v_op.id::text,jsonb_build_object('kind',v_op.kind)) on conflict(source_identity) do nothing; end if;
end $$;

create function public.bind_sales_team_provider_operation_v1(p_operation_id uuid,p_provider_id text,p_provider_request_id text,p_reconciled boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_op public.sales_team_provider_operations_v1;
begin
 select * into v_op from public.sales_team_provider_operations_v1 where id=p_operation_id for update;
 if v_op.id is null or p_provider_id is null or p_provider_request_id !~ '^req_[A-Za-z0-9]+$' then raise exception 'INVALID_PROVIDER_BINDING'; end if;
 if v_op.provider_id is not null and (v_op.provider_id<>p_provider_id or v_op.provider_request_id<>p_provider_request_id) then raise exception 'PROVIDER_BINDING_CHANGED'; end if;
 if not p_reconciled and (v_op.status<>'dispatching' or v_op.lease_until<=clock_timestamp()) then raise exception 'PROVIDER_BINDING_REQUIRES_RECONCILIATION'; end if;
 update public.sales_team_provider_operations_v1 set provider_id=p_provider_id,provider_request_id=p_provider_request_id,bound_at=coalesce(bound_at,clock_timestamp()),status='bound',lease_until=null where id=p_operation_id;
 update public.sales_team_financial_alerts_v1 set status='resolved' where operation_id=p_operation_id and code='PROVIDER_RESULT_UNKNOWN' and status<>'resolved';
 return public.sales_team_operation_json_v1(p_operation_id);
end $$;

do $$ declare v_name text;v_sig regprocedure;begin
 foreach v_name in array array['sales_team_worker_runs_v1','sales_team_provider_operations_v1','sales_team_payment_obligations_v1','sales_team_payment_runtime_v1',
  'sales_team_receipts_v1','sales_team_commission_balances_v1','sales_team_cost_allocations_v1','sales_team_financial_ledger_v1','sales_team_financial_alerts_v1'] loop
  execute format('alter table public.%I enable row level security',v_name);execute format('revoke all on public.%I from public,anon,authenticated',v_name);
  execute format('grant select,insert,update on public.%I to service_role',v_name);
 end loop;
 for v_sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
  ('sales_team_operation_json_v1','sales_team_operation_admitted_v1','claim_sales_team_provider_operation_v1','assert_sales_team_provider_dispatch_v1','mark_sales_team_provider_unknown_v1','bind_sales_team_provider_operation_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',v_sig);execute format('grant execute on function %s to service_role',v_sig);
 end loop;
end $$;
grant usage,select on sequence public.sales_team_financial_ledger_v1_id_seq to service_role;
revoke update on public.sales_team_financial_ledger_v1,public.sales_team_cost_allocations_v1 from service_role;
create trigger sales_team_ledger_immutable_v1 before update or delete on public.sales_team_financial_ledger_v1 for each row execute function creatornet_team_private.reject_history_change();
create trigger sales_team_cost_allocation_immutable_v1 before update or delete on public.sales_team_cost_allocations_v1 for each row execute function creatornet_team_private.reject_history_change();
commit;
