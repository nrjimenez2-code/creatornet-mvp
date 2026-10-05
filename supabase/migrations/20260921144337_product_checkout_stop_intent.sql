begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- A permanent stop intent is not terminal unpaid proof or release authority.
-- Keep the original row/request/key/session until a separate verified release.
alter table public.product_checkout_attempts add column original_stop_requested_at timestamptz;

create function public.guard_product_checkout_stop_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' then
  if new.original_stop_requested_at is not null then raise exception 'Stop requires an existing original checkout'; end if;
  return new;
 end if;
 if old.original_stop_requested_at is not null then
  if new.original_stop_requested_at is distinct from old.original_stop_requested_at then raise exception 'Original stop intent is immutable'; end if;
  if new.original_request_lease_token is distinct from old.original_request_lease_token or
    new.original_request_lease_until is distinct from old.original_request_lease_until or
    new.original_request is distinct from old.original_request then raise exception 'Stopped checkout cannot dispatch'; end if;
 elsif new.original_stop_requested_at is not null then
  if old.original_request_protocol is distinct from 'product-checkout-original-v1' or old.checkout_kind is distinct from 'full' or
    old.original_request is null or old.original_request_context is null or old.stripe_checkout_session_id is null or
    old.status is distinct from 'open' or old.original_request_lease_until>clock_timestamp() or
    new.original_stop_requested_at<clock_timestamp()-interval '5 seconds' or new.original_stop_requested_at>clock_timestamp() then
   raise exception 'Original checkout is not ready for stop intent'; end if;
 end if;
 return new;
end $$;
create trigger guard_product_checkout_stop_v1 before insert or update on public.product_checkout_attempts
 for each row execute function public.guard_product_checkout_stop_v1();

create function public.request_product_checkout_stop_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.product_checkout_attempts%rowtype;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh checkout stop context required'; end if;
 select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key;
 if not found then raise exception 'Owned original checkout unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.buyer_id::text||':'||a.product_id::text,72913));
 select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key for update;
 if not found or a.original_request_protocol is distinct from 'product-checkout-original-v1' or a.checkout_kind is distinct from 'full' or
   a.original_request is null or a.original_request_context is distinct from p_context or p_context is null then
  raise exception 'Original stop context unavailable'; end if;
 if a.original_stop_requested_at is null then
  update public.product_checkout_attempts set original_stop_requested_at=clock_timestamp() where id=a.id returning * into a;
 end if;
 return jsonb_build_object('attempt_id',a.id,'requested_at',a.original_stop_requested_at,'release_allowed',false);
end $$;
revoke all on function public.guard_product_checkout_stop_v1(),public.request_product_checkout_stop_v1(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.request_product_checkout_stop_v1(uuid,uuid,uuid,jsonb) to service_role;

-- Maintain pre-column installment archives unchanged. Both schema generations
-- remain verifiable only when the new full-payment-only marker is null.
do $$ declare definition text; needle text; replacement text; begin
 definition:=pg_get_functiondef('public.guard_buyer_installment_checkout_v1()'::regprocedure);
 needle:='h.original_attempt=to_jsonb(old) or (old.original_request_protocol is null and old.original_request is null and h.original_attempt=to_jsonb(old)-''original_request_protocol''-''original_request''-''original_request_context''-''original_request_started_at''-''original_request_lease_token''-''original_request_lease_until'')';
 replacement:='h.original_attempt=to_jsonb(old) or (old.original_stop_requested_at is null and (h.original_attempt=to_jsonb(old)-''original_stop_requested_at'' or (old.original_request_protocol is null and old.original_request is null and h.original_attempt=to_jsonb(old)-''original_stop_requested_at''-''original_request_protocol''-''original_request''-''original_request_context''-''original_request_started_at''-''original_request_lease_token''-''original_request_lease_until'')))';
 if strpos(definition,needle)=0 then raise exception 'Prior installment archive guard requires review'; end if;
 execute replace(definition,needle,replacement);
end $$;
commit;
