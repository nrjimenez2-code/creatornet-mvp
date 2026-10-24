-- Local candidate: consume bound original returns, never admit a provider POST.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column transfer_reversal_observations_enabled boolean not null default false;
alter table public.sales_team_cash_policy_v1 add column transfer_reversal_cost_reserve_cents bigint check(transfer_reversal_cost_reserve_cents between 0 and 99999999);
create table public.sales_team_transfer_reversal_runs_v1 (
 run_id uuid primary key references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_reversal_checks_v1 (
 id uuid primary key,task_id uuid not null unique,worker_run_id uuid not null references public.sales_team_transfer_reversal_runs_v1(run_id) on delete restrict,
 operation_id uuid not null references public.sales_team_provider_operations_v1(id) on delete restrict,
 transfer_request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 context jsonb not null,receipt_revision integer not null,created_at timestamptz not null default clock_timestamp(),unique(worker_run_id,operation_id)
);
create table public.sales_team_transfer_reversal_completions_v1 (
 operation_id uuid primary key references public.sales_team_provider_operations_v1(id) on delete restrict,
 check_id uuid not null unique references public.sales_team_transfer_reversal_checks_v1(id) on delete restrict,
 transfer_request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 reversal_id text not null unique check(reversal_id~'^trr_[A-Za-z0-9]+$'),balance_id text not null unique check(balance_id~'^txn_[A-Za-z0-9]+$'),
 amount_cents bigint not null check(amount_cents between 1 and 99999999),worker_run_id uuid not null references public.sales_team_transfer_reversal_runs_v1(run_id) on delete restrict,
 proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_reversal_costs_v1 (
 operation_id uuid primary key references public.sales_team_transfer_reversal_completions_v1(operation_id) on delete restrict,
 receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,creator_id uuid not null references auth.users(id) on delete restrict,
 balance_id text not null unique,fee_cents bigint not null check(fee_cents between 0 and 99999999),created_at timestamptz not null default clock_timestamp()
);
create index sales_team_reversal_original_principal_v1 on public.sales_team_transfer_reversal_completions_v1(transfer_request_id);
create index sales_team_reversal_receipt_cost_v1 on public.sales_team_transfer_reversal_costs_v1(receipt_id);
create index sales_team_reversal_bound_context_v1 on public.sales_team_provider_operations_v1(context) where kind='reversal' and status='bound' and scope_key='recovery:v1';
create function creatornet_team_private.transfer_reversal_operation_id_v1(p_request_id uuid)
returns uuid language sql immutable security invoker set search_path=pg_catalog as $$
 select overlay(overlay(substring(encode(sha256(convert_to('creatornet-team-v1:'||p_request_id::text||':reversal:recovery:v1','UTF8')),'hex'),1,32) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;
create function creatornet_team_private.transfer_reversal_worker_v1(p_run_id uuid,p_token uuid,p_context jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_token,p_context);
 if not exists(select 1 from public.sales_team_transfer_reversal_runs_v1 where run_id=p_run_id) or
  not exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_reversal_observations_enabled) then raise exception 'CURRENT_REVERSAL_OBSERVATION_WORKER_REQUIRED';end if;
end $$;
create function creatornet_team_private.transfer_reversal_original_v1(p_operation_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare op public.sales_team_provider_operations_v1;q public.sales_team_transfer_requests_v1;t public.sales_team_provider_operations_v1;amount bigint;expected jsonb;begin
 select * into op from public.sales_team_provider_operations_v1 where id=p_operation_id and context=p_context;
 select * into q from public.sales_team_transfer_requests_v1 where id::text=op.request->'params'->'metadata'->>'team_transfer_request_id' and context=p_context;
 select * into t from public.sales_team_provider_operations_v1 where id=q.operation_id;
 if op.id is null or q.id is null or t.id is null or op.kind<>'reversal' or op.status<>'bound' or op.scope_key<>'recovery:v1' or
  op.worker_run_id is null or op.actor_id is not null or op.sale_id is distinct from q.sale_id or op.creator_id is distinct from q.creator_id or
  op.id<>creatornet_team_private.transfer_reversal_operation_id_v1(op.scope_id) or op.idempotency_key<>'cn-team-v1:'||op.id::text or
  coalesce(op.provider_id,'')!~'^trr_[A-Za-z0-9]+$' or coalesce(op.provider_request_id,'')!~'^req_[A-Za-z0-9]+$' or
  t.kind<>'transfer' or t.status<>'bound' or t.context is distinct from p_context or t.request is distinct from q.request or t.worker_run_id is distinct from q.original_worker_run_id or
  t.scope_id<>q.id or t.scope_key<>'settlement:v1' or t.sale_id is distinct from q.sale_id or t.creator_id is distinct from q.creator_id or t.actor_id is not null or
  t.idempotency_key<>'cn-team-v1:'||t.id::text or coalesce(t.provider_id,'')!~'^tr_[A-Za-z0-9]+$' or coalesce(t.provider_request_id,'')!~'^req_[A-Za-z0-9]+$' or
  op.first_dispatch_at<t.first_dispatch_at-interval '5 seconds' or op.first_dispatch_at>clock_timestamp()+interval '5 seconds' or
  exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id) or
  not exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id and transfer_id=t.provider_id) or
  not exists(select 1 from public.sales_team_sale_agreements_v1 a join public.sales_team_receipts_v1 r on r.sale_id=a.id and r.id=q.receipt_id
   join public.sales_team_creator_balances_v1 c on c.receipt_id=r.id and c.creator_id=a.creator_id and c.sale_id=a.id
   join public.sales_team_commission_balances_v1 b on b.receipt_id=r.id and b.creator_id=a.creator_id and b.sale_id=a.id and b.membership_id=a.membership_id
   where a.id=q.sale_id and a.creator_id=q.creator_id and a.context=p_context and
   q.beneficiary_user_id=case when q.beneficiary='creator' then a.creator_id else a.closer_id end and
   q.destination_id=a.terms->'distribution'->>(case when q.beneficiary='creator' then 'creatorRecipientId' else 'closerRecipientId' end)) then raise exception 'BOUND_ORIGINAL_TEAM_REVERSAL_REQUIRED';end if;
 if jsonb_typeof(op.request->'params'->'amount') is distinct from 'number' then raise exception 'ORIGINAL_REVERSAL_AMOUNT_REQUIRED';end if;
 amount:=(op.request->'params'->>'amount')::bigint;
 if amount not between 1 and q.amount_cents then raise exception 'ORIGINAL_REVERSAL_AMOUNT_REQUIRED';end if;
 expected:=jsonb_build_object('apiVersion','2026-08-26.dahlia','method','POST','path','/v1/transfers/'||t.provider_id||'/reversals','params',jsonb_build_object('amount',amount,
  'metadata',jsonb_build_object('team_protocol','creatornet-team-recovery-v1','team_sale_id',q.sale_id,'team_receipt_id',q.receipt_id,'team_transfer_request_id',q.id,'team_recovery_request_id',op.scope_id,'team_provider_operation_id',op.id,'team_beneficiary',q.beneficiary)));
 if op.request is distinct from expected then raise exception 'ORIGINAL_REVERSAL_REQUEST_CHANGED';end if;
 return jsonb_build_object('id',op.scope_id,'amountCents',amount,'originalWorkerRunId',op.worker_run_id,'transfer',public.sales_team_transfer_request_json_v1(q.id),'operation',public.sales_team_operation_json_v1(op.id));
end $$;
-- A per-balance lock makes ownership checks symmetric against these exact
-- existing owners, including original receipt charges. No prefix scan or
-- historical ownership backfill is used.
create function creatornet_team_private.guard_reversal_balance_owner_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare key text;begin
 key:=case when tg_table_name='sales_team_transfer_completions_v1' then to_jsonb(new)->>'balance_id' when tg_table_name='sales_team_receipts_v1' then to_jsonb(new)->>'balance_transaction_id' else to_jsonb(new)->>'transaction_id' end;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-owned-balance:'||key,0));
 if exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where balance_id=key) then raise exception 'REVERSAL_BALANCE_ALREADY_OWNED';end if;
 return new;
end $$;
create trigger reversal_balance_owner_v1 before insert on public.sales_team_financial_balance_entries_v1 for each row execute function creatornet_team_private.guard_reversal_balance_owner_v1();
create trigger reversal_balance_owner_v1 before insert on public.sales_team_shared_cash_balance_entries_v1 for each row execute function creatornet_team_private.guard_reversal_balance_owner_v1();
create trigger reversal_balance_owner_v1 before insert on public.sales_team_transfer_completions_v1 for each row execute function creatornet_team_private.guard_reversal_balance_owner_v1();
create trigger reversal_balance_owner_v1 before insert or update of balance_transaction_id on public.sales_team_receipts_v1 for each row execute function creatornet_team_private.guard_reversal_balance_owner_v1();
do $cost_source$ declare src text;begin
 select trim(regexp_replace(prosrc,'\s+',' ','g')) into src from pg_proc where oid='creatornet_team_private.transfer_cost_total_v1(uuid)'::regprocedure;
 if src<>'select coalesce(sum(cost.fee_cents),0)::bigint from public.sales_team_transfer_costs_v1 cost join public.sales_team_transfer_requests_v1 q on q.id=cost.request_id join public.sales_team_sale_agreements_v1 a on a.id=q.sale_id and a.creator_id=cost.creator_id where cost.receipt_id=p_receipt_id and q.receipt_id=p_receipt_id and q.creator_id=cost.creator_id' then raise exception 'REVERSAL_TRANSFER_COST_DEPENDENCY_DIFFERS';end if;
end $cost_source$;
alter function creatornet_team_private.transfer_cost_total_v1(uuid) rename to transfer_cost_before_reversals_v1;
create function creatornet_team_private.transfer_cost_total_v1(p_receipt_id uuid)
returns bigint language sql stable security invoker set search_path=pg_catalog as $$
 select creatornet_team_private.transfer_cost_before_reversals_v1(p_receipt_id)+coalesce((select sum(cost.fee_cents) from public.sales_team_transfer_reversal_costs_v1 cost
 join public.sales_team_transfer_reversal_completions_v1 done on done.operation_id=cost.operation_id join public.sales_team_transfer_requests_v1 q on q.id=done.transfer_request_id
 join public.sales_team_sale_agreements_v1 a on a.id=q.sale_id and a.creator_id=cost.creator_id
 where cost.receipt_id=p_receipt_id and q.receipt_id=p_receipt_id and q.creator_id=cost.creator_id),0)::bigint
$$;
create function public.claim_sales_team_reversal_observation_run_v1(p_run_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare slot timestamptz;run public.sales_team_settlement_runs_v1;digest text;begin
 if p_run_id is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'SETTLEMENT_CONTEXT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-settlement-v1',0));
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_reversal_observations_enabled) then return jsonb_build_object('status','held');end if;
 if not exists(select 1 from public.sales_team_provider_operations_v1 op join public.sales_team_transfer_requests_v1 q on q.id::text=op.request->'params'->'metadata'->>'team_transfer_request_id'
  join public.sales_team_transfer_completions_v1 original on original.request_id=q.id where op.kind='reversal' and op.status='bound' and op.scope_key='recovery:v1' and op.context=p_context and q.context=p_context and
  not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=op.id)) then return jsonb_build_object('status','idle');end if;
 digest:=creatornet_team_private.transfer_contract_digest_v1();
 if not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and transfer_contract_sha256=digest) then raise exception 'TRANSFER_CONTRACT_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.sales_team_settlement_runs_v1 r join public.sales_team_worker_runs_v1 w on w.id=r.run_id where w.status='running' and w.lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 slot:=date_bin(interval '15 minutes',clock_timestamp(),'2000-01-01'::timestamptz);
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='settlement' and scheduled_slot=slot) then return jsonb_build_object('status','slot_consumed');end if;
 insert into public.sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values(p_run_id,'settlement',slot,clock_timestamp()+interval '90 seconds','running');
 insert into public.sales_team_settlement_runs_v1(run_id,context,contract_sha256) values(p_run_id,p_context,digest) returning * into run;
 insert into public.sales_team_transfer_reversal_runs_v1(run_id) values(p_run_id);
 return jsonb_build_object('status','claimed','runId',p_run_id,'leaseToken',run.lease_token);
end $$;
create function public.begin_sales_team_reversal_check_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_operation_id uuid,p_check_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c public.sales_team_transfer_reversal_checks_v1;original jsonb;q public.sales_team_transfer_requests_v1;revision integer;begin
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_lease_token,p_context);
 if p_check_id is null or p_task_id is null then raise exception 'REVERSAL_CHECK_IDENTITIES_REQUIRED';end if;
 original:=creatornet_team_private.transfer_reversal_original_v1(p_operation_id,p_context);select * into q from public.sales_team_transfer_requests_v1 where id=(original->'transfer'->>'id')::uuid;
 select observation_revision into revision from public.sales_team_receipts_v1 where id=q.receipt_id;
 select * into c from public.sales_team_transfer_reversal_checks_v1 where id=p_check_id;
 if c.id is not null and (c.worker_run_id<>p_run_id or c.task_id<>p_task_id or c.operation_id<>p_operation_id or c.context is distinct from p_context or c.transfer_request_id<>q.id) then raise exception 'ORIGINAL_REVERSAL_CHECK_CHANGED';end if;
 if c.id is null then
  if (select count(*) from public.sales_team_transfer_reversal_checks_v1 where worker_run_id=p_run_id)>=3 then raise exception 'REVERSAL_TASK_LIMIT_REQUIRED';end if;
  insert into public.sales_team_transfer_reversal_checks_v1(id,task_id,worker_run_id,operation_id,transfer_request_id,context,receipt_revision) values(p_check_id,p_task_id,p_run_id,p_operation_id,q.id,p_context,revision);
 end if;
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_lease_token,p_context);
 return jsonb_build_object('checkId',p_check_id,'completed',exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p_operation_id),'held',creatornet_team_private.transfer_accounting_held_v1(q.id),'original',original);
end $$;
create function public.complete_sales_team_reversal_check_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_check_id uuid,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c public.sales_team_transfer_reversal_checks_v1;q public.sales_team_transfer_requests_v1;op public.sales_team_provider_operations_v1;r public.sales_team_receipts_v1;
 original jsonb;t jsonb:=p_proof->'transfer';rev jsonb:=p_proof->'reversal';b jsonb:=p_proof->'balance';root jsonb;amount bigint;previous bigint;fee_sum bigint:=0;fee jsonb;req text;seen text[]:='{}';reserve bigint;overrun boolean;unobserved boolean;held boolean;begin
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into c from public.sales_team_transfer_reversal_checks_v1 where id=p_check_id and task_id=p_task_id and worker_run_id=p_run_id and context=p_context;
 if c.id is null then raise exception 'CURRENT_ORIGINAL_REVERSAL_CHECK_REQUIRED';end if;
 select * into q from public.sales_team_transfer_requests_v1 where id=c.transfer_request_id and context=p_context;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_lease_token,p_context);
 if exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=c.operation_id) then return jsonb_build_object('completed',true,'recorded',false,'held',creatornet_team_private.transfer_accounting_held_v1(q.id));end if;
 original:=creatornet_team_private.transfer_reversal_original_v1(c.operation_id,p_context);
 select * into op from public.sales_team_provider_operations_v1 where id=c.operation_id for update;select * into r from public.sales_team_receipts_v1 where id=q.receipt_id for update;
 if r.observation_revision is distinct from c.receipt_revision then raise exception 'CURRENT_REVERSAL_RECEIPT_REQUIRED';end if;
 amount:=(original->>'amountCents')::bigint;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"requestId":"string","operationId":"string","transferRequestId":"string","receiptId":"string","saleId":"string","creatorId":"string","beneficiary":"string","context":"object","transfer":"object","reversal":"object","balance":"object","originalRequestId":"string","idempotencyKey":"string","transferReadRequestIds":"array","reversalReadRequestIds":"array","balanceReadRequestIds":"array","readStartedAt":"number","observedAt":"number"}');
 perform creatornet_team_private.financial_shape_v1(t,'{"id":"string","amountCents":"number","amountReversedCents":"number","reversed":"boolean","currency":"string","destinationId":"string","sourceChargeId":"string","destinationPaymentId":"string","balanceId":"string","transferGroup":"string","sourceType":"string","created":"number","livemode":"boolean","metadata":"object"}');
 perform creatornet_team_private.financial_shape_v1(rev,'{"id":"string","transferId":"string","amountCents":"number","currency":"string","balanceId":"string","created":"number","destinationPaymentRefundId":"string|null","sourceRefundId":"null","metadata":"object"}');
 perform creatornet_team_private.financial_shape_v1(b,'{"id":"string","sourceId":"string","type":"string","reportingCategory":"string","balanceType":"string","currency":"string","amountCents":"number","feeCents":"number","netCents":"number","created":"number","availableOn":"number","status":"string","feeDetails":"array"}');
 if p_proof->>'requestId'<>op.scope_id::text or p_proof->>'operationId'<>op.id::text or p_proof->>'transferRequestId'<>q.id::text or p_proof->>'receiptId'<>q.receipt_id::text or
  p_proof->>'saleId'<>q.sale_id::text or p_proof->>'creatorId'<>q.creator_id::text or p_proof->>'beneficiary'<>q.beneficiary or p_proof->'context' is distinct from p_context or
  p_proof->>'originalRequestId' is distinct from op.provider_request_id or p_proof->>'idempotencyKey' is distinct from op.idempotency_key or
  (p_proof->>'readStartedAt')::numeric not between greatest(extract(epoch from c.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-25000) and extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'observedAt')::numeric not between floor((p_proof->>'readStartedAt')::numeric/1000) and extract(epoch from clock_timestamp())+5 or
  jsonb_array_length(p_proof->'transferReadRequestIds')<>2 or jsonb_array_length(p_proof->'reversalReadRequestIds')<>2 or jsonb_array_length(p_proof->'balanceReadRequestIds')<>2 then raise exception 'FRESH_ORIGINAL_REVERSAL_PROOF_REQUIRED';end if;
 for req in select jsonb_array_elements_text((p_proof->'transferReadRequestIds')||(p_proof->'reversalReadRequestIds')||(p_proof->'balanceReadRequestIds')) loop
  if req!~'^req_[A-Za-z0-9]+$' or req=any(seen) then raise exception 'DISTINCT_REVERSAL_READS_REQUIRED';end if;seen:=array_append(seen,req);
 end loop;
 select proof->'transfer' into root from public.sales_team_transfer_completions_v1 where request_id=q.id;
 if t-'amountReversedCents'-'reversed' is distinct from root-'amountReversedCents'-'reversed' or
  (t->>'amountReversedCents')::bigint not between amount and q.amount_cents or t->'reversed' is distinct from to_jsonb((t->>'amountReversedCents')::bigint=q.amount_cents) then raise exception 'EXACT_ORIGINAL_REVERSAL_TRANSFER_REQUIRED';end if;
 if rev->>'id' is distinct from op.provider_id or rev->>'transferId' is distinct from t->>'id' or (rev->>'amountCents')::bigint<>amount or rev->>'currency'<>'usd' or
  rev->>'balanceId'!~'^txn_[A-Za-z0-9]+$' or rev->'metadata' is distinct from op.request->'params'->'metadata' or
  (rev->>'created')::numeric not between greatest((t->>'created')::numeric,extract(epoch from op.first_dispatch_at)-5) and extract(epoch from clock_timestamp())+5 or
  extract(epoch from op.first_dispatch_at)<(t->>'created')::numeric-5 or
  rev->'destinationPaymentRefundId'<>'null'::jsonb and rev->>'destinationPaymentRefundId'!~'^pyr_[A-Za-z0-9]+$' then raise exception 'EXACT_ORIGINAL_REVERSAL_REQUIRED';end if;
 if b->>'id' is distinct from rev->>'balanceId' or b->>'sourceId' is distinct from rev->>'id' or b->>'type'<>'transfer_refund' or b->>'reportingCategory'!~'^[a-z_]{1,80}$' or b->>'balanceType'<>'payments' or b->>'currency'<>'usd' or
  (b->>'amountCents')::bigint<>amount or (b->>'feeCents')::bigint not between 0 and 99999999 or (b->>'netCents')::numeric<>(b->>'amountCents')::numeric-(b->>'feeCents')::numeric or
  (b->>'created')::numeric not between (rev->>'created')::numeric-5 and extract(epoch from clock_timestamp())+5 or (b->>'availableOn')::numeric not between 1 and extract(epoch from clock_timestamp()) or b->>'status'<>'available' or jsonb_array_length(b->'feeDetails')>32 then raise exception 'EXACT_REVERSAL_BALANCE_RETURN_REQUIRED';end if;
 for fee in select value from jsonb_array_elements(b->'feeDetails') loop
  perform creatornet_team_private.financial_shape_v1(fee,'{"amount":"number","currency":"string","application":"null","type":"string"}');
  if (fee->>'amount')::bigint not between 0 and 99999999 or fee->>'currency'<>'usd' or fee->>'type' not in ('stripe_fee','tax','payment_method_passthrough_fee') then raise exception 'ACTUAL_REVERSAL_FEES_REQUIRED';end if;fee_sum:=fee_sum+(fee->>'amount')::bigint;
 end loop;
 if fee_sum<>(b->>'feeCents')::bigint then raise exception 'ACTUAL_REVERSAL_FEES_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-owned-balance:'||(b->>'id'),0));
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_lease_token,p_context);
 if exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where reversal_id=rev->>'id' or balance_id=b->>'id') or
  exists(select 1 from public.sales_team_transfer_completions_v1 where balance_id=b->>'id') or exists(select 1 from public.sales_team_financial_balance_entries_v1 where transaction_id=b->>'id') or
  exists(select 1 from public.sales_team_shared_cash_balance_entries_v1 where transaction_id=b->>'id') or
  exists(select 1 from public.sales_team_receipts_v1 where balance_transaction_id=b->>'id') then raise exception 'REVERSAL_BALANCE_ALREADY_OWNED';end if;
 select coalesce(sum(amount_cents),0) into previous from public.sales_team_transfer_reversal_completions_v1 where transfer_request_id=q.id;
 if previous+amount>q.amount_cents or previous+amount>(t->>'amountReversedCents')::bigint then raise exception 'ORIGINAL_REVERSAL_PRINCIPAL_CAP_REQUIRED';end if;
 insert into public.sales_team_transfer_reversal_completions_v1(operation_id,check_id,transfer_request_id,reversal_id,balance_id,amount_cents,worker_run_id,proof) values(op.id,c.id,q.id,rev->>'id',b->>'id',amount,p_run_id,p_proof);
 insert into public.sales_team_transfer_reversal_costs_v1(operation_id,receipt_id,creator_id,balance_id,fee_cents) values(op.id,q.receipt_id,q.creator_id,b->>'id',fee_sum);
 if q.beneficiary='creator' then update public.sales_team_creator_balances_v1 set creator_reversed_cents=creator_reversed_cents+amount where receipt_id=q.receipt_id and creator_id=q.creator_id and sale_id=q.sale_id and creator_reversed_cents+amount<=creator_released_cents;
 else update public.sales_team_commission_balances_v1 set reversed_cents=reversed_cents+amount where receipt_id=q.receipt_id and creator_id=q.creator_id and sale_id=q.sale_id and membership_id=(select membership_id from public.sales_team_sale_agreements_v1 where id=q.sale_id) and reversed_cents+amount<=released_cents;end if;
 if not found then raise exception 'OWNED_ORIGINAL_RETURNED_PRINCIPAL_REQUIRED';end if;
 insert into public.sales_team_financial_ledger_v1(creator_id,sale_id,membership_id,receipt_id,entry_kind,amount_cents,source_identity,evidence)
 values(q.creator_id,q.sale_id,case when q.beneficiary='closer' then (select membership_id from public.sales_team_sale_agreements_v1 where id=q.sale_id) end,q.receipt_id,'transfer_reversal',-amount,'transfer-reversal:'||op.id::text,jsonb_build_object('operationId',op.id,'reversalId',rev->>'id','beneficiary',q.beneficiary,'workerRunId',p_run_id));
 select transfer_reversal_cost_reserve_cents into reserve from public.sales_team_cash_policy_v1 where singleton;overrun:=reserve is null or fee_sum>reserve;unobserved:=(t->>'amountReversedCents')::bigint>previous+amount;
 if overrun then insert into public.sales_team_financial_alerts_v1(creator_id,sale_id,operation_id,code,source_identity,evidence) values(q.creator_id,q.sale_id,op.id,'TRANSFER_COST_RESERVE_EXCEEDED','transfer-reversal-cost:'||op.id::text,jsonb_build_object('actualCostCents',fee_sum,'reservedCostCents',reserve)) on conflict(source_identity) do nothing;end if;
 if unobserved then insert into public.sales_team_financial_alerts_v1(creator_id,sale_id,operation_id,code,source_identity,evidence) values(q.creator_id,q.sale_id,op.id,'TRANSFER_REVERSAL_REVIEW_REQUIRED','transfer-reversals:'||q.id::text,jsonb_build_object('transferRequestId',q.id,'observedPrincipalCents',previous+amount,'providerReversedCents',(t->>'amountReversedCents')::bigint)) on conflict(source_identity) do update set status='open',evidence=excluded.evidence;
 else update public.sales_team_financial_alerts_v1 set status='resolved' where source_identity='transfer-reversals:'||q.id::text;end if;
 update public.sales_team_receipts_v1 set observation_revision=observation_revision+1,observed_at=clock_timestamp(),review_hold=review_hold or overrun or unobserved where id=q.receipt_id;
 perform public.recompute_sales_team_balances_v1(q.sale_id,'transfer-reversal:'||op.id::text,jsonb_build_object('operationId',op.id,'balanceId',b->>'id','actualTransferReversalCostCents',fee_sum));
 update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;
 held:=creatornet_team_private.transfer_accounting_held_v1(q.id);
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_lease_token,p_context);
 return jsonb_build_object('operationId',op.id,'completed',true,'recorded',true,'held',held,'returnedPrincipalCents',amount,'actualTransferReversalCostCents',fee_sum);
end $$;
create function public.finish_sales_team_reversal_observation_run_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_failed boolean)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_settlement_runs_v1 run join public.sales_team_transfer_reversal_runs_v1 observed on observed.run_id=run.run_id where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context) then raise exception 'ORIGINAL_REVERSAL_OBSERVATION_RUN_REQUIRED';end if;
 update public.sales_team_worker_runs_v1 set status=case when p_failed is distinct from false or exists(select 1 from public.sales_team_transfer_reversal_checks_v1 checked
  where checked.worker_run_id=p_run_id and (not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=checked.operation_id) or creatornet_team_private.transfer_accounting_held_v1(checked.transfer_request_id))) then 'review_required' else 'complete' end,finished_at=clock_timestamp() where id=p_run_id and status='running';
end $$;
-- Observation runs may drain/read originals; they cannot acquire new money
-- authority through another public or older transfer/generic journal alias.
do $guards$ declare src text;needle text;begin
 src:=pg_get_functiondef('public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid)'::regprocedure);needle:='begin';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_RESERVATION_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||' if exists(select 1 from public.sales_team_transfer_reversal_runs_v1 where run_id=p_run_id) then raise exception ''REVERSAL_OBSERVATION_ONLY_RUN'';end if;');
 src:=pg_get_functiondef('public.sales_team_transfer_operation_admitted_v1(jsonb,jsonb)'::regprocedure);needle:='worker.kind=''settlement'' and worker.status=';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_TRANSFER_ADMISSION_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'not exists(select 1 from public.sales_team_transfer_reversal_runs_v1 where run_id=worker.id) and '||needle);
 src:=pg_get_functiondef('public.sales_team_operation_admitted_v1(jsonb,jsonb)'::regprocedure);needle:='select case when p_scope->>''kind''=''transfer''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_GENERIC_ADMISSION_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'select case when exists(select 1 from public.sales_team_transfer_reversal_runs_v1 where run_id::text=p_scope->>''workerRunId'') then false when p_scope->>''kind''=''transfer''');
 src:=pg_get_functiondef('creatornet_team_private.transfer_share_v1(uuid,text)'::regprocedure);needle:='code=''TRANSFER_COST_RESERVE_EXCEEDED''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_SHARE_HOLD_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'code in (''TRANSFER_COST_RESERVE_EXCEEDED'',''TRANSFER_REVERSAL_REVIEW_REQUIRED'')');
 src:=pg_get_functiondef('creatornet_team_private.transfer_accounting_held_v1(uuid)'::regprocedure);needle:='code=''TRANSFER_COST_RESERVE_EXCEEDED''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_ACCOUNTING_HOLD_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'code in (''TRANSFER_COST_RESERVE_EXCEEDED'',''TRANSFER_REVERSAL_REVIEW_REQUIRED'')');
end $guards$;
-- F29's symmetric owner locks also run inside the existing F25 consumer. An
-- expired worker cannot commit completion after any lock wait or late mutation.
do $transfer_lease$ declare src text;needle text;begin
 src:=pg_get_functiondef('public.complete_sales_team_transfer_check_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)'::regprocedure);
 needle:='perform pg_advisory_xact_lock(hashtextextended(''sales-team-financial:''||q.creator_id::text,0));';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_TRANSFER_LOCK_AUTHORITY_DIFFERS';end if;
 src:=replace(src,needle,needle||'perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);');
 needle:='return jsonb_build_object(''requestId'',q.id,''completed'',true,''recorded'',true';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_TRANSFER_FINAL_AUTHORITY_DIFFERS';end if;
 execute replace(src,needle,'perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);'||needle);
end $transfer_lease$;
do $digest$ declare src text;needle text;begin
 src:=pg_get_functiondef('creatornet_team_private.transfer_contract_digest_v1()'::regprocedure);needle:='''transfer_cost_total_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_PRIVATE_DIGEST_DIFFERS';end if;
 src:=replace(src,needle,needle||',''transfer_cost_before_reversals_v1'',''transfer_reversal_operation_id_v1'',''transfer_reversal_worker_v1'',''transfer_reversal_original_v1'',''guard_reversal_balance_owner_v1''');needle:='''sales_team_transfer_operation_id_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_PUBLIC_DIGEST_DIFFERS';end if;
 execute replace(src,needle,needle||',''claim_sales_team_reversal_observation_run_v1'',''begin_sales_team_reversal_check_v1'',''complete_sales_team_reversal_check_v1'',''finish_sales_team_reversal_observation_run_v1''');
end $digest$;
-- These existing contracts now execute the named owner trigger or the extended
-- cost reader. Review their actual dependency definitions, including the saved
-- F25 cost body, rather than relying on a transitive function name alone.
do $dependent_digests$ declare item record;src text;begin
 for item in select * from (values
  ('creatornet_team_private.shared_cash_contract_digest_v1()','''cash_encumbered_v1''',',''guard_reversal_balance_owner_v1'',''transfer_cost_total_v1'',''transfer_cost_before_reversals_v1'''),
  ('creatornet_team_private.retained_cash_contract_digest_v1()','''transfer_cost_total_v1''',',''guard_reversal_balance_owner_v1'',''transfer_cost_before_reversals_v1'''),
  ('creatornet_team_private.recovery_contract_digest_v1()','''shared_cash_trace_v1''',',''guard_reversal_balance_owner_v1'',''transfer_cost_total_v1'',''transfer_cost_before_reversals_v1''')
 ) definitions(signature,needle,extra) loop
  src:=pg_get_functiondef(item.signature::regprocedure);
  if (length(src)-length(replace(src,item.needle,'')))/length(item.needle)<>1 then raise exception 'REVERSAL_NAMED_DEPENDENT_DIGEST_DIFFERS: %',item.signature;end if;
  execute replace(src,item.needle,item.needle||item.extra);
 end loop;
end $dependent_digests$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_transfer_reversal_runs_v1','sales_team_transfer_reversal_checks_v1','sales_team_transfer_reversal_completions_v1','sales_team_transfer_reversal_costs_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_transfer_reversal_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('claim_sales_team_reversal_observation_run_v1','begin_sales_team_reversal_check_v1','complete_sales_team_reversal_check_v1','finish_sales_team_reversal_observation_run_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('transfer_cost_total_v1','transfer_cost_before_reversals_v1','transfer_reversal_operation_id_v1','transfer_reversal_worker_v1','transfer_reversal_original_v1','guard_reversal_balance_owner_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
