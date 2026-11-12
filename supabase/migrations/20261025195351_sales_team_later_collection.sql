-- Local candidate. Explicit accepted later obligations; no scheduler or off-session debit.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column later_collection_enabled boolean not null default false;
create table public.sales_team_later_payment_windows_v1 (
 obligation_id uuid primary key references public.sales_team_payment_obligations_v1(id) on delete restrict,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 anchor_at timestamptz not null,due_at timestamptz not null,expires_at timestamptz not null,
 context jsonb not null,created_at timestamptz not null default clock_timestamp(),
 check(expires_at>created_at and due_at<=created_at)
);
create function creatornet_team_private.team_month_boundary_v1(p_anchor timestamptz,p_month integer)
returns timestamptz language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare original timestamp:=p_anchor at time zone 'UTC';base timestamp;begin
 if p_anchor is null or p_month is null or p_month<0 or p_month>12000 then raise exception 'TEAM_MONTH_BOUNDARY_REQUIRED';end if;
 base:=date_trunc('month',original)+make_interval(months=>p_month);
 return (base+make_interval(days=>least(extract(day from original)::integer,extract(day from base+interval '1 month'-interval '1 day')::integer)-1)+(original-date_trunc('day',original))) at time zone 'UTC';
end $$;
-- Repeat schedule derivation from accepted terms and independently captured
-- history. Mutable runtime fields alone cannot move the anchor or recipient.
create function creatornet_team_private.later_payment_schedule_v1(p_sale_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;r public.sales_team_payment_runtime_v1;first_paid timestamptz;n integer;amount integer;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id;
 select * into r from public.sales_team_payment_runtime_v1 where sale_id=a.id;
 select receipt.paid_at into first_paid from public.sales_team_receipts_v1 receipt
 join public.sales_team_payment_obligations_v1 paid on paid.id=receipt.obligation_id and paid.sale_id=receipt.sale_id and paid.period_number=1 and paid.status='paid' and paid.paid_at=receipt.paid_at
 join public.sales_team_capture_provenance_v1 capture on capture.receipt_id=receipt.id and capture.obligation_id=paid.id
 join public.sales_team_payment_attempts_v1 attempt on attempt.obligation_id=paid.id and attempt.sale_id=a.id
 join public.sales_team_provider_operations_v1 original on original.id=attempt.intent_operation_id and original.status='bound' and original.provider_id=receipt.payment_intent_id
 join public.sales_team_provider_operations_v1 confirmation on confirmation.id=capture.confirmation_operation_id and confirmation.status='bound' and confirmation.provider_id=receipt.payment_intent_id
 where receipt.sale_id=a.id;
 if a.id is null or r.covered_periods<1 or first_paid is null or r.anchor_at is distinct from first_paid or a.terms->>'paymentKind' not in ('installments','monthly') or
  not exists(select 1 from public.sales_team_payment_setups_v1 setup join public.sales_team_provider_operations_v1 customer on customer.id=setup.customer_operation_id
   where setup.sale_id=a.id and setup.context=a.context and customer.status='bound' and customer.kind='customer' and customer.sale_id=a.id and customer.creator_id=a.creator_id and customer.actor_id=a.buyer_id and customer.context=a.context and customer.request=setup.customer_request and customer.provider_id=r.customer_id) or
  (select count(*) from public.sales_team_receipts_v1 receipt join public.sales_team_payment_obligations_v1 paid on paid.id=receipt.obligation_id and paid.sale_id=receipt.sale_id and paid.status='paid' and paid.paid_at=receipt.paid_at
   join public.sales_team_capture_provenance_v1 capture on capture.receipt_id=receipt.id and capture.obligation_id=paid.id
   where receipt.sale_id=a.id and paid.period_number between 1 and r.covered_periods)<>r.covered_periods then return null;end if;
 n:=r.covered_periods+1;
 if a.terms->>'paymentKind'='installments' then
  select (payment->>'amountCents')::integer into amount from jsonb_array_elements(a.terms->'payments') payment where (payment->>'number')::integer=n;
 else
  if n<=coalesce((a.terms->>'initialCommitmentMonths')::integer,1) or coalesce((a.terms->'monthlyTerms'->>'autoRenew')::boolean,false) then amount:=(a.terms->>'amountCents')::integer;end if;
 end if;
 if amount is null then return jsonb_build_object('status','complete');end if;
 return jsonb_build_object('periodNumber',n,'amountCents',amount,'dueAt',creatornet_team_private.team_month_boundary_v1(first_paid,n-1));
end $$;
create function creatornet_team_private.later_payment_admitted_v1(p_obligation_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_later_payment_windows_v1 w
 join public.sales_team_payment_obligations_v1 obligation on obligation.id=w.obligation_id and obligation.sale_id=w.sale_id and obligation.due_at=w.due_at
 join public.sales_team_sale_agreements_v1 agreement on agreement.id=w.sale_id and agreement.buyer_id=w.buyer_id and agreement.context=w.context
 join public.sales_team_sale_requests_v1 sale on sale.id=agreement.id and sale.status='accepted'
 join public.sales_team_purchase_admissions_v1 admission on admission.sale_id=agreement.id and admission.status='active'
 join public.sales_team_payment_runtime_v1 runtime on runtime.sale_id=agreement.id and runtime.customer_id is not null and runtime.anchor_at=w.anchor_at
 join public.sales_team_controls_v1 controls on controls.singleton and controls.later_collection_enabled and controls.payment_collection_enabled and controls.receipt_recording_enabled and controls.fulfillment_enabled and controls.event_reconciliation_enabled and controls.financial_reconciliation_enabled
 join public.sales_team_financial_config_v1 config on config.singleton and config.context=p_context and config.actual_pricing_verified and config.reserves_verified and config.disclosures_approved
 where w.obligation_id=p_obligation_id and w.context=p_context and w.expires_at>clock_timestamp() and w.due_at<=clock_timestamp() and obligation.period_number=runtime.covered_periods+1 and obligation.status in ('unpaid','admitted')
 and runtime.stop_requested_at is null and runtime.canceled_at is null and not runtime.financial_hold
 and creatornet_team_private.later_payment_schedule_v1(agreement.id)=jsonb_build_object('periodNumber',obligation.period_number,'amountCents',obligation.amount_cents,'dueAt',w.due_at)
 and not exists(select 1 from public.sales_team_payment_events_v1 event where event.sale_id=agreement.id and not exists(select 1 from public.sales_team_payment_event_results_v1 result where result.event_id=event.event_id))
 and not exists(select 1 from public.sales_team_financial_checks_v1 checkup join public.sales_team_receipts_v1 receipt on receipt.id=checkup.receipt_id where receipt.sale_id=agreement.id and not exists(select 1 from public.sales_team_financial_check_results_v1 result where result.check_id=checkup.id))
 and not exists(select 1 from public.sales_team_receipts_v1 where obligation_id=obligation.id)
 and not exists(select 1 from public.sales_team_receipts_v1 prior where prior.sale_id=agreement.id and (prior.review_hold or prior.dispute_hold))
 and (select count(*) from public.sales_team_receipts_v1 prior join public.sales_team_payment_obligations_v1 paid on paid.id=prior.obligation_id where prior.sale_id=agreement.id and paid.period_number<obligation.period_number)=runtime.covered_periods
 and not exists(select 1 from public.sales_team_receipts_v1 prior where prior.sale_id=agreement.id and not exists(select 1 from public.sales_team_shared_receipts_v1 where receipt_id=prior.id)))
$$;
create function public.reserve_sales_team_next_payment_v1(p_sale_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;r public.sales_team_payment_runtime_v1;o public.sales_team_payment_obligations_v1;n integer;amount integer;due timestamptz;schedule jsonb;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id and context=p_context;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into r from public.sales_team_payment_runtime_v1 where sale_id=a.id for update;
 schedule:=creatornet_team_private.later_payment_schedule_v1(a.id);
 if schedule is null then raise exception 'VERIFIED_FIRST_TEAM_PAYMENT_REQUIRED';end if;
 if schedule->>'status'='complete' then return schedule;end if;
 n:=r.covered_periods+1;
 select * into o from public.sales_team_payment_obligations_v1 where sale_id=a.id and period_number=n;
 if o.id is not null then
  if not exists(select 1 from public.sales_team_later_payment_windows_v1 where obligation_id=o.id and sale_id=a.id and buyer_id=p_buyer_id and context=p_context) then raise exception 'ORIGINAL_LATER_TEAM_PAYMENT_REQUIRED';end if;
  return public.read_sales_team_period_payment_v1(a.id,p_buyer_id,o.id);
 end if;
 amount:=(schedule->>'amountCents')::integer;due:=(schedule->>'dueAt')::timestamptz;
 if due>clock_timestamp() then return jsonb_build_object('status','not_due','periodNumber',n,'dueAt',due);end if;
 insert into public.sales_team_payment_obligations_v1(id,sale_id,period_number,amount_cents,due_at) values(gen_random_uuid(),a.id,n,amount,due) returning * into o;
 insert into public.sales_team_later_payment_windows_v1(obligation_id,sale_id,buyer_id,anchor_at,due_at,expires_at,context) values(o.id,a.id,a.buyer_id,r.anchor_at,due,date_trunc('second',clock_timestamp())+interval '24 hours',p_context);
 if not creatornet_team_private.later_payment_admitted_v1(o.id,p_context) then raise exception 'LATER_TEAM_PAYMENT_HELD';end if;
 return public.read_sales_team_period_payment_v1(a.id,p_buyer_id,o.id);
end $$;
create function public.read_sales_team_period_payment_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;o public.sales_team_payment_obligations_v1;w public.sales_team_later_payment_windows_v1;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 select * into o from public.sales_team_payment_obligations_v1 where id=p_obligation_id and sale_id=a.id;
 if a.id is null or o.id is null then raise exception 'OWNED_TEAM_OBLIGATION_REQUIRED';end if;
 if o.period_number=1 then return public.read_sales_team_payment_v1(p_sale_id,p_buyer_id);end if;
 select * into w from public.sales_team_later_payment_windows_v1 where obligation_id=o.id and sale_id=a.id and buyer_id=a.buyer_id and context=a.context;
 if w.obligation_id is null then raise exception 'ORIGINAL_LATER_TEAM_PAYMENT_REQUIRED';end if;
 return jsonb_build_object('sale',to_jsonb(a),'setup',(select to_jsonb(s) from public.sales_team_payment_setups_v1 s where sale_id=a.id),
 'runtime',(select to_jsonb(r) from public.sales_team_payment_runtime_v1 r where sale_id=a.id),'collection_expires_at',w.expires_at,
 'obligation',to_jsonb(o),'attempt',(select to_jsonb(t) from public.sales_team_payment_attempts_v1 t where obligation_id=o.id),
 'confirmation',(select to_jsonb(c)||jsonb_build_object('operation_status',(select status from public.sales_team_provider_operations_v1 where id=c.operation_id)) from public.sales_team_payment_confirmations_v1 c where obligation_id=o.id order by step_number desc limit 1),
 'state',(select to_jsonb(s) from public.sales_team_payment_states_v1 s where obligation_id=o.id order by observed_at desc,id desc limit 1),
 'receipt',(select jsonb_build_object('id',r.id,'held',r.review_hold or r.dispute_hold,'fulfilled',exists(select 1 from public.sales_team_shared_receipts_v1 where receipt_id=r.id)) from public.sales_team_receipts_v1 r where obligation_id=o.id),'closed',false);
end $$;
create function public.read_sales_team_collection_overview_v1(p_sale_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;schedule jsonb;obligation uuid;payment jsonb;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 obligation:=(select id from public.sales_team_payment_obligations_v1 unpaid where sale_id=a.id and period_number>1 and not exists(select 1 from public.sales_team_receipts_v1 where obligation_id=unpaid.id));
 if obligation is not null then return jsonb_build_object('payment',public.read_sales_team_period_payment_v1(a.id,p_buyer_id,obligation));end if;
 payment:=public.read_sales_team_payment_v1(a.id,p_buyer_id);schedule:=creatornet_team_private.later_payment_schedule_v1(a.id);
 if schedule is null or exists(select 1 from public.sales_team_payment_runtime_v1 where sale_id=a.id and (stop_requested_at is not null or canceled_at is not null)) then return jsonb_build_object('payment',payment);end if;
 if schedule->>'status'='complete' then return jsonb_build_object('payment',payment,'nextPayment',schedule);end if;
 return jsonb_build_object('payment',payment,'nextPayment',schedule||jsonb_build_object('status',case when (schedule->>'dueAt')::timestamptz<=clock_timestamp() then 'due' else 'not_due' end));
end $$;
-- Clone the exact reviewed validators with an explicit owned obligation. Leave
-- first-payment entry points intact; no sale-wide LIMIT 1 can pick another period.
do $periods$ declare src text;begin
 src:=pg_get_functiondef('public.reserve_sales_team_intent_v1(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 if position('where sale_id=a.id and period_number=1;' in src)=0 or position('s.expires_at<=clock_timestamp() or not public.sales_team_payment_admitted_v1(a.id,a.context)' in src)=0 then raise exception 'LATER_INTENT_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,'FUNCTION public.reserve_sales_team_intent_v1(p_sale_id uuid, p_buyer_id uuid, p_operation_id uuid, p_contract jsonb, p_request jsonb)','FUNCTION public.reserve_sales_team_period_intent_v1(p_sale_id uuid, p_buyer_id uuid, p_operation_id uuid, p_contract jsonb, p_request jsonb, p_obligation_id uuid)');
 if position('FUNCTION public.reserve_sales_team_period_intent_v1' in src)=0 then raise exception 'LATER_INTENT_SIGNATURE_DIFFERS';end if;
 src:=replace(src,'where sale_id=a.id and period_number=1;','where sale_id=a.id and id=p_obligation_id;');
 src:=replace(src,'s.expires_at<=clock_timestamp() or not public.sales_team_payment_admitted_v1(a.id,a.context)','not creatornet_team_private.later_payment_admitted_v1(o.id,a.context)');
 src:=replace(src,'extract(epoch from s.expires_at)::bigint','(select extract(epoch from expires_at)::bigint from public.sales_team_later_payment_windows_v1 where obligation_id=o.id)');
 execute src;
 src:=pg_get_functiondef('public.reserve_sales_team_confirmation_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'::regprocedure);
 if position('where sale_id=a.id;' in src)=0 or position('not public.sales_team_payment_admitted_v1(a.id,a.context)' in src)=0 then raise exception 'LATER_CONFIRMATION_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,'FUNCTION public.reserve_sales_team_confirmation_v1(p_sale_id uuid, p_buyer_id uuid, p_request_id uuid, p_operation_id uuid, p_kind text, p_token_proof jsonb, p_request jsonb)','FUNCTION public.reserve_sales_team_period_confirmation_v1(p_sale_id uuid, p_buyer_id uuid, p_request_id uuid, p_operation_id uuid, p_kind text, p_token_proof jsonb, p_request jsonb, p_obligation_id uuid)');
 if position('FUNCTION public.reserve_sales_team_period_confirmation_v1' in src)=0 then raise exception 'LATER_CONFIRMATION_SIGNATURE_DIFFERS';end if;
 src:=replace(src,'where sale_id=a.id;','where sale_id=a.id and obligation_id=p_obligation_id;');
 src:=replace(src,'not public.sales_team_payment_admitted_v1(a.id,a.context)','not creatornet_team_private.later_payment_admitted_v1(t.obligation_id,a.context)');
 src:=replace(src,'select * into c from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id and request_id=p_request_id;',
  'if exists(select 1 from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_payment_attempts_v1 attempt using(obligation_id) where attempt.sale_id=a.id and confirmation.request_id=p_request_id and confirmation.obligation_id<>t.obligation_id) then raise exception ''ORIGINAL_TEAM_CONFIRMATION_CHANGED'';end if; select * into c from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id and request_id=p_request_id;');execute src;
end $periods$;
-- The legacy first-payment surface must keep selecting period one after a sale
-- has later attempts. Patch only these named owning definitions and fail closed
-- if a reviewed source fragment is absent or occurs more than once.
do $first$ declare signature text;src text;needle text;begin
 foreach signature in array array['public.reserve_sales_team_confirmation_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb)','public.sales_team_operation_admitted_before_refund_v1(jsonb,jsonb)','public.close_unpaid_sales_team_payment_v1(uuid,uuid,jsonb)'] loop
  src:=pg_get_functiondef(signature::regprocedure);needle:='select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id;';
  if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'FIRST_PAYMENT_DEPENDENCY_DIFFERS: %',signature;end if;
  src:=replace(src,needle,'select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id and obligation_id=(select id from public.sales_team_payment_obligations_v1 where sale_id=a.id and period_number=1);');execute src;
 end loop;
 src:=pg_get_functiondef('public.read_sales_team_payment_before_fulfillment_v1(uuid,uuid)'::regprocedure);
 needle:='from public.sales_team_payment_attempts_v1 t where sale_id=a.id)';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'FIRST_PAYMENT_READ_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'from public.sales_team_payment_attempts_v1 t where sale_id=a.id and obligation_id=(select id from public.sales_team_payment_obligations_v1 where sale_id=a.id and period_number=1))');
 needle:='where t.sale_id=a.id order by';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>2 then raise exception 'FIRST_PAYMENT_HISTORY_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'where t.sale_id=a.id and t.obligation_id=(select id from public.sales_team_payment_obligations_v1 where sale_id=a.id and period_number=1) order by');
end $first$;
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_before_later_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;t public.sales_team_payment_attempts_v1;c public.sales_team_payment_confirmations_v1;begin
 if p_scope->>'kind' not in ('intent','confirmation','cancellation') then return public.sales_team_operation_before_later_v1(p_scope,p_context);end if;
 select * into a from public.sales_team_sale_agreements_v1 where id=(p_scope->>'saleId')::uuid;
 if p_scope->>'kind'='intent' then select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id and 'intent:'||obligation_id::text=p_scope->>'scopeKey';
 elsif p_scope->>'kind'='cancellation' then select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id and 'cancel:'||obligation_id::text=p_scope->>'scopeKey';
 else
  if (select count(*) from public.sales_team_payment_confirmations_v1 where 'confirm:'||request_id::text=p_scope->>'scopeKey' and obligation_id in (select obligation_id from public.sales_team_payment_attempts_v1 where sale_id=a.id))<>1 then return false;end if;
  select * into c from public.sales_team_payment_confirmations_v1 where 'confirm:'||request_id::text=p_scope->>'scopeKey' and obligation_id in (select obligation_id from public.sales_team_payment_attempts_v1 where sale_id=a.id);select * into t from public.sales_team_payment_attempts_v1 where obligation_id=c.obligation_id;end if;
 if not exists(select 1 from public.sales_team_later_payment_windows_v1 where obligation_id=t.obligation_id) then return public.sales_team_operation_before_later_v1(p_scope,p_context);end if;
 if a.context is distinct from p_context or p_scope->>'scopeId' is distinct from a.id::text or p_scope->>'creatorId' is distinct from a.creator_id::text or p_scope->>'actorId' is distinct from a.buyer_id::text or p_scope->>'workerRunId' is not null then return false;end if;
 if not exists(select 1 from public.sales_team_later_payment_windows_v1 w join public.sales_team_payment_obligations_v1 obligation on obligation.id=w.obligation_id and obligation.sale_id=w.sale_id
  where w.obligation_id=t.obligation_id and w.sale_id=a.id and w.buyer_id=a.buyer_id and w.context=a.context and obligation.period_number>1 and
   t.contract->>'saleId'=a.id::text and t.contract->>'obligationId'=obligation.id::text and t.contract->'context'=a.context and t.contract->'terms'=a.terms and t.contract->>'fingerprint'=a.fingerprint) then return false;end if;
 if p_scope->>'kind'='cancellation' then return exists(select 1 from public.sales_team_payment_runtime_v1 where sale_id=a.id and stop_requested_at is not null) and exists(select 1 from public.sales_team_provider_operations_v1 where id=t.intent_operation_id and status='bound') and not exists(select 1 from public.sales_team_receipts_v1 where obligation_id=t.obligation_id);end if;
 if not creatornet_team_private.later_payment_admitted_v1(t.obligation_id,p_context) then return false;end if;
 if p_scope->>'kind'='intent' then return true;end if;
 return c.operation_id is not null and c.created_at>clock_timestamp()-interval '30 seconds' and not exists(select 1 from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id and step_number>c.step_number);
end $$;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''team_month_boundary_v1'',''later_payment_schedule_v1'',''later_payment_admitted_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''reserve_sales_team_next_payment_v1'',''read_sales_team_period_payment_v1'',''read_sales_team_collection_overview_v1'',''reserve_sales_team_period_intent_v1'',''reserve_sales_team_period_confirmation_v1'',''sales_team_operation_before_later_v1'',''sales_team_operation_admitted_v1'',''reserve_sales_team_confirmation_v1'',''sales_team_operation_admitted_before_refund_v1'',''close_unpaid_sales_team_payment_v1'',''read_sales_team_payment_before_fulfillment_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'LATER_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
alter table public.sales_team_later_payment_windows_v1 enable row level security;
revoke all on public.sales_team_later_payment_windows_v1 from public,anon,authenticated,service_role;
grant select on public.sales_team_later_payment_windows_v1 to service_role;
create trigger immutable_later_payment_window_v1 before update or delete on public.sales_team_later_payment_windows_v1 for each row execute function creatornet_team_private.reject_history_change();
do $grants$ declare sig regprocedure;begin
 for sig in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('reserve_sales_team_next_payment_v1','read_sales_team_period_payment_v1','read_sales_team_collection_overview_v1','reserve_sales_team_period_intent_v1','reserve_sales_team_period_confirmation_v1','sales_team_operation_admitted_v1','sales_team_operation_before_later_v1')) or (pronamespace='creatornet_team_private'::regnamespace and proname in ('team_month_boundary_v1','later_payment_schedule_v1','later_payment_admitted_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
