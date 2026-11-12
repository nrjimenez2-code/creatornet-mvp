-- Unapplied. Recovery can admit only an already recorded operation, never the
-- next missing preparation step. No release, publication or payment authority.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create function public.recover_buyer_mentorship_preparation_v1(
  p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_step text,p_request jsonb default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned preparation reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  perform 1 from public.buyer_mentorship_installment_reservations_v1
    where id=r.id and request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Preparation reservation changed'; end if;
  if exists(select 1 from public.buyer_mentorship_abandonment_holds_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id) then
    raise exception 'Preparation recovery is no longer admissible'; end if;
  if p_step='customer.create' and p_request is null then
    perform 1 from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id for update;
    if not found then return jsonb_build_object('status','partial_preparation'); end if;
    return public.claim_buyer_mentorship_customer_v1(p_request_id,p_buyer_id,p_context);
  elsif p_step='bootstrap.begin' and p_request is null then
    perform 1 from public.buyer_mentorship_bootstraps_v1 where reservation_id=r.id;
    if not found then return jsonb_build_object('status','partial_preparation'); end if;
    return public.begin_buyer_mentorship_bootstrap_v1(p_request_id,p_buyer_id,p_context);
  elsif p_step in ('product.create','subscription.create','subscription.hold','checkout.create') and p_request is not null then
    perform 1 from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step=p_step for update;
    if not found then return jsonb_build_object('status','partial_preparation'); end if;
    return public.claim_buyer_mentorship_bootstrap_v1(p_request_id,p_buyer_id,p_context,p_step,p_request);
  end if;
  raise exception 'Invalid preparation recovery step';
end $$;
revoke all on function public.recover_buyer_mentorship_preparation_v1(uuid,uuid,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.recover_buyer_mentorship_preparation_v1(uuid,uuid,jsonb,text,jsonb) to service_role;
commit;
