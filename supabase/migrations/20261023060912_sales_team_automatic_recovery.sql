-- Local candidate. Authenticated bounded GET-only inspection, never new money.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column automatic_recovery_enabled boolean not null default false;
alter table public.sales_team_cash_policy_v1 add column recovery_contract_sha256 text check(recovery_contract_sha256~'^[a-f0-9]{64}$');
create table public.sales_team_recovery_runs_v1 (
 run_id uuid primary key references public.sales_team_worker_runs_v1(id) on delete restrict,
 lease_token uuid not null default gen_random_uuid(),context jsonb not null,contract_sha256 text not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_recovery_tasks_v1 (
 id uuid primary key default gen_random_uuid(),run_id uuid not null references public.sales_team_recovery_runs_v1(run_id) on delete restrict,
 kind text not null check(kind in ('financial','event','shared_cash','recipient','fulfillment')),source_id text not null,source jsonb not null,
 created_at timestamptz not null default clock_timestamp(),unique(run_id,kind,source_id)
);
create index sales_team_recovery_source_v1 on public.sales_team_recovery_tasks_v1(kind,source_id,created_at);
create table public.sales_team_recovery_task_results_v1 (
 task_id uuid primary key references public.sales_team_recovery_tasks_v1(id) on delete restrict,
 held boolean not null,code text not null check(code in ('observed','review_required')),created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_financial_check_recoveries_v1 (
 original_check_id uuid primary key references public.sales_team_financial_checks_v1(id) on delete restrict,
 recovery_check_id uuid not null references public.sales_team_financial_check_results_v1(check_id) on delete restrict deferrable initially deferred,
 worker_run_id uuid not null references public.sales_team_recovery_runs_v1(run_id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.sales_team_financial_check_results_v1 add column recovered_by_worker_run_id uuid references public.sales_team_recovery_runs_v1(run_id) on delete restrict,
 add column recovery_check_id uuid references public.sales_team_financial_check_results_v1(check_id) on delete restrict,
 add constraint sales_team_recovered_check_provenance_v1 check((recovered_by_worker_run_id is null)=(recovery_check_id is null));

create function creatornet_team_private.recovery_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid),E'\n' order by p.oid::regprocedure::text collate "C"),'UTF8')),'hex') from pg_proc p
 where (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in ('recovery_contract_digest_v1','recovery_worker_v1','shared_cash_original_v1','shared_cash_trace_v1')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('claim_sales_team_recovery_run_v1','next_sales_team_recovery_task_v1','finish_sales_team_recovery_task_v1','finish_sales_team_recovery_run_v1','begin_sales_team_recovery_financial_v1','complete_sales_team_recovery_financial_v1','observe_sales_team_recovery_recipient_v1','begin_sales_team_financial_check_v1','complete_sales_team_financial_check_v1','begin_sales_team_shared_cash_check_v1','complete_sales_team_shared_cash_check_v1','record_sales_team_recipient_v1','complete_sales_team_payment_event_v1','fulfill_sales_team_receipt_v1'))
$$;
create function creatornet_team_private.recovery_worker_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_recovery_runs_v1 run join public.sales_team_worker_runs_v1 w on w.id=run.run_id
  join public.sales_team_financial_config_v1 f on f.singleton and f.context=run.context join public.sales_team_cash_policy_v1 policy on policy.singleton
  where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context and w.kind='reconciliation' and w.status='running' and w.lease_until>clock_timestamp() and
  run.contract_sha256=policy.recovery_contract_sha256 and run.contract_sha256=creatornet_team_private.recovery_contract_digest_v1()) then raise exception 'CURRENT_RECOVERY_WORKER_REQUIRED';end if;
end $$;
create function public.claim_sales_team_recovery_run_v1(p_run_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_worker public.sales_team_worker_runs_v1;v_run public.sales_team_recovery_runs_v1;slot timestamptz;digest text;begin
 if p_run_id is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'RECOVERY_CONTEXT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-automatic-recovery-v1',0));
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_recovery_enabled) then return jsonb_build_object('status','held');end if;
 digest:=creatornet_team_private.recovery_contract_digest_v1();if not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and recovery_contract_sha256=digest) then raise exception 'RECOVERY_CONTRACT_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.sales_team_recovery_runs_v1 run join public.sales_team_worker_runs_v1 w on w.id=run.run_id where w.status='running' and w.lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 slot:=date_bin(interval '15 minutes',clock_timestamp(),'2000-01-01'::timestamptz);
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='reconciliation' and scheduled_slot=slot) then return jsonb_build_object('status','slot_consumed');end if;
 insert into public.sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values(p_run_id,'reconciliation',slot,clock_timestamp()+interval '90 seconds','running') returning * into v_worker;
 insert into public.sales_team_recovery_runs_v1(run_id,context,contract_sha256) values(v_worker.id,p_context,digest) returning * into v_run;
 return jsonb_build_object('status','claimed','runId',v_worker.id,'leaseToken',v_run.lease_token);
end $$;
create function public.next_sales_team_recovery_task_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_fulfill boolean default false)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare task public.sales_team_recovery_tasks_v1;candidate record;begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-automatic-recovery-v1',0));
 if (select count(*) from public.sales_team_recovery_tasks_v1 where run_id=p_run_id)>=3 then return null;end if;
 with candidates as (
  select 'financial'::text kind,r.id::text id,r.observed_at created_at,jsonb_build_object('receiptId',r.id) source from public.sales_team_receipts_v1 r join public.sales_team_sale_agreements_v1 a on a.id=r.sale_id
   where a.context=p_context and exists(select 1 from public.sales_team_financial_checks_v1 c where c.receipt_id=r.id and c.created_at<clock_timestamp()-interval '2 minutes' and not exists(select 1 from public.sales_team_financial_check_results_v1 done where done.check_id=c.id))
  union all
  select 'event',e.event_id,e.created_at,jsonb_build_object('saleId',a.id,'buyerId',a.buyer_id,'obligationId',e.obligation_id,'paymentIntentId',e.payment_intent_id,'context',e.context) from public.sales_team_payment_events_v1 e join public.sales_team_sale_agreements_v1 a on a.id=e.sale_id
   where e.context=p_context and not exists(select 1 from public.sales_team_payment_event_results_v1 done where done.event_id=e.event_id)
  union all
  select 'shared_cash',c.source_kind||':'||c.source_id,c.created_at,jsonb_build_object('kind',c.source_kind,'id',c.source_id) from public.sales_team_shared_cash_commitments_v1 c
   where c.version=(select max(latest.version) from public.sales_team_shared_cash_commitments_v1 latest where latest.source_kind=c.source_kind and latest.source_id=c.source_id) and
   not exists(select 1 from public.sales_team_shared_cash_resolutions_v1 done where done.source_kind=c.source_kind and done.source_id=c.source_id and done.commitment_version=c.version and done.context=p_context) and
   (c.source_kind='legacy_refund' and exists(select 1 from public.refund_operations q where q.id::text=c.source_id and q.status in ('completed','failed') and q.processing_token is null) or
    c.source_kind='tip_restoration' and exists(select 1 from public.tip_dispute_recoveries q join public.tips tip on tip.id=q.tip_id where q.stripe_dispute_id=c.source_id and tip.dispute_status in ('won','lost','prevented','warning_closed')))
  union all
  select 'recipient',s.user_id::text,s.created_at,jsonb_build_object('user_id',s.user_id,'id',s.id,'api',s.api,'account_id',s.account_id,'legacy_creation_key',s.legacy_creation_key,'context',s.context,'request',null) from public.sales_team_recipient_setups_v1 s left join public.sales_team_recipients_v1 r on r.user_id=s.user_id
   where s.context=p_context and s.account_id is not null and public.sales_team_recipient_allowed_v1(s.user_id) and (r.user_id is null or not r.ownership_verified or r.verified_at<clock_timestamp()-interval '10 minutes')
  union all
  select 'fulfillment',r.id::text,r.paid_at,jsonb_build_object('saleId',a.id,'buyerId',a.buyer_id,'receiptId',r.id) from public.sales_team_receipts_v1 r join public.sales_team_sale_agreements_v1 a on a.id=r.sale_id
   where p_fulfill and a.context=p_context and not r.review_hold and not r.dispute_hold and exists(select 1 from public.sales_team_controls_v1 where singleton and fulfillment_enabled) and
   not exists(select 1 from public.sales_team_shared_receipts_v1 delivered where delivered.receipt_id=r.id)
 ) select c.* into candidate from candidates c where not exists(select 1 from public.sales_team_recovery_tasks_v1 seen where seen.run_id=p_run_id and seen.kind=c.kind and seen.source_id=c.id)
 order by (select max(previous.created_at) from public.sales_team_recovery_tasks_v1 previous where previous.kind=c.kind and previous.source_id=c.id) nulls first,c.created_at,c.kind,c.id limit 1;
 if not found then return null;end if;
 insert into public.sales_team_recovery_tasks_v1(run_id,kind,source_id,source) values(p_run_id,candidate.kind,candidate.id,candidate.source) returning * into task;return to_jsonb(task);
end $$;
create function public.finish_sales_team_recovery_task_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_held boolean)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare task public.sales_team_recovery_tasks_v1;begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);
 select * into task from public.sales_team_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id;
 if task.id is null or p_held is null then raise exception 'ORIGINAL_RECOVERY_TASK_REQUIRED';end if;
 if exists(select 1 from public.sales_team_recovery_task_results_v1 where task_id=task.id and held is distinct from p_held) then raise exception 'ORIGINAL_RECOVERY_RESULT_CHANGED';end if;
 if not p_held and not (case task.kind
  when 'financial' then exists(select 1 from public.sales_team_financial_check_results_v1 done join public.sales_team_financial_checks_v1 checked on checked.id=done.check_id join public.sales_team_receipts_v1 receipt on receipt.id=checked.receipt_id where done.check_id=task.id and not receipt.review_hold and not receipt.dispute_hold)
  when 'event' then exists(select 1 from public.sales_team_payment_event_results_v1 done left join public.sales_team_receipts_v1 receipt on receipt.id=done.receipt_id where done.event_id=task.source_id and (done.receipt_id is null or not receipt.review_hold and not receipt.dispute_hold))
  when 'shared_cash' then exists(select 1 from public.sales_team_shared_cash_resolutions_v1 done where done.check_id=task.id and done.context=p_context and done.source_fingerprint=creatornet_team_private.shared_cash_original_v1(done.source_kind,done.source_id,p_context)->>'fingerprint')
  when 'recipient' then exists(select 1 from public.sales_team_recipient_observations_v1 observation join public.sales_team_recipients_v1 recipient on recipient.user_id=observation.user_id where observation.user_id::text=task.source_id and observation.context=p_context and observation.observed_at>=task.created_at and recipient.ownership_verified and recipient.transfers_active and recipient.payouts_ready and recipient.verified_at>=task.created_at)
  when 'fulfillment' then exists(select 1 from public.sales_team_shared_receipts_v1 delivered join public.sales_team_receipts_v1 receipt on receipt.id=delivered.receipt_id where delivered.receipt_id::text=task.source_id and not receipt.review_hold and not receipt.dispute_hold)
  else false end) then raise exception 'COMPLETE_RECOVERY_TASK_PROOF_REQUIRED';end if;
 insert into public.sales_team_recovery_task_results_v1(task_id,held,code) values(p_task_id,p_held,case when p_held then 'review_required' else 'observed' end) on conflict(task_id) do nothing;
 if p_held then
  insert into public.sales_team_financial_alerts_v1(code,source_identity,evidence) values('TEAM_AUTOMATIC_RECOVERY_REVIEW','automatic-recovery:'||task.kind||':'||task.source_id,jsonb_build_object('kind',task.kind,'sourceId',task.source_id,'workerRunId',p_run_id,'taskId',task.id)) on conflict(source_identity) do nothing;
 else
  update public.sales_team_financial_alerts_v1 set status='resolved' where source_identity='automatic-recovery:'||task.kind||':'||task.source_id and code='TEAM_AUTOMATIC_RECOVERY_REVIEW' and status<>'resolved';
 end if;
end $$;
create function public.finish_sales_team_recovery_run_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_failed boolean default false)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);
 update public.sales_team_worker_runs_v1 set status=case when coalesce(p_failed,true) or exists(select 1 from public.sales_team_recovery_tasks_v1 t left join public.sales_team_recovery_task_results_v1 result on result.task_id=t.id where t.run_id=p_run_id and coalesce(result.held,true)) then 'review_required' else 'complete' end,finished_at=clock_timestamp() where id=p_run_id;
end $$;
create function public.begin_sales_team_recovery_financial_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare t public.sales_team_recovery_tasks_v1;begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);select * into t from public.sales_team_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id and kind='financial';
 if t.id is null then raise exception 'ORIGINAL_RECOVERY_TASK_REQUIRED';end if;
 return public.begin_sales_team_financial_check_v1(t.id,(t.source->>'receiptId')::uuid,null,null,p_run_id,p_context);
end $$;
-- Exclude a stale predecessor only inside the transaction that independently
-- completes its actual worker check. A deferred FK requires the result to exist.
do $patch$ declare src text;needle text;begin
 src:=replace(pg_get_functiondef('public.complete_sales_team_financial_check_v1(uuid,integer,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
 needle:='not exists(select 1 from public.sales_team_financial_check_results_v1 cr where cr.check_id=other.id)';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_PENDING_CHECK_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||' and not exists(select 1 from public.sales_team_financial_check_recoveries_v1 recovery where recovery.original_check_id=other.id and recovery.recovery_check_id=c.id)');
end $patch$;
create function public.complete_sales_team_recovery_financial_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_check_id uuid,p_expected_revision integer,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare checked public.sales_team_financial_checks_v1;a public.sales_team_sale_agreements_v1;result jsonb;begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);
 select * into checked from public.sales_team_financial_checks_v1 where id=p_check_id and worker_run_id=p_run_id and context=p_context;
 select sale.* into a from public.sales_team_receipts_v1 receipt join public.sales_team_sale_agreements_v1 sale on sale.id=receipt.sale_id where receipt.id=checked.receipt_id;
 if a.id is null or not exists(select 1 from public.sales_team_recovery_tasks_v1 where id=p_check_id and run_id=p_run_id and kind='financial') then raise exception 'ORIGINAL_RECOVERY_CHECK_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 if not exists(select 1 from public.sales_team_financial_check_results_v1 where check_id=p_check_id) then
  insert into public.sales_team_financial_check_recoveries_v1(original_check_id,recovery_check_id,worker_run_id)
   select old.id,p_check_id,p_run_id from public.sales_team_financial_checks_v1 old join public.sales_team_worker_runs_v1 run on run.id=p_run_id
   where old.receipt_id=checked.receipt_id and old.context=p_context and old.created_at<run.started_at-interval '2 minutes' and
   not exists(select 1 from public.sales_team_financial_check_results_v1 done where done.check_id=old.id) on conflict(original_check_id) do nothing;
 end if;
 result:=public.complete_sales_team_financial_check_v1(p_check_id,p_expected_revision,p_snapshot);
 insert into public.sales_team_financial_check_results_v1(check_id,proof,recovered_by_worker_run_id,recovery_check_id)
  select link.original_check_id,done.proof,p_run_id,done.check_id from public.sales_team_financial_check_recoveries_v1 link join public.sales_team_financial_check_results_v1 done on done.check_id=link.recovery_check_id
  where link.recovery_check_id=p_check_id and link.worker_run_id=p_run_id on conflict(check_id) do nothing;
 return result;
end $$;
create function public.observe_sales_team_recovery_recipient_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_observation jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare t public.sales_team_recovery_tasks_v1;begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);select * into t from public.sales_team_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id and kind='recipient';
 if t.id is null or t.source->>'account_id' is null then raise exception 'ORIGINAL_RECOVERY_RECIPIENT_REQUIRED';end if;
 if p_observation is null then
  update public.sales_team_recipients_v1 set ownership_verified=false,transfers_active=false,payouts_ready=false,evidence=jsonb_build_object('code','CURRENT_VERIFICATION_REQUIRED','workerRunId',p_run_id),updated_at=clock_timestamp()
   where user_id=t.source_id::uuid and account_id=t.source->>'account_id' and mode=p_context->>'mode' and platform_account_id=p_context->>'platformAccountId';return;
 end if;
 if p_observation->>'accountId' is distinct from t.source->>'account_id' then raise exception 'ORIGINAL_RECOVERY_RECIPIENT_REQUIRED';end if;
 -- The old parameter names the target payee. Caller authority comes from the
 -- actual worker/token above; this task records who performed the observation.
 perform public.record_sales_team_recipient_v1(t.source_id::uuid,p_context,p_observation);
end $$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_recovery_runs_v1','sales_team_recovery_tasks_v1','sales_team_recovery_task_results_v1','sales_team_financial_check_recoveries_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated',name);execute format('grant select,insert on public.%I to service_role',name);
  execute format('create trigger immutable_recovery_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('claim_sales_team_recovery_run_v1','next_sales_team_recovery_task_v1','finish_sales_team_recovery_task_v1','finish_sales_team_recovery_run_v1','begin_sales_team_recovery_financial_v1','complete_sales_team_recovery_financial_v1','observe_sales_team_recovery_recipient_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('recovery_worker_v1','recovery_contract_digest_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
