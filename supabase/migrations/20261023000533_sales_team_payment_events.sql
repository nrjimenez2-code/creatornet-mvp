-- Local candidate. Signed event identities hold originals before independent
-- GET-only reconciliation. No account/payment/refund/transfer/payout dispatch.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column event_reconciliation_enabled boolean not null default false;
create table public.sales_team_payment_events_v1 (
 event_id text primary key check(event_id~'^evt_[A-Za-z0-9_]{1,128}$'),
 event_type text not null,
 event_created bigint not null,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 obligation_id uuid not null references public.sales_team_payment_attempts_v1(obligation_id) on delete restrict,
 payment_intent_id text not null check(payment_intent_id~'^pi_[A-Za-z0-9]+$'),
 charge_id text,
 object_id text not null,
 context jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_payment_event_results_v1 (
 event_id text primary key references public.sales_team_payment_events_v1(event_id) on delete restrict,
 receipt_id uuid references public.sales_team_receipts_v1(id) on delete restrict,
 proof jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_refund_reviews_v1 (
 id uuid primary key,
 receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 refund_id text not null unique check(refund_id~'^re_[A-Za-z0-9]+$'),
 charge_id text not null,
 amount_cents bigint not null check(amount_cents>0),
 responsibility text not null check(responsibility in ('creator','platform')),
 reason_code text not null,
 reviewed_by uuid not null references public.profiles(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 check(reason_code='legally_required' or responsibility='creator' and reason_code in ('creator_non_delivery','creator_missed_session','material_misrepresentation','creator_discretionary') or
  responsibility='platform' and reason_code in ('duplicate_charge','platform_technical_error','incorrect_platform_billing','platform_goodwill'))
);
create function public.guard_sales_team_pending_receipt_v1() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$begin
 if exists(select 1 from public.sales_team_payment_events_v1 e where e.obligation_id=new.obligation_id and not exists(select 1 from public.sales_team_payment_event_results_v1 r where r.event_id=e.event_id)) then new.review_hold:=true;end if;
 return new;
end $$;
create trigger sales_team_pending_receipt_hold_v1 before insert on public.sales_team_receipts_v1 for each row execute function public.guard_sales_team_pending_receipt_v1();
create function public.locate_sales_team_payment_event_v1(p_payment_intent_id text,p_charge_id text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare t public.sales_team_payment_attempts_v1;a public.sales_team_sale_agreements_v1;o public.sales_team_provider_operations_v1;r public.sales_team_receipts_v1;
begin
 if p_payment_intent_id is not null and p_payment_intent_id!~'^pi_[A-Za-z0-9]+$' or p_charge_id is not null and p_charge_id!~'^ch_[A-Za-z0-9]+$' then raise exception 'INVALID_TEAM_EVENT_IDENTITY';end if;
 select * into r from public.sales_team_receipts_v1 where charge_id=p_charge_id;
 if r.id is not null and p_payment_intent_id is not null and r.payment_intent_id<>p_payment_intent_id then raise exception 'TEAM_EVENT_IDENTITY_DIFFERS';end if;
 select * into o from public.sales_team_provider_operations_v1 where kind='intent' and provider_id=coalesce(p_payment_intent_id,r.payment_intent_id);
 if o.id is null then return null;end if;
 select * into t from public.sales_team_payment_attempts_v1 where intent_operation_id=o.id;
 select * into a from public.sales_team_sale_agreements_v1 where id=t.sale_id;
 if o.status is distinct from 'bound' or t.obligation_id is null or a.id is null or o.context is distinct from a.context or o.sale_id is distinct from a.id or
  o.actor_id is distinct from a.buyer_id or o.creator_id is distinct from a.creator_id or t.contract->>'operationId' is distinct from o.id::text or
  r.id is not null and (r.sale_id<>a.id or r.obligation_id<>t.obligation_id) then raise exception 'ORIGINAL_TEAM_EVENT_BINDING_REQUIRED';end if;
 return jsonb_build_object('saleId',a.id,'buyerId',a.buyer_id,'obligationId',t.obligation_id,'paymentIntentId',o.provider_id,'context',a.context);
end $$;
create function public.begin_sales_team_payment_event_v1(p_event_id text,p_event_type text,p_event_created bigint,p_object_id text,p_payment_intent_id text,p_charge_id text,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare s jsonb;e public.sales_team_payment_events_v1;r public.sales_team_receipts_v1;
begin
 s:=public.locate_sales_team_payment_event_v1(p_payment_intent_id,p_charge_id);
 if s is null or p_context is distinct from s->'context' or p_event_id is null or p_event_id!~'^evt_[A-Za-z0-9_]{1,128}$' or
  p_event_created is null or p_event_created<=0 or p_event_created>extract(epoch from clock_timestamp())+300 or
  p_event_type not in ('payment_intent.created','payment_intent.succeeded','payment_intent.processing','payment_intent.payment_failed','payment_intent.canceled','payment_intent.requires_action',
   'charge.succeeded','charge.updated','charge.captured','charge.failed','charge.pending','charge.refunded','refund.created','refund.updated','refund.failed',
   'charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated') or
  p_object_id is null or not (p_event_type like 'payment_intent.%' and p_object_id=p_payment_intent_id or p_event_type like 'charge.dispute.%' and p_object_id~'^du_[A-Za-z0-9]+$' or
   p_event_type like 'refund.%' and p_object_id~'^re_[A-Za-z0-9]+$' or p_event_type like 'charge.%' and p_event_type not like 'charge.dispute.%' and p_object_id=p_charge_id) then raise exception 'SIGNED_TEAM_EVENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||(select creator_id::text from public.sales_team_sale_agreements_v1 where id=(s->>'saleId')::uuid),0));
 select * into e from public.sales_team_payment_events_v1 where event_id=p_event_id;
 if e.event_id is not null then
  if e.event_type<>p_event_type or e.event_created<>p_event_created or e.object_id<>p_object_id or e.payment_intent_id<>p_payment_intent_id or
   e.charge_id is distinct from p_charge_id or e.context is distinct from p_context then raise exception 'ORIGINAL_TEAM_EVENT_CHANGED';end if;
  return jsonb_build_object('recorded',exists(select 1 from public.sales_team_payment_event_results_v1 where event_id=e.event_id),
   'receiptId',(select receipt_id from public.sales_team_payment_event_results_v1 where event_id=e.event_id));
 end if;
 insert into public.sales_team_payment_events_v1(event_id,event_type,event_created,sale_id,obligation_id,payment_intent_id,charge_id,object_id,context)
 values(p_event_id,p_event_type,p_event_created,(s->>'saleId')::uuid,(s->>'obligationId')::uuid,p_payment_intent_id,p_charge_id,p_object_id,p_context);
 select * into r from public.sales_team_receipts_v1 where obligation_id=(s->>'obligationId')::uuid;
 if r.id is not null then
  update public.sales_team_receipts_v1 set review_hold=true,observation_revision=observation_revision+1 where id=r.id;
  perform public.recompute_sales_team_balances_v1(r.sale_id,'pending-event:'||p_event_id,jsonb_build_object('sourceEventId',p_event_id));
 end if;
 return jsonb_build_object('recorded',false);
end $$;
create function public.complete_sales_team_lifecycle_event_v1(p_event_id text,p_state_id uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare e public.sales_team_payment_events_v1;s public.sales_team_payment_states_v1;begin
 select * into e from public.sales_team_payment_events_v1 where event_id=p_event_id;
 if e.event_id is null then raise exception 'ORIGINAL_TEAM_EVENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||(select creator_id::text from public.sales_team_sale_agreements_v1 where id=e.sale_id),0));
 if exists(select 1 from public.sales_team_payment_event_results_v1 where event_id=e.event_id) then return;end if;
 select * into s from public.sales_team_payment_states_v1 where id=p_state_id and obligation_id=e.obligation_id and payment_intent_id=e.payment_intent_id;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and event_reconciliation_enabled) or s.id is null or s.observed_at<e.created_at or s.status='succeeded' or
  e.event_type not in ('payment_intent.created','payment_intent.succeeded','payment_intent.processing','payment_intent.payment_failed','payment_intent.canceled','payment_intent.requires_action','charge.succeeded','charge.updated','charge.captured','charge.failed','charge.pending') or
  exists(select 1 from public.sales_team_receipts_v1 where obligation_id=e.obligation_id) or
  exists(select 1 from public.sales_team_payment_states_v1 newer where newer.obligation_id=e.obligation_id and (newer.proof->>'readStartedAt')::bigint>(s.proof->>'readStartedAt')::bigint) then raise exception 'CURRENT_TEAM_LIFECYCLE_REQUIRED';end if;
 insert into public.sales_team_payment_event_results_v1(event_id,proof) values(e.event_id,jsonb_build_object('stateId',s.id,'status',s.status,'providerRequestId',s.provider_request_id));
end $$;
create function public.read_sales_team_refund_reviews_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id) then raise exception 'OWNED_SALE_REQUIRED';end if;
 return coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from public.sales_team_refund_reviews_v1 d join public.sales_team_receipts_v1 r on r.id=d.receipt_id
  where r.sale_id=p_sale_id and r.obligation_id=p_obligation_id),'[]'::jsonb);
end $$;
create function public.complete_sales_team_payment_event_v1(p_event_id text,p_expected_revision integer,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare e public.sales_team_payment_events_v1;a public.sales_team_sale_agreements_v1;r public.sales_team_receipts_v1;t public.sales_team_payment_attempts_v1;
 cp jsonb:=p_snapshot->'capture'->'receipt';rb jsonb:=p_snapshot->'capture'->'readback';p jsonb:=p_snapshot->'proof';result jsonb;v jsonb;refund_total bigint:=0;extra_pending boolean;k text;
begin
 select * into e from public.sales_team_payment_events_v1 where event_id=p_event_id;
 select * into a from public.sales_team_sale_agreements_v1 where id=e.sale_id;
 if a.id is null then raise exception 'ORIGINAL_TEAM_EVENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 if exists(select 1 from public.sales_team_payment_event_results_v1 where event_id=e.event_id) then
  select * into r from public.sales_team_receipts_v1 where obligation_id=e.obligation_id;return jsonb_build_object('receiptId',r.id,'held',r.review_hold or r.dispute_hold);
 end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and event_reconciliation_enabled) then raise exception 'TEAM_EVENT_RECONCILIATION_HELD';end if;
 select * into t from public.sales_team_payment_attempts_v1 where obligation_id=e.obligation_id;
 select * into r from public.sales_team_receipts_v1 where obligation_id=e.obligation_id;
 if r.id is not null and r.observation_revision is distinct from p_expected_revision or r.id is null and p_expected_revision is not null then raise exception 'FINANCIAL_OBSERVATION_STALE';end if;
 if jsonb_typeof(p_snapshot) is distinct from 'object' or jsonb_typeof(cp) is distinct from 'object' or jsonb_typeof(rb) is distinct from 'object' or jsonb_typeof(p) is distinct from 'object' or
  cp->'context' is distinct from e.context or cp->>'protocol' is distinct from 'creatornet-team-distribution-v1' or cp->>'saleId' is distinct from e.sale_id::text or
  cp->>'obligationId' is distinct from e.obligation_id::text or cp->>'paymentIntentId' is distinct from e.payment_intent_id or
  e.charge_id is not null and cp->>'chargeId' is distinct from e.charge_id or cp->>'currency' is distinct from 'usd' or cp->'paid' is distinct from 'true'::jsonb or cp->'captured' is distinct from 'true'::jsonb or
  cp->>'chargeId' is null or (cp->>'subtotalCents')::bigint is distinct from (t.contract->>'amountCents')::bigint or
  coalesce(rb->>'intentRequestId','')!~'^req_[A-Za-z0-9]+$' or rb->>'chargeRequestId' is distinct from cp->>'providerRequestId' or
  coalesce((rb->>'readStartedAt')::numeric,0) not between extract(epoch from clock_timestamp())*1000-60000 and extract(epoch from clock_timestamp())*1000+1000 or
  coalesce((p_snapshot->>'readStartedAt')::numeric,0) not between extract(epoch from clock_timestamp())*1000-60000 and extract(epoch from clock_timestamp())*1000+1000 or
  jsonb_typeof(p_snapshot->'refunds') is distinct from 'array' or jsonb_typeof(p_snapshot->'disputes') is distinct from 'array' or
  p->>'sourceEventId' is distinct from e.event_id or p->'context' is distinct from e.context or p->>'paymentIntentId' is distinct from e.payment_intent_id or p->>'chargeId' is distinct from cp->>'chargeId' or
  (p->>'refundedCents')::bigint is distinct from (cp->>'refundedCents')::bigint or jsonb_typeof(p->'alerts') is distinct from 'array' then raise exception 'VERIFIED_TEAM_EVENT_SNAPSHOT_REQUIRED';end if;
 for k in select jsonb_object_keys(p_snapshot) loop if k not in ('capture','proof','refunds','disputes','readStartedAt') then raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;end loop;
 for k in select jsonb_object_keys(rb) loop if k not in ('intentRequestId','chargeRequestId','balanceRequestId','readStartedAt','observedAt') then raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;end loop;
 for v in select value from jsonb_array_elements(p_snapshot->'refunds') loop
  if v->>'chargeId' is distinct from cp->>'chargeId' or coalesce(v->>'id','')!~'^re_[A-Za-z0-9]+$' or coalesce((v->>'amountCents')::bigint,0) not between 1 and (cp->>'subtotalCents')::bigint or
   v->>'status' not in ('succeeded','failed','canceled','pending','requires_action') or exists(select 1 from jsonb_object_keys(v) key where key not in ('id','chargeId','amountCents','status','created')) then raise exception 'VERIFIED_TEAM_REFUND_REQUIRED';end if;
  if v->>'status'='succeeded' then refund_total:=refund_total+(v->>'amountCents')::bigint;end if;
 end loop;
  if refund_total>(p->>'refundedCents')::bigint or (refund_total<>(p->>'refundedCents')::bigint or exists(select 1 from jsonb_array_elements(p_snapshot->'refunds') f where f->>'status' in ('pending','requires_action'))) and p->'reviewHold' is distinct from 'true'::jsonb or
  e.object_id~'^re_' and not exists(select 1 from jsonb_array_elements(p_snapshot->'refunds') f where f->>'id'=e.object_id) or
  e.object_id~'^du_' and not exists(select 1 from jsonb_array_elements(p_snapshot->'disputes') d where d->>'id'=e.object_id) then raise exception 'TEAM_EVENT_FINANCIAL_COVERAGE_REQUIRED';end if;
 if (select count(*) from jsonb_array_elements(p_snapshot->'refunds'))<>(select count(distinct f->>'id') from jsonb_array_elements(p_snapshot->'refunds') f) then raise exception 'DUPLICATE_TEAM_REFUND';end if;
 for v in select value from jsonb_array_elements(p_snapshot->'disputes') loop
  if v->>'chargeId' is distinct from cp->>'chargeId' or coalesce(v->>'id','')!~'^du_[A-Za-z0-9]+$' or
   coalesce((v->>'amountCents')::bigint,0) not between 1 and (cp->>'subtotalCents')::bigint or p->'reviewHold' is distinct from 'true'::jsonb or
   exists(select 1 from jsonb_object_keys(v) key where key not in ('id','chargeId','amountCents','status')) then raise exception 'TEAM_DISPUTE_BALANCE_REVIEW_REQUIRED';end if;
 end loop;
 if cp->'disputed'='true'::jsonb and jsonb_array_length(p_snapshot->'disputes')=0 and p->'reviewHold' is distinct from 'true'::jsonb then raise exception 'TEAM_DISPUTE_IDENTITY_REQUIRED';end if;
 if jsonb_array_length(p->'alerts')>0 and p->'reviewHold' is distinct from 'true'::jsonb then raise exception 'TEAM_FINANCIAL_ALERT_HOLD_REQUIRED';end if;
 if p->'decisionIds' is distinct from coalesce((select jsonb_agg(d.id::text order by d.id) from public.sales_team_refund_reviews_v1 d where d.receipt_id=r.id),'[]'::jsonb) then raise exception 'REFUND_RESPONSIBILITY_CHANGED';end if;
 if exists(select 1 from jsonb_array_elements(p_snapshot->'refunds') f where f->>'status'='succeeded' and not exists(select 1 from public.sales_team_refund_reviews_v1 d where d.receipt_id=r.id and d.refund_id=f->>'id' and d.amount_cents=(f->>'amountCents')::bigint)) and p->'reviewHold' is distinct from 'true'::jsonb then raise exception 'TEAM_REFUND_RESPONSIBILITY_REQUIRED';end if;
 if r.id is null then
  result:=public.record_verified_sales_team_capture_v1(a.id,a.buyer_id,e.obligation_id,(select operation_id from public.sales_team_payment_confirmations_v1 where obligation_id=e.obligation_id order by step_number desc limit 1),p_snapshot->'capture');
  select * into r from public.sales_team_receipts_v1 where id=(result->>'id')::uuid;
 end if;
 if r.charge_id is distinct from cp->>'chargeId' or r.payment_intent_id is distinct from cp->>'paymentIntentId' then raise exception 'ORIGINAL_TEAM_RECEIPT_CHANGED';end if;
 extra_pending:=exists(select 1 from public.sales_team_payment_events_v1 pe where pe.obligation_id=e.obligation_id and pe.event_id<>e.event_id and not exists(select 1 from public.sales_team_payment_event_results_v1 pr where pr.event_id=pe.event_id));
 if extra_pending then p:=jsonb_set(jsonb_set(p,'{reviewHold}','true'::jsonb),'{alerts}',p->'alerts'||'["ANOTHER_TEAM_EVENT_PENDING"]'::jsonb);end if;
 result:=public.reconcile_sales_team_receipt_v1(r.id,r.observation_revision,'event:'||e.event_id,(p->>'refundedCents')::bigint,(p->>'totalLossCents')::bigint,
  (p->>'disputeHold')::boolean,(p->>'reviewHold')::boolean,(cp->>'processingCostCents')::bigint,cp->>'balanceTransactionId',to_timestamp((cp->>'availableOn')::double precision),p);
 insert into public.sales_team_payment_event_results_v1(event_id,receipt_id,proof) values(e.event_id,r.id,jsonb_build_object('financial',p,'refunds',p_snapshot->'refunds','disputes',p_snapshot->'disputes','readback',rb));
 return jsonb_build_object('receiptId',r.id,'held',(result->>'review_hold')::boolean or (result->>'dispute_hold')::boolean);
end $$;
-- Pending signed observations also close the shared reader and fresh dispatch
-- gates. The hold survives network failures and process/lease loss.
alter function public.read_sales_team_entitlement_v1(uuid,uuid) rename to read_sales_team_entitlement_before_events_v1;
create function public.read_sales_team_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;begin
 result:=public.read_sales_team_entitlement_before_events_v1(p_purchase_id,p_buyer_id);
 if exists(select 1 from public.purchases p join public.sales_team_payment_events_v1 e on e.sale_id=p.sales_team_sale_id where p.id=p_purchase_id and p.buyer_id=p_buyer_id and not exists(select 1 from public.sales_team_payment_event_results_v1 r where r.event_id=e.event_id)) then return jsonb_build_object('applicable',true,'allowed',false,'maxAgeSeconds',0);end if;
 return result;
end $$;
alter function public.sales_team_payment_admitted_v1(uuid,jsonb) rename to sales_team_payment_admitted_before_events_v1;
create function public.sales_team_payment_admitted_v1(p_sale_id uuid,p_context jsonb) returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select public.sales_team_payment_admitted_before_events_v1(p_sale_id,p_context) and exists(select 1 from public.sales_team_controls_v1 where singleton and event_reconciliation_enabled) and
 not exists(select 1 from public.sales_team_payment_events_v1 e where e.sale_id=p_sale_id and not exists(select 1 from public.sales_team_payment_event_results_v1 r where r.event_id=e.event_id))
$$;
do $$ declare n text;sig regprocedure;begin
 foreach n in array array['sales_team_payment_events_v1','sales_team_payment_event_results_v1','sales_team_refund_reviews_v1'] loop
  execute format('alter table public.%I enable row level security',n);execute format('revoke all on public.%I from public,anon,authenticated',n);execute format('grant select,insert on public.%I to service_role',n);
  execute format('create trigger team_event_history_immutable before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',n);
 end loop;
 for sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('guard_sales_team_pending_receipt_v1','locate_sales_team_payment_event_v1','begin_sales_team_payment_event_v1','read_sales_team_refund_reviews_v1','complete_sales_team_payment_event_v1','complete_sales_team_lifecycle_event_v1',
  'read_sales_team_entitlement_v1','read_sales_team_entitlement_before_events_v1','sales_team_payment_admitted_v1','sales_team_payment_admitted_before_events_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $$;
commit;
