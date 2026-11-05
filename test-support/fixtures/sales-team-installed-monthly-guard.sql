CREATE OR REPLACE FUNCTION public.guard_monthly_mentorship_purchase_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare a public.monthly_mentorship_agreements_v1%rowtype;
begin
  if tg_op='UPDATE' and old.monthly_mentorship_id is not null and new.monthly_mentorship_id is distinct from old.monthly_mentorship_id then
    raise exception 'Monthly purchase identity cannot be replaced'; end if;
  if new.monthly_mentorship_id is null then
    if exists(select 1 from public.products where id=new.product_id and membership_terms is not null) then
      raise exception 'Monthly offer requires its owned membership purchase'; end if;
    return new;
  end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=new.monthly_mentorship_id;
  if not found or a.purchase_id is distinct from new.id or a.buyer_id is distinct from new.buyer_id or
    a.creator_id is distinct from new.creator_id or a.product_id is distinct from new.product_id or a.post_id is distinct from new.post_id or
    new.kind is distinct from 'monthly_mentorship_v1' or new.access_granted is distinct from false or
    new.earnings_credited_at is not null or coalesce(new.paid_count,0)<>0 or new.target_months is not null or
    new.subscription_id is distinct from a.stripe_subscription_id then
    raise exception 'Monthly service cannot use legacy ownership, entitlement, or installment credit'; end if;
  return new;
end;
$function$
