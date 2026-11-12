-- Local candidate. Independently read financial costs and audited reviews.
-- Every external operation in the companion runtime is GET-only.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column financial_reconciliation_enabled boolean not null default false,
 add column refund_review_enabled boolean not null default false;
alter table public.sales_team_receipts_v1 add column financial_adjustment_cost_cents bigint not null default 0,
 add column financial_processing_credit_cents bigint not null default 0 check(financial_processing_credit_cents>=0),
 add constraint sales_team_actual_financial_cost_v1 check(coalesce(processing_cost_cents,0)+financial_adjustment_cost_cents>=0);
alter table public.sales_team_creator_balances_v1 add column actual_financial_adjustment_cost_cents bigint not null default 0;
alter table public.payment_fee_ledger add column team_financial_adjustment_cost_cents bigint not null default 0,
 add constraint sales_team_financial_cost_exclusive_v1 check(sales_team_receipt_id is not null or team_financial_adjustment_cost_cents=0);
comment on column public.sales_team_receipts_v1.financial_adjustment_cost_cents is 'Net actual refund/dispute fees and fee credits from unique independently bound balance transactions. Original charge processing fee stays immutable.';
create table public.sales_team_financial_checks_v1 (
 id uuid primary key,
 receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 context jsonb not null,
 actor_id uuid references public.profiles(id) on delete restrict,
 event_id text references public.sales_team_payment_events_v1(event_id) on delete restrict,
 worker_run_id uuid references public.sales_team_worker_runs_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 check(num_nonnulls(actor_id,event_id,worker_run_id)=1)
);
create table public.sales_team_financial_check_requests_v1 (
 request_id uuid primary key,
 check_id uuid not null references public.sales_team_financial_checks_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_financial_check_results_v1 (
 check_id uuid primary key references public.sales_team_financial_checks_v1(id) on delete restrict,
 proof jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_financial_balance_entries_v1 (
 transaction_id text primary key check(transaction_id~'^txn_[A-Za-z0-9]+$'),
 receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 identity jsonb not null,
 check_id uuid not null references public.sales_team_financial_checks_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create index sales_team_financial_check_receipt_v1 on public.sales_team_financial_checks_v1(receipt_id,created_at);
-- Exact required shapes prevent JSON null/missing fields or fractional cents
-- from bypassing SQL three-valued comparisons. Never retain raw provider PII.
create function creatornet_team_private.financial_shape_v1(v jsonb,shape jsonb)
returns void language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare k text;t text;begin
 if jsonb_typeof(v) is distinct from 'object' or (select count(*) from jsonb_object_keys(v))<>(select count(*) from jsonb_object_keys(shape)) then raise exception 'FINANCIAL_PROOF_SHAPE_REQUIRED';end if;
 for k,t in select key,value#>>'{}' from jsonb_each(shape) loop
  if not v?k or not coalesce(jsonb_typeof(v->k)=any(string_to_array(t,'|')),false) then raise exception 'FINANCIAL_PROOF_SHAPE_REQUIRED: %',k;end if;
  if jsonb_typeof(v->k)='number' and ((v->>k)::numeric<>trunc((v->>k)::numeric) or abs((v->>k)::numeric)>9007199254740991) then raise exception 'FINANCIAL_INTEGER_REQUIRED: %',k;end if;
 end loop;
end $$;
create function creatornet_team_private.financial_processing_share_v1(gross bigint,cost bigint,refunded bigint)
returns bigint language sql immutable security invoker set search_path=pg_catalog as $$
 select case when cost+floor((gross::numeric*1200+5000)/10000)::bigint=0 then 0 else
 floor((cost::numeric*floor(((cost+floor((gross::numeric*1200+5000)/10000)::bigint)::numeric*refunded+gross/2)/gross)+(cost+floor((gross::numeric*1200+5000)/10000)::bigint)/2)/(cost+floor((gross::numeric*1200+5000)/10000)::bigint))::bigint end
$$;
-- These are private service operations, but persisted admin/worker authority is
-- still checked in the database. An event check must follow its real signed row.
create function public.begin_sales_team_financial_check_v1(p_check_id uuid,p_receipt_id uuid,p_actor_id uuid,p_event_id text,p_worker_run_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;c public.sales_team_financial_checks_v1;begin
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;select * into a from public.sales_team_sale_agreements_v1 where id=r.sale_id;
 if p_check_id is null or a.id is null or p_context is distinct from a.context or num_nonnulls(p_actor_id,p_event_id,p_worker_run_id)<>1 or
  p_actor_id is not null and not exists(select 1 from public.profiles where id=p_actor_id and role='admin') or
  p_event_id is not null and not exists(select 1 from public.sales_team_payment_event_results_v1 e where e.event_id=p_event_id and e.receipt_id=r.id) or
  p_worker_run_id is not null and not exists(select 1 from public.sales_team_worker_runs_v1 where id=p_worker_run_id and kind='reconciliation' and status='running' and lease_until>clock_timestamp()) or
  not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'FINANCIAL_CHECK_AUTHORITY_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into c from public.sales_team_financial_checks_v1 where id=coalesce((select check_id from public.sales_team_financial_check_requests_v1 where request_id=p_check_id),p_check_id);
 if c.id is null then
  select pending.* into c from public.sales_team_financial_checks_v1 pending where pending.receipt_id=r.id and pending.actor_id is not distinct from p_actor_id and pending.event_id is not distinct from p_event_id and pending.worker_run_id is not distinct from p_worker_run_id and
   not exists(select 1 from public.sales_team_financial_check_results_v1 done where done.check_id=pending.id) order by pending.created_at,pending.id limit 1;
 end if;
 if c.id is not null then
  if c.receipt_id<>r.id or c.actor_id is distinct from p_actor_id or c.event_id is distinct from p_event_id or c.worker_run_id is distinct from p_worker_run_id or c.context is distinct from p_context then raise exception 'ORIGINAL_FINANCIAL_CHECK_CHANGED';end if;
 else
  if not exists(select 1 from public.sales_team_controls_v1 where singleton and financial_reconciliation_enabled) then raise exception 'TEAM_FINANCIAL_RECONCILIATION_HELD';end if;
  insert into public.sales_team_financial_checks_v1(id,receipt_id,context,actor_id,event_id,worker_run_id) values(p_check_id,r.id,p_context,p_actor_id,p_event_id,p_worker_run_id);
  select * into c from public.sales_team_financial_checks_v1 where id=p_check_id;
  update public.sales_team_receipts_v1 set review_hold=true,observation_revision=observation_revision+1 where id=r.id;
  perform public.recompute_sales_team_balances_v1(a.id,'pending-check:'||p_check_id::text,jsonb_build_object('checkId',p_check_id));
 end if;
 insert into public.sales_team_financial_check_requests_v1(request_id,check_id) values(p_check_id,c.id) on conflict(request_id) do nothing;
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;
 return jsonb_build_object('checkId',c.id,'revision',r.observation_revision,'held',r.review_hold or r.dispute_hold,'completed',exists(select 1 from public.sales_team_financial_check_results_v1 where check_id=c.id),'receiptId',r.id,
  'source',jsonb_build_object('saleId',a.id,'buyerId',a.buyer_id,'obligationId',r.obligation_id,'paymentIntentId',r.payment_intent_id,'context',a.context));
end $$;
-- Preserve the reviewed arithmetic and existing legacy ledger branches. Each
-- catalog edit names exact source fragments and refuses unknown definitions.
do $patch$ declare src text;change record;begin
 src:=replace(pg_get_functiondef('public.recompute_sales_team_balances_before_shared_v1(uuid,text,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
 for change in select * from (values
  ('v_creator bigint;v_deficit bigint;','v_aux bigint;v_creator bigint;v_deficit bigint;',1),
  ('v_credit:=v_receipt.platform_processing_credit_cents;','v_aux:=v_receipt.financial_adjustment_cost_cents;v_credit:=v_receipt.platform_processing_credit_cents+v_receipt.financial_processing_credit_cents;',1),
  ('v_net-v_platform-v_commission-v_cost+v_credit','v_net-v_platform-v_commission-v_cost-v_aux+v_credit',1),
  ('v_platform+v_commission+v_cost-v_credit','v_platform+v_commission+v_cost+v_aux-v_credit',1),
  ($o$'processing_cost',v_cost,$o$,$n$'processing_cost',v_cost+v_aux,$n$,1),
  ('coalesce(v_old.actual_processing_cost_cents,0)','coalesce(v_old.actual_processing_cost_cents,0)+coalesce(v_old.actual_financial_adjustment_cost_cents,0)',1),
  ('payout_cost_reserve_cents,actual_processing_cost_cents,platform_processing_credit_cents,creator_deficit_cents,tax_reserve_cents)',
   'payout_cost_reserve_cents,actual_processing_cost_cents,actual_financial_adjustment_cost_cents,platform_processing_credit_cents,creator_deficit_cents,tax_reserve_cents)',1),
  ('v_payout_reserve,v_cost,v_credit,v_deficit,v_receipt.tax_cents)','v_payout_reserve,v_cost,v_aux,v_credit,v_deficit,v_receipt.tax_cents)',1),
  ('actual_processing_cost_cents=excluded.actual_processing_cost_cents,','actual_processing_cost_cents=excluded.actual_processing_cost_cents,actual_financial_adjustment_cost_cents=excluded.actual_financial_adjustment_cost_cents,',1)
 ) t(needle,replacement,expected) loop
  if (length(src)-length(replace(src,change.needle,'')))/length(change.needle)<>change.expected then raise exception 'TEAM_FINANCIAL_ARITHMETIC_DEPENDENCY_DIFFERS: %',change.needle;end if;
  src:=replace(src,change.needle,change.replacement);
 end loop;execute src;
end $patch$;
create function public.complete_sales_team_financial_check_v1(p_check_id uuid,p_expected_revision integer,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.sales_team_financial_checks_v1;r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;
 cp jsonb:=p_snapshot->'capture'->'receipt';rb jsonb:=p_snapshot->'capture'->'readback';p jsonb:=p_snapshot->'proof';b jsonb:=p_snapshot->'balanceEvidence';e jsonb;own jsonb;f jsonb;old_identity jsonb;identity_value jsonb;
 fees bigint:=0;principal bigint:=0;fee_parts bigint;refs integer:=0;original_cost bigint;aux bigint;aux_credit bigint;complete boolean;pending boolean;result jsonb;k text;lower_bound numeric;net bigint;
 refunded bigint:=0;prior bigint:=0;base_credit bigint:=0;platform_aux bigint:=0;expected_original bigint;expected_aux bigint;decision public.sales_team_refund_reviews_v1;
begin
 select * into c from public.sales_team_financial_checks_v1 where id=p_check_id;select * into r from public.sales_team_receipts_v1 where id=c.receipt_id;
 select * into a from public.sales_team_sale_agreements_v1 where id=r.sale_id;
 if c.id is null or a.id is null or c.context is distinct from a.context or
  c.actor_id is not null and not exists(select 1 from public.profiles where id=c.actor_id and role='admin') or
  c.worker_run_id is not null and not exists(select 1 from public.sales_team_worker_runs_v1 where id=c.worker_run_id and kind='reconciliation' and status='running' and lease_until>clock_timestamp()) then raise exception 'FINANCIAL_CHECK_AUTHORITY_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into r from public.sales_team_receipts_v1 where id=c.receipt_id for update;
 if exists(select 1 from public.sales_team_financial_check_results_v1 where check_id=c.id) then return jsonb_build_object('receiptId',r.id,'held',r.review_hold or r.dispute_hold);end if;
 if r.observation_revision is distinct from p_expected_revision then raise exception 'FINANCIAL_OBSERVATION_STALE';end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and financial_reconciliation_enabled) then raise exception 'TEAM_FINANCIAL_RECONCILIATION_HELD';end if;
 perform creatornet_team_private.financial_shape_v1(p_snapshot,'{"capture":"object","proof":"object","refunds":"array","disputes":"array","readStartedAt":"number","balanceEvidence":"object"}');
 perform creatornet_team_private.financial_shape_v1(p_snapshot->'capture','{"receipt":"object","readback":"object"}');
 perform creatornet_team_private.financial_shape_v1(cp,'{"protocol":"string","context":"object","saleId":"string","obligationId":"string","currency":"string","paid":"boolean","captured":"boolean","paymentIntentId":"string","chargeId":"string","subtotalCents":"number","taxCents":"number","paidAt":"number","balanceTransactionId":"string|null","refundedCents":"number","disputed":"boolean","processingCostCents":"number|null","availableOn":"number|null","metadataHash":"string","providerRequestId":"string"}');
 perform creatornet_team_private.financial_shape_v1(rb,'{"intentRequestId":"string","chargeRequestId":"string","balanceRequestId":"string|null","readStartedAt":"number","observedAt":"number"}');
 perform creatornet_team_private.financial_shape_v1(p,'{"context":"object","chargeId":"string","paymentIntentId":"string","refundedCents":"number","totalLossCents":"number","disputeHold":"boolean","reviewHold":"boolean","platformFeeReturnedCents":"number","platformProcessingCostCreditCents":"number","alerts":"array","refundIds":"array","decisionIds":"array","providerEvidenceIds":"array","sourceEventId":"string|null","providerRequestIds":"array"}');
 perform creatornet_team_private.financial_shape_v1(b,'{"complete":"boolean","entries":"array","owners":"object","principalLossCents":"number","feeAdjustmentCents":"number","originalProcessingCreditCents":"number","financialProcessingCreditCents":"number","alerts":"array","refundListComplete":"boolean","disputeListComplete":"boolean"}');
 perform creatornet_team_private.financial_shape_v1(b->'owners','{"refunds":"array","disputes":"array"}');
 if exists(select 1 from jsonb_array_elements(p->'alerts'||b->'alerts') v where jsonb_typeof(v)<>'string' or (v#>>'{}')!~'^[A-Z][A-Z0-9_]{0,99}$') or
  exists(select 1 from jsonb_array_elements(p->'providerRequestIds') v where jsonb_typeof(v)<>'string' or (v#>>'{}')!~'^req_[A-Za-z0-9]+$') or
  p->'providerEvidenceIds' is distinct from (case when cp->>'balanceTransactionId' is null then '[]'::jsonb else jsonb_build_array(cp->>'balanceTransactionId') end)||coalesce((select jsonb_agg(v->'id' order by (v->>'id') collate "C") from jsonb_array_elements(b->'entries') v),'[]'::jsonb) then raise exception 'FINANCIAL_EVIDENCE_IDENTITIES_REQUIRED';end if;
 if p->>'sourceEventId' is distinct from c.event_id or (cp->>'paidAt')::bigint is distinct from extract(epoch from r.paid_at)::bigint or cp->>'taxCents' is distinct from r.tax_cents::text or
  cp->>'metadataHash' is distinct from r.proof->>'metadataHash' or (cp->>'refundedCents')::bigint not between r.refunded_subtotal_cents and r.subtotal_cents or
  (cp->>'availableOn')::bigint is distinct from extract(epoch from r.available_on)::bigint and r.processing_cost_cents is not null or
  jsonb_array_length(b->'entries')>32 or jsonb_array_length(p_snapshot->'refunds')>300 or jsonb_array_length(p_snapshot->'disputes')>300 then raise exception 'ORIGINAL_FINANCIAL_CAPTURE_REQUIRED';end if;
 lower_bound:=extract(epoch from case when c.event_id is null then c.created_at else (select created_at from public.sales_team_payment_events_v1 where event_id=c.event_id) end)*1000-1000;
 if jsonb_typeof(cp) is distinct from 'object' or jsonb_typeof(rb) is distinct from 'object' or jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(b) is distinct from 'object' or
  cp->'context' is distinct from c.context or cp->>'saleId' is distinct from a.id::text or cp->>'obligationId' is distinct from r.obligation_id::text or cp->>'paymentIntentId' is distinct from r.payment_intent_id or cp->>'chargeId' is distinct from r.charge_id or
  cp->>'protocol' is distinct from 'creatornet-team-distribution-v1' or cp->>'currency' is distinct from 'usd' or cp->'paid' is distinct from 'true'::jsonb or cp->'captured' is distinct from 'true'::jsonb or
  (cp->>'subtotalCents')::bigint is distinct from r.subtotal_cents or coalesce((p_snapshot->>'readStartedAt')::numeric,0)<greatest(lower_bound,extract(epoch from clock_timestamp())*1000-60000) or
  (p_snapshot->>'readStartedAt')::numeric>extract(epoch from clock_timestamp())*1000+1000 or
  coalesce((rb->>'readStartedAt')::numeric,0) not between extract(epoch from clock_timestamp())*1000-60000 and extract(epoch from clock_timestamp())*1000+1000 or
  coalesce(rb->>'chargeRequestId','')!~'^req_[A-Za-z0-9]+$' or rb->>'chargeRequestId' is distinct from cp->>'providerRequestId' or coalesce(rb->>'intentRequestId','')!~'^req_[A-Za-z0-9]+$' or
  p->'context' is distinct from c.context or p->>'paymentIntentId' is distinct from r.payment_intent_id or p->>'chargeId' is distinct from r.charge_id or
  (p->>'refundedCents')::bigint is distinct from (cp->>'refundedCents')::bigint or jsonb_typeof(p->'alerts') is distinct from 'array' or
  jsonb_typeof(b->'complete') is distinct from 'boolean' or jsonb_typeof(b->'entries') is distinct from 'array' or jsonb_typeof(b->'owners'->'refunds') is distinct from 'array' or jsonb_typeof(b->'owners'->'disputes') is distinct from 'array' or
  jsonb_typeof(p_snapshot->'refunds') is distinct from 'array' or jsonb_typeof(p_snapshot->'disputes') is distinct from 'array' then raise exception 'VERIFIED_FINANCIAL_CHECK_REQUIRED';end if;
 for k in select jsonb_object_keys(p_snapshot) loop if k not in ('capture','proof','refunds','disputes','readStartedAt','balanceEvidence') then raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;end loop;
 for k in select jsonb_object_keys(b) loop if k not in ('complete','entries','owners','principalLossCents','feeAdjustmentCents','originalProcessingCreditCents','financialProcessingCreditCents','alerts','refundListComplete','disputeListComplete') then raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;end loop;
 for k in select jsonb_object_keys(rb) loop if k not in ('intentRequestId','chargeRequestId','balanceRequestId','readStartedAt','observedAt') then raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;end loop;
 complete:=(b->>'complete')::boolean;original_cost:=(cp->>'processingCostCents')::bigint;
 for own in select value from jsonb_array_elements(p_snapshot->'refunds') loop
  perform creatornet_team_private.financial_shape_v1(own,'{"id":"string","chargeId":"string","amountCents":"number","status":"string","created":"number"}');
  if own->>'chargeId' is distinct from r.charge_id or own->>'id'!~'^re_[A-Za-z0-9]+$' or own->>'status' not in ('succeeded','failed','canceled','pending','requires_action') or (own->>'amountCents')::bigint not between 1 and r.subtotal_cents or (own->>'created')::bigint not between extract(epoch from r.paid_at)-5 and extract(epoch from clock_timestamp())+5 then raise exception 'ORIGINAL_FINANCIAL_REFUND_REQUIRED';end if;
  if own->>'status'='succeeded' then refunded:=refunded+(own->>'amountCents')::bigint;end if;
 end loop;
 for own in select value from jsonb_array_elements(p_snapshot->'disputes') loop
  perform creatornet_team_private.financial_shape_v1(own,'{"id":"string","chargeId":"string","amountCents":"number","status":"string"}');
  if own->>'chargeId' is distinct from r.charge_id or own->>'id'!~'^du_[A-Za-z0-9]+$' or own->>'status' not in ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented') or (own->>'amountCents')::bigint not between 1 and r.subtotal_cents then raise exception 'ORIGINAL_FINANCIAL_DISPUTE_REQUIRED';end if;
 end loop;
 if jsonb_array_length(p_snapshot->'refunds')<>(select count(distinct v->>'id') from jsonb_array_elements(p_snapshot->'refunds') v) or
  jsonb_array_length(p_snapshot->'disputes')<>(select count(distinct v->>'id') from jsonb_array_elements(p_snapshot->'disputes') v) or
  jsonb_array_length(b->'owners'->'refunds')<>(select count(distinct v->>'id') from jsonb_array_elements(b->'owners'->'refunds') v) or
  jsonb_array_length(b->'owners'->'disputes')<>(select count(distinct v->>'id') from jsonb_array_elements(b->'owners'->'disputes') v) or
  p->'refundIds' is distinct from coalesce((select jsonb_agg(v->'id' order by n) from jsonb_array_elements(p_snapshot->'refunds') with ordinality t(v,n)),'[]'::jsonb) or
  refunded>(p->>'refundedCents')::bigint or complete and refunded<>(p->>'refundedCents')::bigint or
  exists(select 1 from jsonb_array_elements(p_snapshot->'refunds') v where v->>'status' in ('pending','requires_action')) and p->'reviewHold' is distinct from 'true'::jsonb then raise exception 'FINANCIAL_SNAPSHOT_COVERAGE_REQUIRED';end if;
 if r.processing_cost_cents is not null and (original_cost is distinct from r.processing_cost_cents or cp->>'balanceTransactionId' is distinct from r.balance_transaction_id) or
  original_cost is not null and (original_cost<0 or coalesce(cp->>'balanceTransactionId','')!~'^txn_[A-Za-z0-9]+$' or coalesce(rb->>'balanceRequestId','')!~'^req_[A-Za-z0-9]+$') then raise exception 'ORIGINAL_TEAM_CAPTURE_COST_CHANGED';end if;
 for e in select value from jsonb_array_elements(b->'entries') loop
  perform creatornet_team_private.financial_shape_v1(e,'{"id":"string","ownerId":"string","kind":"string","sourceId":"string","amountCents":"number","feeCents":"number","netCents":"number","currency":"string","created":"number","availableOn":"number","status":"string","providerRequestId":"string","feeDetails":"array"}');
  if coalesce(e->>'id','')!~'^txn_[A-Za-z0-9]+$' or coalesce(e->>'providerRequestId','')!~'^req_[A-Za-z0-9]+$' or e->>'currency' is distinct from 'usd' or
   e->>'kind' not in ('refund','refund_failure','dispute','dispute_reversal') or e->>'sourceId' is distinct from e->>'ownerId' or
   jsonb_typeof(e->'amountCents') is distinct from 'number' or jsonb_typeof(e->'feeCents') is distinct from 'number' or jsonb_typeof(e->'netCents') is distinct from 'number' or
   abs((e->>'amountCents')::bigint) not between 1 and 99999999 or abs((e->>'feeCents')::bigint)>99999999 or
   (e->>'netCents')::bigint<>(e->>'amountCents')::bigint-(e->>'feeCents')::bigint or jsonb_typeof(e->'feeDetails') is distinct from 'array' or
   e->>'kind' in ('refund','dispute') and (e->>'amountCents')::bigint>=0 or e->>'kind' in ('refund_failure','dispute_reversal') and (e->>'amountCents')::bigint<=0 or
   e->>'status' not in ('pending','available') or coalesce((e->>'created')::bigint,0)<extract(epoch from r.paid_at)-5 or (e->>'created')::bigint>extract(epoch from clock_timestamp())+5 or coalesce((e->>'availableOn')::bigint,0)<=0 or
   exists(select 1 from jsonb_object_keys(e) key where key not in ('id','ownerId','kind','sourceId','amountCents','feeCents','netCents','currency','created','availableOn','status','providerRequestId','feeDetails')) then raise exception 'OWNED_FINANCIAL_BALANCE_REQUIRED';end if;
  if e->>'kind'='refund' and not exists(select 1 from jsonb_array_elements(b->'owners'->'refunds') x where x->>'id'=e->>'ownerId' and x->>'balanceId'=e->>'id') or
   e->>'kind'='refund_failure' and not exists(select 1 from jsonb_array_elements(b->'owners'->'refunds') x where x->>'id'=e->>'ownerId' and x->>'failureBalanceId'=e->>'id') or
   e->>'kind' in ('dispute','dispute_reversal') and not exists(select 1 from jsonb_array_elements(b->'owners'->'disputes') x where x->>'id'=e->>'ownerId' and x->'balanceIds'? (e->>'id')) then raise exception 'FINANCIAL_BALANCE_REFERENCE_REQUIRED';end if;
  fee_parts:=0;for f in select value from jsonb_array_elements(e->'feeDetails') loop
   perform creatornet_team_private.financial_shape_v1(f,'{"amount":"number","currency":"string","application":"null","type":"string"}');
   if f->>'currency' is distinct from 'usd' or f->'application' is distinct from 'null'::jsonb or f->>'type' not in ('stripe_fee','tax','payment_method_passthrough_fee') or jsonb_typeof(f->'amount') is distinct from 'number' or
    exists(select 1 from jsonb_object_keys(f) key where key not in ('amount','currency','application','type')) then raise exception 'ACTUAL_FINANCIAL_FEE_REQUIRED';end if;fee_parts:=fee_parts+(f->>'amount')::bigint;
  end loop;if fee_parts<>(e->>'feeCents')::bigint then raise exception 'ACTUAL_FINANCIAL_FEE_REQUIRED';end if;
  fees:=fees+(e->>'feeCents')::bigint;principal:=principal-(e->>'amountCents')::bigint;
  identity_value:=e-'providerRequestId'-'status'-'availableOn';select identity into old_identity from public.sales_team_financial_balance_entries_v1 where transaction_id=e->>'id';
  if old_identity is not null and (old_identity is distinct from identity_value or not exists(select 1 from public.sales_team_financial_balance_entries_v1 where transaction_id=e->>'id' and receipt_id=r.id)) then raise exception 'ORIGINAL_FINANCIAL_BALANCE_CHANGED';end if;
 end loop;
 if jsonb_array_length(b->'entries')<>(select count(distinct v->>'id') from jsonb_array_elements(b->'entries') v) or fees is distinct from (b->>'feeAdjustmentCents')::bigint then raise exception 'FINANCIAL_BALANCE_TOTAL_DIFFERS';end if;
 for own in select value from jsonb_array_elements(b->'owners'->'refunds') loop
  perform creatornet_team_private.financial_shape_v1(own,'{"id":"string","status":"string","amountCents":"number","balanceId":"string|null","failureBalanceId":"string|null"}');
  if own->>'balanceId' is not null and own->>'balanceId'!~'^txn_[A-Za-z0-9]+$' or own->>'failureBalanceId' is not null and own->>'failureBalanceId'!~'^txn_[A-Za-z0-9]+$' then raise exception 'FINANCIAL_BALANCE_REFERENCE_REQUIRED';end if;
  if not exists(select 1 from jsonb_array_elements(p_snapshot->'refunds') v where v->>'id'=own->>'id' and v->>'chargeId'=r.charge_id and v->>'status'=own->>'status' and (v->>'amountCents')::bigint=(own->>'amountCents')::bigint) or
   exists(select 1 from jsonb_object_keys(own) key where key not in ('id','status','amountCents','balanceId','failureBalanceId')) then raise exception 'ORIGINAL_FINANCIAL_REFUND_REQUIRED';end if;
  refs:=refs+num_nonnulls(own->>'balanceId',own->>'failureBalanceId');
  if complete and (own->>'status'='succeeded' and (own->>'balanceId' is null or own->>'failureBalanceId' is not null) or own->>'status' in ('failed','canceled') and (own->>'balanceId' is null)<>(own->>'failureBalanceId' is null)) then raise exception 'REFUND_BALANCE_TRACE_INCOMPLETE';end if;
  select coalesce(sum((v->>'amountCents')::bigint),0) into net from jsonb_array_elements(b->'entries') v where v->>'ownerId'=own->>'id';
  if complete and (own->>'status'='succeeded' and net<>-(own->>'amountCents')::bigint or own->>'status' in ('failed','canceled') and net<>0 or own->>'status' in ('pending','requires_action')) then raise exception 'REFUND_PRINCIPAL_TRACE_UNRECONCILED';end if;
 end loop;
 for own in select value from jsonb_array_elements(b->'owners'->'disputes') loop
  perform creatornet_team_private.financial_shape_v1(own,'{"id":"string","status":"string","amountCents":"number","balanceIds":"array"}');
  if jsonb_array_length(own->'balanceIds')>2 or exists(select 1 from jsonb_array_elements(own->'balanceIds') v where jsonb_typeof(v)<>'string' or (v#>>'{}')!~'^txn_[A-Za-z0-9]+$') then raise exception 'ORIGINAL_FINANCIAL_DISPUTE_REQUIRED';end if;
  if not exists(select 1 from jsonb_array_elements(p_snapshot->'disputes') v where v->>'id'=own->>'id' and v->>'chargeId'=r.charge_id and v->>'status'=own->>'status' and (v->>'amountCents')::bigint=(own->>'amountCents')::bigint) or
   jsonb_typeof(own->'balanceIds') is distinct from 'array' or exists(select 1 from jsonb_object_keys(own) key where key not in ('id','status','amountCents','balanceIds')) then raise exception 'ORIGINAL_FINANCIAL_DISPUTE_REQUIRED';end if;
  refs:=refs+jsonb_array_length(own->'balanceIds');select coalesce(sum((v->>'amountCents')::bigint),0) into net from jsonb_array_elements(b->'entries') v where v->>'ownerId'=own->>'id';
  if complete and (own->>'status'='lost' and net<>-(own->>'amountCents')::bigint or own->>'status' in ('won','prevented','warning_closed') and net<>0 or own->>'status' in ('lost','won','needs_response','under_review') and jsonb_array_length(own->'balanceIds')=0) then raise exception 'DISPUTE_PRINCIPAL_TRACE_UNRECONCILED';end if;
  if own->>'status' in ('warning_needs_response','warning_under_review','needs_response','under_review') and p->'disputeHold' is distinct from 'true'::jsonb then raise exception 'OPEN_DISPUTE_HOLD_REQUIRED';end if;
 end loop;
 if refs<>(select count(distinct key) from (
  select v->>'balanceId' key from jsonb_array_elements(b->'owners'->'refunds') v union all select v->>'failureBalanceId' from jsonb_array_elements(b->'owners'->'refunds') v union all
  select key#>>'{}' from jsonb_array_elements(b->'owners'->'disputes') v cross join lateral jsonb_array_elements(v->'balanceIds') key) keys where key is not null) then raise exception 'DUPLICATE_FINANCIAL_BALANCE_REFERENCE';end if;
 if complete and refs<>jsonb_array_length(b->'entries') or jsonb_array_length(b->'owners'->'refunds')<>jsonb_array_length(p_snapshot->'refunds') or jsonb_array_length(b->'owners'->'disputes')<>jsonb_array_length(p_snapshot->'disputes') then raise exception 'FINANCIAL_BALANCE_COVERAGE_REQUIRED';end if;
 if complete and (b->'refundListComplete' is distinct from 'true'::jsonb or b->'disputeListComplete' is distinct from 'true'::jsonb or principal not between 0 and r.subtotal_cents or principal is distinct from (b->>'principalLossCents')::bigint or
  original_cost is null or original_cost+fees<0 or exists(select 1 from public.sales_team_financial_balance_entries_v1 old where old.receipt_id=r.id and not exists(select 1 from jsonb_array_elements(b->'entries') v where v->>'id'=old.transaction_id))) then raise exception 'COMPLETE_FINANCIAL_TRACE_REQUIRED';end if;
 if complete and not exists(select 1 from jsonb_array_elements(p_snapshot->'disputes') d where d->>'status' not in ('won','lost','prevented','warning_closed')) and (p->>'totalLossCents')::bigint is distinct from principal then raise exception 'COMBINED_PRINCIPAL_TRACE_DIFFERS';end if;
 if p->'decisionIds' is distinct from coalesce((select jsonb_agg(id::text order by id) from public.sales_team_refund_reviews_v1 where receipt_id=r.id),'[]'::jsonb) then raise exception 'REFUND_RESPONSIBILITY_CHANGED';end if;
 -- Allocate original processing cents cumulatively in the same saved refund
 -- order as the runtime, then add each reviewed refund's own actual net fees.
 for own in select value from jsonb_array_elements(p_snapshot->'refunds') where value->>'status'='succeeded' order by (value->>'created')::bigint,(value->>'id') collate "C" loop
  select * into decision from public.sales_team_refund_reviews_v1 where receipt_id=r.id and refund_id=own->>'id' and amount_cents=(own->>'amountCents')::bigint and charge_id=r.charge_id;
  if decision.responsibility='platform' then
   base_credit:=base_credit+creatornet_team_private.financial_processing_share_v1(r.subtotal_cents,coalesce(original_cost,0),prior+(own->>'amountCents')::bigint)-creatornet_team_private.financial_processing_share_v1(r.subtotal_cents,coalesce(original_cost,0),prior);
   select platform_aux+coalesce(sum((v->>'feeCents')::bigint),0) into platform_aux from jsonb_array_elements(b->'entries') v where v->>'ownerId'=own->>'id';
  end if;
  prior:=prior+(own->>'amountCents')::bigint;
 end loop;
 expected_original:=greatest(0,least(base_credit,base_credit+platform_aux));expected_aux:=greatest(0,base_credit+platform_aux-expected_original);
 if (b->>'originalProcessingCreditCents')::bigint is distinct from expected_original or (b->>'financialProcessingCreditCents')::bigint is distinct from expected_aux or
  (p->>'platformProcessingCostCreditCents')::bigint is distinct from expected_original or complete and (base_credit+platform_aux<0 or base_credit+platform_aux>original_cost+fees) then raise exception 'FINANCIAL_CREDIT_ALLOCATION_DIFFERS';end if;
 if coalesce(original_cost,0)+floor((r.subtotal_cents::numeric*1200+5000)/10000)::bigint<=r.subtotal_cents then
  if (p->>'platformFeeReturnedCents')::bigint is distinct from floor(((coalesce(original_cost,0)+floor((r.subtotal_cents::numeric*1200+5000)/10000)::bigint)::numeric*(p->>'totalLossCents')::bigint+r.subtotal_cents/2)/r.subtotal_cents)::bigint-creatornet_team_private.financial_processing_share_v1(r.subtotal_cents,coalesce(original_cost,0),(p->>'totalLossCents')::bigint) then raise exception 'FINANCIAL_PLATFORM_FEE_ALLOCATION_DIFFERS';end if;
 elsif p->'reviewHold' is distinct from 'true'::jsonb or p->>'platformFeeReturnedCents'<>'0' then raise exception 'FINANCIAL_COST_DEFICIT_HOLD_REQUIRED';end if;
 if exists(select 1 from jsonb_array_elements(p_snapshot->'refunds') v where v->>'status'='succeeded' and not exists(select 1 from public.sales_team_refund_reviews_v1 d where d.receipt_id=r.id and d.refund_id=v->>'id' and d.amount_cents=(v->>'amountCents')::bigint)) and p->'reviewHold' is distinct from 'true'::jsonb then raise exception 'TEAM_REFUND_RESPONSIBILITY_REQUIRED';end if;
 if not complete or jsonb_array_length(p->'alerts')>0 then p:=jsonb_set(p,'{reviewHold}','true'::jsonb);end if;
 pending:=exists(select 1 from public.sales_team_payment_events_v1 e0 where e0.obligation_id=r.obligation_id and not exists(select 1 from public.sales_team_payment_event_results_v1 er where er.event_id=e0.event_id)) or
  exists(select 1 from public.sales_team_financial_checks_v1 other where other.receipt_id=r.id and other.id<>c.id and not exists(select 1 from public.sales_team_financial_check_results_v1 cr where cr.check_id=other.id));
 if pending then p:=jsonb_set(jsonb_set(p,'{reviewHold}','true'::jsonb),'{alerts}',p->'alerts'||'["ANOTHER_FINANCIAL_OBSERVATION_PENDING"]'::jsonb);end if;
 aux:=case when complete then fees else r.financial_adjustment_cost_cents end;aux_credit:=case when complete then (b->>'financialProcessingCreditCents')::bigint else r.financial_processing_credit_cents end;
 if aux_credit is null or aux_credit<0 or aux_credit+coalesce((p->>'platformProcessingCostCreditCents')::bigint,0)>coalesce(original_cost,0)+aux then raise exception 'FINANCIAL_CREDIT_ALLOCATION_DIFFERS';end if;
 update public.sales_team_receipts_v1 set processing_cost_cents=original_cost,balance_transaction_id=cp->>'balanceTransactionId',financial_adjustment_cost_cents=aux,financial_processing_credit_cents=aux_credit where id=r.id;
 result:=public.reconcile_sales_team_receipt_v1(r.id,r.observation_revision,'check:'||c.id::text,(p->>'refundedCents')::bigint,(p->>'totalLossCents')::bigint,(p->>'disputeHold')::boolean,(p->>'reviewHold')::boolean,
  original_cost,cp->>'balanceTransactionId',to_timestamp((cp->>'availableOn')::double precision),p);
 for e in select value from jsonb_array_elements(b->'entries') loop insert into public.sales_team_financial_balance_entries_v1(transaction_id,receipt_id,identity,check_id) values(e->>'id',r.id,e-'providerRequestId'-'status'-'availableOn',c.id) on conflict(transaction_id) do nothing;end loop;
 insert into public.sales_team_financial_check_results_v1(check_id,proof) values(c.id,jsonb_build_object('financial',p,'balances',b,'refunds',p_snapshot->'refunds','disputes',p_snapshot->'disputes','readback',rb));
 return jsonb_build_object('receiptId',r.id,'held',(result->>'review_hold')::boolean or (result->>'dispute_hold')::boolean);
end $$;
do $patch$ declare src text;change record;begin
 src:=replace(pg_get_functiondef('public.sync_sales_team_shared_accounting_v1(uuid)'::regprocedure),chr(13)||chr(10),chr(10));
 for change in select * from (values
  ('c.actual_processing_cost_cents,c.platform_processing_credit_cents','c.actual_processing_cost_cents,c.actual_financial_adjustment_cost_cents,c.platform_processing_credit_cents',1),
  ('s.actual_processing_cost_cents','(s.actual_processing_cost_cents+s.actual_financial_adjustment_cost_cents)',3),
  ('case when s.processing_cost_cents is null then null else 0 end','case when s.processing_cost_cents is null then null else s.actual_financial_adjustment_cost_cents end',2),
  ('team_financial_hold=s.review_hold','team_financial_adjustment_cost_cents=s.actual_financial_adjustment_cost_cents,team_financial_hold=s.review_hold',1)
 ) t(needle,replacement,expected) loop
  if (length(src)-length(replace(src,change.needle,'')))/length(change.needle)<>change.expected then raise exception 'TEAM_FINANCIAL_SHARED_DEPENDENCY_DIFFERS: %',change.needle;end if;
  src:=replace(src,change.needle,change.replacement);
 end loop;execute src;
end $patch$;
-- Keep the existing signed-event validation and conservative hold, then apply
-- the full independently inspected financial trace in the SAME transaction.
alter function public.complete_sales_team_payment_event_v1(text,integer,jsonb) rename to complete_sales_team_event_before_financial_v1;
create function public.complete_sales_team_payment_event_v1(p_event_id text,p_expected_revision integer,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare base jsonb:=p_snapshot-'balanceEvidence';result jsonb;r public.sales_team_receipts_v1;check_id uuid;begun jsonb;begin
 if p_snapshot?'balanceEvidence' then
  if not exists(select 1 from public.sales_team_controls_v1 where singleton and financial_reconciliation_enabled) then raise exception 'TEAM_FINANCIAL_RECONCILIATION_HELD';end if;
  -- The older validator requires every dispute to remain held. This transient
  -- conservative observation cannot escape the enclosing transaction.
  if jsonb_array_length(base->'disputes')>0 then base:=jsonb_set(base,'{proof,reviewHold}','true'::jsonb);end if;
 end if;
 if not p_snapshot?'balanceEvidence' then base:=jsonb_set(base,'{proof,reviewHold}','true'::jsonb);end if;
 if exists(select 1 from public.sales_team_financial_checks_v1 c join public.sales_team_receipts_v1 receipt on receipt.id=c.receipt_id
   where receipt.payment_intent_id=p_snapshot->'capture'->'receipt'->>'paymentIntentId' and not exists(select 1 from public.sales_team_financial_check_results_v1 cr where cr.check_id=c.id)) then base:=jsonb_set(base,'{proof,reviewHold}','true'::jsonb);end if;
 result:=public.complete_sales_team_event_before_financial_v1(p_event_id,p_expected_revision,base);
 if not p_snapshot?'balanceEvidence' then return result;end if;
 select * into r from public.sales_team_receipts_v1 where id=(result->>'receiptId')::uuid;
 -- An internal database UUID, explicitly linked to the real signed event.
 check_id:=md5('creatornet-team-financial-event-v1:'||p_event_id||':'||r.id::text)::uuid;
 begun:=public.begin_sales_team_financial_check_v1(check_id,r.id,null,p_event_id,null,p_snapshot->'proof'->'context');
 select * into r from public.sales_team_receipts_v1 where id=r.id;
 return public.complete_sales_team_financial_check_v1(check_id,r.observation_revision,p_snapshot);
end $$;
revoke all on function creatornet_team_private.financial_shape_v1(jsonb,jsonb) from public,anon,authenticated;
grant execute on function creatornet_team_private.financial_shape_v1(jsonb,jsonb) to service_role;
revoke all on function creatornet_team_private.financial_processing_share_v1(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function creatornet_team_private.financial_processing_share_v1(bigint,bigint,bigint) to service_role;
alter function public.read_sales_team_entitlement_v1(uuid,uuid) rename to read_sales_team_entitlement_before_financial_v1;
create function public.read_sales_team_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;begin
 result:=public.read_sales_team_entitlement_before_financial_v1(p_purchase_id,p_buyer_id);
 if exists(select 1 from public.purchases p join public.sales_team_receipts_v1 r on r.sale_id=p.sales_team_sale_id join public.sales_team_financial_checks_v1 c on c.receipt_id=r.id
  where p.id=p_purchase_id and p.buyer_id=p_buyer_id and not exists(select 1 from public.sales_team_financial_check_results_v1 cr where cr.check_id=c.id)) then return jsonb_build_object('applicable',true,'allowed',false,'maxAgeSeconds',0);end if;
 return result;
end $$;
alter function public.sales_team_payment_admitted_v1(uuid,jsonb) rename to sales_team_payment_admitted_before_financial_v1;
create function public.sales_team_payment_admitted_v1(p_sale_id uuid,p_context jsonb) returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select public.sales_team_payment_admitted_before_financial_v1(p_sale_id,p_context) and exists(select 1 from public.sales_team_controls_v1 where singleton and financial_reconciliation_enabled) and
 not exists(select 1 from public.sales_team_financial_checks_v1 c join public.sales_team_receipts_v1 r on r.id=c.receipt_id where r.sale_id=p_sale_id and not exists(select 1 from public.sales_team_financial_check_results_v1 cr where cr.check_id=c.id))
$$;
create function public.read_sales_team_financial_admin_queue_v1(p_actor_id uuid,p_context jsonb,p_after uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare cursor_at timestamptz;result jsonb;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'INVALID_FINANCIAL_QUEUE_LIMIT';end if;
 if p_after is not null then
  select r.paid_at into cursor_at from public.sales_team_receipts_v1 r join public.sales_team_sale_agreements_v1 a on a.id=r.sale_id where r.id=p_after and a.context=p_context;
  if cursor_at is null then raise exception 'INVALID_FINANCIAL_QUEUE_CURSOR';end if;
 end if;
 with page as materialized (
  select r.* from public.sales_team_receipts_v1 r join public.sales_team_sale_agreements_v1 a on a.id=r.sale_id where a.context=p_context and (p_after is null or (r.paid_at,r.id)<(cursor_at,p_after)) order by r.paid_at desc,r.id desc limit p_limit+1
 ), visible as (select * from page order by paid_at desc,id desc limit p_limit)
 select jsonb_build_object('mode',p_context->>'mode','rows',coalesce((select jsonb_agg(jsonb_build_object('receiptId',r.id,'saleId',r.sale_id,'paymentIntentId',r.payment_intent_id,'chargeId',r.charge_id,
  'revision',r.observation_revision,'held',r.review_hold or r.dispute_hold,'paidAt',r.paid_at,'subtotalCents',r.subtotal_cents,'refundedCents',r.refunded_subtotal_cents,'lossCents',r.confirmed_loss_subtotal_cents,
  'processingCostCents',r.processing_cost_cents,'adjustmentCostCents',r.financial_adjustment_cost_cents,'financialProcessingCreditCents',r.financial_processing_credit_cents,
  'pendingChecks',(select count(*) from public.sales_team_financial_checks_v1 c where c.receipt_id=r.id and not exists(select 1 from public.sales_team_financial_check_results_v1 cr where cr.check_id=c.id)),
  'refunds',coalesce((select cr.proof->'refunds' from public.sales_team_financial_check_results_v1 cr join public.sales_team_financial_checks_v1 c on c.id=cr.check_id where c.receipt_id=r.id order by cr.created_at desc,c.id desc limit 1),
    (select er.proof->'refunds' from public.sales_team_payment_event_results_v1 er where er.receipt_id=r.id order by er.created_at desc,er.event_id desc limit 1),'[]'::jsonb),
  'reviews',coalesce((select jsonb_agg(jsonb_build_object('refundId',d.refund_id,'responsibility',d.responsibility,'reasonCode',d.reason_code) order by d.id) from public.sales_team_refund_reviews_v1 d where d.receipt_id=r.id),'[]'::jsonb)
 ) order by r.paid_at desc,r.id desc) from visible r),'[]'::jsonb),
 'nextCursor',case when (select count(*) from page)>p_limit then (select id from visible order by paid_at,id limit 1) else null end) into result;
 return result;
end $$;
create function public.read_sales_team_financial_admin_source_v1(p_actor_id uuid,p_receipt_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;select * into a from public.sales_team_sale_agreements_v1 where id=r.sale_id;
 if r.id is null or a.context is distinct from p_context or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'OWNED_FINANCIAL_SOURCE_REQUIRED';end if;
 return jsonb_build_object('receiptId',r.id,'revision',r.observation_revision,'held',r.review_hold or r.dispute_hold,'source',
  jsonb_build_object('saleId',a.id,'buyerId',a.buyer_id,'obligationId',r.obligation_id,'paymentIntentId',r.payment_intent_id,'context',a.context));
end $$;
create function public.review_sales_team_refund_v1(p_actor_id uuid,p_request_id uuid,p_receipt_id uuid,p_expected_revision integer,p_responsibility text,p_reason_code text,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;d public.sales_team_refund_reviews_v1;k text;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;select * into a from public.sales_team_sale_agreements_v1 where id=r.sale_id;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id for update;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"context":"object","chargeId":"string","paymentIntentId":"string","refundId":"string","status":"string","amountCents":"number","providerRequestId":"string","readStartedAt":"number"}');
 if r.id is null or p_request_id is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=a.context) or p_proof->'context' is distinct from a.context or p_proof->>'chargeId' is distinct from r.charge_id or p_proof->>'paymentIntentId' is distinct from r.payment_intent_id or
  coalesce(p_proof->>'refundId','')!~'^re_[A-Za-z0-9]+$' or p_proof->>'status' is distinct from 'succeeded' or (p_proof->>'amountCents')::bigint not between 1 and r.refunded_subtotal_cents or
  coalesce(p_proof->>'providerRequestId','')!~'^req_[A-Za-z0-9]+$' or coalesce((p_proof->>'readStartedAt')::numeric,0) not between extract(epoch from clock_timestamp())*1000-30000 and extract(epoch from clock_timestamp())*1000+1000 then raise exception 'VERIFIED_TEAM_REFUND_REVIEW_REQUIRED';end if;
 for k in select jsonb_object_keys(p_proof) loop if k not in ('context','chargeId','paymentIntentId','refundId','status','amountCents','providerRequestId','readStartedAt') then raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;end loop;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into d from public.sales_team_refund_reviews_v1 where refund_id=p_proof->>'refundId' or id=p_request_id;
 if d.id is not null then
  if d.receipt_id<>r.id or d.refund_id<>p_proof->>'refundId' or d.amount_cents<>(p_proof->>'amountCents')::bigint or d.responsibility<>p_responsibility or d.reason_code<>p_reason_code then raise exception 'ORIGINAL_REFUND_REVIEW_CHANGED';end if;
  return jsonb_build_object('reviewId',d.id,'holdRetained',true);
 end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and refund_review_enabled) then raise exception 'TEAM_REFUND_REVIEW_HELD';end if;
 if r.observation_revision is distinct from p_expected_revision then raise exception 'FINANCIAL_OBSERVATION_STALE';end if;
 insert into public.sales_team_refund_reviews_v1(id,receipt_id,refund_id,charge_id,amount_cents,responsibility,reason_code,reviewed_by)
 values(p_request_id,r.id,p_proof->>'refundId',r.charge_id,(p_proof->>'amountCents')::bigint,p_responsibility,p_reason_code,p_actor_id) returning * into d;
 update public.sales_team_receipts_v1 set review_hold=true,observation_revision=observation_revision+1 where id=r.id;
 perform public.recompute_sales_team_balances_v1(a.id,'refund-review:'||d.id::text,jsonb_build_object('reviewId',d.id));
 return jsonb_build_object('reviewId',d.id,'holdRetained',true);
end $$;
do $$ declare n text;sig regprocedure;begin
 foreach n in array array['sales_team_financial_checks_v1','sales_team_financial_check_requests_v1','sales_team_financial_check_results_v1','sales_team_financial_balance_entries_v1'] loop
  execute format('alter table public.%I enable row level security',n);execute format('revoke all on public.%I from public,anon,authenticated',n);execute format('grant select,insert on public.%I to service_role',n);
  execute format('create trigger team_financial_history_immutable before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',n);
 end loop;
 for sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('begin_sales_team_financial_check_v1','complete_sales_team_financial_check_v1','complete_sales_team_payment_event_v1','complete_sales_team_event_before_financial_v1',
  'read_sales_team_entitlement_v1','read_sales_team_entitlement_before_financial_v1','sales_team_payment_admitted_v1','sales_team_payment_admitted_before_financial_v1','read_sales_team_financial_admin_queue_v1','read_sales_team_financial_admin_source_v1','review_sales_team_refund_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $$;
do $patch$ declare src text;change record;begin
 src:=replace(pg_get_functiondef('public.fulfill_sales_team_receipt_v1(uuid,uuid,uuid)'::regprocedure),chr(13)||chr(10),chr(10));
 for change in select * from (values
  ('c.actual_processing_cost_cents','(c.actual_processing_cost_cents+c.actual_financial_adjustment_cost_cents)',3),
  ('case when r.processing_cost_cents is null then null else 0 end','case when r.processing_cost_cents is null then null else c.actual_financial_adjustment_cost_cents end',2),
  ('team_creator_deficit_cents,team_financial_hold)','team_creator_deficit_cents,team_financial_adjustment_cost_cents,team_financial_hold)',1),
  ('c.creator_deficit_cents,r.review_hold','c.creator_deficit_cents,c.actual_financial_adjustment_cost_cents,r.review_hold',1)
 ) t(needle,replacement,expected) loop
  if (length(src)-length(replace(src,change.needle,'')))/length(change.needle)<>change.expected then raise exception 'TEAM_FINANCIAL_FULFILLMENT_DEPENDENCY_DIFFERS: %',change.needle;end if;
  src:=replace(src,change.needle,change.replacement);
 end loop;execute src;
end $patch$;
do $patch$ declare src text;needle text:=$o$'actualProcessingCostCents',b.actual_processing_cost_cents,$o$;begin
 src:=replace(pg_get_functiondef('public.read_sales_team_statement_v1(uuid,uuid,uuid,integer)'::regprocedure),chr(13)||chr(10),chr(10));
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_FINANCIAL_STATEMENT_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,needle||$n$'actualFinancialAdjustmentCostCents',b.actual_financial_adjustment_cost_cents,'financialProcessingCreditCents',r.financial_processing_credit_cents,$n$);execute src;
end $patch$;
commit;
