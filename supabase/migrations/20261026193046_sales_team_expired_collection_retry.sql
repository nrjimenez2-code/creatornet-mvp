-- Local candidate. Fresh explicit manual authority after a conclusively closed
-- or never-dispatched original. Old financial identities are never reused.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column collection_retry_enabled boolean not null default false;
drop index public.sales_team_one_regular_period_v1;
drop index public.sales_team_one_payoff_period_v1;
create unique index sales_team_one_regular_period_v1 on public.sales_team_payment_obligations_v1(sale_id,period_number) where payment_kind='payment' and status<>'stopped';
create unique index sales_team_one_payoff_period_v1 on public.sales_team_payment_obligations_v1(sale_id,period_number) where payment_kind='monthly_payoff' and status<>'stopped';
alter table public.sales_team_payoff_stops_v1 drop constraint sales_team_payoff_stops_v1_obligation_id_fkey;
alter table public.sales_team_payoff_stops_v1 add constraint sales_team_payoff_stops_v1_obligation_id_fkey foreign key(obligation_id) references public.sales_team_payment_obligations_v1(id) on delete restrict;
create table public.sales_team_collection_retries_v1 (
 id uuid primary key,sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 original_obligation_id uuid unique references public.sales_team_payment_obligations_v1(id) on delete restrict,
 obligation_id uuid not null unique references public.sales_team_payment_obligations_v1(id) on delete restrict,
 payoff_id uuid references public.sales_team_payoff_agreements_v1(id) on delete restrict,
 period_number integer not null check(period_number>1),payment_kind text not null check(payment_kind in ('payment','monthly_payoff')),
 amount_cents integer not null check(amount_cents between 50 and 99999999),due_at timestamptz not null,
 agreement_fingerprint text not null,context jsonb not null,basis jsonb not null,quote jsonb not null,
 quote_fingerprint text not null check(quote_fingerprint~'^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp(),
 check(obligation_id is distinct from original_obligation_id),check((payment_kind='monthly_payoff')=(payoff_id is not null))
);
create table public.sales_team_collection_retry_stops_v1 (
 obligation_id uuid primary key references public.sales_team_collection_retries_v1(obligation_id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_payoff_original_closures_v1 (
 payoff_id uuid not null references public.sales_team_payoff_agreements_v1(id) on delete restrict,
 obligation_id uuid not null references public.sales_team_payment_obligations_v1(id) on delete restrict,
 intent_operation_id uuid references public.sales_team_provider_operations_v1(id) on delete restrict,
 state_id uuid references public.sales_team_payment_states_v1(id) on delete restrict,
 proof jsonb not null,created_at timestamptz not null default clock_timestamp(),primary key(payoff_id,obligation_id)
);
create function creatornet_team_private.team_payoff_for_obligation_v1(p_obligation_id uuid)
returns setof public.sales_team_payoff_agreements_v1 language sql stable security invoker set search_path=pg_catalog as $$
 select payoff.* from public.sales_team_payoff_agreements_v1 payoff where payoff.obligation_id=p_obligation_id or exists(select 1 from public.sales_team_collection_retries_v1 retry where retry.obligation_id=p_obligation_id and retry.payoff_id=payoff.id)
$$;
create function creatornet_team_private.team_current_payoff_obligation_v1(p_payoff_id uuid)
returns uuid language sql stable security invoker set search_path=pg_catalog as $$
 select (select obligation_id from (
  select payoff.obligation_id from public.sales_team_payoff_agreements_v1 payoff where payoff.id=p_payoff_id and not exists(select 1 from public.sales_team_collection_retries_v1 where original_obligation_id=payoff.obligation_id)
  union all select retry.obligation_id from public.sales_team_collection_retries_v1 retry where retry.payoff_id=p_payoff_id and not exists(select 1 from public.sales_team_collection_retries_v1 child where child.original_obligation_id=retry.obligation_id)) leaf)
$$;
create function creatornet_team_private.team_closed_collection_proof_v1(p_obligation_id uuid,p_fresh boolean)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare obligation public.sales_team_payment_obligations_v1;agreement public.sales_team_sale_agreements_v1;attempt public.sales_team_payment_attempts_v1;original public.sales_team_provider_operations_v1;cancel public.sales_team_provider_operations_v1;state public.sales_team_payment_states_v1;begin
 select * into obligation from public.sales_team_payment_obligations_v1 where id=p_obligation_id;
 select * into agreement from public.sales_team_sale_agreements_v1 where id=obligation.sale_id;
 select * into attempt from public.sales_team_payment_attempts_v1 where obligation_id=obligation.id;
 select * into original from public.sales_team_provider_operations_v1 where id=attempt.intent_operation_id;
 if agreement.id is null or obligation.period_number<=1 or obligation.status not in ('unpaid','admitted','stopped') or exists(select 1 from public.sales_team_receipts_v1 where obligation_id=obligation.id) or
  exists(select 1 from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_provider_operations_v1 operation on operation.id=confirmation.operation_id where confirmation.obligation_id=obligation.id and operation.status<>'bound') or
  exists(select 1 from public.sales_team_collection_retries_v1 where obligation_id=obligation.id) and not exists(select 1 from public.sales_team_collection_retry_stops_v1 where obligation_id=obligation.id) then return null;end if;
 select * into cancel from public.sales_team_provider_operations_v1 where scope_id=agreement.id and kind='cancellation' and scope_key='cancel:'||obligation.id::text;
 if cancel.id is not null and (cancel.status<>'bound' or original.id is null or cancel.provider_id is distinct from original.provider_id or cancel.sale_id is distinct from agreement.id or cancel.creator_id is distinct from agreement.creator_id or cancel.actor_id is distinct from agreement.buyer_id or cancel.context is distinct from agreement.context) then return null;end if;
 if original.id is null then
  if exists(select 1 from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_provider_operations_v1 operation on operation.id=confirmation.operation_id where confirmation.obligation_id=obligation.id) then return null;end if;
  if exists(select 1 from public.sales_team_provider_operations_v1 where scope_id=agreement.id and kind in ('intent','cancellation') and scope_key in ('intent:'||obligation.id::text,'cancel:'||obligation.id::text)) then return null;end if;
  return jsonb_build_object('obligationId',obligation.id,'noDispatch',true,'attempt',to_jsonb(attempt),'operation',null,'stateId',null,'cancellation',null);
 end if;
 select * into state from public.sales_team_payment_states_v1 where obligation_id=obligation.id order by observed_at desc,id desc limit 1;
 if original.status<>'bound' or original.sale_id is distinct from agreement.id or original.creator_id is distinct from agreement.creator_id or original.actor_id is distinct from agreement.buyer_id or original.context is distinct from agreement.context or original.request is distinct from attempt.request or attempt.contract->'terms' is distinct from agreement.terms or attempt.contract->'context' is distinct from agreement.context or attempt.contract->>'fingerprint' is distinct from agreement.fingerprint or attempt.contract->>'obligationId' is distinct from obligation.id::text or
  state.id is null or state.status<>'canceled' or state.payment_intent_id is distinct from original.provider_id or state.proof->'unpaidMethod' is distinct from 'true'::jsonb or
  p_fresh and state.observed_at<=clock_timestamp()-interval '30 seconds' then return null;end if;
 return jsonb_build_object('obligationId',obligation.id,'noDispatch',false,'attempt',to_jsonb(attempt),'operation',to_jsonb(original)-'lease_until'-'lease_token',
  'stateId',state.id,'cancellation',case when cancel.id is null then null else to_jsonb(cancel)-'lease_until'-'lease_token' end);
end $$;
create function creatornet_team_private.team_closed_collection_retained_v1(p_obligation_id uuid,p_proof jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare current_proof jsonb;begin
 current_proof:=creatornet_team_private.team_closed_collection_proof_v1(p_obligation_id,false);
 if current_proof is null or p_proof is null or current_proof-'stateId' is distinct from p_proof-'stateId' then return false;end if;
 return p_proof->'noDispatch'='true'::jsonb or exists(select 1 from public.sales_team_payment_states_v1 where id=(p_proof->>'stateId')::uuid and obligation_id=p_obligation_id and status='canceled' and proof->'unpaidMethod'='true'::jsonb and payment_intent_id=p_proof->'operation'->>'provider_id');
end $$;
create function creatornet_team_private.team_retry_financial_ready_v1(p_sale_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_sale_agreements_v1 agreement
 join public.sales_team_sale_requests_v1 sale on sale.id=agreement.id and sale.status='accepted'
 join public.sales_team_purchase_admissions_v1 admission on admission.sale_id=agreement.id and admission.status='active'
 join public.sales_team_payment_runtime_v1 runtime on runtime.sale_id=agreement.id and runtime.stop_requested_at is not null and runtime.canceled_at is null and not runtime.financial_hold
 join public.sales_team_controls_v1 controls on controls.singleton and controls.payment_collection_enabled and controls.receipt_recording_enabled and controls.fulfillment_enabled and controls.event_reconciliation_enabled and controls.financial_reconciliation_enabled
 join public.sales_team_financial_config_v1 config on config.singleton and config.context=p_context and config.actual_pricing_verified and config.reserves_verified and config.disclosures_approved
 where agreement.id=p_sale_id and agreement.context=p_context and creatornet_team_private.later_payment_schedule_before_lifecycle_v1(agreement.id) is not null and
 not exists(select 1 from public.sales_team_receipts_v1 receipt where receipt.sale_id=agreement.id and (receipt.review_hold or receipt.dispute_hold or receipt.refunded_subtotal_cents>0 or receipt.confirmed_loss_subtotal_cents>0 or not exists(select 1 from public.sales_team_shared_receipts_v1 where receipt_id=receipt.id))) and
 not exists(select 1 from public.sales_team_payment_events_v1 event where event.sale_id=agreement.id and not exists(select 1 from public.sales_team_payment_event_results_v1 result where result.event_id=event.event_id)) and
 not exists(select 1 from public.sales_team_financial_checks_v1 checkup join public.sales_team_receipts_v1 receipt on receipt.id=checkup.receipt_id where receipt.sale_id=agreement.id and not exists(select 1 from public.sales_team_financial_check_results_v1 result where result.check_id=checkup.id)))
$$;
create function creatornet_team_private.team_retry_basis_v1(p_sale_id uuid,p_original_obligation_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare agreement public.sales_team_sale_agreements_v1;runtime public.sales_team_payment_runtime_v1;original public.sales_team_payment_obligations_v1;payoff public.sales_team_payoff_agreements_v1;
 schedule jsonb;closure jsonb;n integer;amount integer;due timestamptz;period_end timestamptz;kind text:='payment';quote jsonb;basis jsonb;begin
 select * into agreement from public.sales_team_sale_agreements_v1 where id=p_sale_id;
 select * into runtime from public.sales_team_payment_runtime_v1 where sale_id=agreement.id;
 if not creatornet_team_private.team_retry_financial_ready_v1(agreement.id,agreement.context) then return null;end if;
 n:=runtime.covered_periods+1;
 if p_original_obligation_id is not null then select * into original from public.sales_team_payment_obligations_v1 where id=p_original_obligation_id and sale_id=agreement.id and period_number=n; if original.id is null then return null;end if;
 else
  select * into payoff from public.sales_team_payoff_agreements_v1 where sale_id=agreement.id;
  if payoff.id is not null then select * into original from public.sales_team_payment_obligations_v1 where id=creatornet_team_private.team_current_payoff_obligation_v1(payoff.id);
  else original:=(select candidate from public.sales_team_payment_obligations_v1 candidate where candidate.sale_id=agreement.id and candidate.period_number=n and candidate.payment_kind='payment' and not exists(select 1 from public.sales_team_collection_retries_v1 where original_obligation_id=candidate.id));end if;
 end if;
 if original.id is not null then
  if original.period_number<>n or exists(select 1 from public.sales_team_collection_retries_v1 where original_obligation_id=original.id) then return null;end if;
  closure:=creatornet_team_private.team_closed_collection_proof_v1(original.id,true);if closure is null then return null;end if;kind:=original.payment_kind;
 end if;
 if kind='monthly_payoff' then
  select * into payoff from creatornet_team_private.team_payoff_for_obligation_v1(original.id);
  if payoff.id is null or payoff.covered_periods<>runtime.covered_periods or payoff.anchor_at<>runtime.anchor_at or payoff.context<>agreement.context or payoff.agreement_fingerprint<>agreement.fingerprint or payoff.period_end<=clock_timestamp() or
   not exists(select 1 from public.sales_team_payoff_stops_v1 where obligation_id=original.id) then return null;end if;
  amount:=payoff.amount_cents;due:=original.due_at;period_end:=payoff.period_end;
 else
  if exists(select 1 from public.sales_team_payoff_agreements_v1 where sale_id=agreement.id) then return null;end if;
  schedule:=creatornet_team_private.later_payment_schedule_v1(agreement.id);
  if schedule is null or schedule->>'status'='complete' or (schedule->>'periodNumber')::integer<>n then return null;end if;
  amount:=(schedule->>'amountCents')::integer;due:=(schedule->>'dueAt')::timestamptz;
  if due>clock_timestamp() then return null;end if;
  if agreement.terms->>'paymentKind'='monthly' then period_end:=creatornet_team_private.team_month_boundary_v1(runtime.anchor_at,n);if period_end<=clock_timestamp() then return null;end if;end if;
 end if;
 if original.id is not null and (original.amount_cents<>amount or original.due_at<>due) then return null;end if;
 if (select count(*) from public.sales_team_collection_retries_v1 where sale_id=agreement.id and period_number=n and payment_kind=kind)>=24 then return null;end if;
 quote:=jsonb_build_object('version','creatornet-team-manual-retry-v1','saleId',agreement.id,'originalObligationId',original.id,'periodNumber',n,'amountCents',amount,'currency','usd','paymentKind',kind,'dueAt',due,'periodEnd',period_end,'windowSeconds',86400,
  'authorization','This is a new manual payment attempt for the exact accepted unpaid amount. The previous payment was canceled or was never sent. Automatic debit permission stays stopped. Confirming this review does not itself pay or waive a balance.');
 basis:=jsonb_build_object('quote',quote,'agreementFingerprint',agreement.fingerprint,'context',agreement.context,'coveredPeriods',runtime.covered_periods,'anchorAt',runtime.anchor_at,'customerId',runtime.customer_id,'payoffId',payoff.id,'closure',closure);
 return jsonb_build_object('quote',quote||jsonb_build_object('fingerprint',encode(sha256(convert_to(basis::text,'UTF8')),'hex')),'basis',basis);
end $$;
create function public.read_sales_team_retry_quote_v1(p_sale_id uuid,p_buyer_id uuid,p_original_obligation_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare source jsonb;begin
 if not exists(select 1 from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id) or p_original_obligation_id is not null and not exists(select 1 from public.sales_team_payment_obligations_v1 where id=p_original_obligation_id and sale_id=p_sale_id) then raise exception 'OWNED_TEAM_RETRY_REQUIRED';end if;
 source:=creatornet_team_private.team_retry_basis_v1(p_sale_id,p_original_obligation_id);
 if source is null then return jsonb_build_object('status','review_required');end if;return jsonb_build_object('status','ready','quote',source->'quote');
end $$;
create function creatornet_team_private.team_collection_retry_admitted_v1(p_obligation_id uuid,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare retry public.sales_team_collection_retries_v1;agreement public.sales_team_sale_agreements_v1;runtime public.sales_team_payment_runtime_v1;obligation public.sales_team_payment_obligations_v1;window_source public.sales_team_later_payment_windows_v1;payoff public.sales_team_payoff_agreements_v1;schedule jsonb;begin
 select * into retry from public.sales_team_collection_retries_v1 where obligation_id=p_obligation_id;
 select * into agreement from public.sales_team_sale_agreements_v1 where id=retry.sale_id;
 select * into runtime from public.sales_team_payment_runtime_v1 where sale_id=agreement.id;
 select * into obligation from public.sales_team_payment_obligations_v1 where id=retry.obligation_id;
 select * into window_source from public.sales_team_later_payment_windows_v1 where obligation_id=obligation.id;
 if retry.id is null or not exists(select 1 from public.sales_team_controls_v1 where singleton and collection_retry_enabled) or
  not creatornet_team_private.team_retry_financial_ready_v1(agreement.id,p_context) or retry.context is distinct from p_context or retry.agreement_fingerprint is distinct from agreement.fingerprint or retry.buyer_id<>agreement.buyer_id or
  runtime.covered_periods<>(retry.basis->>'coveredPeriods')::integer or runtime.anchor_at is distinct from (retry.basis->>'anchorAt')::timestamptz or runtime.customer_id is distinct from retry.basis->>'customerId' or
  obligation.sale_id<>agreement.id or obligation.period_number<>retry.period_number or obligation.payment_kind<>retry.payment_kind or obligation.amount_cents<>retry.amount_cents or obligation.due_at<>retry.due_at or obligation.status not in ('unpaid','admitted') or
  window_source.obligation_id is null or window_source.sale_id<>agreement.id or window_source.buyer_id<>agreement.buyer_id or window_source.context<>p_context or window_source.anchor_at<>runtime.anchor_at or window_source.due_at<>retry.due_at or window_source.expires_at<=clock_timestamp() or
  exists(select 1 from public.sales_team_collection_retry_stops_v1 where obligation_id=obligation.id) or exists(select 1 from public.sales_team_collection_retries_v1 where original_obligation_id=obligation.id) or exists(select 1 from public.sales_team_receipts_v1 where obligation_id=obligation.id) then return false;end if;
 if retry.original_obligation_id is not null then
  if not exists(select 1 from public.sales_team_payment_obligations_v1 parent where parent.id=retry.original_obligation_id and parent.sale_id=agreement.id and parent.period_number=retry.period_number and parent.payment_kind=retry.payment_kind and parent.amount_cents=retry.amount_cents and parent.due_at=retry.due_at and parent.status='stopped') or
   not creatornet_team_private.team_closed_collection_retained_v1(retry.original_obligation_id,retry.basis->'closure') then return false;end if;
 end if;
 if retry.payment_kind='monthly_payoff' then
  select * into payoff from public.sales_team_payoff_agreements_v1 where id=retry.payoff_id;
  return exists(select 1 from public.sales_team_controls_v1 where singleton and payoff_collection_enabled) and payoff.sale_id=agreement.id and payoff.buyer_id=agreement.buyer_id and payoff.context=p_context and payoff.agreement_fingerprint=agreement.fingerprint and payoff.covered_periods=runtime.covered_periods and payoff.minimum_months=(agreement.terms->>'initialCommitmentMonths')::integer and
   payoff.amount_cents=retry.amount_cents and payoff.amount_cents=(agreement.terms->>'amountCents')::bigint*(payoff.minimum_months-payoff.covered_periods) and payoff.anchor_at=runtime.anchor_at and payoff.period_end=creatornet_team_private.team_month_boundary_v1(runtime.anchor_at,payoff.minimum_months) and payoff.period_end>clock_timestamp();
 end if;
 schedule:=creatornet_team_private.later_payment_schedule_v1(agreement.id);
 return schedule is not null and (schedule->>'periodNumber')::integer=retry.period_number and (schedule->>'amountCents')::integer=retry.amount_cents and (schedule->>'dueAt')::timestamptz=retry.due_at and retry.due_at<=clock_timestamp() and
  (agreement.terms->>'paymentKind'<>'monthly' or creatornet_team_private.team_month_boundary_v1(runtime.anchor_at,retry.period_number)>clock_timestamp());
end $$;
create function public.accept_sales_team_collection_retry_v1(p_sale_id uuid,p_buyer_id uuid,p_request_id uuid,p_original_obligation_id uuid,p_fingerprint text,p_accepted boolean,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare agreement public.sales_team_sale_agreements_v1;prior public.sales_team_collection_retries_v1;obligation public.sales_team_payment_obligations_v1;source jsonb;quote jsonb;expiry timestamptz;begin
 select * into agreement from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id and context=p_context;
 if agreement.id is null then raise exception 'OWNED_TEAM_RETRY_REQUIRED';end if;
 if p_accepted is distinct from true or p_request_id is null then raise exception 'EXPLICIT_TEAM_RETRY_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||agreement.creator_id::text,0));
 select * into prior from public.sales_team_collection_retries_v1 where id=p_request_id;
 if prior.id is not null then
  if prior.sale_id<>agreement.id or prior.buyer_id<>agreement.buyer_id or prior.original_obligation_id is distinct from p_original_obligation_id or prior.quote_fingerprint<>p_fingerprint or prior.context<>p_context then raise exception 'ORIGINAL_TEAM_RETRY_REQUIRED';end if;
  return public.read_sales_team_period_payment_v1(agreement.id,agreement.buyer_id,prior.obligation_id);
 end if;
 source:=creatornet_team_private.team_retry_basis_v1(agreement.id,p_original_obligation_id);quote:=source->'quote';
 if source is null or quote->>'fingerprint' is distinct from p_fingerprint or quote->'originalObligationId' is distinct from to_jsonb(p_original_obligation_id) and not (p_original_obligation_id is null and quote->'originalObligationId'='null'::jsonb) then raise exception 'CURRENT_TEAM_RETRY_QUOTE_REQUIRED';end if;
 if p_original_obligation_id is not null then update public.sales_team_payment_obligations_v1 set status='stopped' where id=p_original_obligation_id and sale_id=agreement.id and status<>'paid';end if;
 insert into public.sales_team_payment_obligations_v1(id,sale_id,period_number,amount_cents,due_at,payment_kind) values(gen_random_uuid(),agreement.id,(quote->>'periodNumber')::integer,(quote->>'amountCents')::integer,(quote->>'dueAt')::timestamptz,quote->>'paymentKind') returning * into obligation;
 insert into public.sales_team_collection_retries_v1(id,sale_id,buyer_id,original_obligation_id,obligation_id,payoff_id,period_number,payment_kind,amount_cents,due_at,agreement_fingerprint,context,basis,quote,quote_fingerprint)
 values(p_request_id,agreement.id,agreement.buyer_id,p_original_obligation_id,obligation.id,(source->'basis'->>'payoffId')::uuid,obligation.period_number,obligation.payment_kind,obligation.amount_cents,obligation.due_at,agreement.fingerprint,p_context,source->'basis',quote,p_fingerprint);
 expiry:=date_trunc('second',clock_timestamp())+interval '24 hours';if quote->>'periodEnd' is not null then expiry:=least(expiry,(quote->>'periodEnd')::timestamptz);end if;
 insert into public.sales_team_later_payment_windows_v1(obligation_id,sale_id,buyer_id,anchor_at,due_at,expires_at,context) values(obligation.id,agreement.id,agreement.buyer_id,(source->'basis'->>'anchorAt')::timestamptz,obligation.due_at,expiry,p_context);
 if not creatornet_team_private.team_collection_retry_admitted_v1(obligation.id,p_context) then raise exception 'TEAM_COLLECTION_RETRY_HELD';end if;
 return public.read_sales_team_period_payment_v1(agreement.id,agreement.buyer_id,obligation.id);
end $$;
alter function creatornet_team_private.later_payment_admitted_v1(uuid,jsonb) rename to later_payment_admitted_before_retry_v1;
create function creatornet_team_private.later_payment_admitted_v1(p_obligation_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select case when exists(select 1 from public.sales_team_collection_retries_v1 where obligation_id=p_obligation_id and payment_kind='payment') then creatornet_team_private.team_collection_retry_admitted_v1(p_obligation_id,p_context) else creatornet_team_private.later_payment_admitted_before_retry_v1(p_obligation_id,p_context) end
$$;
alter function creatornet_team_private.team_payoff_admitted_v1(uuid,jsonb) rename to team_payoff_admitted_before_retry_v1;
create function creatornet_team_private.team_payoff_admitted_v1(p_obligation_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select case when exists(select 1 from public.sales_team_collection_retries_v1 where obligation_id=p_obligation_id and payment_kind='monthly_payoff') then creatornet_team_private.team_collection_retry_admitted_v1(p_obligation_id,p_context) else creatornet_team_private.team_payoff_admitted_before_retry_v1(p_obligation_id,p_context) end
$$;
-- Preserve exact originals, and patch only the named owning selectors/ports.
do $retry_ports$ declare src text;needle text;begin
 src:=pg_get_functiondef('public.reserve_sales_team_next_payment_v1(uuid,uuid,jsonb)'::regprocedure);needle:='where sale_id=a.id and period_number=n and payment_kind=''payment'';';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RETRY_NEXT_PERIOD_DEPENDENCY_DIFFERS';end if;execute replace(src,needle,'where sale_id=a.id and period_number=n and payment_kind=''payment'' and status<>''stopped'';');
 src:=pg_get_functiondef('public.stop_sales_team_payoff_v1(uuid,uuid,uuid)'::regprocedure);needle:='from public.sales_team_payoff_agreements_v1 where sale_id=a.id and buyer_id=a.buyer_id and obligation_id=p_obligation_id';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RETRY_PAYOFF_STOP_DEPENDENCY_DIFFERS';end if;execute replace(src,needle,'from creatornet_team_private.team_payoff_for_obligation_v1(p_obligation_id) where sale_id=a.id and buyer_id=a.buyer_id');
 src:=pg_get_functiondef('public.record_verified_sales_team_capture_v1(uuid,uuid,uuid,uuid,jsonb)'::regprocedure);needle:='from public.sales_team_payoff_agreements_v1 where obligation_id=p_obligation_id and sale_id=a.id and buyer_id=a.buyer_id';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RETRY_PAYOFF_CAPTURE_DEPENDENCY_DIFFERS';end if;execute replace(src,needle,'from creatornet_team_private.team_payoff_for_obligation_v1(p_obligation_id) where sale_id=a.id and buyer_id=a.buyer_id');
 src:=pg_get_functiondef('creatornet_team_private.team_exit_quote_v1(uuid)'::regprocedure);needle:='''obligationId'',payoff.obligation_id';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RETRY_PAYOFF_VIEW_DEPENDENCY_DIFFERS';end if;src:=replace(src,needle,'''obligationId'',creatornet_team_private.team_current_payoff_obligation_v1(payoff.id)');
 needle:='and obligation.payment_kind=''payment'' and not exists';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RETRY_CLOSED_ANCESTOR_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'and obligation.payment_kind=''payment'' and not exists(select 1 from public.sales_team_collection_retries_v1 where original_obligation_id=obligation.id) and not exists(select 1 from public.sales_team_payoff_original_closures_v1 closure where closure.payoff_id=payoff.id and closure.obligation_id=obligation.id and creatornet_team_private.team_closed_collection_retained_v1(obligation.id,closure.proof)) and not exists');
end $retry_ports$;
alter function public.accept_sales_team_payoff_v1(uuid,uuid,uuid,text,boolean,jsonb) rename to accept_team_payoff_before_retry_v1;
create function public.accept_sales_team_payoff_v1(p_sale_id uuid,p_buyer_id uuid,p_request_id uuid,p_fingerprint text,p_accepted boolean,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare agreement public.sales_team_sale_agreements_v1;payoff public.sales_team_payoff_agreements_v1;parent record;proof jsonb;result jsonb;had_prior boolean;begin
 select * into agreement from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id and context=p_context;
 if agreement.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||agreement.creator_id::text,0));
 had_prior:=exists(select 1 from public.sales_team_payoff_agreements_v1 where sale_id=agreement.id);
 result:=public.accept_team_payoff_before_retry_v1(p_sale_id,p_buyer_id,p_request_id,p_fingerprint,p_accepted,p_context);
 if had_prior then return result;end if;
 select * into payoff from public.sales_team_payoff_agreements_v1 where id=p_request_id and sale_id=agreement.id;
 for parent in select obligation.* from public.sales_team_payment_obligations_v1 obligation where obligation.sale_id=agreement.id and obligation.payment_kind='payment' and obligation.period_number>payoff.covered_periods and obligation.status='stopped' and not exists(select 1 from public.sales_team_collection_retries_v1 where original_obligation_id=obligation.id) loop
  proof:=creatornet_team_private.team_closed_collection_proof_v1(parent.id,true);if proof is null then raise exception 'PAYOFF_ORIGINAL_CLOSURE_REQUIRED';end if;
  insert into public.sales_team_payoff_original_closures_v1(payoff_id,obligation_id,intent_operation_id,state_id,proof) values(payoff.id,parent.id,(proof->'operation'->>'id')::uuid,(proof->>'stateId')::uuid,proof);
 end loop;
 return result;
end $$;
revoke all on function public.accept_team_payoff_before_retry_v1(uuid,uuid,uuid,text,boolean,jsonb) from public,anon,authenticated,service_role;
create function public.stop_sales_team_collection_retry_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare agreement public.sales_team_sale_agreements_v1;retry public.sales_team_collection_retries_v1;begin
 select * into agreement from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 select * into retry from public.sales_team_collection_retries_v1 where obligation_id=p_obligation_id and sale_id=agreement.id and buyer_id=p_buyer_id;
 if retry.id is null then raise exception 'OWNED_TEAM_RETRY_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||agreement.creator_id::text,0));
 insert into public.sales_team_collection_retry_stops_v1(obligation_id,buyer_id) values(p_obligation_id,p_buyer_id) on conflict(obligation_id) do nothing;
 if retry.payment_kind='monthly_payoff' then perform public.stop_sales_team_payoff_v1(p_sale_id,p_buyer_id,p_obligation_id);else perform public.stop_sales_team_payment_v1(p_sale_id,p_buyer_id);end if;
end $$;
alter function public.read_sales_team_period_payment_v1(uuid,uuid,uuid) rename to read_team_period_before_retry_v1;
create function public.read_sales_team_period_payment_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;retry public.sales_team_collection_retries_v1;begin
 result:=public.read_team_period_before_retry_v1(p_sale_id,p_buyer_id,p_obligation_id);
 select * into retry from public.sales_team_collection_retries_v1 where obligation_id=p_obligation_id and sale_id=p_sale_id and buyer_id=p_buyer_id;
 if retry.id is not null then result:=result||jsonb_build_object('retry_agreement_id',retry.id,'collection_stop_requested',exists(select 1 from public.sales_team_collection_retry_stops_v1 where obligation_id=p_obligation_id and buyer_id=p_buyer_id));end if;
 return result;
end $$;
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_before_retry_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare target uuid;begin
 if p_scope->>'kind' not in ('intent','confirmation','cancellation') then return public.sales_team_operation_before_retry_v1(p_scope,p_context);end if;
 if p_scope->>'kind' in ('intent','cancellation') then select obligation_id into target from public.sales_team_payment_attempts_v1 where sale_id=(p_scope->>'saleId')::uuid and (case when p_scope->>'kind'='intent' then 'intent:' else 'cancel:' end)||obligation_id::text=p_scope->>'scopeKey';
 else target:=(select confirmation.obligation_id from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_payment_attempts_v1 attempt using(obligation_id) where attempt.sale_id=(p_scope->>'saleId')::uuid and 'confirm:'||confirmation.request_id::text=p_scope->>'scopeKey');end if;
 if exists(select 1 from public.sales_team_collection_retries_v1 where original_obligation_id=target) then return false;end if;
 if p_scope->>'kind'='cancellation' and exists(select 1 from public.sales_team_collection_retries_v1 where obligation_id=target) and not exists(select 1 from public.sales_team_collection_retry_stops_v1 where obligation_id=target) then return false;end if;
 return public.sales_team_operation_before_retry_v1(p_scope,p_context);
end $$;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''team_payoff_for_obligation_v1'',''team_current_payoff_obligation_v1'',''team_closed_collection_proof_v1'',''team_closed_collection_retained_v1'',''team_retry_financial_ready_v1'',''team_retry_basis_v1'',''team_collection_retry_admitted_v1'',''later_payment_admitted_before_retry_v1'',''later_payment_admitted_v1'',''team_payoff_admitted_before_retry_v1'',''team_payoff_admitted_v1'',''team_exit_quote_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''read_sales_team_retry_quote_v1'',''accept_sales_team_collection_retry_v1'',''accept_team_payoff_before_retry_v1'',''accept_sales_team_payoff_v1'',''stop_sales_team_collection_retry_v1'',''stop_sales_team_payoff_v1'',''read_team_period_before_retry_v1'',''read_sales_team_period_payment_v1'',''sales_team_operation_before_retry_v1'',''sales_team_operation_admitted_v1'',''reserve_sales_team_next_payment_v1'',''record_verified_sales_team_capture_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'RETRY_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
do $security$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_collection_retries_v1','sales_team_collection_retry_stops_v1','sales_team_payoff_original_closures_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_team_collection_retry_v1 before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('read_sales_team_retry_quote_v1','accept_sales_team_collection_retry_v1','accept_sales_team_payoff_v1','stop_sales_team_collection_retry_v1','read_team_period_before_retry_v1','read_sales_team_period_payment_v1','sales_team_operation_before_retry_v1','sales_team_operation_admitted_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('team_payoff_for_obligation_v1','team_current_payoff_obligation_v1','team_closed_collection_proof_v1','team_closed_collection_retained_v1','team_retry_financial_ready_v1','team_retry_basis_v1','team_collection_retry_admitted_v1','later_payment_admitted_before_retry_v1','later_payment_admitted_v1','team_payoff_admitted_before_retry_v1','team_payoff_admitted_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $security$;
commit;
