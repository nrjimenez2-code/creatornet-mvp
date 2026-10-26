-- Local candidate. Accepted obligations survive departure and new-sales disable.
-- No scheduler, off-session debit, hosted installation or activation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column payoff_collection_enabled boolean not null default false;
alter table public.sales_team_payment_runtime_v1 add column renewal_stopped_at timestamptz;
alter table public.sales_team_payment_obligations_v1 add column payment_kind text not null default 'payment' check(payment_kind in ('payment','monthly_payoff'));
alter table public.sales_team_payment_obligations_v1 drop constraint sales_team_payment_obligations_v1_sale_id_period_number_key;
create unique index sales_team_one_regular_period_v1 on public.sales_team_payment_obligations_v1(sale_id,period_number) where payment_kind='payment';
create unique index sales_team_one_payoff_period_v1 on public.sales_team_payment_obligations_v1(sale_id,period_number) where payment_kind='monthly_payoff';
create table public.sales_team_exit_requests_v1 (
 id uuid primary key,sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,kind text not null check(kind in ('stop_renewal','revoke_debits')),
 agreement_fingerprint text not null,context jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_payoff_agreements_v1 (
 id uuid primary key,sale_id uuid not null unique references public.sales_team_sale_agreements_v1(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,obligation_id uuid not null unique references public.sales_team_payment_obligations_v1(id) on delete restrict,
 agreement_fingerprint text not null,quote jsonb not null,quote_fingerprint text not null check(quote_fingerprint~'^[a-f0-9]{64}$'),
 covered_periods integer not null check(covered_periods>=1),minimum_months integer not null,amount_cents integer not null check(amount_cents between 50 and 99999999),
 anchor_at timestamptz not null,period_start timestamptz not null,period_end timestamptz not null,context jsonb not null,accepted_at timestamptz not null default clock_timestamp(),
 check(minimum_months>covered_periods and period_end>period_start)
);
create table public.sales_team_payoff_completions_v1 (
 payoff_id uuid primary key references public.sales_team_payoff_agreements_v1(id) on delete restrict,
 receipt_id uuid not null unique references public.sales_team_receipts_v1(id) on delete restrict,
 covered_periods integer not null,paid_through timestamptz not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_payoff_stops_v1 (
 obligation_id uuid primary key references public.sales_team_payoff_agreements_v1(obligation_id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,created_at timestamptz not null default clock_timestamp()
);
alter function creatornet_team_private.later_payment_schedule_v1(uuid) rename to later_payment_schedule_before_lifecycle_v1;
create function creatornet_team_private.later_payment_schedule_v1(p_sale_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;r public.sales_team_payment_runtime_v1;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id;
 select * into r from public.sales_team_payment_runtime_v1 where sale_id=a.id;
 if exists(select 1 from public.sales_team_payoff_agreements_v1 payoff join public.sales_team_payoff_completions_v1 done on done.payoff_id=payoff.id where payoff.sale_id=a.id) or
  a.terms->>'paymentKind'='monthly' and r.renewal_stopped_at is not null and r.covered_periods>=(a.terms->>'initialCommitmentMonths')::integer then return jsonb_build_object('status','complete');end if;
 return creatornet_team_private.later_payment_schedule_before_lifecycle_v1(p_sale_id);
end $$;
create function creatornet_team_private.team_exit_quote_v1(p_sale_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;r public.sales_team_payment_runtime_v1;payoff public.sales_team_payoff_agreements_v1;
 reasons jsonb:='[]';minimum integer;remaining integer;amount bigint;paid_through timestamptz;minimum_end timestamptz;body jsonb;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id;select * into r from public.sales_team_payment_runtime_v1 where sale_id=a.id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 select * into payoff from public.sales_team_payoff_agreements_v1 where sale_id=a.id;
 minimum:=case when a.terms->>'paymentKind'='monthly' then (a.terms->>'initialCommitmentMonths')::integer else 0 end;
 remaining:=greatest(0,minimum-coalesce(r.covered_periods,0));
 if r.anchor_at is not null then paid_through:=creatornet_team_private.team_month_boundary_v1(r.anchor_at,r.covered_periods);if minimum>0 then minimum_end:=creatornet_team_private.team_month_boundary_v1(r.anchor_at,minimum);end if;end if;
 if a.terms->>'paymentKind' in ('installments','monthly') and creatornet_team_private.later_payment_schedule_before_lifecycle_v1(a.id) is null and not exists(select 1 from public.sales_team_payoff_completions_v1 where payoff_id=payoff.id) then reasons:=reasons||'"VERIFIED_CAPTURE_HISTORY_REQUIRED"'::jsonb;end if;
 if r.financial_hold or exists(select 1 from public.sales_team_receipts_v1 where sale_id=a.id and (review_hold or dispute_hold or refunded_subtotal_cents>0 or confirmed_loss_subtotal_cents>0)) then reasons:=reasons||'"FINANCIAL_REVIEW_REQUIRED"'::jsonb;end if;
 if exists(select 1 from public.sales_team_payment_events_v1 event where event.sale_id=a.id and not exists(select 1 from public.sales_team_payment_event_results_v1 result where result.event_id=event.event_id)) or
  exists(select 1 from public.sales_team_financial_checks_v1 checkup join public.sales_team_receipts_v1 receipt on receipt.id=checkup.receipt_id where receipt.sale_id=a.id and not exists(select 1 from public.sales_team_financial_check_results_v1 result where result.check_id=checkup.id)) then reasons:=reasons||'"FINANCIAL_OBSERVATION_PENDING"'::jsonb;end if;
 if exists(select 1 from public.sales_team_receipts_v1 receipt where receipt.sale_id=a.id and not exists(select 1 from public.sales_team_shared_receipts_v1 where receipt_id=receipt.id)) then reasons:=reasons||'"SHARED_FULFILLMENT_REQUIRED"'::jsonb;end if;
 if exists(select 1 from public.sales_team_payment_attempts_v1 attempt join public.sales_team_payment_obligations_v1 obligation on obligation.id=attempt.obligation_id
  join public.sales_team_provider_operations_v1 original on original.id=attempt.intent_operation_id
  where attempt.sale_id=a.id and obligation.period_number>coalesce(r.covered_periods,0) and obligation.payment_kind='payment' and not exists(select 1 from public.sales_team_receipts_v1 where obligation_id=obligation.id) and
   (original.status<>'bound' or not exists(select 1 from public.sales_team_payment_states_v1 state where state.id=(select id from public.sales_team_payment_states_v1 where obligation_id=obligation.id order by observed_at desc,id desc limit 1) and state.status='canceled' and state.payment_intent_id=original.provider_id and state.proof->'unpaidMethod'='true'::jsonb and state.observed_at>clock_timestamp()-interval '30 seconds') or
    exists(select 1 from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_provider_operations_v1 operation on operation.id=confirmation.operation_id where confirmation.obligation_id=obligation.id and operation.status<>'bound'))) then reasons:=reasons||'"ORIGINAL_PAYMENT_RECONCILIATION_REQUIRED"'::jsonb;end if;
 if minimum_end is not null and minimum_end<=clock_timestamp() and remaining>0 then reasons:=reasons||'"MINIMUM_TERM_ENDED_REVIEW"'::jsonb;end if;
 amount:=case when a.terms->>'paymentKind'='monthly' then (a.terms->>'amountCents')::bigint*remaining else null end;
 if amount>99999999 then reasons:=reasons||'"PAYOFF_AMOUNT_REVIEW_REQUIRED"'::jsonb;end if;
 body:=jsonb_build_object('version','creatornet-team-exit-v1','saleId',a.id,'agreementFingerprint',a.fingerprint,'paymentKind',a.terms->>'paymentKind',
  'coveredPeriods',coalesce(r.covered_periods,0),'minimumMonths',minimum,'remainingMonths',remaining,'payoffAmountCents',amount,'monthlyPriceCents',case when minimum>0 then (a.terms->>'amountCents')::integer else null end,
  'paidThrough',paid_through,'minimumEnd',minimum_end,'reviewReasons',reasons,'automaticDebitsStopped',r.stop_requested_at is not null,'renewalStopped',r.renewal_stopped_at is not null,
  'canAcceptPayoff',minimum>0 and remaining>0 and coalesce(r.covered_periods,0)>0 and reasons='[]'::jsonb and payoff.id is null,
  'payoff',case when payoff.id is null then null else jsonb_build_object('id',payoff.id,'obligationId',payoff.obligation_id,'fingerprint',payoff.quote_fingerprint,'completed',exists(select 1 from public.sales_team_payoff_completions_v1 where payoff_id=payoff.id)) end,
  'authorization','Only your separately confirmed one-time payoff can settle the remaining minimum. Stop does not waive a balance. Failed or abandoned attempts do not count as paid. A completed payoff stops renewal and preserves paid access and support through the accepted minimum. Refund rights are preserved.');
 return body||jsonb_build_object('fingerprint',encode(sha256(convert_to(body::text,'UTF8')),'hex'));
end $$;
create function public.read_sales_team_exit_quote_v1(p_sale_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$begin
 if not exists(select 1 from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id) then raise exception 'OWNED_SALE_REQUIRED';end if;
 return creatornet_team_private.team_exit_quote_v1(p_sale_id);
end $$;
create function public.request_sales_team_exit_v1(p_sale_id uuid,p_buyer_id uuid,p_request_id uuid,p_kind text,p_accepted boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;original public.sales_team_exit_requests_v1;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 if p_accepted is distinct from true or p_kind not in ('stop_renewal','revoke_debits') or p_request_id is null then raise exception 'EXPLICIT_TEAM_EXIT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into original from public.sales_team_exit_requests_v1 where id=p_request_id;
 if original.id is not null and (original.sale_id<>a.id or original.buyer_id<>a.buyer_id or original.kind<>p_kind or original.agreement_fingerprint<>a.fingerprint or original.context<>a.context) then raise exception 'ORIGINAL_TEAM_EXIT_CHANGED';end if;
 if p_kind='stop_renewal' and a.terms->>'paymentKind'<>'monthly' then raise exception 'MONTHLY_TEAM_SALE_REQUIRED';end if;
 insert into public.sales_team_exit_requests_v1(id,sale_id,buyer_id,kind,agreement_fingerprint,context) values(p_request_id,a.id,a.buyer_id,p_kind,a.fingerprint,a.context) on conflict(id) do nothing;
 if p_kind='revoke_debits' then perform public.stop_sales_team_payment_v1(a.id,a.buyer_id);
 else insert into public.sales_team_payment_runtime_v1(sale_id,renewal_stopped_at) values(a.id,clock_timestamp()) on conflict(sale_id) do update set renewal_stopped_at=coalesce(sales_team_payment_runtime_v1.renewal_stopped_at,excluded.renewal_stopped_at);end if;
 return creatornet_team_private.team_exit_quote_v1(a.id);
end $$;
create function creatornet_team_private.team_payoff_admitted_v1(p_obligation_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_payoff_agreements_v1 payoff
 join public.sales_team_sale_agreements_v1 agreement on agreement.id=payoff.sale_id and agreement.buyer_id=payoff.buyer_id and agreement.context=payoff.context and agreement.fingerprint=payoff.agreement_fingerprint and agreement.terms->>'paymentKind'='monthly'
 join public.sales_team_sale_requests_v1 sale on sale.id=agreement.id and sale.status='accepted'
 join public.sales_team_purchase_admissions_v1 admission on admission.sale_id=agreement.id and admission.status='active'
 join public.sales_team_payment_runtime_v1 runtime on runtime.sale_id=agreement.id and runtime.stop_requested_at is not null and runtime.canceled_at is null and not runtime.financial_hold and runtime.covered_periods=payoff.covered_periods and runtime.anchor_at=payoff.anchor_at
 join public.sales_team_payment_obligations_v1 obligation on obligation.id=payoff.obligation_id and obligation.sale_id=agreement.id and obligation.payment_kind='monthly_payoff' and obligation.period_number=payoff.covered_periods+1 and obligation.amount_cents=payoff.amount_cents and obligation.status in ('unpaid','admitted')
 join public.sales_team_later_payment_windows_v1 window_source on window_source.obligation_id=obligation.id and window_source.sale_id=agreement.id and window_source.buyer_id=agreement.buyer_id and window_source.context=agreement.context and window_source.anchor_at=payoff.anchor_at and window_source.due_at=obligation.due_at and window_source.expires_at>clock_timestamp()
 join public.sales_team_controls_v1 controls on controls.singleton and controls.payoff_collection_enabled and controls.payment_collection_enabled and controls.receipt_recording_enabled and controls.fulfillment_enabled and controls.event_reconciliation_enabled and controls.financial_reconciliation_enabled
 join public.sales_team_financial_config_v1 config on config.singleton and config.context=p_context and config.actual_pricing_verified and config.reserves_verified and config.disclosures_approved
 where payoff.obligation_id=p_obligation_id and payoff.context=p_context and payoff.minimum_months=(agreement.terms->>'initialCommitmentMonths')::integer and payoff.minimum_months>payoff.covered_periods and
 payoff.amount_cents=(agreement.terms->>'amountCents')::bigint*(payoff.minimum_months-payoff.covered_periods) and payoff.period_start=creatornet_team_private.team_month_boundary_v1(payoff.anchor_at,payoff.covered_periods) and payoff.period_end=creatornet_team_private.team_month_boundary_v1(payoff.anchor_at,payoff.minimum_months) and payoff.period_end>clock_timestamp() and
 creatornet_team_private.later_payment_schedule_before_lifecycle_v1(agreement.id) is not null and not exists(select 1 from public.sales_team_payoff_stops_v1 where obligation_id=obligation.id) and not exists(select 1 from public.sales_team_receipts_v1 where obligation_id=obligation.id) and
 not exists(select 1 from public.sales_team_receipts_v1 prior where prior.sale_id=agreement.id and (prior.review_hold or prior.dispute_hold or prior.refunded_subtotal_cents>0 or prior.confirmed_loss_subtotal_cents>0 or not exists(select 1 from public.sales_team_shared_receipts_v1 where receipt_id=prior.id))) and
 not exists(select 1 from public.sales_team_payment_events_v1 event where event.sale_id=agreement.id and not exists(select 1 from public.sales_team_payment_event_results_v1 result where result.event_id=event.event_id)) and
 not exists(select 1 from public.sales_team_financial_checks_v1 checkup join public.sales_team_receipts_v1 receipt on receipt.id=checkup.receipt_id where receipt.sale_id=agreement.id and not exists(select 1 from public.sales_team_financial_check_results_v1 result where result.check_id=checkup.id)))
$$;
create function public.accept_sales_team_payoff_v1(p_sale_id uuid,p_buyer_id uuid,p_request_id uuid,p_fingerprint text,p_accepted boolean,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;r public.sales_team_payment_runtime_v1;payoff public.sales_team_payoff_agreements_v1;o public.sales_team_payment_obligations_v1;quote jsonb;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id and context=p_context;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 if p_accepted is distinct from true or p_request_id is null then raise exception 'EXPLICIT_TEAM_PAYOFF_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 if exists(select 1 from public.sales_team_payoff_agreements_v1 where id=p_request_id and sale_id<>a.id) then raise exception 'ORIGINAL_TEAM_PAYOFF_REQUIRED';end if;
 select * into payoff from public.sales_team_payoff_agreements_v1 where sale_id=a.id;
 if payoff.id is not null then
  if payoff.id<>p_request_id or payoff.sale_id<>a.id or payoff.buyer_id<>a.buyer_id or payoff.context<>p_context or payoff.quote_fingerprint<>p_fingerprint then raise exception 'ORIGINAL_TEAM_PAYOFF_REQUIRED';end if;
  return public.read_sales_team_period_payment_v1(a.id,a.buyer_id,payoff.obligation_id);
 end if;
 quote:=creatornet_team_private.team_exit_quote_v1(a.id);
 if quote->>'fingerprint' is distinct from p_fingerprint or quote->'canAcceptPayoff' is distinct from 'true'::jsonb then raise exception 'CURRENT_TEAM_PAYOFF_QUOTE_REQUIRED';end if;
 select * into r from public.sales_team_payment_runtime_v1 where sale_id=a.id for update;
 perform public.stop_sales_team_payment_v1(a.id,a.buyer_id);
 update public.sales_team_payment_obligations_v1 set status='stopped' where sale_id=a.id and payment_kind='payment' and period_number>r.covered_periods and status<>'paid';
 insert into public.sales_team_payment_obligations_v1(id,sale_id,period_number,amount_cents,due_at,payment_kind) values(gen_random_uuid(),a.id,r.covered_periods+1,(quote->>'payoffAmountCents')::integer,date_trunc('second',clock_timestamp()),'monthly_payoff') returning * into o;
 insert into public.sales_team_payoff_agreements_v1(id,sale_id,buyer_id,obligation_id,agreement_fingerprint,quote,quote_fingerprint,covered_periods,minimum_months,amount_cents,anchor_at,period_start,period_end,context)
 values(p_request_id,a.id,a.buyer_id,o.id,a.fingerprint,quote,p_fingerprint,r.covered_periods,(quote->>'minimumMonths')::integer,o.amount_cents,r.anchor_at,(quote->>'paidThrough')::timestamptz,(quote->>'minimumEnd')::timestamptz,a.context);
 insert into public.sales_team_later_payment_windows_v1(obligation_id,sale_id,buyer_id,anchor_at,due_at,expires_at,context) values(o.id,a.id,a.buyer_id,r.anchor_at,o.due_at,least(date_trunc('second',clock_timestamp())+interval '24 hours',(quote->>'minimumEnd')::timestamptz),a.context);
 if not creatornet_team_private.team_payoff_admitted_v1(o.id,a.context) then raise exception 'TEAM_PAYOFF_COLLECTION_HELD';end if;
 return public.read_sales_team_period_payment_v1(a.id,a.buyer_id,o.id);
end $$;
create function public.stop_sales_team_payoff_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null or not exists(select 1 from public.sales_team_payoff_agreements_v1 where sale_id=a.id and buyer_id=a.buyer_id and obligation_id=p_obligation_id) then raise exception 'OWNED_TEAM_PAYOFF_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 insert into public.sales_team_payoff_stops_v1(obligation_id,buyer_id) values(p_obligation_id,a.buyer_id) on conflict(obligation_id) do nothing;
 perform public.stop_sales_team_payment_v1(a.id,a.buyer_id);
end $$;
alter function public.read_sales_team_period_payment_v1(uuid,uuid,uuid) rename to read_team_period_before_lifecycle_v1;
create function public.read_sales_team_period_payment_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;begin
 result:=public.read_team_period_before_lifecycle_v1(p_sale_id,p_buyer_id,p_obligation_id);
 if result->'obligation'->>'payment_kind'='monthly_payoff' then result:=result||jsonb_build_object('collection_stop_requested',exists(select 1 from public.sales_team_payoff_stops_v1 where obligation_id=p_obligation_id and buyer_id=p_buyer_id));end if;
 return result;
end $$;
-- Exact reviewed manual ports, with separate payoff authority and no future-use
-- setup. The original first/later entry points remain available for originals.
do $payoff_ports$ declare src text;needle text;begin
 src:=pg_get_functiondef('public.reserve_sales_team_period_intent_v1(uuid,uuid,uuid,jsonb,jsonb,uuid)'::regprocedure);
 needle:='FUNCTION public.reserve_sales_team_period_intent_v1';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 or position('later_payment_admitted_v1(o.id,a.context)' in src)=0 or position('''kind'',''payment''' in src)=0 or position('''payment_kind'',''payment''' in src)=0 then raise exception 'PAYOFF_INTENT_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'FUNCTION public.reserve_sales_team_payoff_intent_v1');src:=replace(src,'later_payment_admitted_v1(o.id,a.context)','team_payoff_admitted_v1(o.id,a.context)');
 src:=replace(src,'''kind'',''payment''','''kind'',''monthly_payoff''');src:=replace(src,'''payment_kind'',''payment''','''payment_kind'',''monthly_payoff''');
 needle:='if a.terms->>''paymentKind''<>''full'' then params:=params||jsonb_build_object(''setup_future_usage'',''off_session'');end if;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'PAYOFF_FUTURE_USAGE_DEPENDENCY_DIFFERS';end if;execute replace(src,needle,'');
 src:=pg_get_functiondef('public.reserve_sales_team_period_confirmation_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb,uuid)'::regprocedure);
 needle:='FUNCTION public.reserve_sales_team_period_confirmation_v1';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 or position('later_payment_admitted_v1(t.obligation_id,a.context)' in src)=0 then raise exception 'PAYOFF_CONFIRMATION_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'FUNCTION public.reserve_sales_team_payoff_confirmation_v1');execute replace(src,'later_payment_admitted_v1(t.obligation_id,a.context)','team_payoff_admitted_v1(t.obligation_id,a.context)');
 src:=pg_get_functiondef('public.reserve_sales_team_next_payment_v1(uuid,uuid,jsonb)'::regprocedure);needle:='where sale_id=a.id and period_number=n;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'LIFECYCLE_NEXT_PERIOD_DEPENDENCY_DIFFERS';end if;execute replace(src,needle,'where sale_id=a.id and period_number=n and payment_kind=''payment'';');
 src:=pg_get_functiondef('public.read_sales_team_collection_overview_v1(uuid,uuid)'::regprocedure);needle:='where sale_id=a.id and period_number>1 and not exists';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'LIFECYCLE_OVERVIEW_DEPENDENCY_DIFFERS';end if;execute replace(src,needle,'where sale_id=a.id and period_number>1 and status<>''stopped'' and not exists');
end $payoff_ports$;
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_before_lifecycle_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;t public.sales_team_payment_attempts_v1;c public.sales_team_payment_confirmations_v1;begin
 if p_scope->>'kind' not in ('intent','confirmation','cancellation') then return public.sales_team_operation_before_lifecycle_v1(p_scope,p_context);end if;
 select * into a from public.sales_team_sale_agreements_v1 where id=(p_scope->>'saleId')::uuid;
 if p_scope->>'kind'='intent' then select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id and 'intent:'||obligation_id::text=p_scope->>'scopeKey';
 elsif p_scope->>'kind'='cancellation' then select * into t from public.sales_team_payment_attempts_v1 where sale_id=a.id and 'cancel:'||obligation_id::text=p_scope->>'scopeKey';
 else
  if (select count(*) from public.sales_team_payment_confirmations_v1 where 'confirm:'||request_id::text=p_scope->>'scopeKey' and obligation_id in (select obligation_id from public.sales_team_payment_attempts_v1 where sale_id=a.id))<>1 then return false;end if;
  select * into c from public.sales_team_payment_confirmations_v1 where 'confirm:'||request_id::text=p_scope->>'scopeKey' and obligation_id in (select obligation_id from public.sales_team_payment_attempts_v1 where sale_id=a.id);select * into t from public.sales_team_payment_attempts_v1 where obligation_id=c.obligation_id;
 end if;
 if t.contract->>'kind' is distinct from 'monthly_payoff' then return public.sales_team_operation_before_lifecycle_v1(p_scope,p_context);end if;
 if p_scope->>'kind'='cancellation' then return exists(select 1 from public.sales_team_payoff_stops_v1 where obligation_id=t.obligation_id and buyer_id=a.buyer_id) and public.sales_team_operation_before_lifecycle_v1(p_scope,p_context);end if;
 if a.context is distinct from p_context or p_scope->>'scopeId' is distinct from a.id::text or p_scope->>'creatorId' is distinct from a.creator_id::text or p_scope->>'actorId' is distinct from a.buyer_id::text or p_scope->>'workerRunId' is not null or
  t.contract->>'saleId' is distinct from a.id::text or t.contract->>'obligationId' is distinct from t.obligation_id::text or t.contract->'terms' is distinct from a.terms or t.contract->>'fingerprint' is distinct from a.fingerprint or t.contract->'context' is distinct from p_context or
  not creatornet_team_private.team_payoff_admitted_v1(t.obligation_id,p_context) then return false;end if;
 if p_scope->>'kind'='intent' then return true;end if;
 return c.operation_id is not null and c.created_at>clock_timestamp()-interval '30 seconds' and not exists(select 1 from public.sales_team_payment_confirmations_v1 where obligation_id=t.obligation_id and step_number>c.step_number);
end $$;
alter function public.record_verified_sales_team_capture_v1(uuid,uuid,uuid,uuid,jsonb) rename to record_team_capture_before_lifecycle_v1;
create function public.record_verified_sales_team_capture_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid,p_confirmation_id uuid,p_capture jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;payoff public.sales_team_payoff_agreements_v1;receipt public.sales_team_receipts_v1;before_covered integer;result jsonb;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into payoff from public.sales_team_payoff_agreements_v1 where obligation_id=p_obligation_id and sale_id=a.id and buyer_id=a.buyer_id;
 select covered_periods into before_covered from public.sales_team_payment_runtime_v1 where sale_id=a.id;
 result:=public.record_team_capture_before_lifecycle_v1(p_sale_id,p_buyer_id,p_obligation_id,p_confirmation_id,p_capture);
 if payoff.id is null then return result;end if;
 select * into receipt from public.sales_team_receipts_v1 where id=(result->>'id')::uuid;
 if exists(select 1 from public.sales_team_payoff_completions_v1 where payoff_id=payoff.id and receipt_id=receipt.id) then return result;end if;
 if before_covered<>payoff.covered_periods or payoff.context<>a.context or payoff.agreement_fingerprint<>a.fingerprint or receipt.subtotal_cents<>payoff.amount_cents then
  update public.sales_team_receipts_v1 set review_hold=true where id=receipt.id;
  insert into public.sales_team_financial_alerts_v1(creator_id,sale_id,code,source_identity,evidence) values(a.creator_id,a.id,'PAYOFF_COVERAGE_REVIEW_REQUIRED','payoff-coverage:'||payoff.id::text,jsonb_build_object('payoffId',payoff.id,'receiptId',receipt.id)) on conflict(source_identity) do nothing;
  select * into receipt from public.sales_team_receipts_v1 where id=receipt.id;
 end if;
 if receipt.review_hold or receipt.dispute_hold or receipt.refunded_subtotal_cents>0 or receipt.confirmed_loss_subtotal_cents>0 then
  update public.sales_team_payment_runtime_v1 set covered_periods=before_covered where sale_id=a.id;
 else
  insert into public.sales_team_payoff_completions_v1(payoff_id,receipt_id,covered_periods,paid_through) values(payoff.id,receipt.id,payoff.minimum_months,payoff.period_end);
  update public.sales_team_payment_runtime_v1 set covered_periods=payoff.minimum_months,renewal_stopped_at=coalesce(renewal_stopped_at,clock_timestamp()),canceled_at=coalesce(canceled_at,clock_timestamp()) where sale_id=a.id;
 end if;
 perform public.sync_sales_team_shared_accounting_v1(a.id);
 return to_jsonb(receipt);
end $$;
-- Only the checked new capture port may complete payoff coverage; old direct
-- capture authority remains sealed behind it for all historical payment kinds.
revoke all on function public.record_team_capture_before_lifecycle_v1(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''later_payment_schedule_before_lifecycle_v1'',''later_payment_schedule_v1'',''team_exit_quote_v1'',''team_payoff_admitted_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''read_sales_team_exit_quote_v1'',''request_sales_team_exit_v1'',''accept_sales_team_payoff_v1'',''stop_sales_team_payoff_v1'',''read_team_period_before_lifecycle_v1'',''read_sales_team_period_payment_v1'',''reserve_sales_team_payoff_intent_v1'',''reserve_sales_team_payoff_confirmation_v1'',''sales_team_operation_before_lifecycle_v1'',''sales_team_operation_admitted_v1'',''record_team_capture_before_lifecycle_v1'',''record_verified_sales_team_capture_v1'',''reserve_sales_team_next_payment_v1'',''read_sales_team_collection_overview_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'LIFECYCLE_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
do $security$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_exit_requests_v1','sales_team_payoff_agreements_v1','sales_team_payoff_completions_v1','sales_team_payoff_stops_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_team_lifecycle_v1 before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('read_sales_team_exit_quote_v1','request_sales_team_exit_v1','accept_sales_team_payoff_v1','stop_sales_team_payoff_v1','read_team_period_before_lifecycle_v1','read_sales_team_period_payment_v1','reserve_sales_team_payoff_intent_v1','reserve_sales_team_payoff_confirmation_v1','sales_team_operation_before_lifecycle_v1','sales_team_operation_admitted_v1','record_verified_sales_team_capture_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('later_payment_schedule_before_lifecycle_v1','later_payment_schedule_v1','team_exit_quote_v1','team_payoff_admitted_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $security$;
commit;
