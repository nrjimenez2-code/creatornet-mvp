-- Local-only shared cash coverage. Historical commitments intentionally remain
-- protected until their independent original-balance reconciliation is installed.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_cash_policy_v1 add column legacy_refund_cost_reserve_cents bigint check(legacy_refund_cost_reserve_cents between 0 and 9007199254740991),
 add column tip_restoration_cost_reserve_cents bigint check(tip_restoration_cost_reserve_cents between 0 and 9007199254740991);
create table public.sales_team_shared_cash_commitments_v1 (
 version bigint generated always as identity primary key,
 source_kind text not null check(source_kind in ('legacy_refund','tip_restoration')),source_id text not null,
 source jsonb not null,principal_cents bigint not null check(principal_cents between 1 and 9007199254740991),
 created_at timestamptz not null default clock_timestamp(),unique(source_kind,source_id,principal_cents)
);
create table public.sales_team_shared_cash_admissions_v1 (
 read_id uuid primary key references public.sales_team_cash_observations_v1(read_id) on delete restrict,
 source_kind text not null,source_id text not null,context jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create index sales_team_shared_cash_source_v1 on public.sales_team_shared_cash_commitments_v1(source_kind,source_id,version);
create index sales_team_shared_cash_admission_source_v1 on public.sales_team_shared_cash_admissions_v1(source_kind,source_id,created_at);
create function creatornet_team_private.shared_cash_source_v1(p_kind text,p_id text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare source jsonb;begin
 if p_kind='legacy_refund' then
  select jsonb_build_object('id',o.id,'creatorId',o.creator_id,'ledgerId',o.payment_fee_ledger_id,'chargeId',o.stripe_charge_id,
   'paymentIntentId',o.stripe_payment_intent_id,'applicationFeeId',o.stripe_application_fee_id,'currency',o.currency,'idempotencyKey',o.idempotency_key)
   into source from public.refund_operations o where o.id::text=p_id;
 elsif p_kind='tip_restoration' then
  select jsonb_build_object('id',o.stripe_dispute_id,'creatorId',t.creator_id,'tipId',o.tip_id,'chargeId',o.stripe_charge_id,
   'paymentIntentId',o.stripe_payment_intent_id,'transferId',o.stripe_transfer_id,'destinationId',t.stripe_destination_account_id,'currency',t.currency)
   into source from public.tip_dispute_recoveries o join public.tips t on t.id=o.tip_id where o.stripe_dispute_id=p_id;
 else raise exception 'SHARED_CASH_SOURCE_REQUIRED';end if;
 if source is null then raise exception 'SHARED_CASH_SOURCE_REQUIRED';end if;
 return source;
end $$;
create function creatornet_team_private.capture_shared_cash_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare kind text;id text;principal bigint;v_source jsonb;begin
 if TG_OP='DELETE' then raise exception 'SHARED_CASH_HISTORY_IS_IMMUTABLE';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 kind:=case when TG_TABLE_NAME='refund_operations' then 'legacy_refund' else 'tip_restoration' end;
 if kind='legacy_refund' then id:=NEW.id::text;principal:=NEW.customer_refund_amount_cents+NEW.application_fee_refund_amount_cents;
 else id:=NEW.stripe_dispute_id;principal:=NEW.disputed_amount_cents;end if;
 v_source:=creatornet_team_private.shared_cash_source_v1(kind,id);
 if exists(select 1 from public.sales_team_shared_cash_commitments_v1 prior_cash where prior_cash.source_kind=kind and prior_cash.source_id=id and prior_cash.source is distinct from v_source) then raise exception 'ORIGINAL_SHARED_CASH_SOURCE_CHANGED';end if;
 insert into public.sales_team_shared_cash_commitments_v1(source_kind,source_id,source,principal_cents) values(kind,id,v_source,principal) on conflict(source_kind,source_id,principal_cents) do nothing;
 return null;
end $$;
create trigger sales_team_shared_refund_cash_v1 after insert or update or delete on public.refund_operations for each row execute function creatornet_team_private.capture_shared_cash_v1();
create trigger sales_team_shared_tip_cash_v1 after insert or update or delete on public.tip_dispute_recoveries for each row execute function creatornet_team_private.capture_shared_cash_v1();
insert into public.sales_team_shared_cash_commitments_v1(source_kind,source_id,source,principal_cents)
 select 'legacy_refund',id::text,creatornet_team_private.shared_cash_source_v1('legacy_refund',id::text),customer_refund_amount_cents+application_fee_refund_amount_cents from public.refund_operations;
insert into public.sales_team_shared_cash_commitments_v1(source_kind,source_id,source,principal_cents)
 select 'tip_restoration',stripe_dispute_id,creatornet_team_private.shared_cash_source_v1('tip_restoration',stripe_dispute_id),disputed_amount_cents from public.tip_dispute_recoveries;
create or replace function creatornet_team_private.shared_platform_cash_liabilities_v1(p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare policy public.sales_team_cash_policy_v1;protected numeric;revision text;begin
 select * into policy from public.sales_team_cash_policy_v1 where singleton;
 if policy.legacy_refund_cost_reserve_cents is null or policy.tip_restoration_cost_reserve_cents is null or
  exists(select 1 from public.sales_team_shared_cash_commitments_v1 where source->>'currency' is distinct from 'usd') or
  not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) or
  exists(select 1 from (values('refund_operations','sales_team_shared_refund_cash_v1'),('tip_dispute_recoveries','sales_team_shared_tip_cash_v1')) required(table_name,trigger_name)
   where not exists(select 1 from pg_trigger where tgrelid=('public.'||required.table_name)::regclass and tgname=required.trigger_name and tgenabled in ('O','A') and tgfoid='creatornet_team_private.capture_shared_cash_v1()'::regprocedure)) then raise exception 'SHARED_PLATFORM_CASH_COVERAGE_REQUIRED';end if;
 if exists(select 1 from public.refund_operations o where not exists(select 1 from public.sales_team_shared_cash_commitments_v1 saved where saved.source_kind='legacy_refund' and saved.source_id=o.id::text and
  saved.source=creatornet_team_private.shared_cash_source_v1('legacy_refund',o.id::text) and saved.principal_cents>=o.customer_refund_amount_cents+o.application_fee_refund_amount_cents)) or
  exists(select 1 from public.tip_dispute_recoveries o where not exists(select 1 from public.sales_team_shared_cash_commitments_v1 saved where saved.source_kind='tip_restoration' and saved.source_id=o.stripe_dispute_id and
  saved.source=creatornet_team_private.shared_cash_source_v1('tip_restoration',o.stripe_dispute_id) and saved.principal_cents>=o.disputed_amount_cents)) then raise exception 'SHARED_PLATFORM_CASH_COVERAGE_REQUIRED';end if;
 with commitments as (select source_kind,source_id,max(principal_cents) principal from public.sales_team_shared_cash_commitments_v1 group by source_kind,source_id)
 select coalesce(sum(principal::numeric+case when source_kind='legacy_refund' then policy.legacy_refund_cost_reserve_cents else policy.tip_restoration_cost_reserve_cents end),0),
  encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(source_kind,source_id,principal) order by source_kind collate "C",source_id collate "C"),'[]'::jsonb)::text||':'||policy.legacy_refund_cost_reserve_cents::text||':'||policy.tip_restoration_cost_reserve_cents::text,'UTF8')),'hex')
 into protected,revision from commitments;
 if protected>9007199254740991 then raise exception 'SHARED_PLATFORM_CASH_RANGE_REQUIRED';end if;
 return jsonb_build_object('protectedCents',protected,'sourceRevision',revision);
end $$;
alter table public.sales_team_cash_reads_v1 alter column actor_id drop not null,add column source_kind text,add column source_id text;
create function public.begin_sales_team_shared_cash_read_v1(p_read_id uuid,p_actor_id uuid,p_context jsonb,p_source_kind text,p_source_id text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare v_source jsonb;begin
 if p_read_id is null or p_source_kind not in ('legacy_refund','tip_restoration') or
  p_source_kind='legacy_refund' and not exists(select 1 from public.profiles where id=p_actor_id and role='admin') or
  p_source_kind='tip_restoration' and p_actor_id is not null then raise exception 'SHARED_CASH_ACTOR_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 v_source:=creatornet_team_private.shared_cash_source_v1(p_source_kind,p_source_id);
 if not exists(select 1 from public.sales_team_shared_cash_commitments_v1 where source_kind=p_source_kind and source_id=p_source_id and sales_team_shared_cash_commitments_v1.source=v_source) then raise exception 'SHARED_CASH_COMMITMENT_REQUIRED';end if;
 insert into public.sales_team_cash_reads_v1(id,actor_id,context,protection,source_kind,source_id) values(p_read_id,p_actor_id,p_context,creatornet_team_private.cash_protection_v1(p_context),p_source_kind,p_source_id);
end $$;
alter function public.complete_sales_team_cash_read_v1(uuid,uuid,jsonb) rename to complete_sales_team_cash_read_before_shared_v1;
create function public.complete_sales_team_cash_read_v1(p_read_id uuid,p_actor_id uuid,p_proof jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.sales_team_cash_reads_v1;begin
 if p_actor_id is not null then perform public.complete_sales_team_cash_read_before_shared_v1(p_read_id,p_actor_id,p_proof);return;end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));select * into r from public.sales_team_cash_reads_v1 where id=p_read_id;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"context":"object","availableCents":"number","firstRequestId":"string","secondRequestId":"string","readStartedAt":"number"}');
 if r.id is null or r.actor_id is not null or r.source_kind is distinct from 'tip_restoration' or r.context is distinct from p_proof->'context' or
  r.protection is distinct from creatornet_team_private.cash_protection_v1(r.context) or r.created_at<clock_timestamp()-interval '30 seconds' or
  (p_proof->>'readStartedAt')::numeric<extract(epoch from r.created_at)*1000-5 or (p_proof->>'readStartedAt')::numeric>extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'readStartedAt')::numeric<extract(epoch from clock_timestamp()-interval '25 seconds')*1000 or
  p_proof->>'firstRequestId'!~'^req_[A-Za-z0-9]+$' or p_proof->>'secondRequestId'!~'^req_[A-Za-z0-9]+$' then raise exception 'FRESH_PLATFORM_CASH_REQUIRED';end if;
 perform creatornet_team_private.shared_cash_source_v1(r.source_kind,r.source_id);
 insert into public.sales_team_cash_observations_v1(read_id,available_cents,proof) values(r.id,(p_proof->>'availableCents')::bigint,p_proof);
end $$;
create function public.admit_sales_team_shared_cash_v1(p_read_id uuid,p_source_kind text,p_source_id text,p_context jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.sales_team_cash_reads_v1;p jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 p:=creatornet_team_private.cash_protection_v1(p_context);select * into r from public.sales_team_cash_reads_v1 where id=p_read_id;
 if r.id is null or r.source_kind is distinct from p_source_kind or r.source_id is distinct from p_source_id or r.context is distinct from p_context or r.protection is distinct from p or r.created_at<clock_timestamp()-interval '30 seconds' or
  not exists(select 1 from public.sales_team_cash_observations_v1 where read_id=r.id) then raise exception 'FRESH_PLATFORM_CASH_REQUIRED';end if;
 if not coalesce(creatornet_team_private.cash_available_floor_v1(p_context,p->'epoch')>=(p->>'teamCents')::numeric+(p->'shared'->>'protectedCents')::numeric+(p->>'reserveCents')::numeric+creatornet_team_private.cash_encumbered_v1(),false) then raise exception 'PROTECTED_PLATFORM_FUNDS_INSUFFICIENT';end if;
 insert into public.sales_team_shared_cash_admissions_v1(read_id,source_kind,source_id,context) values(r.id,p_source_kind,p_source_id,p_context) on conflict(read_id) do nothing;
end $$;
create function creatornet_team_private.shared_cash_required_v1()
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_controls_v1 where singleton and cash_reservations_enabled) or exists(select 1 from public.sales_team_receipts_v1) or exists(select 1 from public.sales_team_shared_cash_admissions_v1)
$$;
create function public.sales_team_shared_cash_admitted_v1(p_source_kind text,p_source_id text)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare r public.sales_team_cash_reads_v1;p jsonb;v_context jsonb;begin
 if not creatornet_team_private.shared_cash_required_v1() then return true;end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and cash_reservations_enabled) then return false;end if;
 select f.context into v_context from public.sales_team_financial_config_v1 f where singleton;p:=creatornet_team_private.cash_protection_v1(v_context);
 select reads.* into r from public.sales_team_shared_cash_admissions_v1 a join public.sales_team_cash_reads_v1 reads on reads.id=a.read_id where a.source_kind=p_source_kind and a.source_id=p_source_id and a.context=v_context order by a.created_at desc,a.read_id desc limit 1;
 return coalesce(r.protection=p and r.created_at>clock_timestamp()-interval '30 seconds' and
  creatornet_team_private.cash_available_floor_v1(v_context,p->'epoch')>=(p->>'teamCents')::numeric+(p->'shared'->>'protectedCents')::numeric+(p->>'reserveCents')::numeric+creatornet_team_private.cash_encumbered_v1(),false);
end $$;
alter function public.claim_refund_operation(uuid,uuid,integer) rename to claim_refund_operation_before_team_cash_v1;
create function public.claim_refund_operation(p_operation_id uuid,p_processing_token uuid,p_lease_seconds integer default 300)
returns text language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if exists(select 1 from public.refund_operations where id=p_operation_id and status not in ('failed','completed')) and not public.sales_team_shared_cash_admitted_v1('legacy_refund',p_operation_id::text) then raise exception 'SHARED_REFUND_CASH_ADMISSION_REQUIRED';end if;
 return public.claim_refund_operation_before_team_cash_v1(p_operation_id,p_processing_token,p_lease_seconds);
end $$;
alter function public.record_tip_dispute_recovery(text,uuid,text,text,text,bigint,bigint,bigint,text) rename to record_tip_dispute_before_team_cash_v1;
create function public.record_tip_dispute_recovery(p_dispute_id text,p_tip_id uuid,p_payment_intent_id text,p_charge_id text,p_transfer_id text,p_disputed_amount_cents bigint,p_event_created bigint,p_reversal_amount_cents bigint,p_dispute_status text)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare result boolean;begin
 if p_dispute_status='won' and creatornet_team_private.shared_cash_required_v1() then raise exception 'SHARED_TIP_CASH_CONTRACT_REQUIRED';end if;
 result:=public.record_tip_dispute_before_team_cash_v1(p_dispute_id,p_tip_id,p_payment_intent_id,p_charge_id,p_transfer_id,p_disputed_amount_cents,p_event_created,p_reversal_amount_cents,p_dispute_status);
 return result;
end $$;
create function public.record_tip_dispute_with_cash_v1(p_dispute_id text,p_tip_id uuid,p_payment_intent_id text,p_charge_id text,p_transfer_id text,p_disputed_amount_cents bigint,p_event_created bigint,p_reversal_amount_cents bigint,p_dispute_status text)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare result boolean;begin
 if p_dispute_status is null or p_dispute_status not in ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','prevented','won','lost') then raise exception 'CURRENT_TIP_DISPUTE_STATUS_REQUIRED';end if;
 result:=public.record_tip_dispute_before_team_cash_v1(p_dispute_id,p_tip_id,p_payment_intent_id,p_charge_id,p_transfer_id,p_disputed_amount_cents,p_event_created,p_reversal_amount_cents,p_dispute_status);
 return result and (p_dispute_status<>'won' or not exists(select 1 from public.tip_dispute_recoveries where stripe_dispute_id=p_dispute_id and reversal_amount_cents>0) or public.sales_team_shared_cash_admitted_v1('tip_restoration',p_dispute_id));
end $$;
-- Preserve the restricted exact-context runtime's single RPC boundary. Every
-- new phase first reuses its persisted administrator/receipt/context check.
do $context$ begin
 if to_regprocedure('public.run_exact_context_admin_refund_v2(uuid,uuid,jsonb,uuid,text,jsonb)') is not null then
  alter function public.run_exact_context_admin_refund_v2(uuid,uuid,jsonb,uuid,text,jsonb) rename to run_exact_refund_before_team_cash_v1;
  execute $definition$
  create function public.run_exact_context_admin_refund_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_ledger_id uuid,p_phase text,p_payload jsonb)
  returns jsonb language plpgsql security invoker set search_path=pg_catalog as $body$
  declare saved jsonb;read_id uuid;operation_id uuid;begin
   if p_phase is null or p_phase not in ('cash_begin','cash_complete','cash_admit','cash_assert') then return public.run_exact_refund_before_team_cash_v1(p_reservation_id,p_actor_id,p_context,p_ledger_id,p_phase,p_payload);end if;
   perform creatornet_team_private.financial_shape_v1(p_payload,case when p_phase='cash_complete' then '{"operationId":"string","readId":"string","proof":"object"}'::jsonb else '{"operationId":"string","readId":"string"}'::jsonb end);
   operation_id:=(p_payload->>'operationId')::uuid;read_id:=(p_payload->>'readId')::uuid;
   saved:=public.run_exact_refund_before_team_cash_v1(p_reservation_id,p_actor_id,p_context,p_ledger_id,'read',jsonb_build_object('operationId',operation_id));
   if saved->>'id' is distinct from operation_id::text then raise exception 'ORIGINAL_SHARED_REFUND_REQUIRED';end if;
   if p_phase='cash_begin' then perform public.begin_sales_team_shared_cash_read_v1(read_id,p_actor_id,p_context,'legacy_refund',operation_id::text);
   else
    if not exists(select 1 from public.sales_team_cash_reads_v1 r where r.id=read_id and r.actor_id=p_actor_id and r.context=p_context and r.source_kind='legacy_refund' and r.source_id=operation_id::text) then raise exception 'ORIGINAL_SHARED_REFUND_REQUIRED';end if;
    if p_phase='cash_complete' then perform public.complete_sales_team_cash_read_v1(read_id,p_actor_id,p_payload->'proof');
    elsif p_phase='cash_admit' then perform public.admit_sales_team_shared_cash_v1(read_id,'legacy_refund',operation_id::text,p_context);
    elsif not public.sales_team_shared_cash_admitted_v1('legacy_refund',operation_id::text) then raise exception 'SHARED_REFUND_CASH_ADMISSION_REQUIRED';end if;
   end if;
   return 'true'::jsonb;
  end $body$
  $definition$;
 end if;
end $context$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_shared_cash_commitments_v1','sales_team_shared_cash_admissions_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated',name);execute format('grant select,insert on public.%I to service_role',name);
  execute format('create trigger immutable_shared_cash before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 grant usage on sequence public.sales_team_shared_cash_commitments_v1_version_seq to service_role;
 for sig in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('begin_sales_team_shared_cash_read_v1','complete_sales_team_cash_read_v1','complete_sales_team_cash_read_before_shared_v1','admit_sales_team_shared_cash_v1','sales_team_shared_cash_admitted_v1','claim_refund_operation','claim_refund_operation_before_team_cash_v1','record_tip_dispute_recovery','record_tip_dispute_before_team_cash_v1','record_tip_dispute_with_cash_v1','run_exact_context_admin_refund_v2','run_exact_refund_before_team_cash_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('shared_cash_source_v1','capture_shared_cash_v1','shared_platform_cash_liabilities_v1','shared_cash_required_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
