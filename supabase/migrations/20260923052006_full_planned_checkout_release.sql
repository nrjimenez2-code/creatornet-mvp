begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.full_manual_checkout_requests_v1 add column released_at timestamptz;

-- Release only the pre-reservation request. Presence of any preparation artifact
-- is uncertainty, never proof that a provider request was not dispatched.
create function public.release_unreserved_full_checkout_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.full_manual_checkout_requests_v1%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' or
    not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Fresh original checkout context required'; end if;
  select * into r from public.full_manual_checkout_requests_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context;
  if not found then raise exception 'Owned original checkout request required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  select * into r from public.full_manual_checkout_requests_v1 where request_id=p_request_id for update;
  if r.released_at is not null then return to_jsonb(r); end if;
  if exists(select 1 from public.server_payment_protocols_v1 where attempt_id=r.attempt_id) or
    exists(select 1 from public.product_checkout_attempts where id=r.attempt_id or (buyer_id=r.buyer_id and product_id=r.product_id)) or
    exists(select 1 from public.full_server_payment_sources_v1 where attempt_id=r.attempt_id) or
    exists(select 1 from public.server_payment_intent_operations_v1 where attempt_id=r.attempt_id) or
    exists(select 1 from public.server_payment_stops_v1 where attempt_id=r.attempt_id) or
    exists(select 1 from public.full_server_payment_receipts_v1 where attempt_id=r.attempt_id) or
    exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=r.attempt_id) or
    exists(select 1 from public.orders where id=r.order_id) or
    exists(select 1 from public.purchases where buyer_id=r.buyer_id and (product_id=r.product_id or post_id=r.post_id)) then
    return null;
  end if;
  update public.full_manual_checkout_requests_v1 set released_at=clock_timestamp() where request_id=r.request_id returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.release_unreserved_full_checkout_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.release_unreserved_full_checkout_v1(uuid,uuid,jsonb) to service_role;

-- Both entrances take the same buyer/product lock as release. A stale worker
-- cannot pin or insert the released attempt after observing an earlier snapshot.
create function public.guard_released_full_request_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare original_id uuid;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh full request admission required'; end if;
  if tg_table_name='server_payment_protocols_v1' then original_id:=new.attempt_id; else original_id:=new.id; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.buyer_id::text||':'||new.product_id::text,72913));
  if exists(select 1 from public.full_manual_checkout_requests_v1 where attempt_id=original_id and released_at is not null) then
    raise exception 'Released full checkout cannot be revived'; end if;
  return new;
end $$;
revoke all on function public.guard_released_full_request_v1() from public,anon,authenticated;
create trigger guard_released_full_request_v1 before insert on public.server_payment_protocols_v1
  for each row execute function public.guard_released_full_request_v1();
create trigger guard_released_full_request_v1 before insert on public.product_checkout_attempts
  for each row execute function public.guard_released_full_request_v1();

do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.plan_full_manual_checkout_v1(uuid,uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
  needle:='r.buyer_id=p_buyer_id and r.product_id=p_product_id and';
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Original request exclusivity differs'; end if;
  execute replace(source,needle,needle||' r.released_at is null and');
end $patch$;
commit;
