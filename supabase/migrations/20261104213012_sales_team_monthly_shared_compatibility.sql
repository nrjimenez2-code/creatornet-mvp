-- Local candidate. Preserves the installed legacy monthly guard body/ACL.
-- Disabled policy admits no new monthly provider dispatch or compatibility
-- exception. No historical adoption, fake legacy agreement or activation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ declare guard oid:='public.guard_monthly_mentorship_purchase_v1()'::regprocedure;begin
 perform 'public.sales_team_operation_admitted_v1(jsonb,jsonb)'::regprocedure;
 perform 'creatornet_team_private.guard_team_shared_rows_v1()'::regprocedure;
 if (select encode(sha256(convert_to(pg_get_functiondef(guard),'UTF8')),'hex'))<>'6959384c7561421c0af7b2314a74518784440f1621cf19bf5282eddad4293770'
  or not (select prosecdef and proconfig=array['search_path=pg_catalog'] from pg_proc where oid=guard)
  or has_function_privilege('anon',guard,'EXECUTE') or has_function_privilege('authenticated',guard,'EXECUTE')
  or has_function_privilege('service_role',guard,'EXECUTE')
  or not exists(select 1 from pg_trigger where tgrelid='public.purchases'::regclass and tgname='guard_monthly_mentorship_purchase_v1'
   and tgfoid=guard and tgtype=23 and tgenabled='O' and tgqual is null and tgnargs=0 and not tgisinternal and tgconstraint=0
   and tgoldtable is null and tgnewtable is null)
 then raise exception 'TEAM_MONTHLY_SHARED_LEGACY_GUARD_DIFFERS';end if;
end $parents$;
create table public.sales_team_monthly_shared_policy_v1 (
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 contract_sha256 text check(contract_sha256~'^[a-f0-9]{64}$')
);
insert into public.sales_team_monthly_shared_policy_v1(singleton) values(true);

create function creatornet_team_private.team_monthly_shared_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(coalesce(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\n' order by p.oid::regprocedure::text collate "C"),'')||':'||
  coalesce((select string_agg(pg_get_triggerdef(t.oid)||':'||t.tgenabled::text,E'\n' order by t.tgname collate "C") from pg_trigger t
   where t.tgrelid='public.purchases'::regclass and t.tgname in ('guard_monthly_mentorship_purchase_v1','sales_team_purchase_guard_v1','zz_team_monthly_shared_fence_v1')),'')||':'||
  creatornet_team_private.transfer_contract_digest_v1(),'UTF8')),'hex')
 from pg_proc p where (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in
 ('team_monthly_shared_contract_digest_v1','team_monthly_shared_ready_v1','team_monthly_shared_purchase_v1','team_monthly_shared_postwrite_v1','guard_team_shared_rows_v1')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('guard_monthly_mentorship_purchase_v1','fulfill_sales_team_receipt_v1',
 'sync_sales_team_shared_accounting_v1','sales_team_operation_admitted_v1','sales_team_operation_before_monthly_shared_v1'))
$$;
create function creatornet_team_private.team_monthly_shared_ready_v1()
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_monthly_shared_policy_v1 where singleton and enabled
  and contract_sha256=creatornet_team_private.team_monthly_shared_contract_digest_v1())
  and encode(sha256(convert_to(pg_get_functiondef('public.guard_monthly_mentorship_purchase_v1()'::regprocedure),'UTF8')),'hex')=
   '6959384c7561421c0af7b2314a74518784440f1621cf19bf5282eddad4293770'
$$;
create function creatornet_team_private.team_monthly_shared_purchase_v1(p_row jsonb)
returns boolean language sql stable security definer set search_path=pg_catalog as $$
 select current_setting('transaction_isolation')='read committed' and creatornet_team_private.team_monthly_shared_ready_v1() and exists(
  select 1 from public.sales_team_sale_agreements_v1 a
  join public.sales_team_purchase_bindings_v1 b on b.sale_id=a.id
  join public.sales_team_payment_obligations_v1 o on o.sale_id=a.id and o.period_number=1
  join public.sales_team_receipts_v1 r on r.sale_id=a.id and r.obligation_id=o.id
  join public.sales_team_capture_provenance_v1 proof on proof.receipt_id=r.id and proof.obligation_id=o.id
  join public.orders ord on ord.id=b.order_id and ord.sales_team_sale_id=a.id and ord.sales_team_receipt_id=r.id
  where a.id::text=p_row->>'sales_team_sale_id' and a.terms->>'paymentKind'='monthly'
   and a.protocol='creatornet-team-distribution-v1' and a.accepted_at is not null
   and p_row->>'monthly_mentorship_id' is null and p_row->>'subscription_id' is null
   and p_row->>'kind'='creatornet_team_v1' and p_row->>'currency'='usd'
   and p_row->'access_granted'='false'::jsonb
   and p_row->>'id'=b.purchase_id::text and p_row->>'order_id'=b.order_id::text
   and p_row->>'buyer_id'=a.buyer_id::text and p_row->>'buyer_user_id'=a.buyer_id::text
   and p_row->>'creator_id'=a.creator_id::text and p_row->>'product_id'=b.product_id::text
   and p_row->>'post_id'=a.terms->>'postId' and p_row->>'booking_id'=a.booking_id::text
   and p_row->>'payment_intent_id'=r.payment_intent_id and p_row->>'amount_cents'=a.terms->>'amountCents'
 )
$$;
create function creatornet_team_private.team_monthly_shared_postwrite_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
 if exists(select 1 from public.sales_team_sale_agreements_v1 where id=new.sales_team_sale_id and terms->>'paymentKind'='monthly')
  and not creatornet_team_private.team_monthly_shared_purchase_v1(to_jsonb(new))
 then raise exception 'TEAM_MONTHLY_SHARED_AUTHORITY_REQUIRED';end if;
 return new;
end $$;
-- WHEN qualifies a verified team original, never a label alone. Every other row
-- still executes the exact retained legacy guard. F11's service/immutable shared
-- row guard remains enabled and is part of the new contract.
create or replace trigger guard_monthly_mentorship_purchase_v1 before insert or update on public.purchases
 for each row when (not creatornet_team_private.team_monthly_shared_purchase_v1(to_jsonb(new)))
 execute function public.guard_monthly_mentorship_purchase_v1();
create trigger zz_team_monthly_shared_fence_v1 after insert or update on public.purchases
 for each row execute function creatornet_team_private.team_monthly_shared_postwrite_v1();

alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_before_monthly_shared_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select public.sales_team_operation_before_monthly_shared_v1(p_scope,p_context) and
  (not (p_scope->>'kind' in ('customer','intent','confirmation','setup') and exists(select 1 from public.sales_team_sale_agreements_v1
    where id=(p_scope->>'saleId')::uuid and terms->>'paymentKind'='monthly')) or
   current_setting('transaction_isolation')='read committed' and creatornet_team_private.team_monthly_shared_ready_v1())
$$;
-- Existing journal claim and final pre-POST assertion both call this owner.
-- Cancellations, refunds, recovery and bound/uncertain original reconciliation
-- retain their existing paths. No provider request or financial history changes.
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''team_monthly_shared_contract_digest_v1'',''team_monthly_shared_ready_v1'',''team_monthly_shared_purchase_v1'',''team_monthly_shared_postwrite_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname=''sales_team_operation_before_monthly_shared_v1'')';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()',
  'creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1
  then raise exception 'TEAM_MONTHLY_SHARED_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
alter table public.sales_team_monthly_shared_policy_v1 enable row level security;
revoke all on public.sales_team_monthly_shared_policy_v1 from public,anon,authenticated,service_role;
grant select on public.sales_team_monthly_shared_policy_v1 to service_role;
revoke all on function creatornet_team_private.team_monthly_shared_contract_digest_v1(),creatornet_team_private.team_monthly_shared_ready_v1(),
 creatornet_team_private.team_monthly_shared_purchase_v1(jsonb),creatornet_team_private.team_monthly_shared_postwrite_v1() from public,anon,authenticated,service_role;
grant execute on function creatornet_team_private.team_monthly_shared_contract_digest_v1(),creatornet_team_private.team_monthly_shared_ready_v1(),
 creatornet_team_private.team_monthly_shared_purchase_v1(jsonb) to service_role;
revoke all on function public.sales_team_operation_admitted_v1(jsonb,jsonb),public.sales_team_operation_before_monthly_shared_v1(jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.sales_team_operation_admitted_v1(jsonb,jsonb),public.sales_team_operation_before_monthly_shared_v1(jsonb,jsonb) to service_role;
commit;
