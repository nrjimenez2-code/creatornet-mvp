-- Default-off local candidate. Derive and freeze original-transfer recovery;
-- reserve only its explicit fee allowance. No provider admission/POST/schedule.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column transfer_recovery_reservations_enabled boolean not null default false;
create table public.sales_team_transfer_recovery_runs_v1 (
 run_id uuid primary key references public.sales_team_transfer_reversal_runs_v1(run_id) on delete restrict,
 allow_new boolean not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_recovery_tasks_v1 (
 id uuid primary key,run_id uuid not null references public.sales_team_transfer_recovery_runs_v1(run_id) on delete restrict,
 transfer_request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 request_id uuid not null,financial_check_id uuid not null unique,root_read_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),unique(run_id,transfer_request_id)
);
create table public.sales_team_transfer_recovery_requests_v1 (
 id uuid primary key,operation_id uuid not null unique,transfer_request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 original_worker_run_id uuid not null references public.sales_team_transfer_recovery_runs_v1(run_id) on delete restrict,
 amount_cents bigint not null check(amount_cents between 1 and 99999999),receipt_revision integer not null,
 cost_reserve_cents bigint not null check(cost_reserve_cents between 0 and 99999999),context jsonb not null,request jsonb not null,
 cash_read_id uuid not null references public.sales_team_cash_observations_v1(read_id) on delete restrict,created_at timestamptz not null default clock_timestamp()
);
create index transfer_recovery_tasks_original_v1 on public.sales_team_transfer_recovery_tasks_v1(transfer_request_id);
create index transfer_recovery_requests_original_v1 on public.sales_team_transfer_recovery_requests_v1(transfer_request_id);
create table public.sales_team_transfer_recovery_cancellations_v1 (
 request_id uuid primary key references public.sales_team_transfer_recovery_requests_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_transfer_recovery_runs_v1(run_id) on delete restrict,
 reason text not null check(reason='not_dispatched'),created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_recovery_financial_links_v1 (
 check_id uuid primary key references public.sales_team_financial_checks_v1(id) on delete restrict deferrable initially deferred,
 task_id uuid not null unique references public.sales_team_transfer_recovery_tasks_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_transfer_recovery_runs_v1(run_id) on delete restrict
);
create table public.sales_team_transfer_recovery_root_reads_v1 (
 id uuid primary key,task_id uuid not null unique references public.sales_team_transfer_recovery_tasks_v1(id) on delete restrict,
 receipt_revision integer not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_recovery_roots_v1 (
 read_id uuid primary key references public.sales_team_transfer_recovery_root_reads_v1(id) on delete restrict,
 ready boolean not null,proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
-- A completed original and its immutable accepted recipient are the only source.
create function creatornet_team_private.transfer_recovery_original_v1(p_transfer_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;t public.sales_team_provider_operations_v1;begin
 select * into q from public.sales_team_transfer_requests_v1 where id=p_transfer_id and context=p_context;
 select * into t from public.sales_team_provider_operations_v1 where id=q.operation_id;
 if q.id is null or t.id is null or t.kind<>'transfer' or t.status<>'bound' or t.context is distinct from p_context or t.request is distinct from q.request or
  t.worker_run_id is distinct from q.original_worker_run_id or t.scope_id<>q.id or t.scope_key<>'settlement:v1' or t.sale_id is distinct from q.sale_id or t.creator_id is distinct from q.creator_id or t.actor_id is not null or
  q.operation_id<>public.sales_team_transfer_operation_id_v1(q.id) or t.idempotency_key<>'cn-team-v1:'||t.id::text or coalesce(t.provider_id,'')!~'^tr_[A-Za-z0-9]+$' or coalesce(t.provider_request_id,'')!~'^req_[A-Za-z0-9]+$' or
  t.first_dispatch_at>clock_timestamp()+interval '5 seconds' or exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id) or
  not exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id and transfer_id=t.provider_id) or
  not exists(select 1 from public.sales_team_sale_agreements_v1 a join public.sales_team_receipts_v1 r on r.sale_id=a.id and r.id=q.receipt_id
   join public.sales_team_creator_balances_v1 c on c.receipt_id=r.id and c.creator_id=a.creator_id and c.sale_id=a.id
   join public.sales_team_commission_balances_v1 b on b.receipt_id=r.id and b.creator_id=a.creator_id and b.sale_id=a.id and b.membership_id=a.membership_id
   where a.id=q.sale_id and a.creator_id=q.creator_id and a.context=p_context and
    q.beneficiary_user_id=case when q.beneficiary='creator' then a.creator_id else a.closer_id end and
    q.destination_id=a.terms->'distribution'->>(case when q.beneficiary='creator' then 'creatorRecipientId' else 'closerRecipientId' end)) then raise exception 'COMPLETED_OWNED_RECOVERY_TRANSFER_REQUIRED';end if;
 return public.sales_team_transfer_request_json_v1(q.id);
end $$;
-- Only released principal within this receipt/accepted beneficiary can return.
-- Creator deficits beyond that principal remain a creator obligation.
create function creatornet_team_private.transfer_recovery_amount_v1(p_transfer_id uuid,p_exclude uuid default null)
returns bigint language sql stable security invoker set search_path=pg_catalog as $$
 select greatest(0,least(
  case when q.beneficiary='creator' then greatest(0,c.creator_released_cents-c.creator_reversed_cents-c.creator_proceeds_cents) else greatest(0,b.released_cents-b.reversed_cents-b.earned_cents) end-
   coalesce((select sum(p.amount_cents) from public.sales_team_transfer_recovery_requests_v1 p join public.sales_team_transfer_requests_v1 source on source.id=p.transfer_request_id
    where source.receipt_id=q.receipt_id and source.beneficiary=q.beneficiary and p.id is distinct from p_exclude and
    not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id)),0),
  q.amount_cents-coalesce((select sum(amount_cents) from public.sales_team_transfer_reversal_completions_v1 where transfer_request_id=q.id),0)-
   coalesce((select sum(p.amount_cents) from public.sales_team_transfer_recovery_requests_v1 p where p.transfer_request_id=q.id and p.id is distinct from p_exclude and
    not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id)),0)))::bigint
 from public.sales_team_transfer_requests_v1 q join public.sales_team_sale_agreements_v1 a on a.id=q.sale_id and a.creator_id=q.creator_id and a.context=q.context
 join public.sales_team_creator_balances_v1 c on c.receipt_id=q.receipt_id and c.creator_id=q.creator_id and c.sale_id=q.sale_id
 join public.sales_team_commission_balances_v1 b on b.receipt_id=q.receipt_id and b.creator_id=q.creator_id and b.sale_id=q.sale_id and b.membership_id=a.membership_id where q.id=p_transfer_id
$$;
create function creatornet_team_private.transfer_recovery_source_v1(p_transfer_id uuid,p_exclude uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;r public.sales_team_receipts_v1;amount bigint;begin
 select * into q from public.sales_team_transfer_requests_v1 where id=p_transfer_id;select * into r from public.sales_team_receipts_v1 where id=q.receipt_id;
 if r.id is null then return null;end if;perform creatornet_team_private.transfer_recovery_original_v1(q.id,q.context);
 if r.review_hold or r.dispute_hold or r.processing_cost_cents is null or r.available_on is null or r.available_on>clock_timestamp() or
  exists(select 1 from public.sales_team_payment_runtime_v1 where sale_id=q.sale_id and financial_hold) or
  exists(select 1 from public.sales_team_refund_requests_v1 where sale_id=q.sale_id and not public.sales_team_refund_request_resolved_v1(id)) or
  exists(select 1 from public.sales_team_financial_alerts_v1 where sale_id=q.sale_id and status='open' and code in ('TRANSFER_COST_RESERVE_EXCEEDED','TRANSFER_REVERSAL_REVIEW_REQUIRED')) or
  not exists(select 1 from public.sales_team_financial_checks_v1 checked join public.sales_team_financial_check_results_v1 done on done.check_id=checked.id
   where checked.receipt_id=r.id and checked.context=q.context and done.created_at>=r.observed_at and done.created_at>clock_timestamp()-interval '2 minutes' and
   done.proof->'balances'->'complete'='true'::jsonb and done.proof->'financial'->'reviewHold'='false'::jsonb and done.proof->'financial'->'disputeHold'='false'::jsonb) or
  exists(select 1 from public.sales_team_provider_operations_v1 op join public.sales_team_transfer_requests_v1 source on source.id::text=op.request->'params'->'metadata'->>'team_transfer_request_id'
   where op.kind='reversal' and source.receipt_id=q.receipt_id and source.beneficiary=q.beneficiary and op.id is distinct from creatornet_team_private.transfer_reversal_operation_id_v1(p_exclude) and
    not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=op.id)) then return null;end if;
 amount:=creatornet_team_private.transfer_recovery_amount_v1(q.id,p_exclude);
 if amount not between 1 and 99999999 then return null;end if;
 return jsonb_build_object('amountCents',amount,'revision',r.observation_revision,'receiptId',r.id);
end $$;
create function creatornet_team_private.transfer_recovery_task_count_v1(p_run_id uuid)
returns bigint language sql stable security invoker set search_path=pg_catalog as $$
 select count(*) from (select id from public.sales_team_transfer_recovery_tasks_v1 where run_id=p_run_id union select task_id from public.sales_team_transfer_reversal_checks_v1 where worker_run_id=p_run_id) tasks
$$;
create function creatornet_team_private.transfer_recovery_worker_v1(p_run_id uuid,p_token uuid,p_context jsonb,p_new boolean default false)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_token,p_context);
 if not exists(select 1 from public.sales_team_transfer_recovery_runs_v1 where run_id=p_run_id and (not p_new or allow_new)) or
  p_new and not exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_recovery_reservations_enabled) then raise exception 'CURRENT_TRANSFER_RECOVERY_WORKER_REQUIRED';end if;
end $$;
create function public.claim_sales_team_transfer_recovery_run_v1(p_run_id uuid,p_context jsonb,p_new boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare slot timestamptz;run public.sales_team_settlement_runs_v1;digest text;allow_new boolean;begin
 if p_run_id is null or p_new is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'SETTLEMENT_CONTEXT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-settlement-v1',0));
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_reversal_observations_enabled) then return jsonb_build_object('status','held');end if;
 allow_new:=p_new and exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_recovery_reservations_enabled) and
  exists(select 1 from public.sales_team_cash_policy_v1 where singleton and transfer_reversal_cost_reserve_cents is not null);
 if not exists(select 1 from public.sales_team_transfer_requests_v1 q join public.sales_team_transfer_completions_v1 completed on completed.request_id=q.id where q.context=p_context and (
  allow_new and creatornet_team_private.transfer_recovery_amount_v1(q.id,null)>0 or
  exists(select 1 from public.sales_team_transfer_recovery_requests_v1 p where p.transfer_request_id=q.id and not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id)) or
  exists(select 1 from public.sales_team_provider_operations_v1 op where op.kind='reversal' and op.scope_key='recovery:v1' and op.context=p_context and op.request->'params'->'metadata'->>'team_transfer_request_id'=q.id::text and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=op.id)))) then return jsonb_build_object('status',case when p_new and not allow_new then 'held' else 'idle' end);end if;
 digest:=creatornet_team_private.transfer_contract_digest_v1();
 if not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and transfer_contract_sha256=digest) then raise exception 'TRANSFER_CONTRACT_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.sales_team_settlement_runs_v1 r join public.sales_team_worker_runs_v1 w on w.id=r.run_id where w.status='running' and w.lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 slot:=date_bin(interval '15 minutes',clock_timestamp(),'2000-01-01'::timestamptz);
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='settlement' and scheduled_slot=slot) then return jsonb_build_object('status','slot_consumed');end if;
 insert into public.sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values(p_run_id,'settlement',slot,clock_timestamp()+interval '90 seconds','running');
 insert into public.sales_team_settlement_runs_v1(run_id,context,contract_sha256) values(p_run_id,p_context,digest) returning * into run;
 insert into public.sales_team_transfer_reversal_runs_v1(run_id) values(p_run_id);
 insert into public.sales_team_transfer_recovery_runs_v1(run_id,allow_new) values(p_run_id,allow_new);
 return jsonb_build_object('status','claimed','runId',p_run_id,'leaseToken',run.lease_token,'allowNew',allow_new);
end $$;
create function public.sales_team_transfer_recovery_request_json_v1(p_request_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select to_jsonb(p)||jsonb_build_object('transfer',public.sales_team_transfer_request_json_v1(q.id),'operation',public.sales_team_operation_json_v1(p.operation_id),
  'scope',jsonb_build_object('scopeId',p.id,'scopeKey','recovery:v1','kind','reversal','saleId',q.sale_id,'creatorId',q.creator_id,'actorId',null,'workerRunId',p.original_worker_run_id),
  'canceled',exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id),'completed',exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id))
 from public.sales_team_transfer_recovery_requests_v1 p join public.sales_team_transfer_requests_v1 q on q.id=p.transfer_request_id where p.id=p_request_id
$$;
create function public.begin_sales_team_transfer_recovery_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare task public.sales_team_transfer_recovery_tasks_v1;pending uuid;original jsonb;begin
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 if p_task_id is null then raise exception 'RECOVERY_TASK_ID_REQUIRED';end if;
 original:=creatornet_team_private.transfer_recovery_original_v1(p_transfer_id,p_context);
 select * into task from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id;
 if task.id is not null and (task.run_id<>p_run_id or task.transfer_request_id<>p_transfer_id) or exists(select 1 from public.sales_team_transfer_reversal_checks_v1 where task_id=p_task_id and (worker_run_id<>p_run_id or transfer_request_id<>p_transfer_id)) then raise exception 'ORIGINAL_RECOVERY_TASK_CHANGED';end if;
 if task.id is null then
  if creatornet_team_private.transfer_recovery_task_count_v1(p_run_id)>=3 then raise exception 'REVERSAL_TASK_LIMIT_REQUIRED';end if;
  select p.id into pending from public.sales_team_transfer_recovery_requests_v1 p where p.transfer_request_id=p_transfer_id and not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id) order by p.created_at,p.id limit 1;
  if pending is null then perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context,true);end if;
  insert into public.sales_team_transfer_recovery_tasks_v1(id,run_id,transfer_request_id,request_id,financial_check_id,root_read_id) values(p_task_id,p_run_id,p_transfer_id,coalesce(pending,gen_random_uuid()),gen_random_uuid(),gen_random_uuid()) returning * into task;
 end if;
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 return to_jsonb(task)||jsonb_build_object('transfer',original,'source_ready',creatornet_team_private.transfer_recovery_source_v1(p_transfer_id,task.request_id) is not null,'reserved',public.sales_team_transfer_recovery_request_json_v1(task.request_id));
end $$;
alter function creatornet_team_private.settlement_financial_authorized_v1(uuid,uuid,uuid) rename to settlement_financial_before_transfer_recovery_v1;
create function creatornet_team_private.settlement_financial_authorized_v1(p_check_id uuid,p_worker_run_id uuid,p_receipt_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select creatornet_team_private.settlement_financial_before_transfer_recovery_v1(p_check_id,p_worker_run_id,p_receipt_id) or exists(
 select 1 from public.sales_team_transfer_recovery_financial_links_v1 link join public.sales_team_transfer_recovery_tasks_v1 task on task.id=link.task_id
 join public.sales_team_transfer_requests_v1 q on q.id=task.transfer_request_id join public.sales_team_transfer_recovery_runs_v1 recovery on recovery.run_id=task.run_id
 join public.sales_team_settlement_runs_v1 run on run.run_id=recovery.run_id join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id
 join public.sales_team_cash_policy_v1 policy on policy.singleton join public.sales_team_financial_config_v1 config on config.singleton and config.context=run.context
 join public.sales_team_controls_v1 controls on controls.singleton and controls.settlement_enabled and controls.transfer_reversal_observations_enabled and controls.transfer_recovery_reservations_enabled
 where link.check_id=p_check_id and task.financial_check_id=p_check_id and link.worker_run_id=p_worker_run_id and task.run_id=p_worker_run_id and q.receipt_id=p_receipt_id and q.context=run.context and recovery.allow_new and
 worker.kind='settlement' and worker.status='running' and worker.lease_until>clock_timestamp() and run.contract_sha256=policy.transfer_contract_sha256 and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1())
$$;
create function public.run_sales_team_transfer_recovery_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_phase text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare task public.sales_team_transfer_recovery_tasks_v1;q public.sales_team_transfer_requests_v1;r public.sales_team_receipts_v1;read public.sales_team_transfer_recovery_root_reads_v1;
 result jsonb;t jsonb:=p_payload->'transfer';root jsonb;known bigint;v_ready boolean;req text;seen text[]:='{}';begin
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context,true);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into task from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id;
 if task.id is null then raise exception 'CURRENT_RECOVERY_TASK_REQUIRED';end if;
 select * into q from public.sales_team_transfer_requests_v1 where id=task.transfer_request_id;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context,true);
 perform creatornet_team_private.transfer_recovery_original_v1(q.id,p_context);
 if p_phase='begin_financial' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{}');
  insert into public.sales_team_transfer_recovery_financial_links_v1(check_id,task_id,worker_run_id) values(task.financial_check_id,task.id,p_run_id) on conflict(check_id) do nothing;
  result:=creatornet_team_private.begin_settlement_financial_v1(task.financial_check_id,q.receipt_id,null,null,p_run_id,p_context);
  if result->>'checkId'<>task.financial_check_id::text then raise exception 'ORIGINAL_RECOVERY_FINANCIAL_CHECK_CHANGED';end if;
 elsif p_phase='complete_financial' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{"revision":"number","snapshot":"object"}');
  result:=creatornet_team_private.complete_settlement_financial_v1(task.financial_check_id,(p_payload->>'revision')::integer,p_payload->'snapshot');
 elsif p_phase='begin_root' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{}');select * into r from public.sales_team_receipts_v1 where id=q.receipt_id;
  insert into public.sales_team_transfer_recovery_root_reads_v1(id,task_id,receipt_revision) values(task.root_read_id,task.id,r.observation_revision) on conflict(id) do nothing;
  result:=jsonb_build_object('readId',task.root_read_id,'transfer',public.sales_team_transfer_request_json_v1(q.id),'completed',exists(select 1 from public.sales_team_transfer_recovery_roots_v1 where read_id=task.root_read_id),'ready',(select history.ready from public.sales_team_transfer_recovery_roots_v1 history where history.read_id=task.root_read_id));
 elsif p_phase='complete_root' then
  select * into read from public.sales_team_transfer_recovery_root_reads_v1 where id=task.root_read_id and task_id=task.id;
  select * into r from public.sales_team_receipts_v1 where id=q.receipt_id;
  perform creatornet_team_private.financial_shape_v1(p_payload,'{"transferRequestId":"string","receiptId":"string","context":"object","transfer":"object","transferReadRequestIds":"array","readStartedAt":"number","observedAt":"number"}');
  perform creatornet_team_private.financial_shape_v1(t,'{"id":"string","amountCents":"number","amountReversedCents":"number","reversed":"boolean","currency":"string","destinationId":"string","sourceChargeId":"string","destinationPaymentId":"string","balanceId":"string","transferGroup":"string","sourceType":"string","created":"number","livemode":"boolean","metadata":"object"}');
  if read.id is null or read.receipt_revision<>r.observation_revision or p_payload->>'transferRequestId'<>q.id::text or p_payload->>'receiptId'<>r.id::text or p_payload->'context' is distinct from p_context or
   (p_payload->>'readStartedAt')::numeric not between greatest(extract(epoch from read.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-25000) and extract(epoch from clock_timestamp())*1000 or
   (p_payload->>'observedAt')::numeric not between floor((p_payload->>'readStartedAt')::numeric/1000) and extract(epoch from clock_timestamp())+5 or jsonb_array_length(p_payload->'transferReadRequestIds')<>2 then raise exception 'FRESH_RECOVERY_ROOT_REQUIRED';end if;
  for req in select jsonb_array_elements_text(p_payload->'transferReadRequestIds') loop if req!~'^req_[A-Za-z0-9]+$' or req=any(seen) then raise exception 'DISTINCT_RECOVERY_ROOT_READS_REQUIRED';end if;seen:=array_append(seen,req);end loop;
  select proof->'transfer' into root from public.sales_team_transfer_completions_v1 where request_id=q.id;
  if t-'amountReversedCents'-'reversed' is distinct from root-'amountReversedCents'-'reversed' or (t->>'amountReversedCents')::bigint not between 0 and q.amount_cents or t->'reversed' is distinct from to_jsonb((t->>'amountReversedCents')::bigint=q.amount_cents) then raise exception 'EXACT_RECOVERY_TRANSFER_REQUIRED';end if;
  select coalesce(sum(amount_cents),0) into known from public.sales_team_transfer_reversal_completions_v1 where transfer_request_id=q.id;
  v_ready:=(t->>'amountReversedCents')::bigint=known;
  if not v_ready then
   insert into public.sales_team_financial_alerts_v1(creator_id,sale_id,code,source_identity,evidence) values(q.creator_id,q.sale_id,'TRANSFER_REVERSAL_REVIEW_REQUIRED','transfer-reversals:'||q.id::text,jsonb_build_object('transferRequestId',q.id,'observedPrincipalCents',known,'providerReversedCents',(t->>'amountReversedCents')::bigint)) on conflict(source_identity) do update set status='open',evidence=excluded.evidence;
   update public.sales_team_receipts_v1 set review_hold=true,observation_revision=observation_revision+1 where id=r.id;
  end if;
  if exists(select 1 from public.sales_team_transfer_recovery_roots_v1 history where history.read_id=read.id and (history.proof is distinct from p_payload or history.ready is distinct from v_ready)) then raise exception 'ORIGINAL_RECOVERY_ROOT_CHANGED';end if;
  insert into public.sales_team_transfer_recovery_roots_v1(read_id,ready,proof) values(read.id,v_ready,p_payload) on conflict(read_id) do nothing;
  result:=jsonb_build_object('ready',v_ready);
 else raise exception 'TRANSFER_RECOVERY_PHASE_REQUIRED';end if;
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context,true);return result;
end $$;
alter function creatornet_team_private.cash_encumbered_v1() rename to cash_encumbered_before_transfer_recovery_v1;
create function creatornet_team_private.cash_encumbered_v1()
returns numeric language sql stable security invoker set search_path=pg_catalog as $$
 select creatornet_team_private.cash_encumbered_before_transfer_recovery_v1()+coalesce((select sum(p.cost_reserve_cents) from public.sales_team_transfer_recovery_requests_v1 p
 where not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id)),0)
$$;
create function public.reserve_sales_team_transfer_recovery_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_read_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare task public.sales_team_transfer_recovery_tasks_v1;q public.sales_team_transfer_requests_v1;p public.sales_team_transfer_recovery_requests_v1;source jsonb;v_protection jsonb;cost bigint;root public.sales_team_transfer_recovery_root_reads_v1;begin
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context,true);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into task from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id;
 if task.id is null then raise exception 'CURRENT_RECOVERY_TASK_REQUIRED';end if;
 select * into q from public.sales_team_transfer_requests_v1 where id=task.transfer_request_id;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context,true);
 select * into p from public.sales_team_transfer_recovery_requests_v1 where id=task.request_id;
 source:=creatornet_team_private.transfer_recovery_source_v1(q.id,task.request_id);
 if source is null then raise exception 'CURRENT_VERIFIED_RECOVERY_DEBT_REQUIRED';end if;
 if exists(select 1 from public.sales_team_transfer_recovery_requests_v1 prior where prior.transfer_request_id=q.id and prior.id<>task.request_id and not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=prior.id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=prior.operation_id)) then raise exception 'ORIGINAL_TRANSFER_RECOVERY_REQUEST_REQUIRED';end if;
 select * into root from public.sales_team_transfer_recovery_root_reads_v1 where id=task.root_read_id and task_id=task.id;
 if root.id is null or root.receipt_revision<>(source->>'revision')::integer or root.created_at<clock_timestamp()-interval '25 seconds' or not exists(select 1 from public.sales_team_transfer_recovery_roots_v1 where read_id=root.id and ready) then raise exception 'FRESH_RECOVERY_ROOT_REQUIRED';end if;
 v_protection:=creatornet_team_private.cash_protection_v1(p_context);
 if not exists(select 1 from public.sales_team_cash_reads_v1 cash join public.sales_team_cash_observations_v1 observation on observation.read_id=cash.id where cash.id=p_read_id and cash.settlement_worker_run_id=p_run_id and cash.context=p_context and cash.protection=v_protection and cash.created_at>clock_timestamp()-interval '25 seconds') then raise exception 'FRESH_SETTLEMENT_CASH_REQUIRED';end if;
 if p.id is null then select transfer_reversal_cost_reserve_cents into cost from public.sales_team_cash_policy_v1 where singleton;
 else
  if p.transfer_request_id<>q.id or p.context is distinct from p_context or p.amount_cents>(source->>'amountCents')::bigint or exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) or exists(select 1 from public.sales_team_provider_operations_v1 where id=p.operation_id) then raise exception 'ORIGINAL_TRANSFER_RECOVERY_RECONCILIATION_REQUIRED';end if;
  cost:=0;
 end if;
 if cost is null then raise exception 'EXPLICIT_TRANSFER_REVERSAL_COST_RESERVE_REQUIRED';end if;
 if not coalesce(creatornet_team_private.cash_available_floor_v1(p_context,v_protection->'epoch')>=(v_protection->>'teamCents')::numeric+(v_protection->'shared'->>'protectedCents')::numeric+(v_protection->>'reserveCents')::numeric+creatornet_team_private.cash_encumbered_v1()+cost,false) then raise exception 'PROTECTED_PLATFORM_FUNDS_INSUFFICIENT';end if;
 if p.id is null then
  insert into public.sales_team_transfer_recovery_requests_v1(id,operation_id,transfer_request_id,original_worker_run_id,amount_cents,receipt_revision,cost_reserve_cents,context,cash_read_id,request)
  values(task.request_id,creatornet_team_private.transfer_reversal_operation_id_v1(task.request_id),q.id,p_run_id,(source->>'amountCents')::bigint,(source->>'revision')::integer,cost,p_context,p_read_id,
   jsonb_build_object('apiVersion','2026-08-26.dahlia','method','POST','path','/v1/transfers/'||(select provider_id from public.sales_team_provider_operations_v1 where id=q.operation_id)||'/reversals','params',jsonb_build_object('amount',(source->>'amountCents')::bigint,
   'metadata',jsonb_build_object('team_protocol','creatornet-team-recovery-v1','team_sale_id',q.sale_id,'team_receipt_id',q.receipt_id,'team_transfer_request_id',q.id,'team_recovery_request_id',task.request_id,'team_provider_operation_id',creatornet_team_private.transfer_reversal_operation_id_v1(task.request_id),'team_beneficiary',q.beneficiary))));
  update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;
 end if;
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context,true);
 return public.sales_team_transfer_recovery_request_json_v1(task.request_id);
end $$;
create function public.cancel_unsent_sales_team_transfer_recovery_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare task public.sales_team_transfer_recovery_tasks_v1;p public.sales_team_transfer_recovery_requests_v1;q public.sales_team_transfer_requests_v1;begin
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into task from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id;
 select * into p from public.sales_team_transfer_recovery_requests_v1 where id=task.request_id and context=p_context;select * into q from public.sales_team_transfer_requests_v1 where id=p.transfer_request_id;
 if task.id is null or p.id is null then raise exception 'ORIGINAL_TRANSFER_RECOVERY_REQUEST_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 -- Complete journal absence, including expired/unknown/failed/bound states.
 if exists(select 1 from public.sales_team_provider_operations_v1 where id=p.operation_id or kind='reversal' and scope_id=p.id) then raise exception 'ORIGINAL_TRANSFER_RECOVERY_RECONCILIATION_REQUIRED';end if;
 if not exists(select 1 from public.sales_team_receipts_v1 r join public.sales_team_financial_checks_v1 checked on checked.receipt_id=r.id and checked.context=p_context
  join public.sales_team_financial_check_results_v1 done on done.check_id=checked.id where r.id=q.receipt_id and not r.review_hold and not r.dispute_hold and
   done.created_at>=r.observed_at and done.created_at>clock_timestamp()-interval '2 minutes' and done.proof->'balances'->'complete'='true'::jsonb and
   done.proof->'financial'->'reviewHold'='false'::jsonb and done.proof->'financial'->'disputeHold'='false'::jsonb) then raise exception 'CURRENT_VERIFIED_RECOVERY_DEBT_REQUIRED';end if;
 if creatornet_team_private.transfer_recovery_amount_v1(q.id,p.id)>=p.amount_cents then raise exception 'RECOVERY_DEBT_HAS_NOT_SHRUNK';end if;
 if not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) then
  insert into public.sales_team_transfer_recovery_cancellations_v1(request_id,worker_run_id,reason) values(p.id,p_run_id,'not_dispatched');
  update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;
 end if;
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 return jsonb_build_object('canceled',true,'requestId',p.id);
end $$;
-- Include every new amount/authority/cash dependency in the reviewed contracts.
-- Preserve the exact installed validators and refuse an unexpected patch target.
do $patch$ declare src text;needle text;item record;begin
 src:=pg_get_functiondef('creatornet_team_private.cash_protection_v1(jsonb)'::regprocedure);needle:='''transferCostReserveCents'',policy.transfer_cost_reserve_cents,';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_CASH_POLICY_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||'''transferReversalCostReserveCents'',policy.transfer_reversal_cost_reserve_cents,');
 src:=pg_get_functiondef('creatornet_team_private.transfer_reversal_original_v1(uuid,jsonb)'::regprocedure);needle:='return jsonb_build_object(''id'',op.scope_id';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_FROZEN_ORIGINAL_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'if exists(select 1 from public.sales_team_transfer_recovery_requests_v1 p where p.operation_id=op.id and (p.id is distinct from op.scope_id or p.transfer_request_id<>q.id or p.original_worker_run_id is distinct from op.worker_run_id or p.context is distinct from p_context or p.request is distinct from op.request or p.amount_cents<>amount or exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 canceled where canceled.request_id=p.id))) then raise exception ''FROZEN_ORIGINAL_TRANSFER_RECOVERY_REQUIRED'';end if;'||needle);
 src:=pg_get_functiondef('public.complete_sales_team_reversal_check_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)'::regprocedure);needle:='select transfer_reversal_cost_reserve_cents into reserve from public.sales_team_cash_policy_v1 where singleton;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_SAVED_COST_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'if exists(select 1 from public.sales_team_transfer_recovery_requests_v1 where operation_id=op.id) then select cost_reserve_cents into reserve from public.sales_team_transfer_recovery_requests_v1 where operation_id=op.id;else '||needle||'end if;');
 src:=pg_get_functiondef('public.begin_sales_team_reversal_check_v1(uuid,uuid,jsonb,uuid,uuid,uuid)'::regprocedure);needle:='if (select count(*) from public.sales_team_transfer_reversal_checks_v1 where worker_run_id=p_run_id)>=3 then';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_COMBINED_TASK_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'if creatornet_team_private.transfer_recovery_task_count_v1(p_run_id)>=3 and not exists(select 1 from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id and transfer_request_id=q.id) then');
 needle:='if p_check_id is null or p_task_id is null then';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_ORIGINAL_TASK_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'if exists(select 1 from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id and (run_id<>p_run_id or transfer_request_id::text is distinct from (creatornet_team_private.transfer_reversal_original_v1(p_operation_id,p_context)->''transfer''->>''id''))) then raise exception ''ORIGINAL_RECOVERY_TASK_CHANGED'';end if;'||needle);execute src;
 src:=pg_get_functiondef('public.finish_sales_team_reversal_observation_run_v1(uuid,uuid,jsonb,boolean)'::regprocedure);needle:='when p_failed is distinct from false or exists(';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_FINISH_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'when p_failed is distinct from false or exists(select 1 from public.sales_team_transfer_recovery_tasks_v1 task where task.run_id=p_run_id and not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=task.request_id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=creatornet_team_private.transfer_reversal_operation_id_v1(task.request_id))) or exists(');
 for item in select * from (values
  ('creatornet_team_private.transfer_contract_digest_v1()','''transfer_cost_total_v1''',',''cash_encumbered_before_transfer_recovery_v1'',''settlement_financial_before_transfer_recovery_v1'',''transfer_recovery_original_v1'',''transfer_recovery_amount_v1'',''transfer_recovery_source_v1'',''transfer_recovery_worker_v1'',''transfer_recovery_task_count_v1'''),
  ('creatornet_team_private.shared_cash_contract_digest_v1()','''cash_encumbered_v1''',',''cash_encumbered_before_transfer_recovery_v1'''),
  ('creatornet_team_private.retained_cash_contract_digest_v1()','''cash_encumbered_v1''',',''cash_encumbered_before_transfer_recovery_v1'''),
  ('creatornet_team_private.recovery_contract_digest_v1()','''shared_cash_trace_v1''',',''cash_encumbered_v1'',''cash_encumbered_before_transfer_recovery_v1''')
 ) definitions(signature,needle,extra) loop
  src:=pg_get_functiondef(item.signature::regprocedure);if (length(src)-length(replace(src,item.needle,'')))/length(item.needle)<>1 then raise exception 'RECOVERY_NAMED_DEPENDENCY_DIFFERS: %',item.signature;end if;execute replace(src,item.needle,item.needle||item.extra);
 end loop;
 src:=pg_get_functiondef('creatornet_team_private.transfer_contract_digest_v1()'::regprocedure);needle:='''sales_team_transfer_operation_id_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_PUBLIC_DIGEST_DIFFERS';end if;
 execute replace(src,needle,needle||',''claim_sales_team_transfer_recovery_run_v1'',''sales_team_transfer_recovery_request_json_v1'',''begin_sales_team_transfer_recovery_v1'',''run_sales_team_transfer_recovery_v1'',''reserve_sales_team_transfer_recovery_v1'',''cancel_unsent_sales_team_transfer_recovery_v1''');
end $patch$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_transfer_recovery_runs_v1','sales_team_transfer_recovery_tasks_v1','sales_team_transfer_recovery_requests_v1','sales_team_transfer_recovery_cancellations_v1','sales_team_transfer_recovery_financial_links_v1','sales_team_transfer_recovery_root_reads_v1','sales_team_transfer_recovery_roots_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_transfer_recovery_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('claim_sales_team_transfer_recovery_run_v1','sales_team_transfer_recovery_request_json_v1','begin_sales_team_transfer_recovery_v1','run_sales_team_transfer_recovery_v1','reserve_sales_team_transfer_recovery_v1','cancel_unsent_sales_team_transfer_recovery_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('cash_encumbered_v1','cash_encumbered_before_transfer_recovery_v1','settlement_financial_authorized_v1','settlement_financial_before_transfer_recovery_v1','transfer_recovery_original_v1','transfer_recovery_amount_v1','transfer_recovery_source_v1','transfer_recovery_worker_v1','transfer_recovery_task_count_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
