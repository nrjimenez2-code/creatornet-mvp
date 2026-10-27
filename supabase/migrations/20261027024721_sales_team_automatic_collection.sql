-- Local candidate. Accepted recurring collection; no scheduler activation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column automatic_collection_enabled boolean not null default false;
alter table public.sales_team_worker_runs_v1 drop constraint sales_team_worker_runs_v1_kind_check;
alter table public.sales_team_worker_runs_v1 add constraint sales_team_worker_runs_v1_kind_check check(kind in ('settlement','reconciliation','surplus','collection'));
alter table public.sales_team_payment_confirmations_v1 drop constraint sales_team_payment_confirmations_v1_kind_check;
alter table public.sales_team_payment_confirmations_v1 add constraint sales_team_payment_confirmations_v1_kind_check check(kind in ('token','reconfirm','saved_method','saved_reconfirm'));
alter table public.sales_team_payment_confirmations_v1 add column saved_method_consent_id uuid references public.sales_team_saved_methods_v1(consent_id) on delete restrict;
alter table public.sales_team_payment_confirmations_v1 add constraint team_saved_confirmation_source_v1 check((kind in ('saved_method','saved_reconfirm'))=(saved_method_consent_id is not null));
create table public.sales_team_collection_runs_v1 (
 run_id uuid primary key references public.sales_team_worker_runs_v1(id) on delete restrict,
 lease_token uuid not null default gen_random_uuid(),context jsonb not null,allow_new boolean not null,
 contract_sha256 text not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_automatic_collections_v1 (
 obligation_id uuid primary key references public.sales_team_payment_obligations_v1(id) on delete restrict,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 consent_id uuid not null references public.sales_team_saved_methods_v1(consent_id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_collection_runs_v1(run_id) on delete restrict,
 request_id uuid not null unique default gen_random_uuid(),context jsonb not null,basis jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create index team_automatic_collection_sale_v1 on public.sales_team_automatic_collections_v1(sale_id,created_at);
create table public.sales_team_collection_tasks_v1 (
 id uuid primary key default gen_random_uuid(),run_id uuid not null references public.sales_team_collection_runs_v1(run_id) on delete restrict,
 obligation_id uuid not null references public.sales_team_automatic_collections_v1(obligation_id) on delete restrict,
 kind text not null check(kind in ('original','new')),created_at timestamptz not null default clock_timestamp(),unique(run_id,obligation_id)
);
create table public.sales_team_collection_task_results_v1 (
 task_id uuid primary key references public.sales_team_collection_tasks_v1(id) on delete restrict,
 held boolean not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_automatic_method_checks_v1 (
 id uuid primary key,obligation_id uuid not null references public.sales_team_automatic_collections_v1(obligation_id) on delete restrict,
 task_id uuid unique references public.sales_team_collection_tasks_v1(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_automatic_manual_handoffs_v1 (
 obligation_id uuid primary key references public.sales_team_automatic_collections_v1(obligation_id) on delete restrict,
 request_id uuid not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_saved_confirmation_events_v1 (
 operation_id uuid primary key references public.sales_team_provider_operations_v1(id) on delete restrict,
 event_id text not null unique check(event_id~'^evt_[A-Za-z0-9]+$'),original_request_id text not null check(original_request_id~'^req_[A-Za-z0-9]+$'),
 proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create function creatornet_team_private.team_saved_authority_json_v1(p_consent_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select jsonb_build_object('consentId',consent.id,'saleId',consent.sale_id,'buyerId',consent.buyer_id,'context',consent.context,'termsFingerprint',consent.agreement_fingerprint,
 'customerId',method.customer_id,'paymentMethodId',method.payment_method_id,'cardHash',method.card_hash,'tokenId',consent.token_id,'tokenProof',consent.token_proof,
 'receiptId',method.receipt_id,'confirmationOperationId',method.confirmation_operation_id,'automaticAuthorized',consent.automatic_authorized)
 from public.sales_team_saved_method_consents_v1 consent join public.sales_team_saved_methods_v1 method on method.consent_id=consent.id
 join public.sales_team_capture_provenance_v1 capture on capture.receipt_id=method.receipt_id and capture.confirmation_operation_id=method.confirmation_operation_id
 where consent.id=p_consent_id
$$;
create function creatornet_team_private.team_current_automatic_authority_v1(p_sale_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare consent_id uuid;begin
 -- The latest paid card owns future authority. Never fall back past a manual
 -- payment whose new card has no checked written permission.
 select case when confirmation.kind in ('saved_method','saved_reconfirm') then confirmation.saved_method_consent_id else consent.id end into consent_id
 from public.sales_team_payment_runtime_v1 runtime join public.sales_team_payment_obligations_v1 obligation on obligation.sale_id=runtime.sale_id and obligation.period_number=runtime.covered_periods and obligation.status='paid' and obligation.payment_kind='payment'
 join public.sales_team_receipts_v1 receipt on receipt.obligation_id=obligation.id and receipt.sale_id=runtime.sale_id
 join public.sales_team_capture_provenance_v1 capture on capture.receipt_id=receipt.id and capture.obligation_id=obligation.id
 join public.sales_team_payment_confirmations_v1 confirmation on confirmation.operation_id=capture.confirmation_operation_id and confirmation.obligation_id=obligation.id
 left join public.sales_team_saved_method_consents_v1 consent on consent.obligation_id=obligation.id and consent.token_id=confirmation.token_id and consent.token_proof=confirmation.token_proof
 where runtime.sale_id=p_sale_id;
 return creatornet_team_private.team_saved_authority_json_v1(consent_id);
end $$;
create function creatornet_team_private.guard_team_automatic_manual_handoff_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$begin
 if new.kind='token' and exists(select 1 from public.sales_team_automatic_collections_v1 where obligation_id=new.obligation_id) then
  if exists(select 1 from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_provider_operations_v1 operation on operation.id=confirmation.operation_id where confirmation.obligation_id=new.obligation_id and confirmation.kind in ('saved_method','saved_reconfirm') and operation.status<>'bound') then raise exception 'ORIGINAL_TEAM_SAVED_CONFIRMATION_NEEDS_RECONCILIATION';end if;
  insert into public.sales_team_automatic_manual_handoffs_v1(obligation_id,request_id) values(new.obligation_id,new.request_id) on conflict(obligation_id) do nothing;
 end if;return new;
end $$;
create trigger team_automatic_manual_handoff_v1 before insert on public.sales_team_payment_confirmations_v1 for each row execute function creatornet_team_private.guard_team_automatic_manual_handoff_v1();
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_before_automatic_collection_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare target uuid;automatic public.sales_team_automatic_collections_v1;confirmation public.sales_team_payment_confirmations_v1;legacy_scope jsonb;begin
 if p_scope->>'kind' not in ('intent','confirmation','cancellation') then return public.sales_team_operation_before_automatic_collection_v1(p_scope,p_context);end if;
 if p_scope->>'kind' in ('intent','cancellation') then select obligation_id into target from public.sales_team_payment_attempts_v1 where sale_id=(p_scope->>'saleId')::uuid and (case when p_scope->>'kind'='intent' then 'intent:' else 'cancel:' end)||obligation_id::text=p_scope->>'scopeKey';
 else select * into confirmation from public.sales_team_payment_confirmations_v1 where obligation_id in (select obligation_id from public.sales_team_payment_attempts_v1 where sale_id=(p_scope->>'saleId')::uuid) and 'confirm:'||request_id::text=p_scope->>'scopeKey';target:=confirmation.obligation_id;end if;
 select * into automatic from public.sales_team_automatic_collections_v1 where obligation_id=target;
 if automatic.obligation_id is null then return public.sales_team_operation_before_automatic_collection_v1(p_scope,p_context);end if;
 if p_scope->>'kind'='intent' and exists(select 1 from public.sales_team_automatic_manual_handoffs_v1 where obligation_id=target) then
  return p_scope->>'workerRunId'=automatic.worker_run_id::text and public.sales_team_operation_before_automatic_collection_v1(jsonb_set(p_scope,'{workerRunId}','null'::jsonb),p_context);
 end if;
 if p_scope->>'kind'='intent' or confirmation.kind='saved_method' then
  if p_scope->>'workerRunId' is distinct from automatic.worker_run_id::text or not creatornet_team_private.team_automatic_dispatch_ready_v1(target,p_context) then return false;end if;
  legacy_scope:=jsonb_set(p_scope,'{workerRunId}','null'::jsonb);
  if p_scope->>'kind'='intent' then return public.sales_team_operation_before_automatic_collection_v1(legacy_scope,p_context);end if;
  return public.sales_team_operation_before_saved_method_v1(legacy_scope,p_context) and confirmation.saved_method_consent_id=automatic.consent_id and confirmation.request_id=automatic.request_id;
 end if;
 if confirmation.kind='saved_reconfirm' then
  return p_scope->>'workerRunId' is null and confirmation.saved_method_consent_id=automatic.consent_id and public.sales_team_operation_before_saved_method_v1(p_scope,p_context) and
   exists(select 1 from public.sales_team_controls_v1 where singleton and saved_method_enabled) and
   exists(select 1 from public.sales_team_automatic_method_checks_v1 where id=confirmation.request_id and obligation_id=target and task_id is null and created_at>clock_timestamp()-interval '30 seconds');
 end if;
 return public.sales_team_operation_before_automatic_collection_v1(p_scope,p_context);
end $$;
alter function public.read_sales_team_period_payment_v1(uuid,uuid,uuid) rename to read_team_period_before_automatic_v1;
create function public.read_sales_team_period_payment_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;automatic public.sales_team_automatic_collections_v1;begin
 result:=public.read_team_period_before_automatic_v1(p_sale_id,p_buyer_id,p_obligation_id);
 select * into automatic from public.sales_team_automatic_collections_v1 where obligation_id=p_obligation_id and sale_id=p_sale_id and buyer_id=p_buyer_id;
 if automatic.obligation_id is not null then result:=result||jsonb_build_object('automatic_worker_run_id',automatic.worker_run_id,'manual_collection_handoff',exists(select 1 from public.sales_team_automatic_manual_handoffs_v1 where obligation_id=automatic.obligation_id));end if;return result;
end $$;
alter function public.read_sales_team_capture_source_v1(uuid,uuid,uuid) rename to read_team_capture_before_automatic_v1;
create function public.read_sales_team_capture_source_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;begin
 result:=public.read_team_capture_before_automatic_v1(p_sale_id,p_buyer_id,p_obligation_id);
 if result->'confirmation'->>'kind' in ('saved_method','saved_reconfirm') then
  result:=jsonb_set(result,'{confirmation,savedMethod}',creatornet_team_private.team_saved_authority_json_v1((result->'confirmation'->>'saved_method_consent_id')::uuid));
 end if;return result;
end $$;
alter function public.record_verified_sales_team_capture_v1(uuid,uuid,uuid,uuid,jsonb) rename to record_team_capture_before_automatic_v1;
create function public.record_verified_sales_team_capture_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid,p_confirmation_id uuid,p_capture jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare confirmation public.sales_team_payment_confirmations_v1;automatic public.sales_team_automatic_collections_v1;begin
 select * into confirmation from public.sales_team_payment_confirmations_v1 where operation_id=p_confirmation_id and obligation_id=p_obligation_id;
 if confirmation.kind in ('saved_method','saved_reconfirm') then
  select * into automatic from public.sales_team_automatic_collections_v1 where obligation_id=p_obligation_id and sale_id=p_sale_id and buyer_id=p_buyer_id;
  if automatic.obligation_id is null or automatic.consent_id is distinct from confirmation.saved_method_consent_id or creatornet_team_private.team_saved_authority_json_v1(automatic.consent_id) is distinct from automatic.basis->'authority' then raise exception 'ORIGINAL_ACCEPTED_SAVED_METHOD_CAPTURE_REQUIRED';end if;
 end if;
 return public.record_team_capture_before_automatic_v1(p_sale_id,p_buyer_id,p_obligation_id,p_confirmation_id,p_capture);
end $$;
revoke all on function public.record_team_capture_before_automatic_v1(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.finish_sales_team_collection_task_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_held boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare held boolean;begin
 if not exists(select 1 from public.sales_team_collection_runs_v1 run join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context and worker.kind='collection' and worker.status='running') then raise exception 'ORIGINAL_TEAM_COLLECTION_RUN_REQUIRED';end if;
 if not exists(select 1 from public.sales_team_collection_tasks_v1 where id=p_task_id and run_id=p_run_id) then raise exception 'ORIGINAL_TEAM_COLLECTION_TASK_REQUIRED';end if;
 held:=p_held is distinct from false or not exists(select 1 from public.sales_team_collection_tasks_v1 task join public.sales_team_receipts_v1 receipt on receipt.obligation_id=task.obligation_id join public.sales_team_shared_receipts_v1 shared on shared.receipt_id=receipt.id where task.id=p_task_id);
 insert into public.sales_team_collection_task_results_v1(task_id,held) values(p_task_id,held) on conflict(task_id) do nothing;
 return (select jsonb_build_object('held',result.held) from public.sales_team_collection_task_results_v1 result where task_id=p_task_id);
end $$;
create function public.finish_sales_team_collection_run_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_failed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_status text;begin
 if not exists(select 1 from public.sales_team_collection_runs_v1 run join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context and worker.kind='collection' and worker.status='running') then raise exception 'ORIGINAL_TEAM_COLLECTION_RUN_REQUIRED';end if;
 v_status:=case when p_failed is distinct from false or exists(select 1 from public.sales_team_collection_tasks_v1 task left join public.sales_team_collection_task_results_v1 result on result.task_id=task.id where task.run_id=p_run_id and (result.task_id is null or result.held)) then 'review_required' else 'complete' end;
 update public.sales_team_worker_runs_v1 set status=v_status,finished_at=clock_timestamp() where id=p_run_id;
 return jsonb_build_object('status',v_status);
end $$;
create function creatornet_team_private.team_automatic_financial_ready_v1(p_sale_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_sale_agreements_v1 a
 join public.sales_team_sale_requests_v1 sale on sale.id=a.id and sale.status='accepted'
 join public.sales_team_purchase_admissions_v1 admission on admission.sale_id=a.id and admission.status='active'
 join public.sales_team_payment_runtime_v1 runtime on runtime.sale_id=a.id and runtime.stop_requested_at is null and runtime.canceled_at is null and not runtime.financial_hold
 join public.sales_team_controls_v1 controls on controls.singleton and controls.automatic_collection_enabled and controls.saved_method_enabled and controls.later_collection_enabled and controls.payment_collection_enabled and controls.receipt_recording_enabled and controls.fulfillment_enabled and controls.event_reconciliation_enabled and controls.financial_reconciliation_enabled
 join public.sales_team_financial_config_v1 config on config.singleton and config.context=p_context and config.actual_pricing_verified and config.reserves_verified and config.disclosures_approved
 where a.id=p_sale_id and a.context=p_context and creatornet_team_private.later_payment_schedule_v1(a.id) is not null and
 not exists(select 1 from public.sales_team_payoff_agreements_v1 where sale_id=a.id) and
 not exists(select 1 from public.sales_team_receipts_v1 receipt where receipt.sale_id=a.id and (receipt.review_hold or receipt.dispute_hold or receipt.refunded_subtotal_cents>0 or receipt.confirmed_loss_subtotal_cents>0 or not exists(select 1 from public.sales_team_shared_receipts_v1 where receipt_id=receipt.id))) and
 not exists(select 1 from public.sales_team_payment_events_v1 event where event.sale_id=a.id and not exists(select 1 from public.sales_team_payment_event_results_v1 result where result.event_id=event.event_id)) and
 not exists(select 1 from public.sales_team_financial_checks_v1 checkup join public.sales_team_receipts_v1 receipt on receipt.id=checkup.receipt_id where receipt.sale_id=a.id and not exists(select 1 from public.sales_team_financial_check_results_v1 result where result.check_id=checkup.id)))
$$;
create function creatornet_team_private.team_collection_worker_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$begin
 if not exists(select 1 from public.sales_team_collection_runs_v1 run join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id
 where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1() and worker.kind='collection' and worker.status='running' and worker.lease_until>clock_timestamp()) then raise exception 'CURRENT_TEAM_COLLECTION_WORKER_REQUIRED';end if;
end $$;
create function public.claim_sales_team_collection_run_v1(p_run_id uuid,p_context jsonb,p_new boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare slot timestamptz;run public.sales_team_collection_runs_v1;begin
 if p_run_id is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'TEAM_COLLECTION_CONTEXT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-collection-v1',0));
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='collection' and status='running' and lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 if not exists(select 1 from public.sales_team_automatic_collections_v1 automatic where automatic.context=p_context and not exists(select 1 from public.sales_team_receipts_v1 receipt join public.sales_team_shared_receipts_v1 shared on shared.receipt_id=receipt.id where receipt.obligation_id=automatic.obligation_id)) and
  not (p_new is true and exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_collection_enabled and saved_method_enabled)) then return jsonb_build_object('status','held');end if;
 slot:=date_bin(interval '15 minutes',clock_timestamp(),'2000-01-01'::timestamptz);
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='collection' and scheduled_slot=slot) then return jsonb_build_object('status','slot_consumed');end if;
 insert into public.sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values(p_run_id,'collection',slot,clock_timestamp()+interval '90 seconds','running');
 insert into public.sales_team_collection_runs_v1(run_id,context,allow_new,contract_sha256) values(p_run_id,p_context,p_new is true and exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_collection_enabled and saved_method_enabled),creatornet_team_private.transfer_contract_digest_v1()) returning * into run;
 return jsonb_build_object('status','claimed','runId',run.run_id,'leaseToken',run.lease_token);
end $$;
create function public.next_sales_team_collection_task_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_new boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare task public.sales_team_collection_tasks_v1;automatic public.sales_team_automatic_collections_v1;agreement public.sales_team_sale_agreements_v1;runtime public.sales_team_payment_runtime_v1;obligation public.sales_team_payment_obligations_v1;authority jsonb;schedule jsonb;expiry timestamptz;allow_new boolean;begin
 perform creatornet_team_private.team_collection_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-team-collection-v1',0));
 select * into task from public.sales_team_collection_tasks_v1 t where t.run_id=p_run_id and not exists(select 1 from public.sales_team_collection_task_results_v1 where task_id=t.id) order by t.created_at,t.id limit 1;
 if task.id is not null then return to_jsonb(task);end if;
 if (select count(*) from public.sales_team_collection_tasks_v1 where run_id=p_run_id)>=3 then return null;end if;
 select p_new is true and run.allow_new into allow_new from public.sales_team_collection_runs_v1 run where run_id=p_run_id;
 -- Two originals retain priority; a third slot can admit a due accepted period.
 if (select count(*) from public.sales_team_collection_tasks_v1 where run_id=p_run_id and kind='original')<2 or not allow_new then
  select * into automatic from public.sales_team_automatic_collections_v1 candidate where candidate.context=p_context and
   not exists(select 1 from public.sales_team_collection_tasks_v1 where run_id=p_run_id and obligation_id=candidate.obligation_id) and
   not exists(select 1 from public.sales_team_collection_retries_v1 retry where retry.original_obligation_id=candidate.obligation_id and creatornet_team_private.team_closed_collection_retained_v1(candidate.obligation_id,retry.basis->'closure')) and
   not exists(select 1 from public.sales_team_receipts_v1 receipt join public.sales_team_shared_receipts_v1 shared on shared.receipt_id=receipt.id where receipt.obligation_id=candidate.obligation_id)
   order by (select max(created_at) from public.sales_team_collection_tasks_v1 where obligation_id=candidate.obligation_id) nulls first,candidate.created_at,candidate.obligation_id limit 1;
 end if;
 if automatic.obligation_id is null and allow_new then
  select * into agreement from public.sales_team_sale_agreements_v1 candidate where candidate.context=p_context and creatornet_team_private.team_automatic_financial_ready_v1(candidate.id,p_context) and
   creatornet_team_private.team_current_automatic_authority_v1(candidate.id)->'automaticAuthorized'='true'::jsonb and
   creatornet_team_private.later_payment_schedule_v1(candidate.id)->>'status' is distinct from 'complete' and
   (creatornet_team_private.later_payment_schedule_v1(candidate.id)->>'dueAt')::timestamptz<=clock_timestamp() and
   not exists(select 1 from public.sales_team_payment_obligations_v1 existing_obligation join public.sales_team_payment_runtime_v1 current_runtime on current_runtime.sale_id=existing_obligation.sale_id where existing_obligation.sale_id=candidate.id and existing_obligation.period_number=current_runtime.covered_periods+1)
   order by (creatornet_team_private.later_payment_schedule_v1(candidate.id)->>'dueAt')::timestamptz,candidate.id limit 1;
  if agreement.id is not null then
   perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||agreement.creator_id::text,0));
   select * into runtime from public.sales_team_payment_runtime_v1 where sale_id=agreement.id for update;
   schedule:=creatornet_team_private.later_payment_schedule_v1(agreement.id);authority:=creatornet_team_private.team_current_automatic_authority_v1(agreement.id);
   if not creatornet_team_private.team_automatic_financial_ready_v1(agreement.id,p_context) or authority->'automaticAuthorized' is distinct from 'true'::jsonb or authority->>'customerId' is distinct from runtime.customer_id or authority->>'termsFingerprint' is distinct from agreement.fingerprint or authority->'context' is distinct from p_context or schedule->>'status'='complete' or
    exists(select 1 from public.sales_team_payment_obligations_v1 where sale_id=agreement.id and period_number=runtime.covered_periods+1) then raise exception 'CURRENT_ACCEPTED_AUTOMATIC_TEAM_PAYMENT_REQUIRED';end if;
   expiry:=date_trunc('second',clock_timestamp())+interval '24 hours';if agreement.terms->>'paymentKind'='monthly' then expiry:=least(expiry,creatornet_team_private.team_month_boundary_v1(runtime.anchor_at,runtime.covered_periods+1));end if;
   if expiry<=clock_timestamp() then return null;end if;
   insert into public.sales_team_payment_obligations_v1(id,sale_id,period_number,amount_cents,due_at) values(gen_random_uuid(),agreement.id,runtime.covered_periods+1,(schedule->>'amountCents')::integer,(schedule->>'dueAt')::timestamptz) returning * into obligation;
   insert into public.sales_team_later_payment_windows_v1(obligation_id,sale_id,buyer_id,anchor_at,due_at,expires_at,context) values(obligation.id,agreement.id,agreement.buyer_id,runtime.anchor_at,obligation.due_at,expiry,p_context);
   insert into public.sales_team_automatic_collections_v1(obligation_id,sale_id,buyer_id,consent_id,worker_run_id,context,basis) values(obligation.id,agreement.id,agreement.buyer_id,(authority->>'consentId')::uuid,p_run_id,p_context,
    jsonb_build_object('authority',authority,'schedule',schedule,'anchorAt',runtime.anchor_at,'coveredPeriods',runtime.covered_periods,'agreementFingerprint',agreement.fingerprint)) returning * into automatic;
   if not creatornet_team_private.later_payment_admitted_v1(obligation.id,p_context) or not creatornet_team_private.team_automatic_financial_ready_v1(agreement.id,p_context) then raise exception 'AUTOMATIC_TEAM_COLLECTION_HELD';end if;
  end if;
 end if;
 if automatic.obligation_id is null then return null;end if;
 insert into public.sales_team_collection_tasks_v1(run_id,obligation_id,kind) values(p_run_id,automatic.obligation_id,case when automatic.worker_run_id=p_run_id then 'new' else 'original' end) returning * into task;
 return to_jsonb(task);
end $$;
create function public.read_sales_team_automatic_collection_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare automatic public.sales_team_automatic_collections_v1;begin
 select * into automatic from public.sales_team_automatic_collections_v1 where obligation_id=p_obligation_id and sale_id=p_sale_id and buyer_id=p_buyer_id;
 if automatic.obligation_id is null then raise exception 'OWNED_AUTOMATIC_TEAM_PAYMENT_REQUIRED';end if;
 return jsonb_build_object('payment',public.read_sales_team_period_payment_v1(p_sale_id,p_buyer_id,p_obligation_id),'automatic',to_jsonb(automatic),'authority',creatornet_team_private.team_saved_authority_json_v1(automatic.consent_id));
end $$;
create function public.record_sales_team_automatic_method_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid,p_check_id uuid,p_proof jsonb,p_run_id uuid default null,p_lease_token uuid default null,p_task_id uuid default null)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare automatic public.sales_team_automatic_collections_v1;authority jsonb;begin
 select * into automatic from public.sales_team_automatic_collections_v1 where obligation_id=p_obligation_id and sale_id=p_sale_id and buyer_id=p_buyer_id;
 if automatic.obligation_id is null then raise exception 'OWNED_AUTOMATIC_TEAM_PAYMENT_REQUIRED';end if;
 if p_task_id is not null then
  perform creatornet_team_private.team_collection_worker_v1(p_run_id,p_lease_token,automatic.context);
  if p_check_id<>p_task_id or not exists(select 1 from public.sales_team_collection_tasks_v1 where id=p_task_id and run_id=p_run_id and obligation_id=automatic.obligation_id) then raise exception 'CURRENT_TEAM_COLLECTION_TASK_REQUIRED';end if;
 elsif p_run_id is not null or p_lease_token is not null then raise exception 'EXPLICIT_BUYER_COLLECTION_CHECK_REQUIRED';end if;
 authority:=creatornet_team_private.team_saved_authority_json_v1(automatic.consent_id);
 if authority is null or p_proof->'context' is distinct from automatic.context or p_proof->>'consentId' is distinct from authority->>'consentId' or p_proof->>'customerId' is distinct from authority->>'customerId' or p_proof->>'paymentMethodId' is distinct from authority->>'paymentMethodId' or p_proof->>'cardHash' is distinct from authority->>'cardHash' or p_proof->>'country' is distinct from 'US' or coalesce(p_proof->>'providerRequestId','')!~'^req_[A-Za-z0-9]+$' or
  coalesce((p_proof->>'readStartedAt')::bigint,0)<extract(epoch from clock_timestamp())*1000-30000 or (p_proof->>'readStartedAt')::bigint>extract(epoch from clock_timestamp())*1000+1000 or coalesce((p_proof->>'observedAt')::bigint,0)<extract(epoch from clock_timestamp())-30 or (p_proof->>'observedAt')::bigint>extract(epoch from clock_timestamp())+1 then raise exception 'CURRENT_TEAM_SAVED_CARD_REQUIRED';end if;
 if exists(select 1 from public.sales_team_automatic_method_checks_v1 where id=p_check_id) then raise exception 'ORIGINAL_TEAM_METHOD_CHECK_REQUIRED';end if;
 insert into public.sales_team_automatic_method_checks_v1(id,obligation_id,task_id,buyer_id,proof) values(p_check_id,p_obligation_id,p_task_id,p_buyer_id,p_proof);
end $$;
create function creatornet_team_private.team_automatic_dispatch_ready_v1(p_obligation_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_automatic_collections_v1 automatic join public.sales_team_payment_runtime_v1 runtime on runtime.sale_id=automatic.sale_id
 join public.sales_team_collection_tasks_v1 task on task.obligation_id=automatic.obligation_id
 join public.sales_team_collection_runs_v1 run on run.run_id=task.run_id and run.allow_new and run.context=automatic.context
 join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id and worker.kind='collection' and worker.status='running' and worker.lease_until>clock_timestamp()
 join public.sales_team_automatic_method_checks_v1 checked on checked.task_id=task.id and checked.obligation_id=automatic.obligation_id and checked.created_at>clock_timestamp()-interval '30 seconds'
 where automatic.obligation_id=p_obligation_id and automatic.context=p_context and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1() and
  runtime.anchor_at is not distinct from (automatic.basis->>'anchorAt')::timestamptz and runtime.covered_periods=(automatic.basis->>'coveredPeriods')::integer and
  creatornet_team_private.team_current_automatic_authority_v1(automatic.sale_id)=automatic.basis->'authority' and creatornet_team_private.team_automatic_financial_ready_v1(automatic.sale_id,p_context) and creatornet_team_private.later_payment_admitted_v1(automatic.obligation_id,p_context) and
  not exists(select 1 from public.sales_team_collection_task_results_v1 where task_id=task.id) and not exists(select 1 from public.sales_team_automatic_manual_handoffs_v1 where obligation_id=automatic.obligation_id))
$$;
create function public.reserve_sales_team_saved_confirmation_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid,p_request_id uuid,p_operation_id uuid,p_check_id uuid,p_on_session boolean,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare automatic public.sales_team_automatic_collections_v1;a public.sales_team_sale_agreements_v1;t public.sales_team_payment_attempts_v1;s public.sales_team_payment_states_v1;c public.sales_team_payment_confirmations_v1;prev public.sales_team_payment_confirmations_v1;authority jsonb;expected jsonb;begin
 select * into automatic from public.sales_team_automatic_collections_v1 where obligation_id=p_obligation_id and sale_id=p_sale_id and buyer_id=p_buyer_id;
 select * into a from public.sales_team_sale_agreements_v1 where id=automatic.sale_id and buyer_id=p_buyer_id;
 if a.id is null or p_on_session is null then raise exception 'OWNED_AUTOMATIC_TEAM_PAYMENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into c from public.sales_team_payment_confirmations_v1 where obligation_id=p_obligation_id and request_id=p_request_id;
 if c.operation_id is not null then if c.operation_id<>p_operation_id or c.kind<>(case when p_on_session then 'saved_reconfirm' else 'saved_method' end) or c.request is distinct from p_request or c.saved_method_consent_id<>automatic.consent_id then raise exception 'ORIGINAL_TEAM_SAVED_CONFIRMATION_REQUIRED';end if;return to_jsonb(c);end if;
 select * into t from public.sales_team_payment_attempts_v1 where obligation_id=p_obligation_id and sale_id=a.id;
 select * into s from public.sales_team_payment_states_v1 where obligation_id=t.obligation_id order by observed_at desc,id desc limit 1;
 select * into prev from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id order by step_number desc limit 1;
 authority:=creatornet_team_private.team_saved_authority_json_v1(automatic.consent_id);
 if t.obligation_id is null or authority is null or not creatornet_team_private.later_payment_admitted_v1(t.obligation_id,a.context) or s.id is null or s.observed_at<=clock_timestamp()-interval '30 seconds' or
  not exists(select 1 from public.sales_team_provider_operations_v1 where id=t.intent_operation_id and status='bound' and provider_id=s.payment_intent_id) or
  not exists(select 1 from public.sales_team_automatic_method_checks_v1 checked where checked.id=p_check_id and checked.obligation_id=t.obligation_id and checked.buyer_id=a.buyer_id and checked.created_at>clock_timestamp()-interval '30 seconds' and (not p_on_session or checked.task_id is null and checked.id=p_request_id)) or
  prev.operation_id is not null and not exists(select 1 from public.sales_team_provider_operations_v1 where id=prev.operation_id and status='bound' and bound_at<=s.observed_at) or coalesce(prev.step_number,0)>=10 then raise exception 'ORIGINAL_TEAM_SAVED_CONFIRMATION_NEEDS_RECONCILIATION';end if;
 if p_on_session then
  if not (s.status='requires_confirmation' or s.status='requires_payment_method' and s.proof->'authenticationRequired'='true'::jsonb and s.proof->'unpaidMethod'='true'::jsonb) or prev.operation_id is null or prev.kind not in ('saved_method','saved_reconfirm') or s.proof->>'authorizedPaymentMethodId' is distinct from authority->>'paymentMethodId' or s.proof->>'authorizedSavedMethodConsentId' is distinct from automatic.consent_id::text then raise exception 'EXPLICIT_TEAM_SAVED_RECONFIRMATION_REQUIRED';end if;
  expected:=jsonb_build_object('use_stripe_sdk',true,'return_url',(a.context->>'siteOrigin')||'/purchase/team/'||a.id::text);
  if s.status='requires_payment_method' then expected:=expected||jsonb_build_object('payment_method',authority->>'paymentMethodId');end if;
 else
  if p_request_id<>automatic.request_id or prev.operation_id is not null or s.status<>'requires_payment_method' or s.proof->'unpaidMethod' is distinct from 'true'::jsonb or not creatornet_team_private.team_automatic_dispatch_ready_v1(t.obligation_id,a.context) then raise exception 'AUTOMATIC_TEAM_COLLECTION_HELD';end if;
  expected:=jsonb_build_object('payment_method',authority->>'paymentMethodId','off_session',true);
 end if;
 expected:=jsonb_build_object('method','POST','apiVersion','2026-08-26.dahlia','path','/v1/payment_intents/'||s.payment_intent_id||'/confirm','params',expected);
 if p_request is distinct from expected then raise exception 'SAVED_TEAM_CONFIRMATION_REQUEST_CHANGED';end if;
 insert into public.sales_team_payment_confirmations_v1(operation_id,obligation_id,request_id,state_id,step_number,kind,token_id,token_proof,request,saved_method_consent_id)
 values(p_operation_id,t.obligation_id,p_request_id,s.id,coalesce(prev.step_number,0)+1,case when p_on_session then 'saved_reconfirm' else 'saved_method' end,authority->>'tokenId',authority->'tokenProof',p_request,automatic.consent_id) returning * into c;return to_jsonb(c);
end $$;
-- Freeze worker identity on the original core journal as well as in TypeScript.
do $worker_identity$ declare src text;needle text;begin
 src:=pg_get_functiondef('public.claim_sales_team_operation_before_refund_v1(uuid,jsonb,jsonb,jsonb)'::regprocedure);
 needle:='v_op.actor_id is distinct from (p_scope->>''actorId'')::uuid';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'AUTOMATIC_COLLECTION_JOURNAL_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||' or v_op.worker_run_id is distinct from (p_scope->>''workerRunId'')::uuid');
end $worker_identity$;
create function public.request_sales_team_manual_collection_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare automatic public.sales_team_automatic_collections_v1;agreement public.sales_team_sale_agreements_v1;attempt public.sales_team_payment_attempts_v1;operation public.sales_team_provider_operations_v1;state public.sales_team_payment_states_v1;begin
 select * into automatic from public.sales_team_automatic_collections_v1 where obligation_id=p_obligation_id and sale_id=p_sale_id and buyer_id=p_buyer_id;
 select * into agreement from public.sales_team_sale_agreements_v1 where id=automatic.sale_id and buyer_id=p_buyer_id;
 if agreement.id is null then raise exception 'OWNED_AUTOMATIC_TEAM_PAYMENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||agreement.creator_id::text,0));
 if exists(select 1 from public.sales_team_automatic_manual_handoffs_v1 where obligation_id=automatic.obligation_id) then return;end if;
 if not creatornet_team_private.later_payment_admitted_v1(automatic.obligation_id,agreement.context) or exists(select 1 from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_provider_operations_v1 op on op.id=confirmation.operation_id where confirmation.obligation_id=automatic.obligation_id and op.status<>'bound') then raise exception 'ORIGINAL_TEAM_PAYMENT_NEEDS_RECONCILIATION';end if;
 select * into attempt from public.sales_team_payment_attempts_v1 where obligation_id=automatic.obligation_id;
 select * into operation from public.sales_team_provider_operations_v1 where sale_id=agreement.id and kind='intent' and scope_key='intent:'||automatic.obligation_id::text;
 if operation.id is not null then
  select * into state from public.sales_team_payment_states_v1 where obligation_id=automatic.obligation_id order by observed_at desc,id desc limit 1;
  if operation.id is distinct from attempt.intent_operation_id or operation.status<>'bound' or state.payment_intent_id is distinct from operation.provider_id or state.status is distinct from 'requires_payment_method' or state.proof->'unpaidMethod' is distinct from 'true'::jsonb or state.observed_at<=clock_timestamp()-interval '30 seconds' then raise exception 'ORIGINAL_TEAM_PAYMENT_NEEDS_RECONCILIATION';end if;
 end if;
 -- The immutable handoff identity is the owned obligation itself. No provider
 -- request/key/customer/intent identity or collection window changes.
 insert into public.sales_team_automatic_manual_handoffs_v1(obligation_id,request_id) values(automatic.obligation_id,automatic.obligation_id);
end $$;
create function public.record_sales_team_saved_confirmation_event_v1(p_operation_id uuid,p_proof jsonb)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare operation public.sales_team_provider_operations_v1;confirmation public.sales_team_payment_confirmations_v1;attempt public.sales_team_payment_attempts_v1;intent public.sales_team_provider_operations_v1;automatic public.sales_team_automatic_collections_v1;begin
 select * into operation from public.sales_team_provider_operations_v1 where id=p_operation_id;
 select * into confirmation from public.sales_team_payment_confirmations_v1 where operation_id=operation.id and kind in ('saved_method','saved_reconfirm');
 select * into attempt from public.sales_team_payment_attempts_v1 where obligation_id=confirmation.obligation_id;
 select * into intent from public.sales_team_provider_operations_v1 where id=attempt.intent_operation_id and status='bound';
 select * into automatic from public.sales_team_automatic_collections_v1 where obligation_id=attempt.obligation_id and consent_id=confirmation.saved_method_consent_id;
 if automatic.obligation_id is null or operation.context is distinct from automatic.context or operation.request is distinct from confirmation.request or
  p_proof->'context' is distinct from automatic.context or p_proof->>'operationId' is distinct from operation.id::text or p_proof->>'obligationId' is distinct from attempt.obligation_id::text or p_proof->>'paymentIntentId' is distinct from intent.provider_id or p_proof->>'idempotencyKey' is distinct from operation.idempotency_key or
  p_proof->'eventAccount' is distinct from 'null'::jsonb or p_proof->'eventLivemode' is distinct from to_jsonb(automatic.context->>'mode'='live') or coalesce(p_proof->>'eventApiVersion','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[a-z0-9_-]+)?$' or
  jsonb_typeof(p_proof->'listRequestIds') is distinct from 'array' or jsonb_array_length(p_proof->'listRequestIds') not between 1 and 3 or exists(select 1 from jsonb_array_elements_text(p_proof->'listRequestIds') item where item!~'^req_[A-Za-z0-9]+$' or item=p_proof->>'originalRequestId' or item=p_proof->>'eventRetrieveRequestId') or
  coalesce(p_proof->>'eventId','')!~'^evt_[A-Za-z0-9]+$' or coalesce(p_proof->>'originalRequestId','')!~'^req_[A-Za-z0-9]+$' or coalesce(p_proof->>'eventRetrieveRequestId','')!~'^req_[A-Za-z0-9]+$' or p_proof->>'eventRetrieveRequestId'=p_proof->>'originalRequestId' or
  coalesce(p_proof->>'eventType','') not in ('payment_intent.payment_failed','payment_intent.requires_action','payment_intent.processing','payment_intent.succeeded','payment_intent.canceled') or
  p_proof->>'eventStatus' is distinct from (case p_proof->>'eventType' when 'payment_intent.payment_failed' then 'requires_payment_method' when 'payment_intent.requires_action' then 'requires_action' when 'payment_intent.processing' then 'processing' when 'payment_intent.succeeded' then 'succeeded' when 'payment_intent.canceled' then 'canceled' end) or
  coalesce((p_proof->>'eventCreated')::bigint,0)<extract(epoch from operation.first_dispatch_at)-5 or (p_proof->>'eventCreated')::bigint>extract(epoch from clock_timestamp())+5 or
  coalesce((p_proof->>'readStartedAt')::bigint,0)<extract(epoch from clock_timestamp())*1000-60000 or (p_proof->>'readStartedAt')::bigint>extract(epoch from clock_timestamp())*1000+1000 or coalesce((p_proof->>'observedAt')::bigint,0)<extract(epoch from clock_timestamp())-30 or (p_proof->>'observedAt')::bigint>extract(epoch from clock_timestamp())+1 then raise exception 'EXACT_ORIGINAL_SAVED_CONFIRMATION_EVENT_REQUIRED';end if;
 insert into public.sales_team_saved_confirmation_events_v1(operation_id,event_id,original_request_id,proof) values(operation.id,p_proof->>'eventId',p_proof->>'originalRequestId',p_proof) on conflict(operation_id) do nothing;
 if not exists(select 1 from public.sales_team_saved_confirmation_events_v1 where operation_id=operation.id and event_id=p_proof->>'eventId' and original_request_id=p_proof->>'originalRequestId') then raise exception 'ORIGINAL_SAVED_CONFIRMATION_EVENT_CHANGED';end if;
end $$;
create function creatornet_team_private.guard_team_saved_confirmation_binding_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$begin
 if new.status='bound' and old.status<>'bound' and (old.status='unknown' or old.lease_until<=clock_timestamp()) and
  exists(select 1 from public.sales_team_payment_confirmations_v1 where operation_id=new.id and kind in ('saved_method','saved_reconfirm')) and
  not exists(select 1 from public.sales_team_saved_confirmation_events_v1 where operation_id=new.id and original_request_id=new.provider_request_id and proof->>'paymentIntentId'=new.provider_id) then raise exception 'EXACT_ORIGINAL_SAVED_CONFIRMATION_EVENT_REQUIRED';end if;
 return new;
end $$;
create trigger team_saved_confirmation_binding_v1 before update on public.sales_team_provider_operations_v1 for each row execute function creatornet_team_private.guard_team_saved_confirmation_binding_v1();
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''team_saved_authority_json_v1'',''team_current_automatic_authority_v1'',''team_automatic_financial_ready_v1'',''team_collection_worker_v1'',''team_automatic_dispatch_ready_v1'',''guard_team_automatic_manual_handoff_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''claim_sales_team_collection_run_v1'',''next_sales_team_collection_task_v1'',''read_sales_team_automatic_collection_v1'',''record_sales_team_automatic_method_v1'',''reserve_sales_team_saved_confirmation_v1'',''finish_sales_team_collection_task_v1'',''finish_sales_team_collection_run_v1'',''sales_team_operation_before_automatic_collection_v1'',''sales_team_operation_admitted_v1'',''read_team_period_before_automatic_v1'',''read_sales_team_period_payment_v1'',''read_team_capture_before_automatic_v1'',''read_sales_team_capture_source_v1'',''record_team_capture_before_automatic_v1'',''record_verified_sales_team_capture_v1'',''claim_sales_team_operation_before_refund_v1''))';
 extra:=extra||' or (p.pronamespace=''public''::regnamespace and p.proname=''record_sales_team_saved_confirmation_event_v1'') or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname=''guard_team_saved_confirmation_binding_v1'')';
 extra:=extra||' or (p.pronamespace=''public''::regnamespace and p.proname=''request_sales_team_manual_collection_v1'')';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'AUTOMATIC_COLLECTION_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
do $security$ declare name text;signature regprocedure;begin
 foreach name in array array['sales_team_collection_runs_v1','sales_team_automatic_collections_v1','sales_team_collection_tasks_v1','sales_team_collection_task_results_v1','sales_team_automatic_method_checks_v1','sales_team_automatic_manual_handoffs_v1','sales_team_saved_confirmation_events_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_team_automatic_collection_v1 before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for signature in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('claim_sales_team_collection_run_v1','next_sales_team_collection_task_v1','read_sales_team_automatic_collection_v1','record_sales_team_automatic_method_v1','reserve_sales_team_saved_confirmation_v1','finish_sales_team_collection_task_v1','finish_sales_team_collection_run_v1','sales_team_operation_before_automatic_collection_v1','sales_team_operation_admitted_v1','read_team_period_before_automatic_v1','read_sales_team_period_payment_v1','read_team_capture_before_automatic_v1','read_sales_team_capture_source_v1','record_verified_sales_team_capture_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('team_saved_authority_json_v1','team_current_automatic_authority_v1','team_automatic_financial_ready_v1','team_collection_worker_v1','team_automatic_dispatch_ready_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',signature);execute format('grant execute on function %s to service_role',signature);
 end loop;
end $security$;
revoke all on function creatornet_team_private.guard_team_automatic_manual_handoff_v1() from public,anon,authenticated,service_role;
revoke all on function public.record_sales_team_saved_confirmation_event_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_sales_team_saved_confirmation_event_v1(uuid,jsonb) to service_role;
revoke all on function public.request_sales_team_manual_collection_v1(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.request_sales_team_manual_collection_v1(uuid,uuid,uuid) to service_role;
revoke all on function creatornet_team_private.guard_team_saved_confirmation_binding_v1() from public,anon,authenticated,service_role;
commit;
