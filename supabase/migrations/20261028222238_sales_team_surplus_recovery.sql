-- Local original-only recovery. No payout dispatch, activation or bank proof.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
create table public.sales_team_surplus_recovery_checks_v1 (
 id uuid primary key,request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 context jsonb not null,operation_id uuid not null references public.sales_team_provider_operations_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_surplus_recovery_proofs_v1 (
 check_id uuid primary key references public.sales_team_surplus_recovery_checks_v1(id) on delete restrict,
 request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 event_id text not null unique check(event_id~'^evt_[A-Za-z0-9]+$'),proof jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create function public.begin_sales_team_surplus_recovery_v1(p_check_id uuid,p_request_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare q public.sales_team_surplus_requests_v1;op public.sales_team_provider_operations_v1;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into q from public.sales_team_surplus_requests_v1 where id=p_request_id and context=p_context;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||p_request_id::text,0));
 select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id for update;
 if p_check_id is null or q.id is null or op.id is null or op.provider_id is not null or op.provider_request_id is not null or
  not (op.status='unknown' or op.status='dispatching' and op.lease_until<=clock_timestamp()) or
  op.request is distinct from q.request or op.context is distinct from p_context or op.kind<>'withdrawal' or op.scope_id is distinct from q.id or op.scope_key<>'surplus:v1' or
  op.sale_id is not null or op.creator_id is not null or op.actor_id is not null or op.worker_run_id is distinct from q.original_worker_run_id or op.idempotency_key is distinct from 'cn-team-v1:'||op.id::text or
  op.first_dispatch_at is null or op.first_dispatch_at<q.created_at or exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=q.id) or
  not exists(select 1 from public.sales_team_surplus_execution_admissions_v1 a join public.sales_team_surplus_execution_actions_v1 d using(request_id,run_id)
   where a.request_id=q.id and a.operation_id=op.id and d.phase='dispatch' and d.provider_lease_token=op.lease_token) then raise exception 'DISPATCHED_UNKNOWN_SURPLUS_REQUIRED';end if;
 insert into public.sales_team_surplus_recovery_checks_v1(id,request_id,context,operation_id) values(p_check_id,q.id,p_context,op.id);
 return public.sales_team_surplus_request_json_v1(q.id);
end $$;
create function public.complete_sales_team_surplus_recovery_v1(p_check_id uuid,p_request_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare checked public.sales_team_surplus_recovery_checks_v1;q public.sales_team_surplus_requests_v1;op public.sales_team_provider_operations_v1;
 event jsonb:=p_proof->'event';money jsonb:=p_proof->'money';payout jsonb;page jsonb;item jsonb;req text;ids text[]:='{}';requests text[]:='{}';last_id text;matches integer:=0;
 page_count integer:=0;from_time bigint;to_time bigint;run uuid;result jsonb;prior public.sales_team_surplus_recovery_proofs_v1;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into checked from public.sales_team_surplus_recovery_checks_v1 where id=p_check_id and request_id=p_request_id and context=p_context;
 select * into q from public.sales_team_surplus_requests_v1 where id=checked.request_id and context=p_context;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||p_request_id::text,0));
 select * into op from public.sales_team_provider_operations_v1 where id=checked.operation_id and id=q.operation_id for update;
 if checked.id is null or q.id is null or op.id is null or op.request is distinct from q.request or op.context is distinct from p_context then raise exception 'ORIGINAL_SURPLUS_RECOVERY_REQUIRED';end if;
 select * into prior from public.sales_team_surplus_recovery_proofs_v1 where check_id=checked.id;
 if prior.check_id is not null then
  if prior.proof is distinct from p_proof then raise exception 'ORIGINAL_SURPLUS_RECOVERY_CHANGED';end if;
  return jsonb_build_object('requestId',q.id,'recorded',false,'complete',p_proof->'money'->'complete','bankConfirmed',false);
 end if;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"context":"object","requestId":"string","operationId":"string","readStartedAt":"number","observedAt":"number","from":"number","to":"number","pages":"array","event":"object","firstEventRequestId":"string","secondEventRequestId":"string","money":"object"}');
 perform creatornet_team_private.financial_shape_v1(event,'{"eventId":"string","eventType":"string","apiVersion":"string","created":"number","account":"null","context":"null","livemode":"boolean","originalRequestId":"string","idempotencyKey":"string","payout":"object"}');
 from_time:=floor(extract(epoch from op.first_dispatch_at))::bigint-5;to_time:=floor((p_proof->>'readStartedAt')::numeric/1000)::bigint;
 if p_proof->'context' is distinct from p_context or p_proof->>'requestId' is distinct from q.id::text or p_proof->>'operationId' is distinct from op.id::text or
  (p_proof->>'readStartedAt')::numeric not between greatest(extract(epoch from checked.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-60000) and extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'observedAt')::numeric not between to_time and extract(epoch from clock_timestamp())+5 or
  (p_proof->>'from')::numeric is distinct from from_time::numeric or (p_proof->>'to')::numeric is distinct from to_time::numeric or from_time<to_time-2592000 or from_time>to_time or
  coalesce(event->>'eventId','')!~'^evt_[A-Za-z0-9]+$' or event->>'eventType'<>'payout.created' or event->>'apiVersion' is distinct from q.request->>'apiVersion' or
  (event->>'created')::numeric not between from_time and to_time or event->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
  coalesce(event->>'originalRequestId','')!~'^req_[A-Za-z0-9]+$' or event->>'idempotencyKey' is distinct from op.idempotency_key or jsonb_array_length(p_proof->'pages') not between 1 and 3 then raise exception 'FRESH_EXACT_SURPLUS_EVENT_REQUIRED';end if;
 payout:=event->'payout';perform creatornet_team_private.financial_shape_v1(payout,'{"id":"string","created":"number","amountCents":"number","currency":"string","destinationId":"string","debitBalanceId":"string","metadata":"object"}');
 if coalesce(payout->>'id','')!~'^po_[A-Za-z0-9]+$' or payout->>'amountCents' is distinct from q.amount_cents::text or payout->>'currency'<>'usd' or
  payout->>'destinationId' is distinct from q.destination_id or payout->'metadata' is distinct from q.request->'params'->'metadata' or coalesce(payout->>'debitBalanceId','')!~'^txn_[A-Za-z0-9]+$' or
  (payout->>'created')::numeric not between from_time and (event->>'created')::numeric+5 or
  payout is distinct from jsonb_build_object('id',money->'payout'->'id','created',money->'payout'->'created','amountCents',money->'payout'->'amountCents','currency',money->'payout'->'currency','destinationId',money->'payout'->'destinationId','debitBalanceId',money->'payout'->'debitBalanceId','metadata',money->'payout'->'metadata') then raise exception 'SAME_ORIGINAL_SURPLUS_EVENT_PAYOUT_REQUIRED';end if;
 for page in select value from jsonb_array_elements(p_proof->'pages') loop
  page_count:=page_count+1;perform creatornet_team_private.financial_shape_v1(page,'{"requestId":"string","startingAfter":"string|null","hasMore":"boolean","events":"array"}');
  if page->>'startingAfter' is distinct from last_id or jsonb_array_length(page->'events')>100 or
   (page->>'hasMore')::boolean is distinct from (page_count<jsonb_array_length(p_proof->'pages')) or
   page->'hasMore'='true'::jsonb and jsonb_array_length(page->'events')=0 then raise exception 'COMPLETE_SURPLUS_EVENT_DISCOVERY_REQUIRED';end if;
  req:=page->>'requestId';if req!~'^req_[A-Za-z0-9]+$' or req=any(requests) or req=event->>'originalRequestId' then raise exception 'DISTINCT_SURPLUS_RECOVERY_READS_REQUIRED';end if;requests:=array_append(requests,req);
  for item in select value from jsonb_array_elements(page->'events') loop
   perform creatornet_team_private.financial_shape_v1(item,'{"eventId":"string","created":"number","matchesOriginalKey":"boolean"}');
   if item->>'eventId'!~'^evt_[A-Za-z0-9]+$' or item->>'eventId'=any(ids) or (item->>'created')::numeric not between from_time and to_time then raise exception 'UNIQUE_SURPLUS_EVENT_DISCOVERY_REQUIRED';end if;
   ids:=array_append(ids,item->>'eventId');last_id:=item->>'eventId';
   if item->'matchesOriginalKey'='true'::jsonb then matches:=matches+1;if item->>'eventId' is distinct from event->>'eventId' or item->'created' is distinct from event->'created' then raise exception 'EXACT_DISCOVERED_SURPLUS_EVENT_REQUIRED';end if;end if;
  end loop;
 end loop;
 if matches<>1 then raise exception 'UNIQUE_ORIGINAL_SURPLUS_EVENT_REQUIRED';end if;
 foreach req in array array[p_proof->>'firstEventRequestId',p_proof->>'secondEventRequestId',money->>'firstPayoutRequestId',money->>'secondPayoutRequestId',money->'debit'->>'providerRequestId']||case when money->'returned'='null'::jsonb then '{}'::text[] else array[money->'returned'->>'providerRequestId'] end loop
  if req is null or req!~'^req_[A-Za-z0-9]+$' or req=any(requests) or req=event->>'originalRequestId' then raise exception 'DISTINCT_SURPLUS_RECOVERY_READS_REQUIRED';end if;requests:=array_append(requests,req);
 end loop;
 if (money->>'readStartedAt')::numeric<(p_proof->>'readStartedAt')::numeric then raise exception 'INDEPENDENT_SURPLUS_RECOVERY_MONEY_REQUIRED';end if;
 select a.run_id into run from public.sales_team_surplus_execution_admissions_v1 a join public.sales_team_surplus_execution_actions_v1 d using(request_id,run_id)
  where a.request_id=q.id and a.operation_id=op.id and d.phase='dispatch' and d.provider_lease_token=op.lease_token;
 if run is null then raise exception 'DISPATCHED_UNKNOWN_SURPLUS_REQUIRED';end if;
 if op.status='bound' then
  if op.provider_id is distinct from payout->>'id' or op.provider_request_id is distinct from event->>'originalRequestId' then raise exception 'ORIGINAL_SURPLUS_BINDING_CHANGED';end if;
 else
  if op.provider_id is not null or op.provider_request_id is not null or not (op.status='unknown' or op.status='dispatching' and op.lease_until<=clock_timestamp()) then raise exception 'UNKNOWN_SURPLUS_OUTCOME_REQUIRED';end if;
  -- The original bind seam and its table trigger still fence this outcome. This
  -- receipt cannot assert/dispatch, extend a lease, change identity or retry POST.
  insert into public.sales_team_surplus_execution_actions_v1(request_id,run_id,phase,provider_lease_token,provider_id,provider_request_id)
   values(q.id,run,'bind',op.lease_token,payout->>'id',event->>'originalRequestId');
  perform public.bind_sales_team_provider_operation_v1(op.id,payout->>'id',event->>'originalRequestId',true);
 end if;
 -- Preserve the actual recovery admission time. The existing F41 consumer
 -- revalidates all money and derives disposition; a denial rolls binding back.
 insert into public.sales_team_surplus_checks_v1(id,request_id,context,provider_id,original_request_id,created_at)
  values(checked.id,q.id,p_context,payout->>'id',event->>'originalRequestId',checked.created_at);
 result:=public.complete_sales_team_surplus_check_v1(checked.id,q.id,p_context,money);
 insert into public.sales_team_surplus_recovery_proofs_v1(check_id,request_id,event_id,proof) values(checked.id,q.id,event->>'eventId',p_proof);
 return result;
end $$;
do $digests$ declare signature text;body text;begin
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()','creatornet_team_private.surplus_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'SURPLUS_RECOVERY_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||' or (p.pronamespace=''public''::regnamespace and p.proname in (''begin_sales_team_surplus_recovery_v1'',''complete_sales_team_surplus_recovery_v1''))');
 end loop;
end $digests$;
do $security$ declare name text;signature regprocedure;begin
 foreach name in array array['sales_team_surplus_recovery_checks_v1','sales_team_surplus_recovery_proofs_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_surplus_recovery_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 foreach signature in array array['public.begin_sales_team_surplus_recovery_v1(uuid,uuid,jsonb)'::regprocedure,'public.complete_sales_team_surplus_recovery_v1(uuid,uuid,jsonb,jsonb)'::regprocedure] loop
  execute format('revoke all on function %s from public,anon,authenticated',signature);execute format('grant execute on function %s to service_role',signature);
 end loop;
end $security$;
commit;
