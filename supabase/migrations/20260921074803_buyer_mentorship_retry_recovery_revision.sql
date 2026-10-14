begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- A recovery observation begun before replacement admission must not overwrite
-- its outcome afterward. Reuse the existing billing revision/snapshot checks;
-- every admission insert (including service-role writes) advances that basis.
create function public.invalidate_buyer_mentorship_retry_recovery_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  update public.buyer_mentorship_billing_state_v1 set revision=revision+1
    where reservation_id=new.reservation_id;
  if not found then raise exception 'Buyer retry billing state unavailable'; end if;
  return new;
end $$;
revoke all on function public.invalidate_buyer_mentorship_retry_recovery_v1() from public,anon,authenticated;
create trigger buyer_mentorship_retry_recovery_revision_v1
  after insert on public.buyer_mentorship_retry_admissions_v1
  for each row execute function public.invalidate_buyer_mentorship_retry_recovery_v1();
commit;
