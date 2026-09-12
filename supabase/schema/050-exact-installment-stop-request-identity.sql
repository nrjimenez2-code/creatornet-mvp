begin;
-- A stale tab/different administrator must not create a second cancellation
-- request for the same plan. Keep the original request and actor for recovery.
-- Existing conflicts fail the migration; do not delete evidence to install it.
create unique index exact_installment_one_cancellation_request
  on public.exact_installment_collection_holds(agreement_id)
  where reason='cancellation_review';
create or replace function public.hold_exact_installment_for_cancellation(p_agreement_id uuid,p_request_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.exact_installment_collection_holds%rowtype;
begin
  if p_request_id is null or p_actor_id is null or not exists(
    select 1 from public.profiles where id=p_actor_id and role='admin') then
    raise exception 'verified administrator required'; end if;
  perform 1 from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found then raise exception 'installment agreement missing'; end if;
  if exists(select 1 from public.exact_installment_collection_holds where agreement_id=p_agreement_id and
    reason='cancellation_review' and request_id<>p_request_id) then raise exception 'billing stop identity changed'; end if;
  insert into public.exact_installment_collection_holds(agreement_id,reason,request_id,requested_by)
    values(p_agreement_id,'cancellation_review',p_request_id,p_actor_id) on conflict(request_id) do nothing;
  select * into h from public.exact_installment_collection_holds where request_id=p_request_id;
  if not found or h.agreement_id is distinct from p_agreement_id or h.reason<>'cancellation_review' or
    h.requested_by is distinct from p_actor_id then raise exception 'collection hold request changed'; end if;
  return h.id;
end;
$$;
revoke all on function public.hold_exact_installment_for_cancellation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.hold_exact_installment_for_cancellation(uuid,uuid,uuid) to service_role;
commit;
