-- Local candidate. Observe admitted original transfers; no provider dispatcher.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column transfer_observations_enabled boolean not null default false;
alter table public.sales_team_creator_balances_v1 add column actual_transfer_cost_cents bigint not null default 0 check(actual_transfer_cost_cents>=0);
alter table public.payment_fee_ledger add column team_transfer_cost_cents bigint not null default 0 check(team_transfer_cost_cents>=0),
 add constraint sales_team_transfer_cost_exclusive_v1 check(sales_team_receipt_id is not null or team_transfer_cost_cents=0);
-- Add the independently observed fee to the exact existing team sum. All other
-- expressions, including the legacy branch, remain byte-for-byte source data.
do $split$ declare expr text;needle text:='((platform_fee_cents + processing_fee_cents) + team_commission_cents)';begin
 select pg_get_expr(conbin,conrelid) into expr from pg_constraint where conrelid='public.payment_fee_ledger'::regclass and conname='payment_fee_ledger_split_check';
 if expr is null or (length(expr)-length(replace(expr,needle,'')))/length(needle)<>1 or
  strpos(expr,'sales_team_receipt_id IS NULL')=0 or strpos(expr,'sales_team_receipt_id IS NOT NULL')=0 or strpos(expr,'team_transfer_cost_cents')>0 then raise exception 'TRANSFER_SHARED_SPLIT_DEPENDENCY_DIFFERS';end if;
 alter table public.payment_fee_ledger drop constraint payment_fee_ledger_split_check;
 execute 'alter table public.payment_fee_ledger add constraint payment_fee_ledger_split_check check('||replace(expr,needle,'('||needle||' + team_transfer_cost_cents)')||')';
end $split$;
create table public.sales_team_transfer_checks_v1 (
 id uuid primary key,task_id uuid not null references public.sales_team_settlement_tasks_v1(id) on delete restrict,
 request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 context jsonb not null,receipt_revision integer not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_recovery_proofs_v1 (
 request_id uuid primary key references public.sales_team_transfer_requests_v1(id) on delete restrict,
 check_id uuid not null references public.sales_team_transfer_checks_v1(id) on delete restrict,
 transfer_id text not null unique,original_request_id text not null,proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_costs_v1 (
 request_id uuid primary key references public.sales_team_transfer_completions_v1(request_id) on delete restrict,
 receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 balance_id text not null unique,fee_cents bigint not null check(fee_cents between 0 and 99999999),created_at timestamptz not null default clock_timestamp()
);
create function creatornet_team_private.transfer_cost_total_v1(p_receipt_id uuid)
returns bigint language sql stable security invoker set search_path=pg_catalog as $$
 select coalesce(sum(cost.fee_cents),0)::bigint from public.sales_team_transfer_costs_v1 cost join public.sales_team_transfer_requests_v1 q on q.id=cost.request_id
 join public.sales_team_sale_agreements_v1 a on a.id=q.sale_id and a.creator_id=cost.creator_id where cost.receipt_id=p_receipt_id and q.receipt_id=p_receipt_id and q.creator_id=cost.creator_id
$$;
-- Exact guarded edits retain cumulative commission, refund responsibility and
-- legacy accounting. Transfer costs stay separate from charge processing fees.
do $arithmetic$ declare src text;change record;begin
 src:=replace(pg_get_functiondef('public.recompute_sales_team_balances_before_shared_v1(uuid,text,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
 for change in select * from (values
  ('v_aux bigint;v_creator bigint;','v_transfer bigint;v_aux bigint;v_creator bigint;',1),
  ('v_aux:=v_receipt.financial_adjustment_cost_cents;','v_transfer:=creatornet_team_private.transfer_cost_total_v1(v_receipt.id);v_aux:=v_receipt.financial_adjustment_cost_cents;',1),
  ('v_net-v_platform-v_commission-v_cost-v_aux+v_credit','v_net-v_platform-v_commission-v_cost-v_aux-v_transfer+v_credit',1),
  ('v_platform+v_commission+v_cost+v_aux-v_credit','v_platform+v_commission+v_cost+v_aux+v_transfer-v_credit',1),
  ($o$'processing_cost',v_cost+v_aux,$o$,$n$'payout_cost',v_transfer,'processing_cost',v_cost+v_aux,$n$,1),
  ($o$'processing_cost',coalesce(v_old.actual_processing_cost_cents,0)$o$,$n$'payout_cost',coalesce(v_old.actual_transfer_cost_cents,0),'processing_cost',coalesce(v_old.actual_processing_cost_cents,0)$n$,1),
  ('payout_cost_reserve_cents,actual_processing_cost_cents,actual_financial_adjustment_cost_cents,','payout_cost_reserve_cents,actual_transfer_cost_cents,actual_processing_cost_cents,actual_financial_adjustment_cost_cents,',1),
  ('v_payout_reserve,v_cost,v_aux,','v_payout_reserve,v_transfer,v_cost,v_aux,',1),
  ('actual_processing_cost_cents=excluded.actual_processing_cost_cents,','actual_transfer_cost_cents=excluded.actual_transfer_cost_cents,actual_processing_cost_cents=excluded.actual_processing_cost_cents,',1)
 ) t(needle,replacement,expected) loop
  if (length(src)-length(replace(src,change.needle,'')))/length(change.needle)<>change.expected then raise exception 'TRANSFER_ACCOUNTING_DEPENDENCY_DIFFERS: %',change.needle;end if;
  src:=replace(src,change.needle,change.replacement);
 end loop;execute src;
 src:=replace(pg_get_functiondef('public.sync_sales_team_shared_accounting_v1(uuid)'::regprocedure),chr(13)||chr(10),chr(10));
 for change in select * from (values
  ('c.actual_processing_cost_cents,c.actual_financial_adjustment_cost_cents,','c.actual_transfer_cost_cents,c.actual_processing_cost_cents,c.actual_financial_adjustment_cost_cents,',1),
  ('deduction:=s.platform_revenue_cents+','deduction:=s.actual_transfer_cost_cents+s.platform_revenue_cents+',1),
  ('team_financial_adjustment_cost_cents=s.actual_financial_adjustment_cost_cents,','team_transfer_cost_cents=s.actual_transfer_cost_cents,team_financial_adjustment_cost_cents=s.actual_financial_adjustment_cost_cents,',1)
 ) t(needle,replacement,expected) loop
  if (length(src)-length(replace(src,change.needle,'')))/length(change.needle)<>change.expected then raise exception 'TRANSFER_SHARED_ACCOUNTING_DEPENDENCY_DIFFERS: %',change.needle;end if;
  src:=replace(src,change.needle,change.replacement);
 end loop;execute src;
 src:=replace(pg_get_functiondef('public.fulfill_sales_team_receipt_v1(uuid,uuid,uuid)'::regprocedure),chr(13)||chr(10),chr(10));
 for change in select * from (values
  ('deduction:=c.platform_revenue_cents+','deduction:=c.actual_transfer_cost_cents+c.platform_revenue_cents+',1),
  ('team_creator_deficit_cents,team_financial_adjustment_cost_cents,team_financial_hold)','team_creator_deficit_cents,team_financial_adjustment_cost_cents,team_transfer_cost_cents,team_financial_hold)',1),
  ('c.creator_deficit_cents,c.actual_financial_adjustment_cost_cents,r.review_hold','c.creator_deficit_cents,c.actual_financial_adjustment_cost_cents,c.actual_transfer_cost_cents,r.review_hold',1)
 ) t(needle,replacement,expected) loop
  if (length(src)-length(replace(src,change.needle,'')))/length(change.needle)<>change.expected then raise exception 'TRANSFER_FULFILLMENT_ACCOUNTING_DEPENDENCY_DIFFERS: %',change.needle;end if;
  src:=replace(src,change.needle,change.replacement);
 end loop;execute src;
 src:=pg_get_functiondef('public.read_sales_team_statement_v1(uuid,uuid,uuid,integer)'::regprocedure);
 if strpos(src,$n$'actualProcessingCostCents',b.actual_processing_cost_cents,$n$)=0 then raise exception 'TRANSFER_STATEMENT_DEPENDENCY_DIFFERS';end if;
 execute replace(src,$n$'actualProcessingCostCents',b.actual_processing_cost_cents,$n$,$n$'actualTransferCostCents',b.actual_transfer_cost_cents,'actualProcessingCostCents',b.actual_processing_cost_cents,$n$);
end $arithmetic$;
create function public.claim_sales_team_transfer_observation_run_v1(p_run_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare slot timestamptz;run public.sales_team_settlement_runs_v1;digest text;begin
 if p_run_id is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'SETTLEMENT_CONTEXT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-settlement-v1',0));
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_observations_enabled) then return jsonb_build_object('status','held');end if;
 if not exists(select 1 from public.sales_team_transfer_requests_v1 q join public.sales_team_provider_operations_v1 op on op.id=q.operation_id where q.context=p_context and
  not exists(select 1 from public.sales_team_transfer_completions_v1 done where done.request_id=q.id) and (op.status<>'dispatching' or op.lease_until<=clock_timestamp())) then return jsonb_build_object('status','idle');end if;
 digest:=creatornet_team_private.transfer_contract_digest_v1();
 if not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and transfer_contract_sha256=digest) then raise exception 'TRANSFER_CONTRACT_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.sales_team_settlement_runs_v1 r join public.sales_team_worker_runs_v1 w on w.id=r.run_id where w.status='running' and w.lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 slot:=date_bin(interval '15 minutes',clock_timestamp(),'2000-01-01'::timestamptz);
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='settlement' and scheduled_slot=slot) then return jsonb_build_object('status','slot_consumed');end if;
 insert into public.sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values(p_run_id,'settlement',slot,clock_timestamp()+interval '90 seconds','running');
 insert into public.sales_team_settlement_runs_v1(run_id,context,contract_sha256) values(p_run_id,p_context,digest) returning * into run;
 return jsonb_build_object('status','claimed','runId',run.run_id,'leaseToken',run.lease_token);
end $$;
create function public.begin_sales_team_transfer_check_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_request_id uuid,p_check_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;op public.sales_team_provider_operations_v1;c public.sales_team_transfer_checks_v1;revision integer;begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 if p_task_id is null or p_check_id is null or not exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_observations_enabled) then raise exception 'TRANSFER_OBSERVATION_HELD';end if;
 select * into q from public.sales_team_transfer_requests_v1 where id=p_request_id and context=p_context;select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id;
 if q.id is null or op.id is null or op.kind<>'transfer' or op.context is distinct from p_context or op.request is distinct from q.request or
  public.sales_team_operation_json_v1(op.id)->'workerRunId' is distinct from to_jsonb(q.original_worker_run_id) or
  exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id) or op.status='dispatching' and op.lease_until>clock_timestamp() then raise exception 'ADMITTED_ORIGINAL_TRANSFER_REQUIRED';end if;
 if (select count(*) from public.sales_team_settlement_tasks_v1 where run_id=p_run_id)>=3 and not exists(select 1 from public.sales_team_settlement_tasks_v1 where id=p_task_id and run_id=p_run_id and request_id=q.id) then raise exception 'SETTLEMENT_TASK_LIMIT_REQUIRED';end if;
 insert into public.sales_team_settlement_tasks_v1(id,run_id,request_id) values(p_task_id,p_run_id,q.id) on conflict(run_id,request_id) do nothing;
 if not exists(select 1 from public.sales_team_settlement_tasks_v1 where id=p_task_id and run_id=p_run_id and request_id=q.id) then raise exception 'ORIGINAL_SETTLEMENT_TASK_CHANGED';end if;
 select observation_revision into revision from public.sales_team_receipts_v1 where id=q.receipt_id;
 select * into c from public.sales_team_transfer_checks_v1 where id=p_check_id;
 if c.id is not null and (c.task_id<>p_task_id or c.worker_run_id<>p_run_id or c.request_id<>q.id or c.context is distinct from p_context) then raise exception 'ORIGINAL_TRANSFER_CHECK_CHANGED';end if;
 if c.id is null then insert into public.sales_team_transfer_checks_v1(id,task_id,request_id,worker_run_id,context,receipt_revision) values(p_check_id,p_task_id,q.id,p_run_id,p_context,revision);end if;
 return jsonb_build_object('checkId',p_check_id,'completed',exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id),'request',public.sales_team_transfer_request_json_v1(q.id));
end $$;
-- Narrow definer owns completion/cost/recovery inserts. Service retains SELECT
-- only on those immutable facts and cannot fabricate a completed transfer.
create function public.complete_sales_team_transfer_check_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_check_id uuid,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c public.sales_team_transfer_checks_v1;q public.sales_team_transfer_requests_v1;op public.sales_team_provider_operations_v1;r public.sales_team_receipts_v1;
 t jsonb:=p_proof->'transfer';b jsonb:=p_proof->'balance';recovery jsonb:=p_proof->'recovery';fee jsonb;fee_sum bigint:=0;req text;seen text[]:='{}';reserved bigint;begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into c from public.sales_team_transfer_checks_v1 where id=p_check_id and worker_run_id=p_run_id and task_id=p_task_id and context=p_context;
 select * into q from public.sales_team_transfer_requests_v1 where id=c.request_id and context=p_context;
 if c.id is null or q.id is null or not exists(select 1 from public.sales_team_settlement_tasks_v1 where id=p_task_id and run_id=p_run_id and request_id=q.id) or
  not exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_observations_enabled) then raise exception 'CURRENT_TRANSFER_CHECK_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 if exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id) then return jsonb_build_object('requestId',q.id,'completed',true,'recorded',false);end if;
 select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id for update;select * into r from public.sales_team_receipts_v1 where id=q.receipt_id for update;
 select cost_reserve_cents into reserved from public.sales_team_transfer_cash_reservations_v1 where request_id=q.id;
 if op.id is null or op.kind<>'transfer' or op.context is distinct from p_context or op.request is distinct from q.request or op.worker_run_id is distinct from q.original_worker_run_id or
  op.scope_id<>q.id or op.scope_key<>'settlement:v1' or op.sale_id is distinct from q.sale_id or op.creator_id is distinct from q.creator_id or op.actor_id is not null or
  op.idempotency_key is distinct from 'cn-team-v1:'||q.operation_id::text or r.observation_revision<>c.receipt_revision or reserved is null or
  exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id) or op.status='dispatching' and op.lease_until>clock_timestamp() or
  not exists(select 1 from public.sales_team_creator_balances_v1 owned join public.sales_team_commission_balances_v1 commission using(receipt_id) join public.sales_team_sale_agreements_v1 agreement on agreement.id=q.sale_id
   where owned.receipt_id=q.receipt_id and owned.creator_id=q.creator_id and owned.sale_id=q.sale_id and commission.creator_id=q.creator_id and commission.sale_id=q.sale_id and commission.membership_id=agreement.membership_id and agreement.creator_id=q.creator_id) then raise exception 'CURRENT_ORIGINAL_TRANSFER_REQUIRED';end if;
 perform creatornet_team_private.financial_shape_v1(p_proof-'recovery','{"requestId":"string","operationId":"string","receiptId":"string","saleId":"string","creatorId":"string","beneficiary":"string","context":"object","transfer":"object","balance":"object","readStartedAt":"number","observedAt":"number","transferReadRequestIds":"array","balanceReadRequestIds":"array","originalRequestId":"string","idempotencyKey":"string"}');
 perform creatornet_team_private.financial_shape_v1(t,'{"id":"string","amountCents":"number","currency":"string","destinationId":"string","destinationPaymentId":"string","sourceChargeId":"string","sourceType":"string","transferGroup":"string","created":"number","livemode":"boolean","balanceId":"string","amountReversedCents":"number","reversed":"boolean","metadata":"object"}');
 perform creatornet_team_private.financial_shape_v1(b,'{"id":"string","sourceId":"string","amountCents":"number","feeCents":"number","netCents":"number","currency":"string","balanceType":"string","type":"string","reportingCategory":"string","created":"number","availableOn":"number","status":"string","feeDetails":"array"}');
 if p_proof->>'requestId'<>q.id::text or p_proof->>'operationId'<>q.operation_id::text or p_proof->>'receiptId'<>q.receipt_id::text or p_proof->>'saleId'<>q.sale_id::text or p_proof->>'creatorId'<>q.creator_id::text or p_proof->>'beneficiary'<>q.beneficiary or
  p_proof->'context' is distinct from p_context or p_proof->>'idempotencyKey' is distinct from op.idempotency_key or p_proof->>'originalRequestId'!~'^req_[A-Za-z0-9]+$' or
  (p_proof->>'readStartedAt')::numeric not between greatest(extract(epoch from c.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-25000) and extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'observedAt')::numeric not between floor((p_proof->>'readStartedAt')::numeric/1000) and extract(epoch from clock_timestamp())+5 or
  jsonb_array_length(p_proof->'transferReadRequestIds')<>2 or jsonb_array_length(p_proof->'balanceReadRequestIds')<>2 then raise exception 'FRESH_ORIGINAL_TRANSFER_PROOF_REQUIRED';end if;
 for req in select jsonb_array_elements_text((p_proof->'transferReadRequestIds')||(p_proof->'balanceReadRequestIds')) loop
  if req!~'^req_[A-Za-z0-9]+$' or req=any(seen) then raise exception 'DISTINCT_TRANSFER_READS_REQUIRED';end if;seen:=array_append(seen,req);
 end loop;
 if t->>'id'!~'^tr_[A-Za-z0-9]+$' or (t->>'amountCents')::bigint<>q.amount_cents or t->>'currency'<>'usd' or t->>'destinationId'<>q.destination_id or
  t->>'destinationPaymentId'!~'^(py|ch)_[A-Za-z0-9]+$' or t->>'sourceChargeId' is distinct from q.request->'params'->>'source_transaction' or t->>'sourceChargeId' is distinct from r.charge_id or
  t->>'sourceType'<>'card' or t->>'transferGroup' is distinct from q.request->'params'->>'transfer_group' or t->'metadata' is distinct from q.request->'params'->'metadata' or
  t->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or t->>'balanceId'!~'^txn_[A-Za-z0-9]+$' or t->'reversed'<>'false'::jsonb or (t->>'amountReversedCents')::bigint<>0 or
  (t->>'created')::numeric not between extract(epoch from op.first_dispatch_at)-5 and extract(epoch from clock_timestamp())+5 then raise exception 'EXACT_ORIGINAL_TRANSFER_REQUIRED';end if;
 if b->>'id' is distinct from t->>'balanceId' or b->>'sourceId' is distinct from t->>'id' or b->>'currency'<>'usd' or b->>'balanceType'<>'payments' or b->>'type'<>'transfer' or b->>'reportingCategory'<>'transfer' or
  (b->>'amountCents')::bigint<>-q.amount_cents or (b->>'feeCents')::bigint not between 0 and 99999999 or (b->>'netCents')::numeric<>(b->>'amountCents')::numeric-(b->>'feeCents')::numeric or
  (b->>'created')::numeric not between (t->>'created')::numeric-5 and extract(epoch from clock_timestamp())+5 or (b->>'availableOn')::numeric not between 1 and extract(epoch from clock_timestamp()) or b->>'status'<>'available' or jsonb_array_length(b->'feeDetails')>32 then raise exception 'EXACT_TRANSFER_DEBIT_REQUIRED';end if;
 for fee in select value from jsonb_array_elements(b->'feeDetails') loop
  perform creatornet_team_private.financial_shape_v1(fee,'{"amount":"number","currency":"string","application":"null","type":"string"}');
  if (fee->>'amount')::bigint not between 0 and 99999999 or fee->>'currency'<>'usd' or fee->>'type' not in ('stripe_fee','tax','payment_method_passthrough_fee') then raise exception 'ACTUAL_TRANSFER_FEES_REQUIRED';end if;
  fee_sum:=fee_sum+(fee->>'amount')::bigint;
 end loop;
 if fee_sum<>(b->>'feeCents')::bigint then raise exception 'ACTUAL_TRANSFER_FEES_REQUIRED';end if;
 if op.provider_id is null then
  perform creatornet_team_private.financial_shape_v1(recovery,'{"eventId":"string","eventType":"string","eventCreated":"number","livemode":"boolean","account":"null","eventReadRequestId":"string","readStartedAt":"number"}');
  if recovery->>'eventId'!~'^evt_[A-Za-z0-9]+$' or recovery->>'eventType'<>'transfer.created' or recovery->'livemode' is distinct from t->'livemode' or recovery->>'eventReadRequestId'!~'^req_[A-Za-z0-9]+$' or recovery->>'eventReadRequestId'=any(seen) or
   (recovery->>'eventCreated')::numeric not between extract(epoch from op.first_dispatch_at)-5 and extract(epoch from clock_timestamp())+5 or
   (recovery->>'readStartedAt')::numeric not between greatest(extract(epoch from c.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-45000) and (p_proof->>'readStartedAt')::numeric then raise exception 'ORIGINAL_TRANSFER_EVENT_REQUIRED';end if;
  insert into public.sales_team_transfer_recovery_proofs_v1(request_id,check_id,transfer_id,original_request_id,proof) values(q.id,c.id,t->>'id',p_proof->>'originalRequestId',p_proof);
  perform public.bind_sales_team_provider_operation_v1(op.id,t->>'id',p_proof->>'originalRequestId',true);
 elsif op.status<>'bound' or op.provider_id is distinct from t->>'id' or op.provider_request_id is distinct from p_proof->>'originalRequestId' or p_proof?'recovery' then raise exception 'ORIGINAL_TRANSFER_BINDING_CHANGED';end if;
 if exists(select 1 from public.sales_team_transfer_completions_v1 where transfer_id=t->>'id' or balance_id=b->>'id') or exists(select 1 from public.sales_team_financial_balance_entries_v1 where transaction_id=b->>'id') then raise exception 'ORIGINAL_TRANSFER_BALANCE_ALREADY_OWNED';end if;
 insert into public.sales_team_transfer_completions_v1(request_id,transfer_id,balance_id,worker_run_id,proof) values(q.id,t->>'id',b->>'id',p_run_id,p_proof);
 insert into public.sales_team_transfer_costs_v1(request_id,receipt_id,creator_id,balance_id,fee_cents) values(q.id,q.receipt_id,q.creator_id,b->>'id',fee_sum);
 if q.beneficiary='creator' then update public.sales_team_creator_balances_v1 set creator_released_cents=creator_released_cents+q.amount_cents where receipt_id=q.receipt_id and creator_id=q.creator_id and sale_id=q.sale_id;
 else update public.sales_team_commission_balances_v1 set released_cents=released_cents+q.amount_cents where receipt_id=q.receipt_id and creator_id=q.creator_id and sale_id=q.sale_id and membership_id=(select membership_id from public.sales_team_sale_agreements_v1 where id=q.sale_id);end if;
 if not found then raise exception 'OWNED_TRANSFER_BALANCE_REQUIRED';end if;
 insert into public.sales_team_financial_ledger_v1(creator_id,sale_id,membership_id,receipt_id,entry_kind,amount_cents,source_identity,evidence)
 values(q.creator_id,q.sale_id,case when q.beneficiary='closer' then (select membership_id from public.sales_team_sale_agreements_v1 where id=q.sale_id) end,q.receipt_id,'transfer',q.amount_cents,'transfer:'||q.id::text,jsonb_build_object('requestId',q.id,'transferId',t->>'id','beneficiary',q.beneficiary,'workerRunId',p_run_id));
 if fee_sum>reserved then
  insert into public.sales_team_financial_alerts_v1(creator_id,sale_id,operation_id,code,source_identity,evidence) values(q.creator_id,q.sale_id,q.operation_id,'TRANSFER_COST_RESERVE_EXCEEDED','transfer-cost:'||q.id::text,jsonb_build_object('actualCostCents',fee_sum,'reservedCostCents',reserved)) on conflict(source_identity) do nothing;
 end if;
 update public.sales_team_receipts_v1 set observation_revision=observation_revision+1,observed_at=clock_timestamp(),review_hold=review_hold or fee_sum>reserved where id=q.receipt_id;
 perform public.recompute_sales_team_balances_v1(q.sale_id,'transfer-cost:'||q.id::text,jsonb_build_object('requestId',q.id,'balanceId',b->>'id','actualTransferCostCents',fee_sum));
 update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;
 return jsonb_build_object('requestId',q.id,'completed',true,'recorded',true,'transferId',t->>'id','actualTransferCostCents',fee_sum,'held',fee_sum>reserved or r.review_hold or r.dispute_hold or
  exists(select 1 from public.sales_team_creator_balances_v1 debt where debt.creator_id=q.creator_id and (debt.creator_deficit_cents>0 or debt.creator_released_cents-debt.creator_reversed_cents>debt.creator_proceeds_cents)) or
  exists(select 1 from public.sales_team_commission_balances_v1 debt where debt.creator_id=q.creator_id and debt.released_cents-debt.reversed_cents>debt.earned_cents));
end $$;
-- A reconciled unknown transfer binding requires the exact proof recorded by the
-- narrow consumer above, in the same transaction. No metadata-only adoption.
alter function public.bind_sales_team_provider_operation_v1(uuid,text,text,boolean) rename to bind_sales_team_operation_before_transfer_proof_v1;
create function public.bind_sales_team_provider_operation_v1(p_operation_id uuid,p_provider_id text,p_provider_request_id text,p_reconciled boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_reconciled and exists(select 1 from public.sales_team_provider_operations_v1 where id=p_operation_id and kind='transfer' and provider_id is null) and
  not exists(select 1 from public.sales_team_transfer_recovery_proofs_v1 proof join public.sales_team_transfer_requests_v1 q on q.id=proof.request_id where q.operation_id=p_operation_id and proof.transfer_id=p_provider_id and proof.original_request_id=p_provider_request_id) then raise exception 'ORIGINAL_TRANSFER_EVENT_REQUIRED';end if;
 return public.bind_sales_team_operation_before_transfer_proof_v1(p_operation_id,p_provider_id,p_provider_request_id,p_reconciled);
end $$;
do $contracts$ declare src text;needle text;begin
 src:=pg_get_functiondef('creatornet_team_private.transfer_contract_digest_v1()'::regprocedure);needle:='''transfer_share_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_OBSERVATION_DIGEST_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,needle||',''transfer_cost_total_v1''');needle:='''sales_team_transfer_operation_id_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_OBSERVATION_DIGEST_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||',''claim_sales_team_transfer_observation_run_v1'',''begin_sales_team_transfer_check_v1'',''complete_sales_team_transfer_check_v1'',''bind_sales_team_operation_before_transfer_proof_v1'',''recompute_sales_team_balances_before_shared_v1'',''recompute_sales_team_balances_v1'',''sync_sales_team_shared_accounting_v1'',''fulfill_sales_team_receipt_v1''');
 src:=pg_get_functiondef('creatornet_team_private.retained_cash_contract_digest_v1()'::regprocedure);needle:='''cash_encumbered_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_COST_RETAINED_DIGEST_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,needle||',''transfer_cost_total_v1''');needle:='''recompute_sales_team_balances_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_COST_RETAINED_ARITHMETIC_DIFFERS';end if;
 execute replace(src,needle,needle||',''recompute_sales_team_balances_before_shared_v1'',''sync_sales_team_shared_accounting_v1''');
 src:=pg_get_functiondef('creatornet_team_private.transfer_share_v1(uuid,text)'::regprocedure);needle:='if a.id is null or';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_ALERT_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'if exists(select 1 from public.sales_team_financial_alerts_v1 where creator_id=a.creator_id and code=''TRANSFER_COST_RESERVE_EXCEEDED'' and status<>''resolved'') then return null;end if;'||needle);
end $contracts$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_transfer_checks_v1','sales_team_transfer_recovery_proofs_v1','sales_team_transfer_costs_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  if name='sales_team_transfer_checks_v1' then execute format('grant insert on public.%I to service_role',name);end if;
  execute format('create trigger immutable_transfer_observation_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('claim_sales_team_transfer_observation_run_v1','begin_sales_team_transfer_check_v1','complete_sales_team_transfer_check_v1','bind_sales_team_provider_operation_v1','bind_sales_team_operation_before_transfer_proof_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname='transfer_cost_total_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
revoke all on function public.bind_sales_team_operation_before_transfer_proof_v1(uuid,text,text,boolean) from service_role;
commit;
