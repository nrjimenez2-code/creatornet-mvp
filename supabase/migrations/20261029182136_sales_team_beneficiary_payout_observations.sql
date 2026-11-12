-- Local candidate: immutable observations of original beneficiary payouts.
-- No financial effects, bank confirmation, provider writes or scheduled job.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ begin
 perform 'public.read_sales_team_surplus_pending_events_v1(uuid,uuid,jsonb,uuid)'::regprocedure;
 perform 'public.complete_sales_team_transfer_check_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)'::regprocedure;
 perform 'public.sales_team_transfer_reversal_completions_v1'::regclass;
end $parents$;
create table public.sales_team_bank_observation_policy_v1 (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,contract_sha256 text check(contract_sha256~'^[a-f0-9]{64}$')
);
insert into public.sales_team_bank_observation_policy_v1(singleton) values(true);
create table public.sales_team_beneficiary_payout_checks_v1 (
 id uuid primary key,lease_token uuid not null default gen_random_uuid(),
 request_id uuid not null references public.sales_team_transfer_completions_v1(request_id) on delete restrict,
 payout_id text not null check(payout_id~'^po_[A-Za-z0-9]+$'),context jsonb not null,
 source_sha256 text not null,contract_sha256 text not null,
 created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null default clock_timestamp()+interval '90 seconds'
);
create index sales_team_beneficiary_payout_active_v1 on public.sales_team_beneficiary_payout_checks_v1(request_id,expires_at);
create table public.sales_team_beneficiary_payout_observations_v1 (
 check_id uuid primary key references public.sales_team_beneficiary_payout_checks_v1(id) on delete restrict,
 request_id uuid not null references public.sales_team_transfer_completions_v1(request_id) on delete restrict,
 context jsonb not null,connected_account_id text not null,payout_id text not null,destination_id text not null,
 proof jsonb not null check(proof->'bankConfirmed'='false'::jsonb),created_at timestamptz not null default clock_timestamp()
);
create index sales_team_beneficiary_payout_history_v1 on public.sales_team_beneficiary_payout_observations_v1(request_id,created_at,check_id);
create table public.sales_team_beneficiary_payout_reads_v1 (
 provider_request_id text primary key check(provider_request_id~'^req_[A-Za-z0-9]+$'),
 check_id uuid not null references public.sales_team_beneficiary_payout_observations_v1(check_id) on delete restrict
);

create function creatornet_team_private.beneficiary_payout_source_v1(p_request_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q jsonb;done public.sales_team_transfer_completions_v1;begin
 q:=public.sales_team_transfer_request_json_v1(p_request_id);
 select * into done from public.sales_team_transfer_completions_v1 where request_id=p_request_id;
 if q is null or done.request_id is null or q->'context' is distinct from p_context or q->'completed' is distinct from 'true'::jsonb or q->'canceled' is distinct from 'false'::jsonb or
  q->>'destination_id' is distinct from q->>'approvedRecipientId' or q->'operation'->>'status' is distinct from 'bound' or
  q->'operation'->>'provider_id' is distinct from done.transfer_id or q->'operation'->'context' is distinct from p_context or
  q->'operation'->'request' is distinct from q->'request' or done.proof->'context' is distinct from p_context or
  done.proof->>'requestId' is distinct from p_request_id::text or done.proof->>'operationId' is distinct from q->>'operation_id' or
  done.proof->>'originalRequestId' is distinct from q->'operation'->>'provider_request_id' or
  done.proof->'transfer'->>'id' is distinct from done.transfer_id or done.proof->'balance'->>'id' is distinct from done.balance_id or
  exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where transfer_request_id=p_request_id)
 then raise exception 'COMPLETED_BENEFICIARY_ORIGINAL_REQUIRED';end if;
 return jsonb_build_object('request',q,'completion',jsonb_build_object('request_id',done.request_id,'transfer_id',done.transfer_id,'balance_id',done.balance_id,'proof',done.proof));
end $$;
create function creatornet_team_private.bank_observation_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(creatornet_team_private.transfer_contract_digest_v1()||':'||
  string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\n' order by p.oid::regprocedure::text collate "C"),'UTF8')),'hex')
 from pg_proc p where (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in
 ('bank_observation_contract_digest_v1','beneficiary_payout_source_v1','beneficiary_payout_authority_v1','beneficiary_payout_balance_v1','financial_shape_v1','reject_history_change')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('begin_sales_team_beneficiary_payout_check_v1','complete_sales_team_beneficiary_payout_check_v1'))
$$;
create function creatornet_team_private.beneficiary_payout_authority_v1(p_context jsonb,p_digest text)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) or
  not exists(select 1 from public.sales_team_bank_observation_policy_v1 where singleton and enabled and contract_sha256=p_digest) or
  p_digest is distinct from creatornet_team_private.bank_observation_contract_digest_v1()
 then raise exception 'BANK_OBSERVATION_AUTHORITY_REQUIRED';end if;
end $$;
create function public.begin_sales_team_beneficiary_payout_check_v1(p_check_id uuid,p_request_id uuid,p_payout_id text,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c public.sales_team_beneficiary_payout_checks_v1;source jsonb;digest text;begin
 if p_check_id is null or p_request_id is null or p_payout_id is null or p_payout_id!~'^po_[A-Za-z0-9]+$' then raise exception 'BENEFICIARY_CHECK_IDENTITIES_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 source:=creatornet_team_private.beneficiary_payout_source_v1(p_request_id,p_context);
 digest:=creatornet_team_private.bank_observation_contract_digest_v1();
 perform creatornet_team_private.beneficiary_payout_authority_v1(p_context,digest);
 select * into c from public.sales_team_beneficiary_payout_checks_v1 where id=p_check_id;
 if c.id is not null then
  if c.request_id<>p_request_id or c.payout_id<>p_payout_id or c.context is distinct from p_context then raise exception 'ORIGINAL_BENEFICIARY_CHECK_CHANGED';end if;
  -- Do not disclose or reuse another attempt's lease, including lost responses.
  return jsonb_build_object('status','consumed','bankConfirmed',false);
 end if;
 if exists(select 1 from public.sales_team_beneficiary_payout_checks_v1 active where active.request_id=p_request_id and active.expires_at>clock_timestamp()
  and not exists(select 1 from public.sales_team_beneficiary_payout_observations_v1 o where o.check_id=active.id))
 then return jsonb_build_object('status','busy','bankConfirmed',false);end if;
 if exists(select 1 from public.sales_team_beneficiary_payout_observations_v1 where request_id=p_request_id and (payout_id<>p_payout_id or context is distinct from p_context))
 then raise exception 'BENEFICIARY_PAYOUT_ASSOCIATION_CHANGED';end if;
 insert into public.sales_team_beneficiary_payout_checks_v1(id,request_id,payout_id,context,source_sha256,contract_sha256)
 values(p_check_id,p_request_id,p_payout_id,p_context,encode(sha256(convert_to(source::text,'UTF8')),'hex'),digest) returning * into c;
 return jsonb_build_object('status','admitted','checkId',c.id,'leaseToken',c.lease_token,'source',source,'bankConfirmed',false);
end $$;
create function creatornet_team_private.beneficiary_payout_balance_v1(b jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 perform creatornet_team_private.financial_shape_v1(b,'{"id":"string","sourceId":"string","amountCents":"number","feeCents":"number","netCents":"number","currency":"string","balanceType":"string","type":"string","reportingCategory":"string","created":"number","availableOn":"number","status":"string"}');
 if b->>'id'!~'^txn_[A-Za-z0-9]+$' or b->>'currency'<>'usd' or b->>'balanceType'<>'payments' or
  abs((b->>'amountCents')::bigint)>99999999 or (b->>'feeCents')::bigint not between 0 and 99999999 or abs((b->>'netCents')::bigint)>99999999 or
  (b->>'netCents')::bigint<>(b->>'amountCents')::bigint-(b->>'feeCents')::bigint or b->>'status' not in ('pending','available') or
  (b->>'created')::bigint not between 1 and extract(epoch from clock_timestamp())+5 or (b->>'availableOn')::bigint<=0 or
  b->>'type'!~'^[a-z_]{1,64}$' or b->>'reportingCategory'!~'^[a-z_]{1,64}$'
 then raise exception 'BENEFICIARY_BALANCE_REQUIRED';end if;
end $$;
create function public.complete_sales_team_beneficiary_payout_check_v1(p_check_id uuid,p_lease_token uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c public.sales_team_beneficiary_payout_checks_v1;source jsonb;q jsonb;t jsonb;old jsonb;req text;seen text[]:='{}';
 payout jsonb:=p_proof->'payout';credit jsonb:=p_proof->'credit';debit jsonb:=p_proof->'debit';returned jsonb:=p_proof->'returned';begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into c from public.sales_team_beneficiary_payout_checks_v1 where id=p_check_id;
 if c.id is null or c.lease_token is distinct from p_lease_token or c.context is distinct from p_context then raise exception 'CURRENT_BENEFICIARY_CHECK_REQUIRED';end if;
 select proof into old from public.sales_team_beneficiary_payout_observations_v1 where check_id=c.id;
 if old is not null then
  if old is distinct from p_proof then raise exception 'IMMUTABLE_BENEFICIARY_OBSERVATION_REQUIRED';end if;
  return jsonb_build_object('status','recorded','requestId',c.request_id,'checkId',c.id,'recorded',false,'bankConfirmed',false);
 end if;
 perform creatornet_team_private.beneficiary_payout_authority_v1(p_context,c.contract_sha256);
 if c.expires_at<=clock_timestamp() then raise exception 'CURRENT_BENEFICIARY_CHECK_REQUIRED';end if;
 source:=creatornet_team_private.beneficiary_payout_source_v1(c.request_id,p_context);q:=source->'request';t:=source->'completion'->'proof'->'transfer';
 if c.source_sha256<>encode(sha256(convert_to(source::text,'UTF8')),'hex') then raise exception 'BENEFICIARY_ORIGINAL_CHANGED';end if;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"version":"string","context":"object","requestId":"string","operationId":"string","receiptId":"string","saleId":"string","creatorId":"string","beneficiary":"string","beneficiaryUserId":"string","connectedAccountId":"string","transferId":"string","destinationPaymentId":"string","transferAmountCents":"number","payout":"object","credit":"object","debit":"object","returned":"object|null","memberCount":"number","membersSha256":"string","transferReadRequestIds":"array","transferBalanceReadRequestIds":"array","connectedReadRequestIds":"array","readStartedAt":"number","observedAt":"number","bankConfirmed":"boolean"}');
 if p_proof->>'version'<>'creatornet-beneficiary-payout-observation-v1' or p_proof->'context' is distinct from p_context or p_proof->'bankConfirmed'<>'false'::jsonb or
  p_proof->>'requestId'<>c.request_id::text or p_proof->>'operationId'<>q->>'operation_id' or p_proof->>'receiptId'<>q->>'receipt_id' or
  p_proof->>'saleId'<>q->>'sale_id' or p_proof->>'creatorId'<>q->>'creator_id' or p_proof->>'beneficiary'<>q->>'beneficiary' or
  p_proof->>'beneficiaryUserId'<>q->>'beneficiary_user_id' or p_proof->>'connectedAccountId'<>q->>'destination_id' or
  p_proof->>'transferId'<>t->>'id' or p_proof->>'destinationPaymentId'<>t->>'destinationPaymentId' or
  (p_proof->>'transferAmountCents')::bigint<>(q->>'amount_cents')::bigint or
  (p_proof->>'readStartedAt')::numeric not between greatest(extract(epoch from c.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-65000) and extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'observedAt')::numeric not between floor((p_proof->>'readStartedAt')::numeric/1000) and extract(epoch from clock_timestamp())+5 or
  (p_proof->>'memberCount')::bigint not between 1 and 300 or p_proof->>'membersSha256'!~'^[a-f0-9]{64}$'
 then raise exception 'FRESH_BENEFICIARY_PAYOUT_PROOF_REQUIRED';end if;
 perform creatornet_team_private.financial_shape_v1(payout,'{"id":"string","amountCents":"number","currency":"string","destinationId":"string","automatic":"boolean","method":"string","status":"string","created":"number","arrivalDate":"number","debitBalanceId":"string","returnBalanceId":"string|null","failureCode":"string|null"}');
 if payout->>'id'<>c.payout_id or payout->>'currency'<>'usd' or payout->>'destinationId'!~'^ba_[A-Za-z0-9]+$' or
  (payout->>'amountCents')::bigint not between 1 and 99999999 or payout->'automatic'<>'true'::jsonb or payout->>'method'<>'standard' or
  payout->>'status' not in ('pending','in_transit','paid','failed','canceled') or (payout->>'created')::bigint not between (t->>'created')::bigint-5 and extract(epoch from clock_timestamp())+5 or
  (payout->>'arrivalDate')::bigint<=0 or payout->>'debitBalanceId'!~'^txn_[A-Za-z0-9]+$' or
  (payout->'returnBalanceId'<>'null'::jsonb and payout->>'returnBalanceId'!~'^txn_[A-Za-z0-9]+$') or
  (payout->>'status' not in ('failed','canceled') and (payout->'returnBalanceId'<>'null'::jsonb or payout->'failureCode'<>'null'::jsonb))
 then raise exception 'ORIGINAL_AUTOMATIC_PAYOUT_REQUIRED';end if;
 perform creatornet_team_private.beneficiary_payout_balance_v1(credit);perform creatornet_team_private.beneficiary_payout_balance_v1(debit);
 if credit->>'sourceId'<>t->>'destinationPaymentId' or (credit->>'amountCents')::bigint<>(q->>'amount_cents')::bigint or
  (credit->>'netCents')::bigint<=0 or credit->>'status'<>'available' or (credit->>'availableOn')::bigint>extract(epoch from clock_timestamp()) or
  (credit->>'created')::bigint<(t->>'created')::bigint-5 or credit->>'id'=payout->>'debitBalanceId' or credit->>'id'=payout->>'returnBalanceId' or
  debit->>'id'<>payout->>'debitBalanceId' or debit->>'sourceId'<>c.payout_id or debit->>'type'<>'payout' or debit->>'reportingCategory'<>'payout' or
  (debit->>'amountCents')::bigint<>-(payout->>'amountCents')::bigint
 then raise exception 'ORIGINAL_PAYOUT_MEMBERSHIP_REQUIRED';end if;
 if (returned='null'::jsonb) is distinct from (payout->'returnBalanceId'='null'::jsonb) then raise exception 'EXACT_PAYOUT_RETURN_REQUIRED';end if;
 if returned<>'null'::jsonb then
  perform creatornet_team_private.beneficiary_payout_balance_v1(returned);
  if returned->>'id'<>payout->>'returnBalanceId' or returned->>'id'=debit->>'id' or returned->>'sourceId'<>c.payout_id or
   returned->>'type' not in ('payout_failure','payout_cancel') or (returned->>'amountCents')::bigint<>(payout->>'amountCents')::bigint
  then raise exception 'EXACT_PAYOUT_RETURN_REQUIRED';end if;
 end if;
 if jsonb_array_length(p_proof->'transferReadRequestIds')<>2 or jsonb_array_length(p_proof->'transferBalanceReadRequestIds')<>2 or
  jsonb_array_length(p_proof->'connectedReadRequestIds')-(case when returned='null'::jsonb then 0 else 1 end) not in (6,8,10)
 then raise exception 'DISTINCT_BENEFICIARY_READS_REQUIRED';end if;
 for req in select jsonb_array_elements_text((p_proof->'transferReadRequestIds')||(p_proof->'transferBalanceReadRequestIds')||(p_proof->'connectedReadRequestIds')) loop
  if req is null or req!~'^req_[A-Za-z0-9]+$' or req=any(seen) or req=source->'completion'->'proof'->>'originalRequestId' or
   (source->'completion'->'proof'->'transferReadRequestIds')?req or (source->'completion'->'proof'->'balanceReadRequestIds')?req or
   exists(select 1 from public.sales_team_beneficiary_payout_reads_v1 where provider_request_id=req)
  then raise exception 'DISTINCT_BENEFICIARY_READS_REQUIRED';end if;seen:=array_append(seen,req);
 end loop;
 if exists(select 1 from public.sales_team_beneficiary_payout_observations_v1 where request_id=c.request_id and
  (payout_id<>c.payout_id or destination_id<>payout->>'destinationId' or context is distinct from p_context))
 then raise exception 'BENEFICIARY_PAYOUT_ASSOCIATION_CHANGED';end if;
 insert into public.sales_team_beneficiary_payout_observations_v1(check_id,request_id,context,connected_account_id,payout_id,destination_id,proof)
 values(c.id,c.request_id,p_context,q->>'destination_id',c.payout_id,payout->>'destinationId',p_proof);
 insert into public.sales_team_beneficiary_payout_reads_v1(provider_request_id,check_id) select unnest(seen),c.id;
 perform creatornet_team_private.beneficiary_payout_authority_v1(p_context,c.contract_sha256);
 if c.expires_at<=clock_timestamp() then raise exception 'CURRENT_BENEFICIARY_CHECK_REQUIRED';end if;
 return jsonb_build_object('status','recorded','requestId',c.request_id,'checkId',c.id,'recorded',true,'bankConfirmed',false);
end $$;

do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_bank_observation_policy_v1','sales_team_beneficiary_payout_checks_v1','sales_team_beneficiary_payout_observations_v1','sales_team_beneficiary_payout_reads_v1'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);
  execute format('grant select on public.%I to service_role',name);
  if name<>'sales_team_bank_observation_policy_v1' then execute format('create trigger immutable_beneficiary_payout_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);end if;
 end loop;
 for sig in select oid::regprocedure from pg_proc where
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('bank_observation_contract_digest_v1','beneficiary_payout_source_v1','beneficiary_payout_authority_v1','beneficiary_payout_balance_v1')) or
  (pronamespace='public'::regnamespace and proname in ('begin_sales_team_beneficiary_payout_check_v1','complete_sales_team_beneficiary_payout_check_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',sig);
 end loop;
end $grants$;
-- Private helpers are callable only through the narrow definer entry points.
grant execute on function public.begin_sales_team_beneficiary_payout_check_v1(uuid,uuid,text,jsonb),
 public.complete_sales_team_beneficiary_payout_check_v1(uuid,uuid,jsonb,jsonb) to service_role;
commit;
