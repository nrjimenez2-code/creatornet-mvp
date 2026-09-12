-- UNAPPLIED. A payable monthly Checkout may be published only after all
-- corresponding provider operation IDs have been saved in the same journal.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or to_regclass('public.monthly_mentorship_operations_v1') is null then
    raise exception 'Monthly publication prerequisites differ'; end if;
end;
$preflight$;
create function public.guard_monthly_provider_publication_v1() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if new.stripe_subscription_id is null then return new; end if;
  if not exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=new.id and kind='customer' and scope_key='initial' and status='complete' and provider_id=new.stripe_customer_id) or
    not exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=new.id and kind='subscription' and scope_key='initial' and status='complete' and provider_id=new.stripe_subscription_id) or
    not exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=new.id and kind='hold' and scope_key='initial' and status='complete' and provider_id=new.stripe_subscription_id) or
    not exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=new.id and kind='checkout' and scope_key='initial' and status='complete' and provider_id=new.stripe_checkout_session_id) then
    raise exception 'Monthly provider publication requires completed owned operations'; end if;
  return new;
end;
$$;
create trigger guard_monthly_provider_publication_v1 before update of stripe_customer_id,stripe_subscription_id,stripe_checkout_session_id
on public.monthly_mentorship_agreements_v1 for each row execute function public.guard_monthly_provider_publication_v1();
revoke all on function public.guard_monthly_provider_publication_v1() from public,anon,authenticated,service_role;
commit;
