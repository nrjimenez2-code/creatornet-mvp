-- Local candidate: reserve protected daily platform surplus. No payout execution,
-- bank completion, scheduler, destination approval or provider setting is installed.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column surplus_reservations_enabled boolean not null default false;
create table public.sales_team_surplus_policy_v1 (
 singleton boolean primary key default true check(singleton),context jsonb,
 destination_id text check(destination_id~'^ba_[A-Za-z0-9]+$'),
 minimum_cents bigint check(minimum_cents between 1 and 99999999),
 maximum_cents bigint check(maximum_cents between 1 and 99999999),
 cost_reserve_cents bigint check(cost_reserve_cents between 0 and 9007199254740991),
 prerequisites_verified boolean not null default false,
 contract_sha256 text check(contract_sha256~'^[a-f0-9]{64}$'),
 evidence jsonb not null default '{}',revision bigint not null default 1 check(revision>0),
 check(minimum_cents<=maximum_cents)
);
insert into public.sales_team_surplus_policy_v1(singleton) values(true);
create table public.sales_team_surplus_runs_v1 (
 run_id uuid primary key references public.sales_team_worker_runs_v1(id) on delete restrict,
 lease_token uuid not null default gen_random_uuid(),context jsonb not null,allow_new boolean not null,
 contract_sha256 text not null,created_at timestamptz not null default clock_timestamp()
);
alter table public.sales_team_cash_reads_v1 add column surplus_worker_run_id uuid references public.sales_team_surplus_runs_v1(run_id) on delete restrict,
 add constraint sales_team_cash_surplus_observer_v1 check(surplus_worker_run_id is null or actor_id is null and source_kind is null and source_id is null and settlement_worker_run_id is null);
create table public.sales_team_surplus_requests_v1 (
 id uuid primary key,operation_id uuid not null unique,
 original_worker_run_id uuid not null unique references public.sales_team_surplus_runs_v1(run_id) on delete restrict,
 read_id uuid not null unique references public.sales_team_cash_observations_v1(read_id) on delete restrict,
 amount_cents bigint not null check(amount_cents between 1 and 99999999),
 cost_reserve_cents bigint not null check(cost_reserve_cents between 0 and 9007199254740991),
 destination_id text not null check(destination_id~'^ba_[A-Za-z0-9]+$'),
 context jsonb not null,policy jsonb not null,protection jsonb not null,request jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_surplus_tasks_v1 (
 run_id uuid primary key references public.sales_team_surplus_runs_v1(run_id) on delete restrict,
 request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 kind text not null check(kind in ('original','new')),created_at timestamptz not null default clock_timestamp()
);
-- Only a separately implemented independent payout/debit/return consumer may
-- later resolve a reservation. No service writer or completion RPC exists here.
create table public.sales_team_surplus_resolutions_v1 (
 request_id uuid primary key references public.sales_team_surplus_requests_v1(id) on delete restrict,
 disposition text not null check(disposition in ('unsent','debit_observed','returned')),
 proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create function creatornet_team_private.surplus_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid),E'\n' order by p.oid::regprocedure::text collate "C")||':'||
  creatornet_team_private.transfer_contract_digest_v1()||':'||creatornet_team_private.shared_cash_contract_digest_v1()||':'||creatornet_team_private.retained_cash_contract_digest_v1()||':'||creatornet_team_private.recovery_contract_digest_v1(),'UTF8')),'hex') from pg_proc p where
 (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in ('surplus_contract_digest_v1','surplus_policy_snapshot_v1','surplus_policy_ready_v1','surplus_worker_v1','cash_protection_v1','cash_protection_before_surplus_v1','cash_encumbered_v1','cash_encumbered_before_surplus_v1','cash_available_floor_v1','financial_shape_v1','reject_history_change')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('claim_sales_team_surplus_run_v1','begin_sales_team_surplus_cash_v1','complete_sales_team_surplus_cash_v1','prepare_sales_team_surplus_v1','finish_sales_team_surplus_run_v1','sales_team_surplus_request_json_v1','sales_team_surplus_operation_id_v1','sales_team_operation_admitted_v1'))
$$;
create function creatornet_team_private.surplus_policy_snapshot_v1()
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select to_jsonb(policy) from public.sales_team_surplus_policy_v1 policy where singleton
$$;
create function creatornet_team_private.surplus_policy_ready_v1(p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_surplus_policy_v1 policy
 join public.sales_team_financial_config_v1 config on config.singleton and config.context=p_context and config.actual_pricing_verified and config.reserves_verified and config.disclosures_approved
 join public.sales_team_controls_v1 controls on controls.singleton and controls.cash_reservations_enabled and controls.surplus_reservations_enabled
 where policy.singleton and policy.context=p_context and policy.destination_id is not null and policy.minimum_cents is not null and policy.maximum_cents is not null and policy.cost_reserve_cents is not null and
 policy.prerequisites_verified and jsonb_typeof(policy.evidence)='object' and policy.evidence<>'{}'::jsonb and policy.contract_sha256=creatornet_team_private.surplus_contract_digest_v1())
$$;
alter function creatornet_team_private.cash_protection_v1(jsonb) rename to cash_protection_before_surplus_v1;
create function creatornet_team_private.cash_protection_v1(p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$begin
 return creatornet_team_private.cash_protection_before_surplus_v1(p_context)||jsonb_build_object('surplusPolicy',creatornet_team_private.surplus_policy_snapshot_v1());
end $$;
alter function creatornet_team_private.cash_encumbered_v1() rename to cash_encumbered_before_surplus_v1;
create function creatornet_team_private.cash_encumbered_v1()
returns numeric language sql stable security invoker set search_path=pg_catalog as $$
 select creatornet_team_private.cash_encumbered_before_surplus_v1()+coalesce((select sum(q.amount_cents::numeric+q.cost_reserve_cents) from public.sales_team_surplus_requests_v1 q
 where not exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=q.id)),0)
$$;
create function creatornet_team_private.surplus_worker_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$begin
 if not exists(select 1 from public.sales_team_surplus_runs_v1 run join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id
 where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context and run.contract_sha256=creatornet_team_private.surplus_contract_digest_v1() and worker.kind='surplus' and worker.status='running' and worker.lease_until>clock_timestamp()) then raise exception 'CURRENT_TEAM_SURPLUS_WORKER_REQUIRED';end if;
end $$;
create function public.sales_team_surplus_operation_id_v1(p_request_id uuid)
returns uuid language sql immutable security invoker set search_path=pg_catalog as $$
 select overlay(overlay(substring(encode(sha256(convert_to('creatornet-team-v1:'||p_request_id::text||':withdrawal:surplus:v1','UTF8')),'hex'),1,32) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;
create function public.sales_team_surplus_request_json_v1(p_request_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select to_jsonb(q)||jsonb_build_object('scope',jsonb_build_object('scopeId',q.id,'scopeKey','surplus:v1','kind','withdrawal','saleId',null,'creatorId',null,'actorId',null,'workerRunId',q.original_worker_run_id),
 'operation',public.sales_team_operation_json_v1(q.operation_id),'resolved',exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=q.id)) from public.sales_team_surplus_requests_v1 q where q.id=p_request_id
$$;
create function public.claim_sales_team_surplus_run_v1(p_run_id uuid,p_context jsonb,p_new boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare slot timestamptz;run public.sales_team_surplus_runs_v1;pending boolean;fresh boolean;begin
 if p_run_id is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'TEAM_SURPLUS_CONTEXT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='surplus' and status='running' and lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 pending:=exists(select 1 from public.sales_team_surplus_requests_v1 q where q.context=p_context and not exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=q.id));
 fresh:=p_new is true and creatornet_team_private.surplus_policy_ready_v1(p_context);
 if not pending and not fresh then return jsonb_build_object('status','held');end if;
 slot:=date_bin(interval '24 hours',clock_timestamp(),'2000-01-01'::timestamptz);
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='surplus' and scheduled_slot=slot) then return jsonb_build_object('status','slot_consumed');end if;
 insert into public.sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values(p_run_id,'surplus',slot,clock_timestamp()+interval '90 seconds','running');
 insert into public.sales_team_surplus_runs_v1(run_id,context,allow_new,contract_sha256) values(p_run_id,p_context,fresh,creatornet_team_private.surplus_contract_digest_v1()) returning * into run;
 return jsonb_build_object('status','claimed','runId',run.run_id,'leaseToken',run.lease_token);
end $$;
create function public.begin_sales_team_surplus_cash_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_read_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$begin
 perform creatornet_team_private.surplus_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 if not creatornet_team_private.surplus_policy_ready_v1(p_context) or not exists(select 1 from public.sales_team_surplus_runs_v1 where run_id=p_run_id and allow_new) then raise exception 'TEAM_SURPLUS_RESERVATIONS_HELD';end if;
 insert into public.sales_team_cash_reads_v1(id,actor_id,context,protection,surplus_worker_run_id) values(p_read_id,null,p_context,creatornet_team_private.cash_protection_v1(p_context),p_run_id);
end $$;
create function public.complete_sales_team_surplus_cash_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_read_id uuid,p_proof jsonb)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare cash public.sales_team_cash_reads_v1;begin
 perform creatornet_team_private.surplus_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into cash from public.sales_team_cash_reads_v1 where id=p_read_id and surplus_worker_run_id=p_run_id;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"context":"object","availableCents":"number","firstRequestId":"string","secondRequestId":"string","readStartedAt":"number"}');
 if cash.id is null or cash.context is distinct from p_context or p_proof->'context' is distinct from p_context or cash.protection is distinct from creatornet_team_private.cash_protection_v1(p_context) or
  cash.created_at<clock_timestamp()-interval '25 seconds' or (p_proof->>'readStartedAt')::numeric not between extract(epoch from cash.created_at)*1000-5 and extract(epoch from clock_timestamp())*1000 or
  coalesce(p_proof->>'firstRequestId','')!~'^req_[A-Za-z0-9]+$' or coalesce(p_proof->>'secondRequestId','')!~'^req_[A-Za-z0-9]+$' or p_proof->>'firstRequestId'=p_proof->>'secondRequestId' then raise exception 'FRESH_TEAM_SURPLUS_CASH_REQUIRED';end if;
 if (p_proof->>'availableCents')::numeric not between -9007199254740991 and 9007199254740991 or (p_proof->>'availableCents')::numeric<>trunc((p_proof->>'availableCents')::numeric) then raise exception 'EXACT_TEAM_SURPLUS_CENTS_REQUIRED';end if;
 insert into public.sales_team_cash_observations_v1(read_id,available_cents,proof) values(cash.id,(p_proof->>'availableCents')::bigint,p_proof);
end $$;
create function public.prepare_sales_team_surplus_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_request_id uuid,p_read_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare task public.sales_team_surplus_tasks_v1;request public.sales_team_surplus_requests_v1;cash public.sales_team_cash_reads_v1;policy public.sales_team_surplus_policy_v1;v_protection jsonb;available numeric;amount bigint;begin
 perform creatornet_team_private.surplus_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into task from public.sales_team_surplus_tasks_v1 where run_id=p_run_id;
 if task.run_id is not null then
  if task.request_id is distinct from p_request_id then raise exception 'ORIGINAL_TEAM_SURPLUS_REQUEST_REQUIRED';end if;
  return jsonb_build_object('status',task.kind,'request',public.sales_team_surplus_request_json_v1(task.request_id));
 end if;
 select * into request from public.sales_team_surplus_requests_v1 q where q.context=p_context and not exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=q.id) order by q.created_at,q.id limit 1;
 if request.id is not null then
  insert into public.sales_team_surplus_tasks_v1(run_id,request_id,kind) values(p_run_id,request.id,'original');
  return jsonb_build_object('status','original','request',public.sales_team_surplus_request_json_v1(request.id));
 end if;
 if not creatornet_team_private.surplus_policy_ready_v1(p_context) or not exists(select 1 from public.sales_team_surplus_runs_v1 where run_id=p_run_id and allow_new) then return jsonb_build_object('status','held');end if;
 if p_read_id is null then return jsonb_build_object('status','cash_required');end if;
 if p_request_id is null or exists(select 1 from public.sales_team_surplus_requests_v1 where id=p_request_id) then raise exception 'NEW_TEAM_SURPLUS_REQUEST_REQUIRED';end if;
 select * into policy from public.sales_team_surplus_policy_v1 where singleton;
 v_protection:=creatornet_team_private.cash_protection_v1(p_context);
 select * into cash from public.sales_team_cash_reads_v1 where id=p_read_id and surplus_worker_run_id=p_run_id and context=p_context and protection=v_protection;
 if cash.id is null or cash.protection is distinct from v_protection or cash.created_at<clock_timestamp()-interval '25 seconds' or not exists(select 1 from public.sales_team_cash_observations_v1 where read_id=cash.id) then raise exception 'FRESH_TEAM_SURPLUS_CASH_REQUIRED';end if;
 available:=creatornet_team_private.cash_available_floor_v1(p_context,v_protection->'epoch')-(v_protection->>'teamCents')::numeric-(v_protection->'shared'->>'protectedCents')::numeric-(v_protection->>'reserveCents')::numeric-creatornet_team_private.cash_encumbered_v1()-policy.cost_reserve_cents;
 if available is null or available<policy.minimum_cents then return jsonb_build_object('status','insufficient_surplus');end if;
 amount:=least(available,policy.maximum_cents)::bigint;
 insert into public.sales_team_surplus_requests_v1(id,operation_id,original_worker_run_id,read_id,amount_cents,cost_reserve_cents,destination_id,context,policy,protection,request)
 values(p_request_id,public.sales_team_surplus_operation_id_v1(p_request_id),p_run_id,cash.id,amount,policy.cost_reserve_cents,policy.destination_id,p_context,to_jsonb(policy),v_protection,
  jsonb_build_object('apiVersion','2026-08-26.dahlia','method','POST','path','/v1/payouts','params',jsonb_build_object('amount',amount,'currency','usd','destination',policy.destination_id,'method','standard','source_type','card','metadata',jsonb_build_object('team_protocol','creatornet-team-surplus-v1','team_surplus_request_id',p_request_id,'team_provider_operation_id',public.sales_team_surplus_operation_id_v1(p_request_id))))) returning * into request;
 insert into public.sales_team_surplus_tasks_v1(run_id,request_id,kind) values(p_run_id,request.id,'new');
 return jsonb_build_object('status','new','request',public.sales_team_surplus_request_json_v1(request.id));
end $$;
create function public.finish_sales_team_surplus_run_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_failed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_status text;begin
 if not exists(select 1 from public.sales_team_surplus_runs_v1 run join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context and worker.kind='surplus' and worker.status='running') then raise exception 'ORIGINAL_TEAM_SURPLUS_RUN_REQUIRED';end if;
 v_status:=case when p_failed is distinct from false or exists(select 1 from public.sales_team_surplus_tasks_v1 task where task.run_id=p_run_id and not exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=task.request_id)) then 'review_required' else 'complete' end;
 update public.sales_team_worker_runs_v1 set status=v_status,finished_at=clock_timestamp() where id=p_run_id;
 return jsonb_build_object('status',v_status);
end $$;
-- Existing refund/transfer/recovery fences must bind the added cash authority.
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''surplus_contract_digest_v1'',''surplus_policy_snapshot_v1'',''surplus_policy_ready_v1'',''surplus_worker_v1'',''cash_protection_before_surplus_v1'',''cash_encumbered_before_surplus_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''claim_sales_team_surplus_run_v1'',''begin_sales_team_surplus_cash_v1'',''complete_sales_team_surplus_cash_v1'',''prepare_sales_team_surplus_v1'',''finish_sales_team_surplus_run_v1'',''sales_team_surplus_request_json_v1'',''sales_team_surplus_operation_id_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'SURPLUS_NAMED_DIGEST_DEPENDENCY_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
do $security$ declare name text;signature regprocedure;begin
 foreach name in array array['sales_team_surplus_policy_v1','sales_team_surplus_runs_v1','sales_team_surplus_requests_v1','sales_team_surplus_tasks_v1','sales_team_surplus_resolutions_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  if name<>'sales_team_surplus_policy_v1' then execute format('create trigger immutable_team_surplus_v1 before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);end if;
 end loop;
 for signature in select oid::regprocedure from pg_proc where
  (pronamespace='public'::regnamespace and proname in ('claim_sales_team_surplus_run_v1','begin_sales_team_surplus_cash_v1','complete_sales_team_surplus_cash_v1','prepare_sales_team_surplus_v1','finish_sales_team_surplus_run_v1','sales_team_surplus_request_json_v1','sales_team_surplus_operation_id_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('surplus_contract_digest_v1','surplus_policy_snapshot_v1','surplus_policy_ready_v1','surplus_worker_v1','cash_protection_v1','cash_encumbered_v1','cash_protection_before_surplus_v1','cash_encumbered_before_surplus_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',signature);execute format('grant execute on function %s to service_role',signature);
 end loop;
end $security$;
commit;
