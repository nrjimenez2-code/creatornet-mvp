begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create index full_manual_checkout_owner_product_v1 on public.full_manual_checkout_requests_v1(buyer_id,product_id);

-- Read-only discovery for lost device state. Never select a latest row or use a
-- current catalog quote as a substitute for the original saved acceptance.
create function public.find_full_manual_checkout_v1(p_buyer_id uuid,p_product_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare candidates jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_buyer_id is null or p_product_id is null or
    not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Owned current request discovery required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||p_product_id::text,72913));
  select jsonb_agg(to_jsonb(r)) into candidates from public.full_manual_checkout_requests_v1 r
    where r.buyer_id=p_buyer_id and r.product_id=p_product_id and r.context=p_context and r.released_at is null and
      not exists(select 1 from public.product_checkout_releases_v1 h where h.attempt_id=r.attempt_id and
        h.buyer_id=r.buyer_id and h.product_id=r.product_id and h.attempt_key=r.attempt_key and h.context=r.context);
  if jsonb_array_length(candidates)>1 then raise exception 'Multiple original requests require review'; end if;
  return candidates->0;
end $$;
revoke all on function public.find_full_manual_checkout_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.find_full_manual_checkout_v1(uuid,uuid,jsonb) to service_role;
commit;
