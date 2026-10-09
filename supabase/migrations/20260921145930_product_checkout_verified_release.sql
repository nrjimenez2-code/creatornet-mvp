begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Exact historical snapshots, never a replacement checkout engine. Active
-- coordination can be removed only in the same transaction as verified release.
create table public.product_checkout_releases_v1 (
 attempt_id uuid primary key references public.product_checkout_stop_proofs_v1(attempt_id),
 buyer_id uuid not null, product_id uuid not null, attempt_key uuid not null unique,
 context jsonb not null, original_attempt jsonb not null, original_order jsonb not null,
 original_purchases jsonb not null check(jsonb_typeof(original_purchases)='array'),
 released_at timestamptz not null default clock_timestamp(),
 check(original_attempt->>'id'=attempt_id::text and original_attempt->>'buyer_id'=buyer_id::text and
  original_attempt->>'product_id'=product_id::text and original_attempt->>'attempt_key'=attempt_key::text)
);
alter table public.product_checkout_releases_v1 enable row level security;
revoke all on public.product_checkout_releases_v1 from public,anon,authenticated,service_role;
grant select,insert on public.product_checkout_releases_v1 to service_role;

-- Immutable proof/operations remain linked by attempt ID after coordination
-- leaves the active table. Their creation guards still require an owned active
-- attempt; their roles cannot delete them or rewrite original identities.
do $$ declare c record; begin
 for c in select conrelid::regclass relation,conname from pg_constraint
  where conrelid in ('public.product_checkout_stop_proofs_v1'::regclass,'public.product_checkout_stop_operations_v1'::regclass)
    and contype='f' and confrelid='public.product_checkout_attempts'::regclass loop
  execute format('alter table %s drop constraint %I',c.relation,c.conname);
 end loop;
end $$;

create view public.product_checkout_records_v1 with(security_invoker=true) as
 select a.* from public.product_checkout_attempts a
 union all select (jsonb_populate_record(null::public.product_checkout_attempts,h.original_attempt)).*
 from public.product_checkout_releases_v1 h;
revoke all on public.product_checkout_records_v1 from public,anon,authenticated,service_role;
grant select on public.product_checkout_records_v1 to service_role;

-- Serialize insertion with release so a delayed original pending-write cannot
-- recreate the purchase after its archived unpaid row was removed. Paid event
-- accounting keeps access to original records and is never silently discarded.
create function public.guard_released_product_purchase_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if new.buyer_id is not null and new.product_id is not null and new.session_id is not null then
  if tg_op='INSERT' then perform pg_advisory_xact_lock(hashtextextended(new.buyer_id::text||':'||new.product_id::text,72913)); end if;
  if coalesce(new.status,'')<>'paid' and exists(select 1 from public.product_checkout_releases_v1 h where
    h.buyer_id=new.buyer_id and h.original_attempt->>'stripe_checkout_session_id'=new.session_id) then
   raise exception 'Released checkout cannot recreate an unpaid purchase'; end if;
 end if;
 return new;
end $$;
create trigger guard_released_product_purchase_v1 before insert or update on public.purchases
 for each row execute function public.guard_released_product_purchase_v1();
revoke all on function public.guard_released_product_purchase_v1() from public,anon,authenticated;

-- Preserve late one-time service accounting using the same original attempt
-- fields, including consent and order binding, after active mode release.
do $$ declare signature text; definition text; begin
 foreach signature in array array['public.attach_fixed_service_consent_v1()',
  'public.bind_fixed_service_one_time_v1(uuid,uuid,uuid,text,text,bigint,bigint,text)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if strpos(definition,'from public.product_checkout_attempts attempt')=0 then
   raise exception 'Original one-time service binding requires review'; end if;
  execute replace(definition,'from public.product_checkout_attempts attempt','from public.product_checkout_records_v1 attempt');
 end loop;
end $$;

-- Existing immutable-request guard remains intact, with one narrowly verified
-- deletion exception. Snapshots must match the full current original row.
do $$ declare definition text; needle text; begin
 definition:=pg_get_functiondef('public.guard_product_checkout_original_request_v1()'::regprocedure);
 needle:='if old.original_request_protocol is not null then raise exception ''Original checkout requires durable release proof''; end if;';
 if strpos(definition,needle)=0 then raise exception 'Original checkout deletion guard requires review'; end if;
 execute replace(definition,needle,'if old.original_request_protocol is not null and not exists(select 1 from public.product_checkout_releases_v1 h where h.attempt_id=old.id and h.original_attempt=to_jsonb(old)) then raise exception ''Original checkout requires durable release proof''; end if;');
end $$;

create function public.release_product_checkout_stop_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.product_checkout_attempts%rowtype; h public.product_checkout_releases_v1%rowtype;
 o public.orders%rowtype; p public.purchases%rowtype; snapshots jsonb:='[]'::jsonb; saved jsonb;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh checkout release context required'; end if;
 select * into h from public.product_checkout_releases_v1 where attempt_id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key;
 if found then
  if h.context is distinct from p_context then raise exception 'Original release context differs'; end if;
  return jsonb_build_object('attempt_id',h.attempt_id,'product_id',h.product_id,'released_at',h.released_at);
 end if;
 select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key;
 if not found then raise exception 'Owned original release unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.buyer_id::text||':'||a.product_id::text,72913));
 -- A simultaneous lost-response retry can observe the committed archive here.
 select * into h from public.product_checkout_releases_v1 where attempt_id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key;
 if found then
  if h.context is distinct from p_context then raise exception 'Original release context differs'; end if;
  return jsonb_build_object('attempt_id',h.attempt_id,'product_id',h.product_id,'released_at',h.released_at);
 end if;
 select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key for update;
 if not found then raise exception 'Original release changed'; end if;
 saved:=public.record_product_checkout_stop_proof_v1(p_attempt_id,p_buyer_id,p_attempt_key,p_context,p_proof);
 select * into o from public.orders where id=a.order_id for update;
 if not found or o.buyer_id is distinct from a.buyer_id or o.creator_id is distinct from a.creator_id or
  o.post_id is distinct from a.post_id or coalesce(o.status,'') not in ('created','canceled') or
  o.amount_cents is distinct from (a.original_request#>>'{params,line_items,0,price_data,unit_amount}')::bigint or
  o.currency is distinct from 'usd' or
  (o.stripe_checkout_session_id is not null and o.stripe_checkout_session_id<>a.stripe_checkout_session_id) or
  (o.stripe_payment_intent_id is not null and o.stripe_payment_intent_id is distinct from p_proof#>>'{paymentIntent,id}') then
  raise exception 'Original order requires reconciliation'; end if;
 -- Any recorded accounting/refund work, including incomplete work, closes the
 -- release path. Never null out ledger/refund foreign keys by deleting a row.
 if exists(select 1 from public.payment_fee_ledger where order_id=a.order_id) or
  exists(select 1 from public.refund_operations where order_id=a.order_id) then raise exception 'Original order has financial operations'; end if;
 for p in select * from public.purchases where buyer_id=a.buyer_id and
  (product_id=a.product_id or (a.post_id is not null and post_id=a.post_id)) for update loop
  if p.session_id is distinct from a.stripe_checkout_session_id or p.order_id is distinct from a.order_id or
   p.product_id is distinct from a.product_id or p.post_id is distinct from a.post_id or p.creator_id is distinct from a.creator_id or
   p.amount_cents is distinct from o.amount_cents or p.currency is distinct from 'usd' or p.subscription_id is not null or
   coalesce(p.status,'') not in ('pending','processing','failed','canceled') or p.access_granted is true or
   p.earnings_credited_at is not null or p.is_refund is true or p.is_suspect is true or
   (p.payment_intent_id is not null and p.payment_intent_id is distinct from p_proof#>>'{paymentIntent,id}') or
   exists(select 1 from public.payment_fee_ledger where purchase_id=p.id) or
   exists(select 1 from public.refund_operations where purchase_id=p.id) then raise exception 'Original purchase requires reconciliation'; end if;
  snapshots:=snapshots||jsonb_build_array(to_jsonb(p));
 end loop;
 insert into public.product_checkout_releases_v1(attempt_id,buyer_id,product_id,attempt_key,context,original_attempt,original_order,original_purchases)
  values(a.id,a.buyer_id,a.product_id,a.attempt_key,p_context,to_jsonb(a),to_jsonb(o),snapshots) returning * into h;
 update public.orders set status='canceled' where id=o.id;
 delete from public.purchases where id in(select (value->>'id')::uuid from jsonb_array_elements(snapshots));
 delete from public.product_checkout_attempts where id=a.id;
 return jsonb_build_object('attempt_id',h.attempt_id,'product_id',h.product_id,'released_at',h.released_at);
end $$;
revoke all on function public.release_product_checkout_stop_v1(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.release_product_checkout_stop_v1(uuid,uuid,uuid,jsonb,jsonb) to service_role;
commit;
