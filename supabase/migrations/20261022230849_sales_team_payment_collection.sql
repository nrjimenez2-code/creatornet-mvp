-- Local candidate. New provider activity stays independently disabled.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column payment_collection_enabled boolean not null default false;
create table public.sales_team_payment_setups_v1 (
 sale_id uuid primary key references public.sales_team_sale_agreements_v1(id) on delete restrict,
 customer_operation_id uuid not null unique,
 customer_request jsonb not null,
 context jsonb not null,
 expires_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_payment_attempts_v1 (
 obligation_id uuid primary key references public.sales_team_payment_obligations_v1(id) on delete restrict,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 intent_operation_id uuid not null unique,
 contract jsonb not null,
 request jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_payment_states_v1 (
 id uuid primary key default gen_random_uuid(),
 obligation_id uuid not null references public.sales_team_payment_attempts_v1(obligation_id) on delete restrict,
 payment_intent_id text not null,
 status text not null check(status in ('requires_payment_method','requires_confirmation','requires_action','processing','succeeded','canceled')),
 payment_method_id text,
 proof jsonb not null,
 provider_request_id text not null unique check(provider_request_id ~ '^req_[A-Za-z0-9]+$'),
 observed_at timestamptz not null default clock_timestamp()
);
create index sales_team_payment_state_latest_v1 on public.sales_team_payment_states_v1(obligation_id,observed_at desc,id desc);
create table public.sales_team_payment_confirmations_v1 (
 operation_id uuid primary key,
 obligation_id uuid not null references public.sales_team_payment_attempts_v1(obligation_id) on delete restrict,
 request_id uuid not null,
 state_id uuid not null unique references public.sales_team_payment_states_v1(id) on delete restrict,
 step_number integer not null check(step_number between 1 and 10),
 kind text not null check(kind in ('token','reconfirm')),
 token_id text not null check(token_id ~ '^ctoken_[A-Za-z0-9]+$'),
 token_proof jsonb not null,
 request jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(obligation_id,request_id),unique(obligation_id,step_number)
);
create unique index sales_team_one_token_owner_v1 on public.sales_team_payment_confirmations_v1(token_id) where kind='token';
create table public.sales_team_payment_closures_v1 (
 sale_id uuid primary key references public.sales_team_sale_agreements_v1(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 proof jsonb not null,
 closed_at timestamptz not null default clock_timestamp()
);

create function public.sales_team_payment_admitted_v1(p_sale_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_sale_agreements_v1 a
  join public.sales_team_sale_requests_v1 s on s.id=a.id
  join public.sales_team_purchase_admissions_v1 d on d.sale_id=a.id
  join public.sales_team_payment_runtime_v1 r on r.sale_id=a.id
  cross join public.sales_team_controls_v1 c cross join public.sales_team_financial_config_v1 f
  where a.id=p_sale_id and a.context=p_context and s.status='accepted' and d.status='active'
   and r.stop_requested_at is null and r.canceled_at is null and not r.financial_hold
   and c.singleton and c.access_enabled and c.new_sales_enabled and c.payment_collection_enabled
   and f.singleton and f.context=p_context and f.actual_pricing_verified and f.reserves_verified and f.disclosures_approved)
$$;

create function public.reserve_sales_team_customer_v1(p_sale_id uuid,p_buyer_id uuid,p_operation_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;s public.sales_team_payment_setups_v1;o jsonb;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null or a.context is distinct from p_context then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||public.sales_team_canonical_product_v1((a.terms->>'productId')::uuid)::text,72913));
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into s from public.sales_team_payment_setups_v1 where sale_id=a.id;
 if s.sale_id is not null then
  if s.customer_operation_id<>p_operation_id or s.context is distinct from p_context then raise exception 'ORIGINAL_TEAM_PAYMENT_CHANGED';end if;
 else
  o:=public.initialize_sales_team_payment_v1(a.id,p_buyer_id);
  if not public.sales_team_payment_admitted_v1(a.id,p_context) then raise exception 'TEAM_PAYMENT_COLLECTION_HELD';end if;
  insert into public.sales_team_payment_setups_v1(sale_id,customer_operation_id,context,expires_at,customer_request)
  values(a.id,p_operation_id,p_context,date_trunc('second',clock_timestamp())+interval '24 hours',jsonb_build_object('method','POST','apiVersion','2026-08-26.dahlia','path','/v1/customers',
   'params',jsonb_build_object('metadata',jsonb_build_object('team_protocol',a.protocol,'team_sale_id',a.id::text,'team_buyer_id',a.buyer_id::text,'team_operation_id',p_operation_id::text)))) returning * into s;
 end if;
 return to_jsonb(s);
end $$;

create function public.bind_sales_team_customer_v1(p_sale_id uuid,p_buyer_id uuid,p_customer_id text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;s public.sales_team_payment_setups_v1;o public.sales_team_provider_operations_v1;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into s from public.sales_team_payment_setups_v1 where sale_id=a.id;
 select * into o from public.sales_team_provider_operations_v1 where id=s.customer_operation_id;
 if o.status is distinct from 'bound' or o.provider_id is distinct from p_customer_id or p_customer_id !~ '^cus_[A-Za-z0-9]+$' or
  o.request is distinct from s.customer_request or o.context is distinct from a.context or o.kind<>'customer' or o.sale_id<>a.id or o.actor_id<>a.buyer_id then raise exception 'TEAM_CUSTOMER_PROOF_REQUIRED';end if;
 if exists(select 1 from public.sales_team_payment_runtime_v1 where sale_id=a.id and customer_id is not null and customer_id<>p_customer_id) then raise exception 'ORIGINAL_TEAM_CUSTOMER_CHANGED';end if;
 update public.sales_team_payment_runtime_v1 set customer_id=p_customer_id where sale_id=a.id;
end $$;

create function public.reserve_sales_team_intent_v1(p_sale_id uuid,p_buyer_id uuid,p_operation_id uuid,p_contract jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;s public.sales_team_payment_setups_v1;o public.sales_team_payment_obligations_v1;r public.sales_team_payment_runtime_v1;t public.sales_team_payment_attempts_v1;expected jsonb;params jsonb;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into o from public.sales_team_payment_obligations_v1 where sale_id=a.id and period_number=1;
 select * into s from public.sales_team_payment_setups_v1 where sale_id=a.id;
 select * into r from public.sales_team_payment_runtime_v1 where sale_id=a.id;
 select * into t from public.sales_team_payment_attempts_v1 where obligation_id=o.id;
 if t.obligation_id is not null then
  if t.intent_operation_id<>p_operation_id or t.contract is distinct from p_contract or t.request is distinct from p_request then raise exception 'ORIGINAL_TEAM_PAYMENT_CHANGED';end if;
  return to_jsonb(t);
 end if;
 if o.id is null or s.sale_id is null or r.customer_id is null or s.expires_at<=clock_timestamp() or not public.sales_team_payment_admitted_v1(a.id,a.context) then raise exception 'TEAM_PAYMENT_COLLECTION_HELD';end if;
 expected:=jsonb_build_object('protocol',a.protocol,'saleId',a.id,'obligationId',o.id,'operationId',p_operation_id,'terms',a.terms,'fingerprint',a.fingerprint,'context',a.context,
  'customerId',r.customer_id,'periodNumber',o.period_number,'amountCents',o.amount_cents,'acceptedAt',floor(extract(epoch from a.accepted_at))::bigint,'expiresAt',extract(epoch from s.expires_at)::bigint,'kind','payment');
 params:=jsonb_build_object('amount',o.amount_cents,'currency','usd','customer',r.customer_id,'confirm',false,'confirmation_method','manual','capture_method','automatic_async',
  'allowed_payment_method_types',jsonb_build_array('card'),'transfer_group','cn_team_'||a.id::text,'metadata',jsonb_build_object('team_protocol',a.protocol,'team_sale_id',a.id::text,
   'team_obligation_id',o.id::text,'team_operation_id',p_operation_id::text,'team_terms_fingerprint',a.fingerprint,'buyer_id',a.buyer_id::text,'creator_id',a.creator_id::text,
   'product_id',a.terms->>'productId','post_id',a.terms->>'postId','period_number',o.period_number::text,'payment_kind','payment'));
 if a.terms->>'paymentKind'<>'full' then params:=params||jsonb_build_object('setup_future_usage','off_session');end if;
 if p_contract is distinct from expected or p_request is distinct from jsonb_build_object('method','POST','apiVersion','2026-08-26.dahlia','path','/v1/payment_intents','params',params) then raise exception 'TEAM_INTENT_CONTRACT_CHANGED';end if;
 insert into public.sales_team_payment_attempts_v1(obligation_id,sale_id,intent_operation_id,contract,request) values(o.id,a.id,p_operation_id,p_contract,p_request) returning * into t;
 return to_jsonb(t);
end $$;

create function public.record_sales_team_payment_state_v1(p_obligation_id uuid,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;t public.sales_team_payment_attempts_v1;o public.sales_team_provider_operations_v1;s public.sales_team_payment_states_v1;
begin
 select * into t from public.sales_team_payment_attempts_v1 where obligation_id=p_obligation_id;
 select * into a from public.sales_team_sale_agreements_v1 where id=t.sale_id;
 if a.id is null then raise exception 'TEAM_PAYMENT_ATTEMPT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into o from public.sales_team_provider_operations_v1 where id=t.intent_operation_id;
 if o.status is distinct from 'bound' or o.request is distinct from t.request or o.provider_id is distinct from p_proof->>'paymentIntentId' or p_proof->'context' is distinct from a.context or
  p_proof->>'obligationId' is distinct from t.obligation_id::text or coalesce(p_proof->>'providerRequestId','') !~ '^req_[A-Za-z0-9]+$' or coalesce(p_proof->>'status','') not in ('requires_payment_method','requires_confirmation','requires_action','processing','succeeded','canceled') or
  coalesce((p_proof->>'amountReceived')::integer,-1)<>(case when p_proof->>'status'='succeeded' then (t.contract->>'amountCents')::integer else 0 end) or
  coalesce((p_proof->>'amountCapturable')::integer,-1)<>0 or coalesce((p_proof->>'observedAt')::bigint,0)<extract(epoch from clock_timestamp())-30 or
  (p_proof->>'observedAt')::bigint>extract(epoch from clock_timestamp())+1 or coalesce((p_proof->>'readStartedAt')::bigint,0)<extract(epoch from clock_timestamp())*1000-30000 or
  (p_proof->>'readStartedAt')::bigint>extract(epoch from clock_timestamp())*1000+1000 then raise exception 'TEAM_PAYMENT_STATE_PROOF_REQUIRED';end if;
 select * into s from public.sales_team_payment_states_v1 where provider_request_id=p_proof->>'providerRequestId';
 if s.id is not null then
  if s.obligation_id<>p_obligation_id or s.proof is distinct from p_proof then raise exception 'ORIGINAL_TEAM_OBSERVATION_CHANGED';end if;
  return to_jsonb(s);
 end if;
 select * into s from public.sales_team_payment_states_v1 where obligation_id=p_obligation_id order by observed_at desc,id desc limit 1;
 if s.id is not null and ((s.proof->>'readStartedAt')::bigint>(p_proof->>'readStartedAt')::bigint or s.status in ('succeeded','canceled') and s.status<>p_proof->>'status') then raise exception 'TEAM_PAYMENT_STATE_READ_STALE';end if;
 insert into public.sales_team_payment_states_v1(obligation_id,payment_intent_id,status,payment_method_id,proof,provider_request_id)
 values(p_obligation_id,o.provider_id,p_proof->>'status',p_proof->>'paymentMethodId',p_proof,p_proof->>'providerRequestId') returning * into s;
 update public.sales_team_payment_obligations_v1 set intent_operation_id=o.id,status=case when status='unpaid' then 'admitted' else status end where id=p_obligation_id;
 return to_jsonb(s);
end $$;

create function public.reserve_sales_team_confirmation_v1(p_sale_id uuid,p_buyer_id uuid,p_request_id uuid,p_operation_id uuid,p_kind text,p_token_proof jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;t public.sales_team_payment_attempts_v1;s public.sales_team_payment_states_v1;c public.sales_team_payment_confirmations_v1;prev public.sales_team_payment_confirmations_v1;expected jsonb;v_step integer;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id;
 select * into c from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id and request_id=p_request_id;
 if c.operation_id is not null then
  if c.operation_id<>p_operation_id or c.kind<>p_kind or c.token_proof is distinct from p_token_proof or c.request is distinct from p_request then raise exception 'ORIGINAL_TEAM_CONFIRMATION_CHANGED';end if;
  return to_jsonb(c);
 end if;
 select * into s from public.sales_team_payment_states_v1 where obligation_id=t.obligation_id order by observed_at desc,id desc limit 1;
 select * into prev from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id order by step_number desc limit 1;
 if t.obligation_id is null or not public.sales_team_payment_admitted_v1(a.id,a.context) or (t.contract->>'expiresAt')::bigint<=extract(epoch from clock_timestamp()) or
  s.id is null or s.observed_at<=clock_timestamp()-interval '30 seconds' or
  (prev.operation_id is not null and not exists(select 1 from public.sales_team_provider_operations_v1 where id=prev.operation_id and status='bound' and bound_at<=s.observed_at)) then raise exception 'ORIGINAL_TEAM_PAYMENT_NEEDS_RECONCILIATION';end if;
 v_step:=coalesce(prev.step_number,0)+1;
 if v_step>10 or coalesce(p_kind not in ('token','reconfirm'),true) or coalesce(p_token_proof->>'tokenId','') !~ '^ctoken_[A-Za-z0-9]+$' or p_token_proof->>'country' is distinct from 'US' or coalesce(p_token_proof->>'previewHash','') !~ '^[a-f0-9]{64}$' then raise exception 'TEAM_CONFIRMATION_PROOF_REQUIRED';end if;
 if p_kind='token' then
  if s.status<>'requires_payment_method' or coalesce((s.proof->>'unpaidMethod')::boolean,false) is not true or
   coalesce((p_token_proof->>'createdAt')::bigint,0)<(t.contract->>'acceptedAt')::bigint or coalesce((p_token_proof->>'expiresAt')::bigint,0)<=extract(epoch from clock_timestamp())+30 then raise exception 'TEAM_CONFIRMATION_PROOF_REQUIRED';end if;
  expected:=jsonb_build_object('confirmation_token',p_token_proof->>'tokenId','use_stripe_sdk',true,'return_url',(a.context->>'siteOrigin')||'/purchase/team/'||a.id::text);
 else
  if s.status<>'requires_confirmation' or prev.operation_id is null or p_token_proof is distinct from prev.token_proof or s.payment_method_id is null or
   s.proof->>'authorizedPaymentMethodId' is distinct from s.payment_method_id or s.proof->>'authorizedTokenId' is distinct from prev.token_id then raise exception 'TEAM_RECONFIRMATION_PROOF_REQUIRED';end if;
  expected:=jsonb_build_object('use_stripe_sdk',true,'return_url',(a.context->>'siteOrigin')||'/purchase/team/'||a.id::text);
 end if;
 expected:=jsonb_build_object('method','POST','apiVersion','2026-08-26.dahlia','path','/v1/payment_intents/'||s.payment_intent_id||'/confirm','params',expected);
 if p_request is distinct from expected then raise exception 'TEAM_CONFIRMATION_REQUEST_CHANGED';end if;
 insert into public.sales_team_payment_confirmations_v1(operation_id,obligation_id,request_id,state_id,step_number,kind,token_id,token_proof,request)
 values(p_operation_id,t.obligation_id,p_request_id,s.id,v_step,p_kind,p_token_proof->>'tokenId',p_token_proof,p_request) returning * into c;
 return to_jsonb(c);
end $$;

alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_admitted_before_payment_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;s public.sales_team_payment_setups_v1;t public.sales_team_payment_attempts_v1;c public.sales_team_payment_confirmations_v1;
begin
 if p_scope->>'kind' not in ('customer','intent','confirmation','cancellation') then return public.sales_team_operation_admitted_before_payment_v1(p_scope,p_context);end if;
 select * into a from public.sales_team_sale_agreements_v1 where id=(p_scope->>'saleId')::uuid;
 if a.id is null or a.context is distinct from p_context or p_scope->>'creatorId' is distinct from a.creator_id::text or
  p_scope->>'actorId' is distinct from a.buyer_id::text or p_scope->>'workerRunId' is not null then return false;end if;
 select * into s from public.sales_team_payment_setups_v1 where sale_id=a.id;
 select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id;
 if p_scope->>'kind'='cancellation' then
  return t.obligation_id is not null and p_scope->>'scopeId'=a.id::text and p_scope->>'scopeKey'='cancel:'||t.obligation_id::text and
   exists(select 1 from public.sales_team_payment_runtime_v1 where sale_id=a.id and stop_requested_at is not null) and
   exists(select 1 from public.sales_team_provider_operations_v1 where id=t.intent_operation_id and status='bound');
 end if;
 if not public.sales_team_payment_admitted_v1(a.id,p_context) or s.sale_id is null or s.expires_at<=clock_timestamp() or p_scope->>'scopeId' is distinct from a.id::text then return false;end if;
 if p_scope->>'kind'='customer' then return p_scope->>'scopeKey'='customer:v1';end if;
 if p_scope->>'kind'='intent' then return t.obligation_id is not null and p_scope->>'scopeKey'='intent:'||t.obligation_id::text;end if;
 select * into c from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id and 'confirm:'||request_id::text=p_scope->>'scopeKey';
 return c.operation_id is not null and c.created_at>clock_timestamp()-interval '30 seconds' and not exists(select 1 from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id and step_number>c.step_number);
end $$;

create function creatornet_team_private.guard_team_payment_operation_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare expected jsonb;expected_id uuid;pi text;
begin
 if new.kind='customer' then select customer_request,customer_operation_id into expected,expected_id from public.sales_team_payment_setups_v1 where sale_id=new.sale_id;
 elsif new.kind='intent' then select request,intent_operation_id into expected,expected_id from public.sales_team_payment_attempts_v1 where sale_id=new.sale_id and 'intent:'||obligation_id::text=new.scope_key;
 elsif new.kind='confirmation' then select c.request,c.operation_id into expected,expected_id from public.sales_team_payment_confirmations_v1 c join public.sales_team_payment_attempts_v1 t using(obligation_id) where t.sale_id=new.sale_id and 'confirm:'||c.request_id::text=new.scope_key;
 elsif new.kind='cancellation' then
  select o.provider_id into pi from public.sales_team_payment_attempts_v1 t join public.sales_team_provider_operations_v1 o on o.id=t.intent_operation_id where t.sale_id=new.sale_id and 'cancel:'||t.obligation_id::text=new.scope_key and o.status='bound';
  if pi is not null then expected:=jsonb_build_object('method','POST','apiVersion','2026-08-26.dahlia','path','/v1/payment_intents/'||pi||'/cancel','params',jsonb_build_object('cancellation_reason','requested_by_customer'));expected_id:=new.id;end if;
 else return new;end if;
 if expected is null or expected_id is distinct from new.id or expected is distinct from new.request then raise exception 'SAVED_TEAM_PAYMENT_REQUEST_REQUIRED';end if;
 return new;
end $$;
create trigger sales_team_saved_payment_request_v1 before insert on public.sales_team_provider_operations_v1 for each row execute function creatornet_team_private.guard_team_payment_operation_v1();
revoke all on function creatornet_team_private.guard_team_payment_operation_v1() from public,anon,authenticated,service_role;

create function public.stop_sales_team_payment_v1(p_sale_id uuid,p_buyer_id uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 insert into public.sales_team_payment_runtime_v1(sale_id,stop_requested_at) values(a.id,clock_timestamp())
 on conflict(sale_id) do update set stop_requested_at=coalesce(sales_team_payment_runtime_v1.stop_requested_at,excluded.stop_requested_at);
end $$;

create function public.read_sales_team_payment_v1(p_sale_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 return jsonb_build_object('sale',to_jsonb(a),'setup',(select to_jsonb(s) from public.sales_team_payment_setups_v1 s where sale_id=a.id),
  'runtime',(select to_jsonb(r) from public.sales_team_payment_runtime_v1 r where sale_id=a.id),
  'obligation',(select to_jsonb(o) from public.sales_team_payment_obligations_v1 o where sale_id=a.id and period_number=1),
  'attempt',(select to_jsonb(t) from public.sales_team_payment_attempts_v1 t where sale_id=a.id),
  'confirmation',(select to_jsonb(c)||jsonb_build_object('operation_status',(select status from public.sales_team_provider_operations_v1 where id=c.operation_id)) from public.sales_team_payment_confirmations_v1 c join public.sales_team_payment_attempts_v1 t using(obligation_id) where t.sale_id=a.id order by c.step_number desc limit 1),
  'state',(select to_jsonb(s) from public.sales_team_payment_states_v1 s join public.sales_team_payment_attempts_v1 t using(obligation_id) where t.sale_id=a.id order by s.observed_at desc,s.id desc limit 1),
  'receipt',(select jsonb_build_object('id',r.id) from public.sales_team_receipts_v1 r join public.sales_team_payment_obligations_v1 o on o.id=r.obligation_id where r.sale_id=a.id and o.period_number=1),
  'closed',exists(select 1 from public.sales_team_payment_closures_v1 where sale_id=a.id));
end $$;

create function public.close_unpaid_sales_team_payment_v1(p_sale_id uuid,p_buyer_id uuid,p_proof jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;t public.sales_team_payment_attempts_v1;o public.sales_team_provider_operations_v1;s public.sales_team_payment_states_v1;product uuid;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||a.creator_id::text,0));
 product:=public.sales_team_canonical_product_v1((a.terms->>'productId')::uuid);
 perform pg_advisory_xact_lock(hashtextextended(a.buyer_id::text||':'||product::text,72913));
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 if exists(select 1 from public.sales_team_payment_closures_v1 where sale_id=a.id) then return;end if;
 if not exists(select 1 from public.sales_team_payment_runtime_v1 where sale_id=a.id and stop_requested_at is not null and covered_periods=0) or
  exists(select 1 from public.sales_team_receipts_v1 where sale_id=a.id) or exists(select 1 from public.sales_team_payment_obligations_v1 where sale_id=a.id and status='paid') then raise exception 'TEAM_PAYMENT_NOT_CONCLUSIVELY_UNPAID';end if;
 select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id;
 select * into o from public.sales_team_provider_operations_v1 where id=t.intent_operation_id;
 if o.id is not null then
  select * into s from public.sales_team_payment_states_v1 where obligation_id=t.obligation_id order by observed_at desc,id desc limit 1;
  if o.status<>'bound' or s.id is null or s.status<>'canceled' or s.payment_intent_id<>o.provider_id or s.observed_at<=clock_timestamp()-interval '30 seconds' or
   p_proof is distinct from s.proof or coalesce((s.proof->>'unpaidMethod')::boolean,false) is not true then raise exception 'TEAM_PAYMENT_NOT_CONCLUSIVELY_UNPAID';end if;
 elsif exists(select 1 from public.sales_team_provider_operations_v1 where sale_id=a.id and kind in ('intent','confirmation')) then raise exception 'TEAM_PAYMENT_NOT_CONCLUSIVELY_UNPAID';
 elsif p_proof is distinct from jsonb_build_object('noIntentDispatched',true) then raise exception 'TEAM_PAYMENT_NOT_CONCLUSIVELY_UNPAID';end if;
 insert into public.sales_team_payment_closures_v1(sale_id,buyer_id,proof) values(a.id,a.buyer_id,p_proof);
 update public.sales_team_purchase_admissions_v1 set status='closed_unpaid',closed_at=clock_timestamp() where sale_id=a.id and status='active';
 update public.sales_team_sale_requests_v1 set status='closed_unpaid' where id=a.id;
 update public.sales_team_payment_runtime_v1 set canceled_at=coalesce(canceled_at,clock_timestamp()) where sale_id=a.id;
 update public.sales_team_payment_obligations_v1 set status='stopped' where sale_id=a.id and status<>'paid';
 update public.sales_team_assignments_v1 set accepted_sale_id=null where accepted_sale_id=a.id;
 insert into public.sales_team_audit_v1(creator_id,actor_id,action,subject_id,after_state) values(a.creator_id,a.buyer_id,'close_unpaid_sale',a.id,p_proof);
end $$;

do $$ declare n text;sig regprocedure;begin
 foreach n in array array['sales_team_payment_setups_v1','sales_team_payment_attempts_v1','sales_team_payment_states_v1','sales_team_payment_confirmations_v1','sales_team_payment_closures_v1'] loop
  execute format('alter table public.%I enable row level security',n);execute format('revoke all on public.%I from public,anon,authenticated',n);execute format('grant select,insert on public.%I to service_role',n);
  execute format('create trigger sales_team_payment_history_immutable_v1 before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',n);
 end loop;
 for sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
  ('sales_team_payment_admitted_v1','reserve_sales_team_customer_v1','bind_sales_team_customer_v1','reserve_sales_team_intent_v1','record_sales_team_payment_state_v1','reserve_sales_team_confirmation_v1',
   'sales_team_operation_admitted_v1','sales_team_operation_admitted_before_payment_v1','stop_sales_team_payment_v1','read_sales_team_payment_v1','close_unpaid_sales_team_payment_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $$;
commit;
