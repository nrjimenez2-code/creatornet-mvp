-- Local candidate. Separate-charge refunds have their own frozen admin request
-- and reuse the original provider-operation journal. All activation is default off.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column refund_dispatch_enabled boolean not null default false;
do $guard$ declare definition text;begin
 select pg_get_constraintdef(oid) into definition from pg_constraint where conrelid='public.sales_team_provider_operations_v1'::regclass and conname='sales_team_provider_operations_v1_kind_check';
 if regexp_replace(coalesce(definition,''),'[[:space:]]','','g')<>$expected$CHECK((kind=ANY(ARRAY['recipient'::text,'customer'::text,'intent'::text,'confirmation'::text,'cancellation'::text,'transfer'::text,'reversal'::text,'withdrawal'::text,'setup'::text])))$expected$ then raise exception 'TEAM_REFUND_OPERATION_KIND_DEPENDENCY_DIFFERS';end if;
 alter table public.sales_team_provider_operations_v1 drop constraint sales_team_provider_operations_v1_kind_check;
 alter table public.sales_team_provider_operations_v1 add constraint sales_team_provider_operations_v1_kind_check check(kind in ('recipient','customer','intent','confirmation','cancellation','transfer','reversal','withdrawal','setup','refund'));
end $guard$;
create table public.sales_team_refund_requests_v1 (
 id uuid primary key,
 receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 requested_by uuid not null references public.profiles(id) on delete restrict,
 amount_cents bigint not null check(amount_cents>0),
 responsibility text not null check(responsibility in ('creator','platform')),
 reason_code text not null,
 context jsonb not null,
 expected_revision integer not null check(expected_revision>=0),
 refunded_before_cents bigint not null check(refunded_before_cents>=0),
 operation_id uuid not null unique,
 request jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 check(reason_code='legally_required' or responsibility='creator' and reason_code in ('creator_non_delivery','creator_missed_session','material_misrepresentation','creator_discretionary') or responsibility='platform' and reason_code in ('duplicate_charge','platform_technical_error','incorrect_platform_billing','platform_goodwill'))
);
create table public.sales_team_refund_dispatch_checks_v1 (
 request_id uuid not null references public.sales_team_refund_requests_v1(id) on delete restrict,
 check_id uuid not null unique references public.sales_team_financial_check_results_v1(check_id) on delete restrict,
 receipt_revision integer not null check(receipt_revision>=0),
 created_at timestamptz not null default clock_timestamp(),primary key(request_id,check_id)
);
create table public.sales_team_refund_request_results_v1 (
 request_id uuid primary key references public.sales_team_refund_requests_v1(id) on delete restrict,
 refund_id text unique check(refund_id~'^re_[A-Za-z0-9]+$'),
 status text not null check(status in ('succeeded','failed','canceled','canceled_before_dispatch')),
 observed_by uuid not null references public.profiles(id) on delete restrict,
 proof jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 check((status='canceled_before_dispatch')=(refund_id is null))
);
create table public.sales_team_refund_request_observations_v1 (
 id uuid primary key default gen_random_uuid(),
 observation_number bigint generated always as identity unique,
 request_id uuid not null references public.sales_team_refund_requests_v1(id) on delete restrict,
 observed_by uuid references public.profiles(id) on delete restrict,
 financial_check_id uuid references public.sales_team_financial_check_results_v1(check_id) on delete restrict,
 proof jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 check(num_nonnulls(observed_by,financial_check_id)=1),unique(request_id,financial_check_id)
);
create table public.sales_team_refund_recovery_proofs_v1 (
 request_id uuid primary key references public.sales_team_refund_requests_v1(id) on delete restrict,
 observed_by uuid not null references public.profiles(id) on delete restrict,
 event_id text not null unique check(event_id~'^evt_[A-Za-z0-9_]+$'),
 refund_id text not null unique check(refund_id~'^re_[A-Za-z0-9]+$'),
 original_request_id text not null check(original_request_id~'^req_[A-Za-z0-9]+$'),
 proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create index sales_team_refund_request_receipt_v1 on public.sales_team_refund_requests_v1(receipt_id,created_at,id);
create function public.sales_team_refund_request_resolved_v1(p_request_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_refund_requests_v1 q join public.sales_team_refund_request_results_v1 result on result.request_id=q.id where q.id=p_request_id and
  (result.status='canceled_before_dispatch' or exists(select 1 from public.sales_team_refund_reviews_v1 review where review.receipt_id=q.receipt_id and review.refund_id=result.refund_id and review.amount_cents=q.amount_cents and review.responsibility=q.responsibility and review.reason_code=q.reason_code)))
$$;
-- A card refund can move from succeeded to failed. Recredit requires a complete
-- independent trace and once-only consumption of its actual failure credit.
create table public.sales_team_refund_return_authorizations_v1 (
 check_id uuid primary key references public.sales_team_financial_check_results_v1(check_id) on delete restrict deferrable initially deferred,
 receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 previous_refunded_cents bigint not null,current_refunded_cents bigint not null,
 context jsonb not null,created_at timestamptz not null default clock_timestamp(),
 check(current_refunded_cents>=0 and current_refunded_cents<previous_refunded_cents)
);
create table public.sales_team_refund_return_credits_v1 (
 check_id uuid not null references public.sales_team_refund_return_authorizations_v1(check_id) on delete restrict,
 transaction_id text not null references public.sales_team_financial_balance_entries_v1(transaction_id) on delete restrict deferrable initially deferred,
 amount_cents bigint not null check(amount_cents>0),primary key(check_id,transaction_id)
);
create function creatornet_team_private.authorize_refund_return_v1(p_check_id uuid,p_expected_revision integer,p_snapshot jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.sales_team_financial_checks_v1;r public.sales_team_receipts_v1;owner jsonb;credit jsonb;debit jsonb;remaining bigint;available bigint;used bigint;take bigint;begin
 select * into c from public.sales_team_financial_checks_v1 where id=p_check_id;select * into r from public.sales_team_receipts_v1 where id=c.receipt_id;
 if r.id is null or r.observation_revision is distinct from p_expected_revision or p_snapshot->'balanceEvidence'->'complete' is distinct from 'true'::jsonb or
  p_snapshot->'proof'->'context' is distinct from c.context or (p_snapshot->'proof'->>'refundedCents')::bigint is distinct from (p_snapshot->'capture'->'receipt'->>'refundedCents')::bigint then raise exception 'VERIFIED_REFUND_RETURN_REQUIRED';end if;
 remaining:=r.refunded_subtotal_cents-(p_snapshot->'proof'->>'refundedCents')::bigint;
 if remaining<=0 then raise exception 'VERIFIED_REFUND_RETURN_REQUIRED';end if;
 insert into public.sales_team_refund_return_authorizations_v1(check_id,receipt_id,previous_refunded_cents,current_refunded_cents,context)
 values(c.id,r.id,r.refunded_subtotal_cents,(p_snapshot->'proof'->>'refundedCents')::bigint,c.context);
 for owner in select value from jsonb_array_elements(p_snapshot->'balanceEvidence'->'owners'->'refunds') where value->>'status' in ('failed','canceled') order by (value->>'id') collate "C" loop
  select value into debit from jsonb_array_elements(p_snapshot->'balanceEvidence'->'entries') where value->>'id'=owner->>'balanceId' and value->>'ownerId'=owner->>'id' and value->>'kind'='refund';
  select value into credit from jsonb_array_elements(p_snapshot->'balanceEvidence'->'entries') where value->>'id'=owner->>'failureBalanceId' and value->>'ownerId'=owner->>'id' and value->>'kind'='refund_failure';
  if debit is null or credit is null or (debit->>'amountCents')::bigint is distinct from -(owner->>'amountCents')::bigint or (credit->>'amountCents')::bigint is distinct from (owner->>'amountCents')::bigint or (credit->>'created')::bigint<(debit->>'created')::bigint then continue;end if;
  select coalesce(sum(amount_cents),0) into used from public.sales_team_refund_return_credits_v1 where transaction_id=credit->>'id';
  available:=(credit->>'amountCents')::bigint-used;take:=least(remaining,greatest(0,available));
  if take>0 then insert into public.sales_team_refund_return_credits_v1(check_id,transaction_id,amount_cents) values(c.id,credit->>'id',take);remaining:=remaining-take;end if;
  exit when remaining=0;
 end loop;
 if remaining<>0 then raise exception 'VERIFIED_UNCONSUMED_REFUND_RETURN_REQUIRED';end if;
end $$;
create function public.record_sales_team_refund_recovery_v1(p_actor_id uuid,p_request_id uuid,p_proof jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;r public.sales_team_receipts_v1;o public.sales_team_provider_operations_v1;existing public.sales_team_refund_recovery_proofs_v1;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 if q.id is null then raise exception 'ORIGINAL_TEAM_REFUND_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 select * into r from public.sales_team_receipts_v1 where id=q.receipt_id;select * into o from public.sales_team_provider_operations_v1 where id=q.operation_id;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"eventId":"string","eventType":"string","eventCreated":"number","livemode":"boolean","account":"null","idempotencyKey":"string","originalRequestId":"string","refundId":"string","chargeId":"string","paymentIntentId":"string","amountCents":"number","currency":"string","refundCreated":"number","metadata":"object","context":"object","eventReadRequestId":"string","refundReadRequestId":"string","readStartedAt":"number"}');
 if o.id is null or p_proof->>'eventId'!~'^evt_[A-Za-z0-9_]+$' or p_proof->>'eventType'<>'refund.created' or p_proof->'livemode' is distinct from to_jsonb(q.context->>'mode'='live') or
  p_proof->>'idempotencyKey' is distinct from o.idempotency_key or p_proof->>'originalRequestId'!~'^req_[A-Za-z0-9]+$' or p_proof->>'refundId'!~'^re_[A-Za-z0-9]+$' or
  p_proof->>'chargeId' is distinct from r.charge_id or p_proof->>'paymentIntentId' is distinct from r.payment_intent_id or (p_proof->>'amountCents')::bigint is distinct from q.amount_cents or p_proof->>'currency'<>'usd' or p_proof->'metadata' is distinct from q.request->'params'->'metadata' or p_proof->'context' is distinct from q.context or
  p_proof->>'eventReadRequestId'!~'^req_[A-Za-z0-9]+$' or p_proof->>'refundReadRequestId'!~'^req_[A-Za-z0-9]+$' or
  (p_proof->>'eventCreated')::numeric not between extract(epoch from o.first_dispatch_at)-5 and extract(epoch from clock_timestamp())+5 or (p_proof->>'refundCreated')::numeric not between extract(epoch from o.first_dispatch_at)-5 and extract(epoch from clock_timestamp())+5 or
  (p_proof->>'readStartedAt')::numeric not between extract(epoch from clock_timestamp())*1000-30000 and extract(epoch from clock_timestamp())*1000+1000 then raise exception 'ORIGINAL_REFUND_EVENT_PROVENANCE_REQUIRED';end if;
 select * into existing from public.sales_team_refund_recovery_proofs_v1 where request_id=q.id;
 if existing.request_id is not null then
  if existing.event_id<>p_proof->>'eventId' or existing.refund_id<>p_proof->>'refundId' or existing.original_request_id<>p_proof->>'originalRequestId' then raise exception 'ORIGINAL_REFUND_EVENT_PROVENANCE_CHANGED';end if;
  return;
 end if;
 insert into public.sales_team_refund_recovery_proofs_v1(request_id,observed_by,event_id,refund_id,original_request_id,proof) values(q.id,p_actor_id,p_proof->>'eventId',p_proof->>'refundId',p_proof->>'originalRequestId',p_proof);
end $$;
-- Only the validated internal check may authorize a decrease. The existing
-- monotonic guard remains in force for all other observation identities.
do $patch$ declare src text;needle text;replacement text;begin
 src:=replace(pg_get_functiondef('public.reconcile_sales_team_receipt_v1(uuid,integer,text,bigint,bigint,boolean,boolean,bigint,text,timestamp with time zone,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
 needle:='p_refunded_cents<v_receipt.refunded_subtotal_cents';
 replacement:='(p_refunded_cents<v_receipt.refunded_subtotal_cents and not exists(select 1 from public.sales_team_refund_return_authorizations_v1 returned where returned.receipt_id=v_receipt.id and p_source_identity=''check:''||returned.check_id::text and returned.previous_refunded_cents=v_receipt.refunded_subtotal_cents and returned.current_refunded_cents=p_refunded_cents and returned.context=p_proof->''context'' and returned.previous_refunded_cents-returned.current_refunded_cents=(select sum(credit.amount_cents) from public.sales_team_refund_return_credits_v1 credit where credit.check_id=returned.check_id)))';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_REFUND_RETURN_RECEIPT_DEPENDENCY_DIFFERS';end if;execute replace(src,needle,replacement);
 src:=replace(pg_get_functiondef('public.complete_sales_team_financial_check_v1(uuid,integer,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
 needle:='declare c public.sales_team_financial_checks_v1;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_REFUND_CHECK_VARIABLE_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'declare refund_request record;refund_observation jsonb;prior_refund_observation jsonb;c public.sales_team_financial_checks_v1;');
 needle:=$old$(cp->>'refundedCents')::bigint not between r.refunded_subtotal_cents and r.subtotal_cents$old$;
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_REFUND_RETURN_CHECK_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,$new$(cp->>'refundedCents')::bigint not between 0 and r.subtotal_cents$new$);
 needle:=' update public.sales_team_receipts_v1 set processing_cost_cents=original_cost,balance_transaction_id=';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_REFUND_RETURN_AUTHORIZATION_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,$new$ -- Every bound original must be present in the independently reread list.
 -- A missing/stale list cannot clear the request hold or reverse terminal state.
 for refund_request in select q.*,o.provider_id from public.sales_team_refund_requests_v1 q join public.sales_team_provider_operations_v1 o on o.id=q.operation_id where q.receipt_id=r.id and o.status='bound' loop
  select value into refund_observation from jsonb_array_elements(p_snapshot->'refunds') where value->>'id'=refund_request.provider_id;
  select proof into prior_refund_observation from public.sales_team_refund_request_observations_v1 where request_id=refund_request.id order by observation_number desc limit 1;
  if refund_observation is null or (refund_observation->>'amountCents')::bigint is distinct from refund_request.amount_cents or refund_observation->>'chargeId' is distinct from r.charge_id or
   prior_refund_observation is not null and (prior_refund_observation->>'created' is distinct from refund_observation->>'created' or
    prior_refund_observation->>'status' in ('failed','canceled') and prior_refund_observation->>'status' is distinct from refund_observation->>'status' or
    prior_refund_observation->>'status'='succeeded' and refund_observation->>'status' not in ('succeeded','failed','canceled')) then raise exception 'ORIGINAL_TEAM_REFUND_STATE_REQUIRES_REVIEW';end if;
 end loop;
 if (p->>'refundedCents')::bigint<r.refunded_subtotal_cents then perform creatornet_team_private.authorize_refund_return_v1(c.id,r.observation_revision,p_snapshot);end if;
$new$||needle);
 needle:=$old$for own in select value from jsonb_array_elements(p_snapshot->'refunds') where value->>'status'='succeeded' order by (value->>'created')::bigint,(value->>'id') collate "C" loop$old$;
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_REFUND_FAILED_COST_ORDER_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,$new$for own in select value from jsonb_array_elements(p_snapshot->'refunds') order by (value->>'created')::bigint,(value->>'id') collate "C" loop$new$);
 needle:='   base_credit:=base_credit+creatornet_team_private.financial_processing_share_v1(r.subtotal_cents,coalesce(original_cost,0),prior+(own->>''amountCents'')::bigint)-creatornet_team_private.financial_processing_share_v1(r.subtotal_cents,coalesce(original_cost,0),prior);';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_REFUND_FAILED_COST_SHARE_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'   if own->>''status''=''succeeded'' then '||btrim(needle)||'end if;');
 needle:='  prior:=prior+(own->>''amountCents'')::bigint;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_REFUND_FAILED_COST_PRIOR_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'  if own->>''status''=''succeeded'' then '||btrim(needle)||'end if;');
 needle:=$old$ return jsonb_build_object('receiptId',r.id,'held',(result->>'review_hold')::boolean or (result->>'dispute_hold')::boolean);$old$;
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_REFUND_FINAL_OBSERVATION_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,$new$ -- Use the same immutable check identity as the actual accounting. Signed
 -- events/workers retain that provenance rather than impersonating an admin.
 for refund_request in select q.id,o.provider_id from public.sales_team_refund_requests_v1 q join public.sales_team_provider_operations_v1 o on o.id=q.operation_id where q.receipt_id=r.id and o.status='bound' loop
  select value into refund_observation from jsonb_array_elements(p_snapshot->'refunds') where value->>'id'=refund_request.provider_id;
  insert into public.sales_team_refund_request_observations_v1(request_id,financial_check_id,proof) values(refund_request.id,c.id,refund_observation);
 end loop;
$new$||needle);execute src;
end $patch$;
alter function public.complete_sales_team_payment_event_v1(text,integer,jsonb) rename to complete_sales_team_event_before_refund_return_v1;
create function public.complete_sales_team_payment_event_v1(p_event_id text,p_expected_revision integer,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare e public.sales_team_payment_events_v1;r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;check_id uuid;begin
 select * into e from public.sales_team_payment_events_v1 where event_id=p_event_id;select * into a from public.sales_team_sale_agreements_v1 where id=e.sale_id;
 if a.id is null then raise exception 'ORIGINAL_TEAM_EVENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));select * into r from public.sales_team_receipts_v1 where obligation_id=e.obligation_id;
 if r.id is not null and (p_snapshot->'capture'->'receipt'->>'refundedCents')::bigint<r.refunded_subtotal_cents then
  if exists(select 1 from public.sales_team_payment_event_results_v1 where event_id=e.event_id) then return jsonb_build_object('receiptId',r.id,'held',r.review_hold or r.dispute_hold);end if;
  if not exists(select 1 from public.sales_team_controls_v1 where singleton and event_reconciliation_enabled and financial_reconciliation_enabled) or not p_snapshot?'balanceEvidence' then raise exception 'TEAM_REFUND_RETURN_RECONCILIATION_HELD';end if;
  if r.observation_revision is distinct from p_expected_revision or e.context is distinct from a.context or p_snapshot->'proof'->>'sourceEventId' is distinct from e.event_id or
   e.payment_intent_id is distinct from r.payment_intent_id or e.charge_id is not null and e.charge_id is distinct from r.charge_id or
   e.object_id~'^re_' and not exists(select 1 from jsonb_array_elements(p_snapshot->'refunds') v where v->>'id'=e.object_id) or e.object_id~'^du_' and not exists(select 1 from jsonb_array_elements(p_snapshot->'disputes') v where v->>'id'=e.object_id) then raise exception 'VERIFIED_REFUND_RETURN_EVENT_REQUIRED';end if;
  -- Result, internal check, return-credit consumption and accounting are one
  -- transaction. The deferred FKs refuse a partial/uncompleted authorization.
  insert into public.sales_team_payment_event_results_v1(event_id,receipt_id,proof) values(e.event_id,r.id,jsonb_build_object('financial',p_snapshot->'proof','refunds',p_snapshot->'refunds','disputes',p_snapshot->'disputes','readback',p_snapshot->'capture'->'readback'));
  check_id:=md5('creatornet-team-financial-event-v1:'||e.event_id||':'||r.id::text)::uuid;
  perform public.begin_sales_team_financial_check_v1(check_id,r.id,null,e.event_id,null,e.context);select * into r from public.sales_team_receipts_v1 where id=r.id;
  return public.complete_sales_team_financial_check_v1(check_id,r.observation_revision,p_snapshot);
 end if;
 return public.complete_sales_team_event_before_refund_return_v1(p_event_id,p_expected_revision,p_snapshot);
end $$;
create function public.sales_team_refund_operation_id_v1(p_request_id uuid)
returns uuid language sql immutable security invoker set search_path=pg_catalog as $$
 select overlay(overlay(substring(encode(sha256(convert_to('creatornet-team-v1:'||p_request_id::text||':refund:refund:v1','UTF8')),'hex'),1,32) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;
create function public.sales_team_refund_request_json_v1(p_request_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select to_jsonb(q)||jsonb_build_object('scope',jsonb_build_object('scopeId',q.id,'scopeKey','refund:v1','kind','refund','saleId',q.sale_id,'creatorId',q.creator_id,'actorId',q.requested_by,'workerRunId',null),
  'source',jsonb_build_object('saleId',a.id,'buyerId',a.buyer_id,'obligationId',r.obligation_id,'paymentIntentId',r.payment_intent_id,'context',q.context),
  'receipt',jsonb_build_object('id',r.id,'revision',r.observation_revision,'subtotalCents',r.subtotal_cents,'refundedCents',r.refunded_subtotal_cents,'lossCents',r.confirmed_loss_subtotal_cents,'chargeId',r.charge_id,'paymentIntentId',r.payment_intent_id,'held',r.review_hold or r.dispute_hold),
  'operation',(select public.sales_team_operation_json_v1(o.id) from public.sales_team_provider_operations_v1 o where o.id=q.operation_id),
  'observedStatus',(select observed.proof->>'status' from public.sales_team_refund_request_observations_v1 observed where observed.request_id=q.id order by observed.observation_number desc limit 1),
  'result',(select jsonb_build_object('status',coalesce((select observed.proof->>'status' from public.sales_team_refund_request_observations_v1 observed where observed.request_id=q.id order by observed.observation_number desc limit 1),result.status),'refundId',result.refund_id) from public.sales_team_refund_request_results_v1 result where result.request_id=q.id))
 from public.sales_team_refund_requests_v1 q join public.sales_team_receipts_v1 r on r.id=q.receipt_id join public.sales_team_sale_agreements_v1 a on a.id=q.sale_id where q.id=p_request_id
$$;
create function public.read_sales_team_refund_request_v1(p_actor_id uuid,p_request_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 if exists(select 1 from public.sales_team_refund_requests_v1 where id=p_request_id and context is distinct from p_context) then raise exception 'ORIGINAL_TEAM_REFUND_CONTEXT_CHANGED';end if;
 return public.sales_team_refund_request_json_v1(p_request_id);
end $$;
create function public.reserve_sales_team_refund_v1(p_actor_id uuid,p_request_id uuid,p_receipt_id uuid,p_expected_revision integer,p_amount_cents bigint,p_responsibility text,p_reason_code text,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;operation_id uuid;params jsonb;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;select * into a from public.sales_team_sale_agreements_v1 where id=r.sale_id;
 if a.id is null or a.context is distinct from p_context or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'OWNED_FINANCIAL_SOURCE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id for update;
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 if q.id is not null then
  if q.receipt_id<>r.id or q.requested_by<>p_actor_id or q.amount_cents is distinct from p_amount_cents or q.responsibility is distinct from p_responsibility or q.reason_code is distinct from p_reason_code or q.expected_revision is distinct from p_expected_revision or q.context is distinct from p_context then raise exception 'ORIGINAL_TEAM_REFUND_REQUEST_CHANGED';end if;
  return public.sales_team_refund_request_json_v1(q.id);
 end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and refund_dispatch_enabled and event_reconciliation_enabled and financial_reconciliation_enabled and refund_review_enabled) then raise exception 'TEAM_REFUND_DISPATCH_HELD';end if;
 if p_request_id is null or p_expected_revision is null or r.observation_revision is distinct from p_expected_revision or p_amount_cents is null or p_amount_cents not between 1 and r.subtotal_cents-r.refunded_subtotal_cents then raise exception 'TEAM_REFUND_CURRENT_TOTALS_REQUIRED';end if;
 if r.review_hold or r.dispute_hold or r.processing_cost_cents is null or r.confirmed_loss_subtotal_cents<>r.refunded_subtotal_cents or
  exists(select 1 from public.sales_team_payment_events_v1 e where e.obligation_id=r.obligation_id and not exists(select 1 from public.sales_team_payment_event_results_v1 er where er.event_id=e.event_id)) or
  exists(select 1 from public.sales_team_financial_checks_v1 c where c.receipt_id=r.id and not exists(select 1 from public.sales_team_financial_check_results_v1 cr where cr.check_id=c.id)) or
  exists(select 1 from public.sales_team_refund_requests_v1 other where other.receipt_id=r.id and not public.sales_team_refund_request_resolved_v1(other.id)) then raise exception 'TEAM_REFUND_FINANCIAL_REVIEW_REQUIRED';end if;
 operation_id:=public.sales_team_refund_operation_id_v1(p_request_id);
 params:=jsonb_build_object('charge',r.charge_id,'amount',p_amount_cents,'metadata',jsonb_build_object('team_protocol','creatornet-team-distribution-v1','team_sale_id',a.id,'team_obligation_id',r.obligation_id,'team_refund_request_id',p_request_id,'team_provider_operation_id',operation_id));
 insert into public.sales_team_refund_requests_v1(id,receipt_id,sale_id,creator_id,requested_by,amount_cents,responsibility,reason_code,context,expected_revision,refunded_before_cents,operation_id,request)
 values(p_request_id,r.id,a.id,a.creator_id,p_actor_id,p_amount_cents,p_responsibility,p_reason_code,p_context,p_expected_revision,r.refunded_subtotal_cents,operation_id,jsonb_build_object('apiVersion','2026-08-26.dahlia','method','POST','path','/v1/refunds','params',params));
 update public.sales_team_receipts_v1 set review_hold=true,observation_revision=observation_revision+1 where id=r.id;
 perform public.recompute_sales_team_balances_v1(a.id,'pending-refund:'||p_request_id::text,jsonb_build_object('refundRequestId',p_request_id));
 return public.sales_team_refund_request_json_v1(p_request_id);
end $$;
-- Every observation path retains the durable request hold, including older
-- signed events and internal inspections finishing during an uncertain write.
alter function public.reconcile_sales_team_receipt_v1(uuid,integer,text,bigint,bigint,boolean,boolean,bigint,text,timestamp with time zone,jsonb) rename to reconcile_sales_team_receipt_before_refund_v1;
create function public.reconcile_sales_team_receipt_v1(p_receipt_id uuid,p_expected_revision integer,p_source_identity text,p_refunded_cents bigint,p_total_loss_cents bigint,p_dispute_hold boolean,p_review_hold boolean,p_processing_cost_cents bigint,p_balance_transaction_id text,p_available_on timestamptz,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare creator uuid;begin
 select creator_id into creator from public.sales_team_sale_agreements_v1 where id=(select sale_id from public.sales_team_receipts_v1 where id=p_receipt_id);
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||creator::text,0));
 if exists(select 1 from public.sales_team_refund_requests_v1 q where q.receipt_id=p_receipt_id and not public.sales_team_refund_request_resolved_v1(q.id)) then
  p_review_hold:=true;p_proof:=jsonb_set(jsonb_set(p_proof,'{reviewHold}','true'::jsonb),'{alerts}',p_proof->'alerts'||'["TEAM_REFUND_REQUEST_PENDING"]'::jsonb);
 end if;
 return public.reconcile_sales_team_receipt_before_refund_v1(p_receipt_id,p_expected_revision,p_source_identity,p_refunded_cents,p_total_loss_cents,p_dispute_hold,p_review_hold,p_processing_cost_cents,p_balance_transaction_id,p_available_on,p_proof);
end $$;
create function public.attach_sales_team_refund_check_v1(p_actor_id uuid,p_request_id uuid,p_check_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;r public.sales_team_receipts_v1;c public.sales_team_financial_checks_v1;cr public.sales_team_financial_check_results_v1;begin
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 if q.id is null or q.requested_by is distinct from p_actor_id or not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 select * into r from public.sales_team_receipts_v1 where id=q.receipt_id;select * into c from public.sales_team_financial_checks_v1 where id=p_check_id;select * into cr from public.sales_team_financial_check_results_v1 where check_id=p_check_id;
 if cr.check_id is null or c.receipt_id is distinct from r.id or c.actor_id is distinct from p_actor_id or c.context is distinct from q.context or c.created_at<q.created_at or cr.created_at<r.observed_at or
  cr.created_at<clock_timestamp()-interval '30 seconds' or cr.proof->'balances'->'complete' is distinct from 'true'::jsonb or cr.proof->'financial'->'reviewHold' is distinct from 'false'::jsonb or cr.proof->'financial'->'disputeHold' is distinct from 'false'::jsonb or cr.proof->'financial'->'alerts' is distinct from '[]'::jsonb or
  r.refunded_subtotal_cents<>q.refunded_before_cents or r.confirmed_loss_subtotal_cents<>r.refunded_subtotal_cents or
  exists(select 1 from public.sales_team_refund_request_results_v1 where request_id=q.id) or exists(select 1 from public.sales_team_provider_operations_v1 where id=q.operation_id) then raise exception 'TEAM_REFUND_FRESH_INSPECTION_REQUIRED';end if;
 insert into public.sales_team_refund_dispatch_checks_v1(request_id,check_id,receipt_revision) values(q.id,c.id,r.observation_revision) on conflict(request_id,check_id) do nothing;
 return public.sales_team_refund_request_json_v1(q.id);
end $$;
create function public.sales_team_refund_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_refund_requests_v1 q join public.sales_team_receipts_v1 r on r.id=q.receipt_id
 join public.sales_team_refund_dispatch_checks_v1 checked on checked.request_id=q.id and checked.receipt_revision=r.observation_revision
 join public.sales_team_financial_check_results_v1 cr on cr.check_id=checked.check_id
 where q.id=(p_scope->>'scopeId')::uuid and p_scope=jsonb_build_object('scopeId',q.id,'scopeKey','refund:v1','kind','refund','saleId',q.sale_id,'creatorId',q.creator_id,'actorId',q.requested_by,'workerRunId',null) and
  q.context=p_context and exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) and exists(select 1 from public.profiles where id=q.requested_by and role='admin') and
  exists(select 1 from public.sales_team_controls_v1 where singleton and refund_dispatch_enabled and event_reconciliation_enabled and refund_review_enabled and financial_reconciliation_enabled) and
  cr.created_at>clock_timestamp()-interval '30 seconds' and cr.created_at>=r.observed_at and r.refunded_subtotal_cents=q.refunded_before_cents and q.amount_cents<=r.subtotal_cents-r.refunded_subtotal_cents and not r.dispute_hold and
  not exists(select 1 from public.sales_team_refund_request_results_v1 where request_id=q.id) and
  not exists(select 1 from public.sales_team_payment_events_v1 e where e.obligation_id=r.obligation_id and not exists(select 1 from public.sales_team_payment_event_results_v1 er where er.event_id=e.event_id)) and
  not exists(select 1 from public.sales_team_financial_checks_v1 c where c.receipt_id=r.id and not exists(select 1 from public.sales_team_financial_check_results_v1 result where result.check_id=c.id)))
$$;
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_admitted_before_refund_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select case when p_scope->>'kind'='refund' then public.sales_team_refund_operation_admitted_v1(p_scope,p_context) else public.sales_team_operation_admitted_before_refund_v1(p_scope,p_context) end
$$;
alter function public.claim_sales_team_provider_operation_v1(uuid,jsonb,jsonb,jsonb) rename to claim_sales_team_operation_before_refund_v1;
create function public.claim_sales_team_provider_operation_v1(p_operation_id uuid,p_scope jsonb,p_context jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if p_scope->>'kind'='refund' and not exists(select 1 from public.sales_team_refund_requests_v1 q where q.id=(p_scope->>'scopeId')::uuid and q.operation_id=p_operation_id and q.request=p_request and q.context=p_context and
  p_scope=jsonb_build_object('scopeId',q.id,'scopeKey','refund:v1','kind','refund','saleId',q.sale_id,'creatorId',q.creator_id,'actorId',q.requested_by,'workerRunId',null)) then raise exception 'ORIGINAL_TEAM_REFUND_OPERATION_REQUIRED';end if;
 return public.claim_sales_team_operation_before_refund_v1(p_operation_id,p_scope,p_context,p_request);
end $$;
create function public.record_sales_team_refund_result_v1(p_actor_id uuid,p_request_id uuid,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;r public.sales_team_receipts_v1;o public.sales_team_provider_operations_v1;previous public.sales_team_refund_request_results_v1;prior jsonb;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 if q.id is null then raise exception 'ORIGINAL_TEAM_REFUND_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 select * into r from public.sales_team_receipts_v1 where id=q.receipt_id;select * into o from public.sales_team_provider_operations_v1 where id=q.operation_id;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"id":"string","chargeId":"string","paymentIntentId":"string","amountCents":"number","currency":"string","status":"string","created":"number","context":"object","metadata":"object","providerRequestId":"string","readStartedAt":"number"}');
 if o.status is distinct from 'bound' or o.provider_id is distinct from p_proof->>'id' or p_proof->>'id'!~'^re_[A-Za-z0-9]+$' or p_proof->>'chargeId' is distinct from r.charge_id or p_proof->>'paymentIntentId' is distinct from r.payment_intent_id or
  (p_proof->>'amountCents')::bigint is distinct from q.amount_cents or p_proof->>'currency'<>'usd' or p_proof->>'status' not in ('succeeded','pending','requires_action','failed','canceled') or p_proof->'metadata' is distinct from q.request->'params'->'metadata' or p_proof->'context' is distinct from q.context or
  p_proof->>'providerRequestId'!~'^req_[A-Za-z0-9]+$' or (p_proof->>'created')::numeric not between extract(epoch from o.first_dispatch_at)-5 and extract(epoch from clock_timestamp())+5 or
  (p_proof->>'readStartedAt')::numeric not between extract(epoch from clock_timestamp())*1000-30000 and extract(epoch from clock_timestamp())*1000+1000 then raise exception 'VERIFIED_ORIGINAL_TEAM_REFUND_REQUIRED';end if;
 select * into previous from public.sales_team_refund_request_results_v1 where request_id=q.id;
 select proof into prior from public.sales_team_refund_request_observations_v1 where request_id=q.id order by observation_number desc limit 1;
 if previous.request_id is not null and (previous.refund_id is distinct from p_proof->>'id' or previous.status='canceled_before_dispatch') or
  prior is not null and (prior->>'created' is distinct from p_proof->>'created' or prior->>'id' is distinct from p_proof->>'id' or
   prior->>'status' in ('failed','canceled') and prior->>'status' is distinct from p_proof->>'status' or prior->>'status'='succeeded' and p_proof->>'status' not in ('succeeded','failed','canceled')) then raise exception 'ORIGINAL_TEAM_REFUND_STATE_REQUIRES_REVIEW';end if;
 insert into public.sales_team_refund_request_observations_v1(request_id,observed_by,proof) values(q.id,p_actor_id,p_proof);
 if p_proof->>'status' in ('succeeded','failed','canceled') and previous.request_id is null then insert into public.sales_team_refund_request_results_v1(request_id,refund_id,status,observed_by,proof) values(q.id,p_proof->>'id',p_proof->>'status',p_actor_id,p_proof);end if;
 -- A provider result does not itself clear the hold. Independent financial
 -- reconciliation, including its exact saved cost responsibility, follows.
 return public.sales_team_refund_request_json_v1(q.id);
end $$;
create function public.record_sales_team_refund_responsibility_v1(p_actor_id uuid,p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;r public.sales_team_receipts_v1;result public.sales_team_refund_request_results_v1;review public.sales_team_refund_reviews_v1;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 if q.id is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=q.context) then raise exception 'ORIGINAL_TEAM_REFUND_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 select * into r from public.sales_team_receipts_v1 where id=q.receipt_id;select * into result from public.sales_team_refund_request_results_v1 where request_id=q.id;
 if result.refund_id is null or result.status='canceled_before_dispatch' then raise exception 'VERIFIED_ORIGINAL_TEAM_REFUND_REQUIRED';end if;
 select * into review from public.sales_team_refund_reviews_v1 where refund_id=result.refund_id;
 if review.id is not null then
  if review.receipt_id<>r.id or review.amount_cents<>q.amount_cents or review.responsibility<>q.responsibility or review.reason_code<>q.reason_code then raise exception 'ORIGINAL_REFUND_RESPONSIBILITY_CHANGED';end if;
  return jsonb_build_object('reviewId',review.id,'holdRetained',true);
 end if;
 insert into public.sales_team_refund_reviews_v1(id,receipt_id,refund_id,charge_id,amount_cents,responsibility,reason_code,reviewed_by)
 values(q.id,r.id,result.refund_id,r.charge_id,q.amount_cents,q.responsibility,q.reason_code,p_actor_id);
 update public.sales_team_receipts_v1 set review_hold=true,observation_revision=observation_revision+1 where id=r.id;
 perform public.recompute_sales_team_balances_v1(q.sale_id,'refund-responsibility:'||q.id::text,jsonb_build_object('refundRequestId',q.id));
 return jsonb_build_object('reviewId',q.id,'holdRetained',true);
end $$;
alter function public.review_sales_team_refund_v1(uuid,uuid,uuid,integer,text,text,jsonb) rename to review_sales_team_refund_before_dispatch_v1;
create function public.review_sales_team_refund_v1(p_actor_id uuid,p_request_id uuid,p_receipt_id uuid,p_expected_revision integer,p_responsibility text,p_reason_code text,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;r public.sales_team_receipts_v1;begin
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||(select creator_id::text from public.sales_team_sale_agreements_v1 where id=r.sale_id),0));
 select request.* into q from public.sales_team_refund_requests_v1 request join public.sales_team_provider_operations_v1 operation on operation.id=request.operation_id where request.receipt_id=r.id and operation.provider_id=p_proof->>'refundId';
 if q.id is not null and (q.responsibility is distinct from p_responsibility or q.reason_code is distinct from p_reason_code) then raise exception 'ORIGINAL_REFUND_RESPONSIBILITY_CHANGED';end if;
 if q.id is null and exists(select 1 from public.sales_team_refund_requests_v1 pending where pending.receipt_id=r.id and not public.sales_team_refund_request_resolved_v1(pending.id)) then raise exception 'TEAM_REFUND_ORIGINAL_RECOVERY_REQUIRED';end if;
 return public.review_sales_team_refund_before_dispatch_v1(p_actor_id,p_request_id,p_receipt_id,p_expected_revision,p_responsibility,p_reason_code,p_proof);
end $$;
create function public.cancel_unsent_sales_team_refund_v1(p_actor_id uuid,p_request_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;begin
 if not exists(select 1 from public.profiles where id=p_actor_id and role='admin') or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'FINANCIAL_ADMIN_REQUIRED';end if;
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 if q.id is null or q.context is distinct from p_context then raise exception 'ORIGINAL_TEAM_REFUND_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 if exists(select 1 from public.sales_team_refund_request_results_v1 where request_id=q.id and status='canceled_before_dispatch') then return public.sales_team_refund_request_json_v1(q.id);end if;
 if exists(select 1 from public.sales_team_provider_operations_v1 where id=q.operation_id) or exists(select 1 from public.sales_team_refund_request_results_v1 where request_id=q.id) then raise exception 'TEAM_REFUND_ORIGINAL_RECOVERY_REQUIRED';end if;
 insert into public.sales_team_refund_request_results_v1(request_id,status,observed_by,proof) values(q.id,'canceled_before_dispatch',p_actor_id,jsonb_build_object('noProviderOperation',true,'context',p_context));
 return public.sales_team_refund_request_json_v1(q.id);
end $$;
create function public.read_sales_team_admin_refund_preview_v1(p_actor_id uuid,p_receipt_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;begin
 perform public.read_sales_team_financial_admin_source_v1(p_actor_id,p_receipt_id,p_context);
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;select * into a from public.sales_team_sale_agreements_v1 where id=r.sale_id;
 return jsonb_build_object('receiptId',r.id,'revision',r.observation_revision,'subtotalCents',r.subtotal_cents,'refundedCents',r.refunded_subtotal_cents,'remainingCents',r.subtotal_cents-r.refunded_subtotal_cents,
  'originalProcessingCostCents',r.processing_cost_cents,'platformFeeReturnedCents',r.platform_fee_return_cents,'originalProcessingCreditCents',r.platform_processing_credit_cents,
  'auxiliaryCostCents',r.financial_adjustment_cost_cents,'chargeId',r.charge_id,'paymentIntentId',r.payment_intent_id,
  'eligible',not(r.review_hold or r.dispute_hold) and r.processing_cost_cents is not null and r.refunded_subtotal_cents=r.confirmed_loss_subtotal_cents and
   not exists(select 1 from public.sales_team_refund_requests_v1 q where q.receipt_id=r.id and not public.sales_team_refund_request_resolved_v1(q.id)));
end $$;
alter function public.read_sales_team_financial_admin_queue_v1(uuid,jsonb,uuid,integer) rename to read_sales_team_financial_queue_before_refunds_v1;
create function public.read_sales_team_financial_admin_queue_v1(p_actor_id uuid,p_context jsonb,p_after uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;begin
 result:=public.read_sales_team_financial_queue_before_refunds_v1(p_actor_id,p_context,p_after,p_limit);
 return jsonb_set(result,'{rows}',coalesce((select jsonb_agg(row||jsonb_build_object('refundRequests',coalesce((select jsonb_agg(jsonb_build_object('requestId',q.id,'amountCents',q.amount_cents,'responsibility',q.responsibility,'reasonCode',q.reason_code,
  'dispatchState',coalesce(operation.status,'not_dispatched'),'providerStatus',coalesce((select observation.proof->>'status' from public.sales_team_refund_request_observations_v1 observation where observation.request_id=q.id order by observation.observation_number desc limit 1),outcome.status),
  'refundId',coalesce(outcome.refund_id,operation.provider_id),'resolved',public.sales_team_refund_request_resolved_v1(q.id),'createdAt',q.created_at) order by q.created_at desc,q.id desc)
  from (select * from public.sales_team_refund_requests_v1 where receipt_id=(row->>'receiptId')::uuid order by public.sales_team_refund_request_resolved_v1(id),created_at desc,id desc limit 10) q
  left join public.sales_team_provider_operations_v1 operation on operation.id=q.operation_id left join public.sales_team_refund_request_results_v1 outcome on outcome.request_id=q.id),'[]'::jsonb)) order by position)
  from jsonb_array_elements(result->'rows') with ordinality rows(row,position)),'[]'::jsonb));
end $$;
do $$ declare n text;sig regprocedure;begin
 foreach n in array array['sales_team_refund_requests_v1','sales_team_refund_dispatch_checks_v1','sales_team_refund_request_results_v1','sales_team_refund_request_observations_v1','sales_team_refund_return_authorizations_v1','sales_team_refund_return_credits_v1','sales_team_refund_recovery_proofs_v1'] loop
  execute format('alter table public.%I enable row level security',n);execute format('revoke all on public.%I from public,anon,authenticated',n);execute format('grant select,insert on public.%I to service_role',n);
  execute format('create trigger team_refund_history_immutable before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',n);
 end loop;
 for sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('read_sales_team_admin_refund_preview_v1','read_sales_team_financial_admin_queue_v1','read_sales_team_financial_queue_before_refunds_v1','record_sales_team_refund_recovery_v1','sales_team_refund_request_resolved_v1','sales_team_refund_operation_id_v1','sales_team_refund_request_json_v1','read_sales_team_refund_request_v1','reserve_sales_team_refund_v1','reconcile_sales_team_receipt_v1','reconcile_sales_team_receipt_before_refund_v1','attach_sales_team_refund_check_v1','sales_team_refund_operation_admitted_v1','sales_team_operation_admitted_v1','sales_team_operation_admitted_before_refund_v1','claim_sales_team_provider_operation_v1','claim_sales_team_operation_before_refund_v1','record_sales_team_refund_result_v1','cancel_unsent_sales_team_refund_v1','record_sales_team_refund_responsibility_v1','review_sales_team_refund_v1','review_sales_team_refund_before_dispatch_v1','complete_sales_team_payment_event_v1','complete_sales_team_event_before_refund_return_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $$;
revoke all on function creatornet_team_private.authorize_refund_return_v1(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function creatornet_team_private.authorize_refund_return_v1(uuid,integer,jsonb) to service_role;
do $$ begin
 execute format('grant usage,select on sequence %s to service_role',pg_get_serial_sequence('public.sales_team_refund_request_observations_v1','observation_number'));
end $$;
commit;
