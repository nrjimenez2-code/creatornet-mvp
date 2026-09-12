-- UNAPPLIED. Approved manual review for a never-applied late activation.
-- Preserve payment dates, service periods and minimum commitment. No provider call.
begin;
create or replace function public.review_monthly_mentorship_late_activation_v1(p_id uuid,p_buyer_id uuid,p_context jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context or
    a.anchor_at is null or a.covered_months<1 or
    public.monthly_mentorship_boundary_v1(a.anchor_at,1)>extract(epoch from clock_timestamp())::bigint or
    exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='activate' and status='complete') then
    raise exception 'Late activation review identity or state differs'; end if;
  if a.billing_review_at is null then
    update public.monthly_mentorship_agreements_v1 set billing_review_at=clock_timestamp(),
      billing_review_reason='late_activation_unapplied',revision=revision+1 where id=a.id;
  end if;
  return true;
end;
$$;
revoke all on function public.review_monthly_mentorship_late_activation_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.review_monthly_mentorship_late_activation_v1(uuid,uuid,jsonb) to service_role;
commit;
