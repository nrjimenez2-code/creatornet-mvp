-- Local candidate. Written sale-specific consent and independently checked card
-- ownership. No scheduler, automatic charge, historical enrollment or Stop reset.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column saved_method_enabled boolean not null default false;
create table public.sales_team_saved_method_consents_v1 (
 id uuid primary key,sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 obligation_id uuid not null references public.sales_team_payment_obligations_v1(id) on delete restrict,
 token_id text not null unique check(token_id~'^ctoken_[A-Za-z0-9]+$'),token_proof jsonb not null,
 agreement_fingerprint text not null,context jsonb not null,quote jsonb not null,
 quote_fingerprint text not null check(quote_fingerprint~'^[a-f0-9]{64}$'),
 automatic_authorized boolean not null,created_at timestamptz not null default clock_timestamp()
);
create index sales_team_saved_method_consent_sale_v1 on public.sales_team_saved_method_consents_v1(sale_id,obligation_id);
create table public.sales_team_saved_methods_v1 (
 consent_id uuid primary key references public.sales_team_saved_method_consents_v1(id) on delete restrict,
 receipt_id uuid not null unique references public.sales_team_receipts_v1(id) on delete restrict,
 confirmation_operation_id uuid not null unique references public.sales_team_provider_operations_v1(id) on delete restrict,
 payment_method_id text not null check(payment_method_id~'^pm_[A-Za-z0-9]+$'),
 customer_id text not null check(customer_id~'^cus_[A-Za-z0-9]+$'),
 card_hash text not null check(card_hash~'^[a-f0-9]{64}$'),proof jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create function creatornet_team_private.team_saved_method_quote_v1(p_sale_id uuid,p_obligation_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;o public.sales_team_payment_obligations_v1;t public.sales_team_payment_attempts_v1;r public.sales_team_payment_runtime_v1;quote jsonb;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id;
 select * into o from public.sales_team_payment_obligations_v1 where id=p_obligation_id and sale_id=a.id;
 select * into t from public.sales_team_payment_attempts_v1 where obligation_id=o.id and sale_id=a.id;
 select * into r from public.sales_team_payment_runtime_v1 where sale_id=a.id;
 if t.obligation_id is null or a.terms->>'paymentKind' not in ('installments','monthly') or o.payment_kind<>'payment' or
  t.contract->'terms' is distinct from a.terms or t.contract->>'fingerprint' is distinct from a.fingerprint or t.contract->'context' is distinct from a.context or
  t.contract->>'customerId' is distinct from r.customer_id then return null;end if;
 quote:=jsonb_build_object('version','creatornet-team-saved-method-v1','saleId',a.id,'obligationId',o.id,'agreementFingerprint',a.fingerprint,
  'paymentKind',a.terms->>'paymentKind','currency','usd','currentPeriod',o.period_number,'currentAmountCents',o.amount_cents,
  'payments',a.terms->'payments','monthlyAmountCents',case when a.terms->>'paymentKind'='monthly' then a.terms->'amountCents' else null end,
  'minimumMonths',a.terms->'initialCommitmentMonths','autoRenew',coalesce(a.terms->'monthlyTerms'->'autoRenew','false'::jsonb),
  'anchorAt',r.anchor_at,'expiresAt',t.contract->'expiresAt','automaticAuthorized',r.stop_requested_at is null,
  'authorization',case when r.stop_requested_at is null then
   'I authorize CreatorNet to save the card used for this payment and initiate the remaining payments for this accepted plan while I am offline. Payments are monthly from the first successful payment, using the original UTC day and time, with shorter months clamped to their last day. Fixed installments stop at the accepted total; monthly service follows the accepted minimum and renewal terms. I can stop future automatic debits here; Stop does not waive an accepted balance. Stopping renewal preserves minimum payments. This permission is only for this sale and does not authorize other purchases.'
  else 'I authorize CreatorNet to save the card used for this manual payment for this accepted sale. Future automatic debits remain stopped. Every later manual payment needs my confirmation. Saving this card does not restore automatic debit permission or waive an accepted balance.' end,
  'acceptedBilling',a.terms->'billing','acceptedPolicy',a.terms->'policy');
 return quote||jsonb_build_object('fingerprint',encode(sha256(convert_to(jsonb_build_object('quote',quote,'context',a.context,'customerId',r.customer_id)::text,'UTF8')),'hex'));
end $$;
create function public.read_sales_team_saved_method_quote_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare target uuid;begin
 if not exists(select 1 from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id) then raise exception 'OWNED_TEAM_SAVED_METHOD_REQUIRED';end if;
 target:=coalesce(p_obligation_id,(select id from public.sales_team_payment_obligations_v1 where sale_id=p_sale_id and period_number=1));
 if not exists(select 1 from public.sales_team_payment_obligations_v1 where id=target and sale_id=p_sale_id) then raise exception 'OWNED_TEAM_OBLIGATION_REQUIRED';end if;
 return creatornet_team_private.team_saved_method_quote_v1(p_sale_id,target);
end $$;
create function public.accept_sales_team_saved_method_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid,p_request_id uuid,p_context jsonb,p_fingerprint text,p_accepted boolean,p_token_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;prior public.sales_team_saved_method_consents_v1;t public.sales_team_payment_attempts_v1;s public.sales_team_payment_states_v1;quote jsonb;admitted boolean;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null or a.context is distinct from p_context or p_accepted is distinct from true then raise exception 'EXPLICIT_TEAM_SAVED_METHOD_CONSENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into prior from public.sales_team_saved_method_consents_v1 where id=p_request_id;
 if prior.id is not null then
  if prior.sale_id<>a.id or prior.buyer_id<>a.buyer_id or prior.obligation_id<>p_obligation_id or prior.context<>p_context or prior.quote_fingerprint is distinct from p_fingerprint or prior.token_proof is distinct from p_token_proof then raise exception 'ORIGINAL_TEAM_SAVED_METHOD_CONSENT_REQUIRED';end if;
  return to_jsonb(prior);
 end if;
 quote:=creatornet_team_private.team_saved_method_quote_v1(a.id,p_obligation_id);
 select * into t from public.sales_team_payment_attempts_v1 where obligation_id=p_obligation_id and sale_id=a.id;
 select * into s from public.sales_team_payment_states_v1 where obligation_id=t.obligation_id order by observed_at desc,id desc limit 1;
 admitted:=case when (t.contract->>'periodNumber')::integer=1 then public.sales_team_payment_admitted_v1(a.id,p_context) else creatornet_team_private.later_payment_admitted_v1(t.obligation_id,p_context) end;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and saved_method_enabled) or admitted is distinct from true or quote is null or quote->>'fingerprint' is distinct from p_fingerprint or
  (t.contract->>'expiresAt')::bigint<=extract(epoch from clock_timestamp()) or s.id is null or s.status<>'requires_payment_method' or s.observed_at<=clock_timestamp()-interval '30 seconds' or s.proof->'unpaidMethod' is distinct from 'true'::jsonb or
  not exists(select 1 from public.sales_team_provider_operations_v1 where id=t.intent_operation_id and status='bound' and provider_id=s.payment_intent_id) or
  coalesce(p_token_proof->>'tokenId','')!~'^ctoken_[A-Za-z0-9]+$' or coalesce(p_token_proof->>'previewHash','')!~'^[a-f0-9]{64}$' or p_token_proof->>'country' is distinct from 'US' or
  coalesce((p_token_proof->>'createdAt')::bigint,0)<(t.contract->>'acceptedAt')::bigint or (p_token_proof->>'createdAt')::bigint>extract(epoch from clock_timestamp())+1 or coalesce((p_token_proof->>'expiresAt')::bigint,0)<=extract(epoch from clock_timestamp())+30 then raise exception 'CURRENT_TEAM_SAVED_METHOD_CONSENT_REQUIRED';end if;
 insert into public.sales_team_saved_method_consents_v1(id,sale_id,buyer_id,obligation_id,token_id,token_proof,agreement_fingerprint,context,quote,quote_fingerprint,automatic_authorized)
 values(p_request_id,a.id,a.buyer_id,t.obligation_id,p_token_proof->>'tokenId',p_token_proof,a.fingerprint,p_context,quote,p_fingerprint,(quote->>'automaticAuthorized')::boolean) returning * into prior;
 return to_jsonb(prior);
end $$;
create function creatornet_team_private.guard_team_saved_method_consent_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if new.kind='token' and exists(select 1 from public.sales_team_controls_v1 where singleton and saved_method_enabled) and
  exists(select 1 from public.sales_team_payment_attempts_v1 where obligation_id=new.obligation_id and contract->'terms'->>'paymentKind'<>'full' and contract->>'kind'='payment') and
  not exists(select 1 from public.sales_team_saved_method_consents_v1 where id=new.request_id and obligation_id=new.obligation_id and token_id=new.token_id and token_proof=new.token_proof) then raise exception 'EXPLICIT_TEAM_SAVED_METHOD_CONSENT_REQUIRED';end if;
 return new;
end $$;
create trigger sales_team_written_saved_method_consent_v1 before insert on public.sales_team_payment_confirmations_v1 for each row execute function creatornet_team_private.guard_team_saved_method_consent_v1();
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_before_saved_method_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare c public.sales_team_payment_confirmations_v1;consent public.sales_team_saved_method_consents_v1;begin
 if not public.sales_team_operation_before_saved_method_v1(p_scope,p_context) then return false;end if;
 if p_scope->>'kind'<>'confirmation' then return true;end if;
 select confirmation.* into c from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_payment_attempts_v1 attempt using(obligation_id)
 where attempt.sale_id=(p_scope->>'saleId')::uuid and 'confirm:'||confirmation.request_id::text=p_scope->>'scopeKey';
 if c.operation_id is null then return false;end if;
 if not exists(select 1 from public.sales_team_payment_attempts_v1 where obligation_id=c.obligation_id and contract->'terms'->>'paymentKind'<>'full' and contract->>'kind'='payment') then return true;end if;
 select * into consent from public.sales_team_saved_method_consents_v1 where token_id=c.token_id and obligation_id=c.obligation_id;
 if consent.id is null and not exists(select 1 from public.sales_team_controls_v1 where singleton and saved_method_enabled) then return true;end if;
 return exists(select 1 from public.sales_team_controls_v1 where singleton and saved_method_enabled) and consent.id is not null and consent.obligation_id=c.obligation_id and consent.token_id=c.token_id and consent.token_proof=c.token_proof and consent.context=p_context and
  consent.quote_fingerprint=creatornet_team_private.team_saved_method_quote_v1(consent.sale_id,consent.obligation_id)->>'fingerprint';
end $$;
create function public.read_sales_team_saved_method_source_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;begin
 if not exists(select 1 from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id) then raise exception 'OWNED_TEAM_SAVED_METHOD_REQUIRED';end if;
 select jsonb_build_object('consent',to_jsonb(consent),'contract',attempt.contract,'receiptId',receipt.id,'paymentIntentId',receipt.payment_intent_id,'confirmationOperationId',capture.confirmation_operation_id)
 into result from public.sales_team_saved_method_consents_v1 consent
 join public.sales_team_sale_agreements_v1 agreement on agreement.id=consent.sale_id and agreement.buyer_id=consent.buyer_id and agreement.context=consent.context and agreement.fingerprint=consent.agreement_fingerprint
 join public.sales_team_payment_attempts_v1 attempt on attempt.obligation_id=consent.obligation_id and attempt.sale_id=agreement.id and attempt.contract->'terms'=agreement.terms and attempt.contract->'context'=agreement.context and attempt.contract->>'fingerprint'=agreement.fingerprint
 join public.sales_team_receipts_v1 receipt on receipt.obligation_id=attempt.obligation_id and receipt.sale_id=agreement.id and not receipt.review_hold and not receipt.dispute_hold and receipt.refunded_subtotal_cents=0 and receipt.confirmed_loss_subtotal_cents=0
 join public.sales_team_shared_receipts_v1 shared on shared.receipt_id=receipt.id
 join public.sales_team_capture_provenance_v1 capture on capture.receipt_id=receipt.id and capture.obligation_id=attempt.obligation_id
 join public.sales_team_payment_confirmations_v1 confirmation on confirmation.operation_id=capture.confirmation_operation_id and confirmation.obligation_id=attempt.obligation_id and confirmation.token_id=consent.token_id and confirmation.token_proof=consent.token_proof
 join public.sales_team_provider_operations_v1 operation on operation.id=confirmation.operation_id and operation.status='bound' and operation.provider_id=receipt.payment_intent_id and operation.request=confirmation.request and operation.context=agreement.context
 join public.sales_team_provider_operations_v1 intent on intent.id=attempt.intent_operation_id and intent.status='bound' and intent.provider_id=receipt.payment_intent_id and intent.request=attempt.request and intent.context=agreement.context
 where consent.sale_id=p_sale_id and consent.buyer_id=p_buyer_id and consent.obligation_id=coalesce(p_obligation_id,(select id from public.sales_team_payment_obligations_v1 where sale_id=p_sale_id and period_number=1));
 return result;
end $$;
create function public.record_sales_team_saved_method_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;source jsonb;prior public.sales_team_saved_methods_v1;begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_TEAM_SAVED_METHOD_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 source:=public.read_sales_team_saved_method_source_v1(a.id,a.buyer_id,p_obligation_id);
 if source is null or p_proof->'context' is distinct from a.context or p_proof->>'consentId' is distinct from source->'consent'->>'id' or p_proof->>'paymentIntentId' is distinct from source->>'paymentIntentId' or
  p_proof->>'receiptId' is distinct from source->>'receiptId' or p_proof->>'confirmationOperationId' is distinct from source->>'confirmationOperationId' or p_proof->>'tokenId' is distinct from source->'consent'->>'token_id' or
  p_proof->>'previewHash' is distinct from source->'consent'->'token_proof'->>'previewHash' or p_proof->>'customerId' is distinct from source->'contract'->>'customerId' or
  coalesce(p_proof->>'paymentMethodId','')!~'^pm_[A-Za-z0-9]+$' or coalesce(p_proof->>'cardHash','')!~'^[a-f0-9]{64}$' or p_proof->>'country' is distinct from 'US' or
  coalesce(p_proof->>'intentRequestId','')!~'^req_[A-Za-z0-9]+$' or coalesce(p_proof->>'tokenRequestId','')!~'^req_[A-Za-z0-9]+$' or coalesce(p_proof->>'methodRequestId','')!~'^req_[A-Za-z0-9]+$' or
  coalesce((p_proof->>'readStartedAt')::bigint,0)<extract(epoch from clock_timestamp())*1000-30000 or (p_proof->>'readStartedAt')::bigint>extract(epoch from clock_timestamp())*1000+1000 or
  coalesce((p_proof->>'observedAt')::bigint,0)<extract(epoch from clock_timestamp())-30 or (p_proof->>'observedAt')::bigint>extract(epoch from clock_timestamp())+1 then raise exception 'VERIFIED_TEAM_SAVED_METHOD_REQUIRED';end if;
 select * into prior from public.sales_team_saved_methods_v1 where consent_id=(source->'consent'->>'id')::uuid;
 if prior.consent_id is not null then
  if prior.receipt_id::text<>source->>'receiptId' or prior.confirmation_operation_id::text<>source->>'confirmationOperationId' or prior.payment_method_id<>p_proof->>'paymentMethodId' or prior.customer_id<>p_proof->>'customerId' or prior.card_hash<>p_proof->>'cardHash' then raise exception 'ORIGINAL_TEAM_SAVED_METHOD_REQUIRED';end if;
  return to_jsonb(prior);
 end if;
 insert into public.sales_team_saved_methods_v1(consent_id,receipt_id,confirmation_operation_id,payment_method_id,customer_id,card_hash,proof)
 values((source->'consent'->>'id')::uuid,(source->>'receiptId')::uuid,(source->>'confirmationOperationId')::uuid,p_proof->>'paymentMethodId',p_proof->>'customerId',p_proof->>'cardHash',p_proof) returning * into prior;
 return to_jsonb(prior);
end $$;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''team_saved_method_quote_v1'',''guard_team_saved_method_consent_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''read_sales_team_saved_method_quote_v1'',''accept_sales_team_saved_method_v1'',''read_sales_team_saved_method_source_v1'',''record_sales_team_saved_method_v1'',''sales_team_operation_before_saved_method_v1'',''sales_team_operation_admitted_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'SAVED_METHOD_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
do $security$ declare name text;signature regprocedure;begin
 foreach name in array array['sales_team_saved_method_consents_v1','sales_team_saved_methods_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_team_saved_method_v1 before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for signature in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('read_sales_team_saved_method_quote_v1','accept_sales_team_saved_method_v1','read_sales_team_saved_method_source_v1','record_sales_team_saved_method_v1','sales_team_operation_before_saved_method_v1','sales_team_operation_admitted_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname='team_saved_method_quote_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',signature);execute format('grant execute on function %s to service_role',signature);
 end loop;
end $security$;
revoke all on function creatornet_team_private.guard_team_saved_method_consent_v1() from public,anon,authenticated,service_role;
commit;
