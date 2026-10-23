-- Local candidate. No historical backfill or status-only release. A source must
-- have been born under the guarded outgoing contract and never admitted money.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column shared_no_outbound_recovery_enabled boolean not null default false;
alter table public.sales_team_cash_policy_v1 add column no_outbound_contract_sha256 text check(no_outbound_contract_sha256~'^[a-f0-9]{64}$');
create table public.sales_team_shared_unsent_origins_v1 (
 source_kind text not null check(source_kind in ('legacy_refund','tip_restoration')),source_id text not null,
 source jsonb not null,contract_sha256 text not null,frozen_reversal_cents bigint,created_at timestamptz not null default clock_timestamp(),primary key(source_kind,source_id)
);
create table public.sales_team_shared_unsent_checks_v1 (
 check_id uuid primary key references public.sales_team_recovery_tasks_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_recovery_runs_v1(run_id) on delete restrict,
 source_kind text not null,source_id text not null,context jsonb not null,source jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_shared_unsent_results_v1 (
 check_id uuid primary key references public.sales_team_shared_unsent_checks_v1(check_id) on delete restrict,
 held boolean not null,proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_shared_unsent_resolutions_v1 (
 source_kind text not null,source_id text not null,context jsonb not null,fingerprint text not null,
 check_id uuid not null unique references public.sales_team_shared_unsent_results_v1(check_id) on delete restrict deferrable initially deferred,
 created_at timestamptz not null default clock_timestamp(),primary key(source_kind,source_id,context,fingerprint)
);
create function creatornet_team_private.no_outbound_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid),E'\n' order by p.oid::regprocedure::text collate "C"),'UTF8')),'hex') from pg_proc p where
 (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in ('no_outbound_contract_digest_v1','capture_unsent_origin_v1','shared_unsent_original_v1','shared_cash_required_v1','shared_cash_source_v1','capture_shared_cash_v1','shared_platform_cash_liabilities_v1','shared_cash_liabilities_before_unsent_v1')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('begin_sales_team_shared_unsent_v1','complete_sales_team_shared_unsent_v1','sales_team_shared_unsent_resolved_v1','claim_refund_operation','claim_refund_operation_before_team_cash_v1','record_tip_dispute_recovery','record_tip_dispute_with_cash_v1','record_tip_dispute_before_team_cash_v1','sales_team_shared_cash_admitted_v1','shared_cash_admitted_before_resolution_v1','admit_sales_team_shared_cash_v1','run_exact_context_admin_refund_v2','run_exact_refund_before_team_cash_v1'))
$$;
create function creatornet_team_private.capture_unsent_origin_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare kind text;id text;reversal bigint;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 -- Sources predating the outgoing guards, or born while they were unnecessary,
 -- receive no provenance. An empty provider list never manufactures this row.
 if not creatornet_team_private.shared_cash_required_v1() then return null;end if;
 if exists(select 1 from (values('refund_operations','sales_team_shared_refund_cash_v1'),('tip_dispute_recoveries','sales_team_shared_tip_cash_v1')) required(table_name,trigger_name)
  where not exists(select 1 from pg_trigger where tgrelid=('public.'||required.table_name)::regclass and tgname=required.trigger_name and tgenabled in ('O','A') and tgfoid='creatornet_team_private.capture_shared_cash_v1()'::regprocedure)) then return null;end if;
 kind:=case when TG_TABLE_NAME='refund_operations' then 'legacy_refund' else 'tip_restoration' end;
 if kind='legacy_refund' then
  if NEW.attempt_count<>0 or NEW.processing_token is not null or NEW.stripe_refund_id is not null or NEW.stripe_application_fee_refund_id is not null then return null;end if;id:=NEW.id::text;
 else
  if NEW.restoration_transfer_id is not null or NEW.restoration_status is not null then return null;end if;id:=NEW.stripe_dispute_id;reversal:=NEW.reversal_amount_cents;
 end if;
 insert into public.sales_team_shared_unsent_origins_v1(source_kind,source_id,source,contract_sha256,frozen_reversal_cents)
 values(kind,id,creatornet_team_private.shared_cash_source_v1(kind,id),creatornet_team_private.no_outbound_contract_digest_v1(),reversal);return null;
end $$;
create trigger sales_team_unsent_refund_origin_v1 after insert on public.refund_operations for each row execute function creatornet_team_private.capture_unsent_origin_v1();
create trigger sales_team_unsent_tip_origin_v1 after insert on public.tip_dispute_recoveries for each row execute function creatornet_team_private.capture_unsent_origin_v1();
create function creatornet_team_private.shared_unsent_original_v1(p_kind text,p_id text,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare birth public.sales_team_shared_unsent_origins_v1;q public.refund_operations;t public.tip_dispute_recoveries;s jsonb;terminal text;version bigint;begin
 select * into birth from public.sales_team_shared_unsent_origins_v1 where source_kind=p_kind and source_id=p_id;
 if birth.source_id is null or not creatornet_team_private.shared_cash_required_v1() or birth.contract_sha256 is distinct from creatornet_team_private.no_outbound_contract_digest_v1() or
  not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and no_outbound_contract_sha256=birth.contract_sha256) or
  not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) or
  exists(select 1 from public.sales_team_shared_cash_admissions_v1 where source_kind=p_kind and source_id=p_id) then return null;end if;
 if birth.source is distinct from creatornet_team_private.shared_cash_source_v1(p_kind,p_id) or
  exists(select 1 from (values
   ('refund_operations','sales_team_unsent_refund_origin_v1','creatornet_team_private.capture_unsent_origin_v1()'),
   ('tip_dispute_recoveries','sales_team_unsent_tip_origin_v1','creatornet_team_private.capture_unsent_origin_v1()'),
   ('refund_operations','sales_team_shared_refund_cash_v1','creatornet_team_private.capture_shared_cash_v1()'),
   ('tip_dispute_recoveries','sales_team_shared_tip_cash_v1','creatornet_team_private.capture_shared_cash_v1()')) required(table_name,trigger_name,function_name)
   where not exists(select 1 from pg_trigger where tgrelid=('public.'||required.table_name)::regclass and tgname=required.trigger_name and tgenabled in ('O','A') and tgfoid=required.function_name::regprocedure)) then return null;end if;
 select max(c.version) into version from public.sales_team_shared_cash_commitments_v1 c where c.source_kind=p_kind and c.source_id=p_id;
 if version is null then return null;end if;
 if p_kind='legacy_refund' then
  select * into q from public.refund_operations where id::text=p_id;
  if q.status<>'failed' or q.attempt_count<>0 or q.processing_token is not null or q.stripe_refund_id is not null or q.stripe_application_fee_refund_id is not null or q.stripe_application_fee_refund_amount_cents is not null then return null;end if;
  s:=jsonb_build_object('kind',p_kind,'id',p_id,'context',p_context,'chargeId',q.stripe_charge_id,'paymentIntentId',q.stripe_payment_intent_id,'grossCents',q.gross_amount_cents,'refundedBeforeCents',q.refunded_before_cents,'terminalStatus',q.status,'contractSha256',birth.contract_sha256,'commitmentVersion',version,'source',birth.source);
 elsif p_kind='tip_restoration' then
  select * into t from public.tip_dispute_recoveries where stripe_dispute_id=p_id;
  select dispute_status into terminal from public.tips where id=t.tip_id;
  if terminal is null or t.reversal_amount_cents is distinct from birth.frozen_reversal_cents or
   not (terminal in ('lost','prevented','warning_closed') or terminal='won' and birth.frozen_reversal_cents=0 and t.reversal_id is null) or
   t.restoration_transfer_id is not null or t.restoration_status is not null then return null;end if;
  s:=jsonb_build_object('kind',p_kind,'id',p_id,'context',p_context,'chargeId',t.stripe_charge_id,'paymentIntentId',t.stripe_payment_intent_id,'disputeId',t.stripe_dispute_id,'originalTransferId',t.stripe_transfer_id,'destinationId',birth.source->>'destinationId','disputedCents',t.disputed_amount_cents,'frozenReversalCents',birth.frozen_reversal_cents,'eventCreated',t.stripe_event_created,'terminalStatus',terminal,'contractSha256',birth.contract_sha256,'commitmentVersion',version,'source',birth.source);
 else return null;end if;
 return s||jsonb_build_object('fingerprint',encode(sha256(convert_to(s::text,'UTF8')),'hex'));
end $$;
create function public.sales_team_shared_unsent_resolved_v1(p_task_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_shared_unsent_resolutions_v1 r join public.sales_team_shared_unsent_checks_v1 c on c.check_id=r.check_id
 where c.check_id=p_task_id and r.context=p_context and r.fingerprint=creatornet_team_private.shared_unsent_original_v1(r.source_kind,r.source_id,p_context)->>'fingerprint')
$$;
create function public.begin_sales_team_shared_unsent_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare task public.sales_team_recovery_tasks_v1;checked public.sales_team_shared_unsent_checks_v1;s jsonb;begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);
 select * into task from public.sales_team_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id and kind='shared_cash';
 if task.id is null or exists(select 1 from public.sales_team_recovery_task_results_v1 where task_id=task.id) then raise exception 'ORIGINAL_UNSENT_SHARED_TASK_REQUIRED';end if;
 perform creatornet_team_private.financial_shape_v1(task.source,'{"kind":"string","id":"string"}');
 if task.source_id is distinct from (task.source->>'kind')||':'||(task.source->>'id') then raise exception 'ORIGINAL_UNSENT_SHARED_SOURCE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into checked from public.sales_team_shared_unsent_checks_v1 where check_id=task.id;
 if checked.check_id is not null then
  if checked.worker_run_id<>p_run_id or checked.context is distinct from p_context then raise exception 'ORIGINAL_UNSENT_SHARED_CHECK_CHANGED';end if;
  return jsonb_build_object('eligible',true,'completed',exists(select 1 from public.sales_team_shared_unsent_results_v1 where check_id=task.id),'held',not public.sales_team_shared_unsent_resolved_v1(task.id,p_context),'source',checked.source);
 end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and shared_no_outbound_recovery_enabled and shared_cash_reconciliation_enabled) then return jsonb_build_object('eligible',false);end if;
 s:=creatornet_team_private.shared_unsent_original_v1(task.source->>'kind',task.source->>'id',p_context);
 if s is null then return jsonb_build_object('eligible',false);end if;
 insert into public.sales_team_shared_unsent_checks_v1(check_id,worker_run_id,source_kind,source_id,context,source) values(task.id,p_run_id,s->>'kind',s->>'id',p_context,s);
 return jsonb_build_object('eligible',true,'completed',false,'held',true,'source',s);
end $$;
create function public.complete_sales_team_shared_unsent_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare checked public.sales_team_shared_unsent_checks_v1;s jsonb;c jsonb;d jsonb;t jsonb;r jsonb;fresh boolean;paths text[];idx integer:=0;begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);
 select * into checked from public.sales_team_shared_unsent_checks_v1 where check_id=p_task_id and worker_run_id=p_run_id and context=p_context;
 if checked.check_id is null or exists(select 1 from public.sales_team_recovery_task_results_v1 where task_id=p_task_id) then raise exception 'ORIGINAL_UNSENT_SHARED_CHECK_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 if exists(select 1 from public.sales_team_shared_unsent_results_v1 where check_id=p_task_id) then return jsonb_build_object('held',not public.sales_team_shared_unsent_resolved_v1(p_task_id,p_context));end if;
 s:=checked.source;perform creatornet_team_private.financial_shape_v1(p_proof,'{"fingerprint":"string","context":"object","readStartedAt":"number","charge":"object","dispute":"object|null","originalTransfer":"object|null","reads":"array"}');
 if p_proof->>'fingerprint' is distinct from s->>'fingerprint' or p_proof->'context' is distinct from p_context or
  (p_proof->>'readStartedAt')::numeric not between extract(epoch from checked.created_at)*1000-5 and extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'readStartedAt')::numeric<extract(epoch from clock_timestamp())*1000-45000 then raise exception 'CURRENT_UNSENT_SHARED_PROOF_REQUIRED';end if;
 c:=p_proof->'charge';perform creatornet_team_private.financial_shape_v1(c,'{"first":"object","second":"object"}');
 if c->'first' is distinct from c->'second' then raise exception 'STABLE_UNSENT_SHARED_CHARGE_REQUIRED';end if;c:=c->'second';
 perform creatornet_team_private.financial_shape_v1(c,'{"id":"string","paymentIntentId":"string","currency":"string","livemode":"boolean","paid":"boolean","captured":"boolean","status":"string","amountCents":"number","refundedCents":"number","applicationFeeId":"string|null","transferId":"string|null","destinationId":"string|null"}');
 if c->>'id' is distinct from s->>'chargeId' or c->>'paymentIntentId' is distinct from s->>'paymentIntentId' or c->>'currency'<>'usd' or c->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
  c->'paid'<>'true'::jsonb or c->'captured'<>'true'::jsonb or c->>'status'<>'succeeded' or (c->>'amountCents')::numeric not between 1 and 9007199254740991 or trunc((c->>'amountCents')::numeric)<>(c->>'amountCents')::numeric then raise exception 'OWNED_UNSENT_SHARED_CHARGE_REQUIRED';end if;
 paths:=array['/v1/charges/'||(s->>'chargeId'),'/v1/charges/'||(s->>'chargeId')];
 if checked.source_kind='legacy_refund' then
  if c->'amountCents' is distinct from s->'grossCents' or c->'refundedCents' is distinct from s->'refundedBeforeCents' or c->>'applicationFeeId' is distinct from s->'source'->>'applicationFeeId' or p_proof->'dispute'<>'null'::jsonb or p_proof->'originalTransfer'<>'null'::jsonb then raise exception 'UNSENT_ORIGINAL_REFUND_SOURCE_REQUIRED';end if;
 else
  if c->>'transferId' is distinct from s->>'originalTransferId' or c->>'destinationId' is distinct from s->>'destinationId' or (c->>'amountCents')::numeric<(s->>'disputedCents')::numeric then raise exception 'UNSENT_ORIGINAL_TIP_SOURCE_REQUIRED';end if;
  d:=p_proof->'dispute';perform creatornet_team_private.financial_shape_v1(d,'{"first":"object","second":"object"}');
  if d->'first' is distinct from d->'second' then raise exception 'STABLE_UNSENT_SHARED_DISPUTE_REQUIRED';end if;d:=d->'second';
  perform creatornet_team_private.financial_shape_v1(d,'{"id":"string","chargeId":"string","paymentIntentId":"string","currency":"string","livemode":"boolean","amountCents":"number","status":"string"}');
  if d->>'id' is distinct from s->>'disputeId' or d->>'chargeId' is distinct from s->>'chargeId' or d->>'paymentIntentId' is distinct from s->>'paymentIntentId' or d->>'currency'<>'usd' or
   d->'livemode' is distinct from c->'livemode' or d->'amountCents' is distinct from s->'disputedCents' or d->>'status' is distinct from s->>'terminalStatus' then raise exception 'OWNED_TERMINAL_UNSENT_DISPUTE_REQUIRED';end if;
  paths:=paths||array['/v1/disputes/'||(s->>'disputeId'),'/v1/disputes/'||(s->>'disputeId')];
  if s->>'terminalStatus'='won' then
   t:=p_proof->'originalTransfer';perform creatornet_team_private.financial_shape_v1(t,'{"first":"object","second":"object"}');
   if t->'first' is distinct from t->'second' then raise exception 'STABLE_UNSENT_SHARED_TRANSFER_REQUIRED';end if;t:=t->'second';
   perform creatornet_team_private.financial_shape_v1(t,'{"id":"string","sourceTransaction":"string","destinationId":"string","currency":"string","livemode":"boolean","amountCents":"number","reversedCents":"number"}');
   if t->>'id' is distinct from s->>'originalTransferId' or t->>'sourceTransaction' is distinct from s->>'chargeId' or t->>'destinationId' is distinct from s->>'destinationId' or t->>'currency'<>'usd' or t->'livemode' is distinct from c->'livemode' or
    (t->>'amountCents')::numeric not between 1 and 9007199254740991 or trunc((t->>'amountCents')::numeric)<>(t->>'amountCents')::numeric or t->'amountCents' is distinct from t->'reversedCents' or s->'frozenReversalCents'<>'0'::jsonb then raise exception 'ACTUAL_ZERO_RESTORATION_OBLIGATION_REQUIRED';end if;
   paths:=paths||array['/v1/transfers/'||(s->>'originalTransferId'),'/v1/transfers/'||(s->>'originalTransferId')];
  elsif p_proof->'originalTransfer'<>'null'::jsonb then raise exception 'OWNED_UNSENT_TRANSFER_PROOF_REQUIRED';end if;
 end if;
 if jsonb_array_length(p_proof->'reads')<>cardinality(paths) or jsonb_array_length(p_proof->'reads')<>(select count(distinct v->>'requestId') from jsonb_array_elements(p_proof->'reads') v) then raise exception 'INDEPENDENT_UNSENT_SHARED_READS_REQUIRED';end if;
 for r in select value from jsonb_array_elements(p_proof->'reads') loop
  idx:=idx+1;perform creatornet_team_private.financial_shape_v1(r,'{"path":"string","requestId":"string"}');
  if r->>'path' is distinct from paths[idx] or r->>'requestId'!~'^req_[A-Za-z0-9]{1,100}$' then raise exception 'INDEPENDENT_UNSENT_SHARED_READS_REQUIRED';end if;
 end loop;
 fresh:=creatornet_team_private.shared_unsent_original_v1(checked.source_kind,checked.source_id,p_context) is not distinct from s;
 if fresh then
  insert into public.sales_team_shared_unsent_resolutions_v1(source_kind,source_id,context,fingerprint,check_id) values(checked.source_kind,checked.source_id,p_context,s->>'fingerprint',p_task_id);
  update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;
 end if;
 insert into public.sales_team_shared_unsent_results_v1(check_id,held,proof) values(p_task_id,not fresh,case when fresh then p_proof else jsonb_build_object('holdReason','source_changed') end);
 return jsonb_build_object('held',not fresh);
end $$;
alter function creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb) rename to shared_cash_liabilities_before_unsent_v1;
create function creatornet_team_private.shared_platform_cash_liabilities_v1(p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare base jsonb;credit numeric;revision text;begin
 base:=creatornet_team_private.shared_cash_liabilities_before_unsent_v1(p_context);
 select coalesce(sum(held.principal+case when r.source_kind='legacy_refund' then policy.legacy_refund_cost_reserve_cents else policy.tip_restoration_cost_reserve_cents end),0),
  coalesce(jsonb_agg(r.fingerprint order by r.source_kind collate "C",r.source_id collate "C"),'[]'::jsonb)::text into credit,revision
 from public.sales_team_shared_unsent_resolutions_v1 r cross join public.sales_team_cash_policy_v1 policy
 cross join lateral (select max(c.principal_cents)::numeric principal from public.sales_team_shared_cash_commitments_v1 c where c.source_kind=r.source_kind and c.source_id=r.source_id) held
 where r.context=p_context and r.fingerprint=creatornet_team_private.shared_unsent_original_v1(r.source_kind,r.source_id,p_context)->>'fingerprint';
 if credit>(base->>'protectedCents')::numeric then raise exception 'UNSENT_SHARED_CASH_CREDIT_DIFFERS';end if;
 return jsonb_build_object('protectedCents',(base->>'protectedCents')::numeric-credit,'sourceRevision',encode(sha256(convert_to((base->>'sourceRevision')||':'||revision,'UTF8')),'hex'));
end $$;
do $named$ declare src text;needle text;begin
 src:=pg_get_functiondef('creatornet_team_private.shared_cash_contract_digest_v1()'::regprocedure);needle:='''shared_cash_liabilities_before_resolution_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'UNSENT_SHARED_DIGEST_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,needle||',''shared_cash_liabilities_before_unsent_v1'',''no_outbound_contract_digest_v1'',''capture_unsent_origin_v1'',''shared_unsent_original_v1''');execute src;
 src:=pg_get_functiondef('public.finish_sales_team_recovery_task_v1(uuid,uuid,jsonb,uuid,boolean)'::regprocedure);needle:='when ''shared_cash'' then exists';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'UNSENT_SHARED_TASK_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'when ''shared_cash'' then public.sales_team_shared_unsent_resolved_v1(task.id,p_context) or exists');
 src:=replace(pg_get_functiondef('public.next_sales_team_recovery_task_v1(uuid,uuid,jsonb,boolean,boolean)'::regprocedure),chr(13)||chr(10),chr(10));
 needle:='not exists(select 1 from public.sales_team_shared_cash_resolutions_v1 done where done.source_kind=c.source_kind and done.source_id=c.source_id and done.commitment_version=c.version and done.context=p_context)';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'UNSENT_SHARED_QUEUE_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||' and not exists(select 1 from public.sales_team_shared_unsent_resolutions_v1 unsent where unsent.source_kind=c.source_kind and unsent.source_id=c.source_id and unsent.context=p_context and unsent.fingerprint=creatornet_team_private.shared_unsent_original_v1(c.source_kind,c.source_id,p_context)->>''fingerprint'')');
 src:=pg_get_functiondef('creatornet_team_private.recovery_contract_digest_v1()'::regprocedure);needle:='''fulfill_sales_team_receipt_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'UNSENT_SHARED_RECOVERY_DIGEST_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,needle||',''begin_sales_team_shared_unsent_v1'',''complete_sales_team_shared_unsent_v1'',''sales_team_shared_unsent_resolved_v1''');
 needle:='''shared_cash_trace_v1''';if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'UNSENT_SHARED_PRIVATE_DIGEST_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||',''no_outbound_contract_digest_v1'',''shared_unsent_original_v1'',''capture_unsent_origin_v1'',''shared_platform_cash_liabilities_v1'',''shared_cash_liabilities_before_unsent_v1''');
end $named$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_shared_unsent_origins_v1','sales_team_shared_unsent_checks_v1','sales_team_shared_unsent_results_v1','sales_team_shared_unsent_resolutions_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated',name);execute format('grant select,insert on public.%I to service_role',name);
  execute format('create trigger immutable_unsent_shared_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('begin_sales_team_shared_unsent_v1','complete_sales_team_shared_unsent_v1','sales_team_shared_unsent_resolved_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('no_outbound_contract_digest_v1','capture_unsent_origin_v1','shared_unsent_original_v1','shared_platform_cash_liabilities_v1','shared_cash_liabilities_before_unsent_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
