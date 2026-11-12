-- Local signed surplus ingress and pending-event cash protection only.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
-- An absent shared claim owner must fail installation transactionally.
do $shared$ begin
 perform 'public.claim_stripe_event(text,text,integer,uuid)'::regprocedure;
 perform 'public.complete_stripe_event(text,uuid)'::regprocedure;
 perform 'public.release_stripe_event(text,uuid)'::regprocedure;
 perform id,type,status,claim_token,claimed_at from public.stripe_events limit 0;
end $shared$;
create table public.sales_team_surplus_events_v1 (
 event_id text primary key check(event_id~'^evt_[A-Za-z0-9]+$'),request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 payout_id text not null check(payout_id~'^po_[A-Za-z0-9]+$'),event_type text not null,event_created bigint not null,context jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create index sales_team_surplus_events_request_v1 on public.sales_team_surplus_events_v1(request_id);
create table public.sales_team_surplus_event_results_v1 (
 event_id text primary key references public.sales_team_surplus_events_v1(event_id) on delete restrict,
 check_id uuid not null references public.sales_team_surplus_observations_v1(check_id) on delete restrict,
 proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create function public.locate_sales_team_surplus_event_v1(p_payout_id text,p_request_id uuid default null,p_operation_id uuid default null,p_idempotency_key text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare q public.sales_team_surplus_requests_v1;op public.sales_team_provider_operations_v1;ids uuid[];begin
 if coalesce(p_payout_id,'')!~'^po_[A-Za-z0-9]+$' then raise exception 'SURPLUS_PAYOUT_LOCATOR_REQUIRED';end if;
 select array_agg(distinct request.id) into ids from public.sales_team_surplus_requests_v1 request
 join public.sales_team_provider_operations_v1 operation on operation.id=request.operation_id
 where operation.provider_id=p_payout_id or request.id=p_request_id or operation.id=p_operation_id or operation.idempotency_key=p_idempotency_key;
 if ids is null then return null;end if;
 if cardinality(ids)<>1 then raise exception 'AMBIGUOUS_SURPLUS_EVENT_REQUIRED';end if;
 select * into q from public.sales_team_surplus_requests_v1 where id=ids[1];select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id;
 if p_request_id is not null and p_request_id<>q.id or p_operation_id is not null and p_operation_id<>op.id or
  p_idempotency_key is not null and p_idempotency_key<>op.idempotency_key or op.provider_id is not null and op.provider_id<>p_payout_id or
  op.status not in ('dispatching','unknown','bound') or op.context is distinct from q.context or op.request is distinct from q.request or
  op.kind<>'withdrawal' or op.scope_id is distinct from q.id or op.scope_key<>'surplus:v1' or op.worker_run_id is distinct from q.original_worker_run_id or
  op.idempotency_key is distinct from 'cn-team-v1:'||op.id::text or not exists(select 1 from public.sales_team_surplus_execution_actions_v1 where request_id=q.id and phase='dispatch' and provider_lease_token=op.lease_token) then raise exception 'OWNED_ORIGINAL_SURPLUS_EVENT_REQUIRED';end if;
 return jsonb_build_object('requestId',q.id,'operationId',op.id,'context',q.context,'providerId',op.provider_id,'operationStatus',op.status);
end $$;
create function creatornet_team_private.signed_surplus_claim_v1(p_event_id text,p_event_type text,p_claim_token uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare claim record;begin
 select id,type,status,claim_token,claimed_at into claim from public.stripe_events where id='stripe:'||p_event_id for update;
 if not found or claim.type is distinct from p_event_type or
  (p_claim_token is null and claim.status<>'completed') or
  (p_claim_token is not null and (claim.status<>'processing' or claim.claim_token is distinct from p_claim_token or claim.claimed_at is null or claim.claimed_at<clock_timestamp()-interval '5 minutes' or claim.claimed_at>clock_timestamp()+interval '5 seconds')) then raise exception 'DURABLE_SIGNED_SURPLUS_CLAIM_REQUIRED';end if;
end $$;
create function public.begin_sales_team_surplus_event_v1(p_event_id text,p_event_type text,p_event_created bigint,p_payout_id text,p_request_id uuid,p_context jsonb,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare source jsonb;prior public.sales_team_surplus_events_v1;begin
 if coalesce(p_event_id,'')!~'^evt_[A-Za-z0-9]+$' or p_event_type is null or p_event_type not in ('payout.created','payout.updated','payout.paid','payout.failed','payout.canceled') or
  p_event_created is null or p_event_created<1 or p_event_created>extract(epoch from clock_timestamp())+300 then raise exception 'SIGNED_SURPLUS_EVENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 perform creatornet_team_private.signed_surplus_claim_v1(p_event_id,p_event_type,p_claim_token);
 source:=public.locate_sales_team_surplus_event_v1(p_payout_id,p_request_id,null,null);
 if source is null or source->'context' is distinct from p_context then raise exception 'OWNED_ORIGINAL_SURPLUS_EVENT_REQUIRED';end if;
 select * into prior from public.sales_team_surplus_events_v1 where event_id=p_event_id;
 if prior.event_id is not null then
  if prior.request_id is distinct from p_request_id or prior.context is distinct from p_context or prior.payout_id is distinct from p_payout_id or prior.event_type is distinct from p_event_type or prior.event_created is distinct from p_event_created then raise exception 'ORIGINAL_SIGNED_SURPLUS_EVENT_CHANGED';end if;
 else
  insert into public.sales_team_surplus_events_v1(event_id,request_id,payout_id,event_type,event_created,context) values(p_event_id,p_request_id,p_payout_id,p_event_type,p_event_created,p_context);
  update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;
 end if;
 return jsonb_build_object('recorded',exists(select 1 from public.sales_team_surplus_event_results_v1 where event_id=p_event_id),'source',source);
end $$;
create function public.complete_sales_team_surplus_event_v1(p_event_id text,p_claim_token uuid,p_check_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare event public.sales_team_surplus_events_v1;observation public.sales_team_surplus_observations_v1;checked public.sales_team_surplus_checks_v1;proof jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into event from public.sales_team_surplus_events_v1 where event_id=p_event_id and context=p_context;
 if event.event_id is null then raise exception 'ORIGINAL_SIGNED_SURPLUS_EVENT_REQUIRED';end if;
 perform creatornet_team_private.signed_surplus_claim_v1(p_event_id,event.event_type,p_claim_token);
 if exists(select 1 from public.sales_team_surplus_event_results_v1 where event_id=event.event_id) then return jsonb_build_object('recorded',false,'bankConfirmed',false);end if;
 select * into checked from public.sales_team_surplus_checks_v1 where id=p_check_id and request_id=event.request_id and context=p_context and provider_id=event.payout_id;
 select * into observation from public.sales_team_surplus_observations_v1 where check_id=checked.id and request_id=event.request_id;proof:=observation.proof;
 if checked.id is null or checked.created_at<event.created_at or observation.check_id is null or proof->'complete' is distinct from 'true'::jsonb or proof->'bankConfirmed' is distinct from 'false'::jsonb or
  (proof->>'readStartedAt')::numeric<extract(epoch from event.created_at)*1000-5 or
  (proof->>'observedAt')::numeric<extract(epoch from clock_timestamp())-65 or proof->'context' is distinct from p_context or proof->'payout'->>'id' is distinct from event.payout_id or
  event.event_type in ('payout.failed','payout.canceled') and (proof->>'disposition' is distinct from 'returned' or proof->'returned'='null'::jsonb) then raise exception 'INDEPENDENT_COMPLETE_SURPLUS_EVENT_MONEY_REQUIRED';end if;
 insert into public.sales_team_surplus_event_results_v1(event_id,check_id,proof) values(event.event_id,checked.id,jsonb_build_object('checkId',checked.id,'payoutId',event.payout_id,'disposition',proof->'disposition','bankConfirmed',false));
 update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;
 return jsonb_build_object('recorded',true,'bankConfirmed',false);
end $$;
create function creatornet_team_private.surplus_request_pending_v1(p_request_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select not exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=p_request_id) or
 exists(select 1 from public.sales_team_surplus_events_v1 event where event.request_id=p_request_id and not exists(select 1 from public.sales_team_surplus_event_results_v1 where event_id=event.event_id))
$$;
alter function creatornet_team_private.surplus_policy_ready_v1(jsonb) rename to surplus_policy_before_events_v1;
create function creatornet_team_private.surplus_policy_ready_v1(p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select creatornet_team_private.surplus_policy_before_events_v1(p_context) and not exists(
 select 1 from public.sales_team_surplus_events_v1 event where event.context=p_context and not exists(select 1 from public.sales_team_surplus_event_results_v1 where event_id=event.event_id))
$$;
-- Retain the F40 daily slot/task owners; extend only their pending-original
-- predicate so a late event after an immutable debit resolution is still first.
do $pending$ declare signature text;body text;needle text;replacement text;begin
 foreach signature in array array['public.claim_sales_team_surplus_run_v1(uuid,jsonb,boolean)','public.prepare_sales_team_surplus_v1(uuid,uuid,jsonb,uuid,uuid)','public.finish_sales_team_surplus_run_v1(uuid,uuid,jsonb,boolean)'] loop
  select pg_get_functiondef(signature::regprocedure) into body;
  if signature like '%prepare_%' or signature like '%claim_%' then
   needle:='not exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=q.id)';replacement:='creatornet_team_private.surplus_request_pending_v1(q.id)';
  else needle:='not exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=task.request_id)';replacement:='creatornet_team_private.surplus_request_pending_v1(task.request_id)';end if;
  if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'SIGNED_SURPLUS_PENDING_OWNER_DIFFERS: %',signature;end if;
  execute replace(body,needle,replacement);
 end loop;
end $pending$;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''public''::regnamespace and p.proname in (''locate_sales_team_surplus_event_v1'',''begin_sales_team_surplus_event_v1'',''complete_sales_team_surplus_event_v1'')) or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''signed_surplus_claim_v1'',''surplus_request_pending_v1'',''surplus_policy_before_events_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()','creatornet_team_private.surplus_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'SIGNED_SURPLUS_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
do $security$ declare name text;signature regprocedure;begin
 foreach name in array array['sales_team_surplus_events_v1','sales_team_surplus_event_results_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_signed_surplus_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for signature in select oid::regprocedure from pg_proc where
  pronamespace='public'::regnamespace and proname in ('locate_sales_team_surplus_event_v1','begin_sales_team_surplus_event_v1','complete_sales_team_surplus_event_v1') or
  pronamespace='creatornet_team_private'::regnamespace and proname in ('signed_surplus_claim_v1','surplus_request_pending_v1','surplus_policy_before_events_v1','surplus_policy_ready_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',signature);execute format('grant execute on function %s to service_role',signature);
 end loop;
end $security$;
commit;
