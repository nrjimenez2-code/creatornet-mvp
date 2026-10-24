-- Local candidate: bounded autonomous settlement, no scheduler activation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column automatic_settlement_enabled boolean not null default false;
create table public.sales_team_automatic_settlement_runs_v1 (
 run_id uuid primary key references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 allow_new boolean not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_settlement_plans_v1 (
 id uuid primary key default gen_random_uuid(),run_id uuid not null references public.sales_team_automatic_settlement_runs_v1(run_id) on delete restrict,
 kind text not null check(kind in ('original','earned')),receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 beneficiary text not null check(beneficiary in ('creator','closer')),request_id uuid not null,task_id uuid not null unique,
 financial_check_id uuid not null unique default gen_random_uuid(),transfer_check_id uuid not null unique default gen_random_uuid(),
 recipient_user_id uuid not null references auth.users(id) on delete restrict,recipient_id text not null,recipient_source jsonb,
 source_ready boolean not null,created_at timestamptz not null default clock_timestamp(),unique(run_id,receipt_id)
);
create index sales_team_settlement_plan_original_v1 on public.sales_team_settlement_plans_v1(request_id,created_at);
create table public.sales_team_settlement_plan_results_v1 (
 plan_id uuid primary key references public.sales_team_settlement_plans_v1(id) on delete restrict,
 held boolean not null,code text not null check(code in ('settled','canceled','review_required')),created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_settlement_financial_links_v1 (
 check_id uuid primary key references public.sales_team_financial_checks_v1(id) on delete restrict deferrable initially deferred,
 plan_id uuid not null unique references public.sales_team_settlement_plans_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict
);
create table public.sales_team_settlement_recipient_checks_v1 (
 plan_id uuid primary key references public.sales_team_settlement_plans_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 user_id uuid not null references auth.users(id) on delete restrict,first_request_id text,second_request_id text,observation jsonb,
 created_at timestamptz not null default clock_timestamp()
);
-- F10 saves its hold at independent capture verification, which can be later
-- than the provider's payment second. Retain that exact saved hold and bind its
-- bounds to the immutable original capture readback, never reset or shorten it.
create function creatornet_team_private.settlement_closer_hold_v1(p_receipt_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_receipts_v1 r join public.sales_team_sale_agreements_v1 a on a.id=r.sale_id
 join public.sales_team_commission_balances_v1 b on b.receipt_id=r.id and b.sale_id=a.id and b.creator_id=a.creator_id and b.membership_id=a.membership_id
 join public.sales_team_capture_provenance_v1 capture on capture.receipt_id=r.id and capture.obligation_id=r.obligation_id
 where r.id=p_receipt_id and (a.terms->'commission'->>'holdDays')::integer between 14 and 90 and
 b.hold_until>=greatest(r.paid_at,to_timestamp((capture.readback->>'readStartedAt')::double precision/1000))+make_interval(days=>(a.terms->'commission'->>'holdDays')::integer) and
 b.hold_until<=capture.created_at+make_interval(days=>(a.terms->'commission'->>'holdDays')::integer) and b.hold_until<=clock_timestamp())
$$;
do $hold$ declare src text;needle text;begin
 src:=pg_get_functiondef('creatornet_team_private.transfer_share_v1(uuid,text)'::regprocedure);
 needle:='b.hold_until is distinct from r.paid_at+make_interval(days=>(a.terms->''commission''->>''holdDays'')::integer) or b.hold_until>clock_timestamp()';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'SETTLEMENT_CLOSER_HOLD_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'not creatornet_team_private.settlement_closer_hold_v1(r.id)');
end $hold$;
create function creatornet_team_private.settlement_plan_worker_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_plan_id uuid)
returns public.sales_team_settlement_plans_v1 language plpgsql stable security invoker set search_path=pg_catalog as $$
declare plan public.sales_team_settlement_plans_v1;begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);
 select * into plan from public.sales_team_settlement_plans_v1 where id=p_plan_id and run_id=p_run_id;
 if plan.id is null or exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=plan.id) or not exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_settlement_enabled) then raise exception 'CURRENT_AUTOMATIC_SETTLEMENT_PLAN_REQUIRED';end if;
 return plan;
end $$;
create function creatornet_team_private.settlement_financial_authorized_v1(p_check_id uuid,p_worker_run_id uuid,p_receipt_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_settlement_financial_links_v1 link join public.sales_team_settlement_plans_v1 plan on plan.id=link.plan_id
 join public.sales_team_automatic_settlement_runs_v1 automatic on automatic.run_id=plan.run_id join public.sales_team_settlement_runs_v1 run on run.run_id=automatic.run_id
 join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id join public.sales_team_cash_policy_v1 policy on policy.singleton
 where link.check_id=p_check_id and link.worker_run_id=p_worker_run_id and plan.run_id=p_worker_run_id and plan.receipt_id=p_receipt_id and plan.financial_check_id=p_check_id and plan.kind='earned' and automatic.allow_new and
 worker.kind='settlement' and worker.status='running' and worker.lease_until>clock_timestamp() and run.contract_sha256=policy.transfer_contract_sha256 and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1() and
 not exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=plan.id))
$$;
-- Copy the exact installed financial validators. Only worker authority changes;
-- source, immutable capture, balance/fee arithmetic and stale-check rules remain.
do $financial$ declare src text;item record;needle text;begin
 for item in select * from (values
  ('public.begin_sales_team_financial_check_v1(uuid,uuid,uuid,text,uuid,jsonb)','public.begin_sales_team_financial_check_v1(','creatornet_team_private.begin_settlement_financial_v1(','begin'),
  ('public.complete_sales_team_financial_check_v1(uuid,integer,jsonb)','public.complete_sales_team_financial_check_v1(','creatornet_team_private.complete_settlement_financial_v1(','complete')
 ) definitions(signature,old_name,new_name,kind) loop
  src:=replace(pg_get_functiondef(item.signature::regprocedure),chr(13)||chr(10),chr(10));needle:='kind=''reconciliation''';
  if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 or strpos(src,item.old_name)=0 then raise exception 'SETTLEMENT_FINANCIAL_SOURCE_DEPENDENCY_DIFFERS';end if;
  src:=replace(replace(src,item.old_name,item.new_name),needle,'kind=''settlement''');
  if item.kind='begin' then
   needle:='select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;select * into a from public.sales_team_sale_agreements_v1 where id=r.sale_id;';
   if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'SETTLEMENT_FINANCIAL_BEGIN_DEPENDENCY_DIFFERS';end if;
   src:=replace(src,needle,'if p_actor_id is not null or p_event_id is not null or not creatornet_team_private.settlement_financial_authorized_v1(p_check_id,p_worker_run_id,p_receipt_id) then raise exception ''CURRENT_SETTLEMENT_FINANCIAL_CHECK_REQUIRED'';end if;'||needle);
  else
   needle:='if c.id is null or a.id is null or';
   if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'SETTLEMENT_FINANCIAL_COMPLETE_DEPENDENCY_DIFFERS';end if;
   src:=replace(src,needle,'if not creatornet_team_private.settlement_financial_authorized_v1(c.id,c.worker_run_id,r.id) or c.actor_id is not null or c.event_id is not null then raise exception ''CURRENT_SETTLEMENT_FINANCIAL_CHECK_REQUIRED'';end if;'||needle);
  end if;execute src;
 end loop;
end $financial$;
create function public.claim_sales_team_automatic_settlement_v1(p_run_id uuid,p_context jsonb,p_new boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;allow_new boolean;begin
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_settlement_enabled) then return jsonb_build_object('status','held');end if;
 allow_new:=p_new is true and exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_reservations_enabled and transfer_execution_enabled and transfer_observations_enabled);
 result:=public.claim_sales_team_transfer_observation_run_v1(p_run_id,p_context);
 if result->>'status'='idle' then
  if not allow_new then return result;end if;
  result:=public.claim_sales_team_settlement_run_v1(p_run_id,p_context);
 end if;
 if result->>'status'='claimed' then insert into public.sales_team_automatic_settlement_runs_v1(run_id,allow_new) values(p_run_id,allow_new);end if;
 return result;
end $$;
create function public.next_sales_team_settlement_plan_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_new boolean default false,p_refresh boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare plan public.sales_team_settlement_plans_v1;chosen record;allow_new boolean;prior_originals integer;v_user uuid;v_recipient text;v_setup jsonb;begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_settlement_enabled) then raise exception 'AUTOMATIC_SETTLEMENT_HELD';end if;
 select * into plan from public.sales_team_settlement_plans_v1 p where p.run_id=p_run_id and not exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=p.id) order by p.created_at,p.id limit 1;
 if plan.id is not null then return to_jsonb(plan);end if;
 if (select count(*) from public.sales_team_settlement_plans_v1 where run_id=p_run_id)>=3 then return null;end if;
 select p_new is true and automatic.allow_new into allow_new from public.sales_team_automatic_settlement_runs_v1 automatic where automatic.run_id=p_run_id;
 if allow_new is null then raise exception 'AUTOMATIC_SETTLEMENT_RUN_REQUIRED';end if;
 allow_new:=allow_new and exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_reservations_enabled and transfer_execution_enabled and transfer_observations_enabled);
 select count(*) into prior_originals from public.sales_team_settlement_plans_v1 where run_id=p_run_id and kind='original';
 -- Two old originals retain priority; a third slot can advance an earned share.
 -- Within either lane, least-recent attempts prevent an old hold starving peers.
 with candidates as (
  select 'original'::text kind,q.receipt_id,q.beneficiary,q.id request_id,q.created_at,false ready,
   (select max(prior.created_at) from public.sales_team_settlement_plans_v1 prior where prior.request_id=q.id) attempted
  from public.sales_team_transfer_requests_v1 q join public.sales_team_provider_operations_v1 op on op.id=q.operation_id where q.context=p_context and
   (op.status<>'dispatching' or op.lease_until<=clock_timestamp()) and not exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id) and
   not exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id)
  union all
  select 'earned',r.id,beneficiary.kind,pending.id,r.paid_at,creatornet_team_private.transfer_share_v1(r.id,beneficiary.kind) is not null,
   (select max(prior.created_at) from public.sales_team_settlement_plans_v1 prior where prior.receipt_id=r.id and prior.beneficiary=beneficiary.kind)
  from public.sales_team_receipts_v1 r join public.sales_team_sale_agreements_v1 a on a.id=r.sale_id
  join public.sales_team_creator_balances_v1 creator on creator.receipt_id=r.id and creator.creator_id=a.creator_id and creator.sale_id=a.id
  join public.sales_team_commission_balances_v1 closer on closer.receipt_id=r.id and closer.creator_id=a.creator_id and closer.sale_id=a.id and closer.membership_id=a.membership_id
  cross join (values('creator'::text),('closer'::text)) beneficiary(kind)
  left join lateral(select q.id from public.sales_team_transfer_requests_v1 q where q.receipt_id=r.id and q.beneficiary=beneficiary.kind and
   not exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id) and not exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id) order by q.created_at,q.id limit 1) pending on true
  where allow_new and a.context=p_context and
   (pending.id is not null or case when beneficiary.kind='creator' then creator.creator_proceeds_cents-creator.creator_released_cents+creator.creator_reversed_cents>0
   else closer.earned_cents-closer.released_cents+closer.reversed_cents>0 and creatornet_team_private.settlement_closer_hold_v1(r.id) end) and
   not exists(select 1 from public.sales_team_provider_operations_v1 where id=(select operation_id from public.sales_team_transfer_requests_v1 where id=pending.id)) and
   (p_refresh is true or creatornet_team_private.transfer_share_v1(r.id,beneficiary.kind) is not null or
    (pending.id is not null and creatornet_team_private.transfer_unpaid_credit_v1(pending.id)<(select amount_cents from public.sales_team_transfer_requests_v1 where id=pending.id)))
 ) select * into chosen from candidates candidate where not exists(select 1 from public.sales_team_settlement_plans_v1 where run_id=p_run_id and receipt_id=candidate.receipt_id)
 order by case when kind='original' and prior_originals<2 then 0 when kind='earned' then 1 else 2 end,attempted nulls first,created_at,receipt_id,beneficiary limit 1;
 if not found then return null;end if;
 select case when chosen.beneficiary='creator' then a.creator_id else a.closer_id end,a.terms->'distribution'->>(case when chosen.beneficiary='creator' then 'creatorRecipientId' else 'closerRecipientId' end)
 into v_user,v_recipient from public.sales_team_sale_agreements_v1 a join public.sales_team_receipts_v1 r on r.sale_id=a.id where r.id=chosen.receipt_id;
 select jsonb_build_object('id',id,'user_id',user_id,'api',api,'account_id',account_id,'legacy_creation_key',legacy_creation_key,'context',context,'request',null)
 into v_setup from public.sales_team_recipient_setups_v1 where user_id=v_user and account_id=v_recipient and context=p_context;
 insert into public.sales_team_settlement_plans_v1(run_id,kind,receipt_id,beneficiary,request_id,task_id,recipient_user_id,recipient_id,recipient_source,source_ready)
 values(p_run_id,chosen.kind,chosen.receipt_id,chosen.beneficiary,coalesce(chosen.request_id,gen_random_uuid()),gen_random_uuid(),v_user,v_recipient,v_setup,chosen.ready) returning * into plan;
 if plan.kind='original' then insert into public.sales_team_settlement_tasks_v1(id,run_id,request_id) values(plan.task_id,p_run_id,plan.request_id);end if;
 return to_jsonb(plan);
end $$;
create function public.run_sales_team_settlement_plan_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_plan_id uuid,p_phase text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare plan public.sales_team_settlement_plans_v1;result jsonb;q public.sales_team_transfer_requests_v1;first jsonb:=p_payload->'first';second jsonb:=p_payload->'second';current_setup jsonb;begin
 plan:=creatornet_team_private.settlement_plan_worker_v1(p_run_id,p_lease_token,p_context,p_plan_id);
 if plan.kind<>'earned' then raise exception 'EARNED_SETTLEMENT_PLAN_REQUIRED';end if;
 if p_phase='unsent' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{}');
  perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
  select * into q from public.sales_team_transfer_requests_v1 where id=plan.request_id and receipt_id=plan.receipt_id and beneficiary=plan.beneficiary and context=p_context;
  if q.id is null then return jsonb_build_object('canceled',false);end if;
  perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
  if exists(select 1 from public.sales_team_provider_operations_v1 where id=q.operation_id) then raise exception 'ORIGINAL_TRANSFER_RECOVERY_REQUIRED';end if;
  if creatornet_team_private.transfer_unpaid_credit_v1(q.id)>=q.amount_cents then return jsonb_build_object('canceled',false);end if;
  insert into public.sales_team_settlement_tasks_v1(id,run_id,request_id) values(plan.task_id,p_run_id,q.id) on conflict(run_id,request_id) do nothing;
  perform public.cancel_unsent_sales_team_transfer_v1(p_run_id,p_lease_token,p_context,plan.task_id);
  return jsonb_build_object('canceled',true);
 elsif p_phase='begin_financial' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{}');
  insert into public.sales_team_settlement_financial_links_v1(check_id,plan_id,worker_run_id) values(plan.financial_check_id,plan.id,p_run_id) on conflict(check_id) do nothing;
  if not exists(select 1 from public.sales_team_settlement_financial_links_v1 where check_id=plan.financial_check_id and plan_id=plan.id and worker_run_id=p_run_id) then raise exception 'ORIGINAL_SETTLEMENT_FINANCIAL_LINK_REQUIRED';end if;
  result:=creatornet_team_private.begin_settlement_financial_v1(plan.financial_check_id,plan.receipt_id,null,null,p_run_id,p_context);
  if result->>'checkId'<>plan.financial_check_id::text then raise exception 'ORIGINAL_SETTLEMENT_FINANCIAL_CHECK_CHANGED';end if;return result;
 elsif p_phase='complete_financial' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{"revision":"number","snapshot":"object"}');
  return creatornet_team_private.complete_settlement_financial_v1(plan.financial_check_id,(p_payload->>'revision')::integer,p_payload->'snapshot');
 elsif p_phase='recipient' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{"first":"object|null","second":"object|null"}');
  select jsonb_build_object('id',id,'user_id',user_id,'api',api,'account_id',account_id,'legacy_creation_key',legacy_creation_key,'context',context,'request',null) into current_setup
   from public.sales_team_recipient_setups_v1 where user_id=plan.recipient_user_id and account_id=plan.recipient_id and context=p_context;
  if plan.recipient_source is null or current_setup is distinct from plan.recipient_source then raise exception 'ORIGINAL_SETTLEMENT_RECIPIENT_REQUIRED';end if;
  if first='null'::jsonb and second='null'::jsonb then
   update public.sales_team_recipients_v1 set ownership_verified=false,transfers_active=false,payouts_ready=false,updated_at=clock_timestamp(),evidence=jsonb_build_object('code','CURRENT_VERIFICATION_REQUIRED','workerRunId',p_run_id)
    where user_id=plan.recipient_user_id and account_id=plan.recipient_id and mode=p_context->>'mode' and platform_account_id=p_context->>'platformAccountId';
  else
   perform creatornet_team_private.financial_shape_v1(first,'{"accountId":"string","country":"string","currency":"string","transfersActive":"boolean","payoutsReady":"boolean","ownershipVerified":"boolean","requestId":"string","api":"string"}');
   perform creatornet_team_private.financial_shape_v1(second,'{"accountId":"string","country":"string","currency":"string","transfersActive":"boolean","payoutsReady":"boolean","ownershipVerified":"boolean","requestId":"string","api":"string"}');
   if first-'requestId' is distinct from second-'requestId' or first->>'requestId'!~'^req_[A-Za-z0-9]+$' or first->>'requestId'=second->>'requestId' or second->>'accountId'<>plan.recipient_id then raise exception 'REPEATED_SETTLEMENT_RECIPIENT_REQUIRED';end if;
   perform public.record_sales_team_recipient_v1(plan.recipient_user_id,p_context,second);
  end if;
  insert into public.sales_team_settlement_recipient_checks_v1(plan_id,worker_run_id,user_id,first_request_id,second_request_id,observation) values(plan.id,p_run_id,plan.recipient_user_id,first->>'requestId',second->>'requestId',second) on conflict(plan_id) do nothing;
  return jsonb_build_object('ready',second->'transfersActive'='true'::jsonb and second->'payoutsReady'='true'::jsonb);
 end if;
 raise exception 'SETTLEMENT_PLAN_PHASE_REQUIRED';
end $$;
create function public.finish_sales_team_settlement_plan_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_plan_id uuid,p_held boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare plan public.sales_team_settlement_plans_v1;held boolean;canceled boolean;creator uuid;begin
 if not exists(select 1 from public.sales_team_settlement_runs_v1 run join public.sales_team_automatic_settlement_runs_v1 automatic on automatic.run_id=run.run_id where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context) then raise exception 'ORIGINAL_AUTOMATIC_SETTLEMENT_RUN_REQUIRED';end if;
 select * into plan from public.sales_team_settlement_plans_v1 where id=p_plan_id and run_id=p_run_id;
 if plan.id is null then raise exception 'ORIGINAL_SETTLEMENT_PLAN_REQUIRED';end if;
 canceled:=exists(select 1 from public.sales_team_transfer_cancellations_v1 canceled join public.sales_team_settlement_tasks_v1 task on task.request_id=canceled.request_id and task.run_id=canceled.worker_run_id
  where canceled.request_id=plan.request_id and canceled.worker_run_id=p_run_id and task.id=plan.task_id) and
  not exists(select 1 from public.sales_team_provider_operations_v1 op join public.sales_team_transfer_requests_v1 q on q.operation_id=op.id where q.id=plan.request_id);
 held:=p_held is distinct from false or (not canceled and creatornet_team_private.transfer_accounting_held_v1(plan.request_id));
 if exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=plan.id) then return(select jsonb_build_object('held',result.held,'settled',result.code='settled')||case when result.code='canceled' then jsonb_build_object('canceled',true) else '{}'::jsonb end from public.sales_team_settlement_plan_results_v1 result where plan_id=plan.id);end if;
 insert into public.sales_team_settlement_plan_results_v1(plan_id,held,code) values(plan.id,held,case when held then 'review_required' when canceled then 'canceled' else 'settled' end);
 select a.creator_id into creator from public.sales_team_receipts_v1 r join public.sales_team_sale_agreements_v1 a on a.id=r.sale_id where r.id=plan.receipt_id;
 if held then insert into public.sales_team_financial_alerts_v1(creator_id,code,source_identity,evidence) values(creator,'SETTLEMENT_REVIEW_REQUIRED','settlement:'||plan.receipt_id::text||':'||plan.beneficiary,jsonb_build_object('receiptId',plan.receipt_id,'beneficiary',plan.beneficiary,'workerRunId',p_run_id)) on conflict(source_identity) do update set status='open',evidence=excluded.evidence;
 else update public.sales_team_financial_alerts_v1 set status='resolved' where source_identity='settlement:'||plan.receipt_id::text||':'||plan.beneficiary;end if;
 return jsonb_build_object('held',held,'settled',not held and not canceled)||case when canceled and not held then jsonb_build_object('canceled',true) else '{}'::jsonb end;
end $$;
create function public.finish_sales_team_automatic_settlement_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_failed boolean)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_settlement_runs_v1 run join public.sales_team_automatic_settlement_runs_v1 automatic on automatic.run_id=run.run_id where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context) then raise exception 'ORIGINAL_AUTOMATIC_SETTLEMENT_RUN_REQUIRED';end if;
 update public.sales_team_worker_runs_v1 set status=case when p_failed is distinct from false or exists(select 1 from public.sales_team_settlement_plans_v1 plan left join public.sales_team_settlement_plan_results_v1 result on result.plan_id=plan.id where plan.run_id=p_run_id and coalesce(result.held,true)) then 'review_required' else 'complete' end,finished_at=clock_timestamp() where id=p_run_id and status='running';
end $$;
-- Automatic observation-only runs cannot turn into fresh-money authority.
alter function public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid) rename to reserve_sales_team_transfer_before_automatic_v1;
create function public.reserve_sales_team_transfer_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_request_id uuid,p_receipt_id uuid,p_beneficiary text,p_read_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 if exists(select 1 from public.sales_team_automatic_settlement_runs_v1 where run_id=p_run_id) and not exists(select 1 from public.sales_team_automatic_settlement_runs_v1 automatic join public.sales_team_settlement_plans_v1 plan on plan.run_id=automatic.run_id where automatic.run_id=p_run_id and automatic.allow_new and plan.kind='earned' and plan.task_id=p_task_id and plan.request_id=p_request_id and plan.receipt_id=p_receipt_id and plan.beneficiary=p_beneficiary and not exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=plan.id)) then raise exception 'AUTOMATIC_EARNED_TRANSFER_PLAN_REQUIRED';end if;
 return public.reserve_sales_team_transfer_before_automatic_v1(p_run_id,p_lease_token,p_context,p_task_id,p_request_id,p_receipt_id,p_beneficiary,p_read_id);
end $$;
do $contracts$ declare src text;needle text;begin
 src:=pg_get_functiondef('public.sales_team_transfer_operation_admitted_v1(jsonb,jsonb)'::regprocedure);needle:='worker.kind=''settlement'' and worker.status=';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'AUTOMATIC_TRANSFER_ADMISSION_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'not exists(select 1 from public.sales_team_automatic_settlement_runs_v1 automatic where automatic.run_id=worker.id and not automatic.allow_new) and '||needle);
 src:=pg_get_functiondef('creatornet_team_private.transfer_contract_digest_v1()'::regprocedure);needle:='''transfer_cost_total_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'AUTOMATIC_SETTLEMENT_PRIVATE_DIGEST_DIFFERS';end if;
 src:=replace(src,needle,needle||',''settlement_closer_hold_v1'',''settlement_plan_worker_v1'',''settlement_financial_authorized_v1'',''begin_settlement_financial_v1'',''complete_settlement_financial_v1''');needle:='''sales_team_transfer_operation_id_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'AUTOMATIC_SETTLEMENT_PUBLIC_DIGEST_DIFFERS';end if;
 execute replace(src,needle,needle||',''claim_sales_team_automatic_settlement_v1'',''next_sales_team_settlement_plan_v1'',''run_sales_team_settlement_plan_v1'',''finish_sales_team_settlement_plan_v1'',''finish_sales_team_automatic_settlement_v1'',''reserve_sales_team_transfer_before_automatic_v1''');
end $contracts$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_automatic_settlement_runs_v1','sales_team_settlement_plans_v1','sales_team_settlement_plan_results_v1','sales_team_settlement_financial_links_v1','sales_team_settlement_recipient_checks_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_automatic_settlement_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('claim_sales_team_automatic_settlement_v1','next_sales_team_settlement_plan_v1','run_sales_team_settlement_plan_v1','finish_sales_team_settlement_plan_v1','finish_sales_team_automatic_settlement_v1','reserve_sales_team_transfer_v1','reserve_sales_team_transfer_before_automatic_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('settlement_closer_hold_v1','settlement_plan_worker_v1','settlement_financial_authorized_v1','begin_settlement_financial_v1','complete_settlement_financial_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
revoke all on function public.reserve_sales_team_transfer_before_automatic_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid) from service_role;
commit;
