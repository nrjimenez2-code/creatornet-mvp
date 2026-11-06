begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Durable unpaid-purchase stop intent, not abandonment completion or debt waiver.
-- The same buyer/product lock serializes preparation, receipt and activation.
create table public.buyer_mentorship_abandonment_holds_v1 (
  reservation_id uuid primary key references public.buyer_mentorship_installment_reservations_v1(id),
  requested_at timestamptz not null default clock_timestamp()
);
alter table public.buyer_mentorship_abandonment_holds_v1 enable row level security;
revoke all on public.buyer_mentorship_abandonment_holds_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_abandonment_holds_v1 to service_role;

create function public.guard_buyer_mentorship_abandonment_hold_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=new.reservation_id;
  if not found or r.status<>'reserved' then raise exception 'Owned unpaid reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  if exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id) then
    raise exception 'Captured purchase requires payment reconciliation'; end if;
  if not exists(select 1 from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id and bound_at is not null) or
    (select count(*) from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and bound_at is not null)<>4 then
    raise exception 'Original preparation must be reconciled before stopping'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_abandonment_hold_v1 before insert on public.buyer_mentorship_abandonment_holds_v1
  for each row execute function public.guard_buyer_mentorship_abandonment_hold_v1();

create function public.request_buyer_mentorship_abandonment_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; h public.buyer_mentorship_abandonment_holds_v1%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh stop context required'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned unpaid reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  select * into h from public.buyer_mentorship_abandonment_holds_v1 where reservation_id=r.id;
  if not found then
    insert into public.buyer_mentorship_abandonment_holds_v1(reservation_id) values(r.id) returning * into h;
  end if;
  -- Replays preserve the original intent even if a late capture was accounted.
  -- They do not authorize cancellation or release; those require fresh proof.
  return to_jsonb(h);
end $$;

create function public.guard_buyer_mentorship_abandonment_dispatch_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=new.reservation_id;
  if not found then raise exception 'Owned dispatch reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  if exists(select 1 from public.buyer_mentorship_abandonment_holds_v1 where reservation_id=r.id) then
    raise exception 'Original purchase stop requires reconciliation'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_abandonment_dispatch_v1 before insert or update on public.buyer_mentorship_customer_operations_v1
  for each row execute function public.guard_buyer_mentorship_abandonment_dispatch_v1();
create trigger guard_buyer_mentorship_abandonment_dispatch_v1 before insert or update on public.buyer_mentorship_bootstrap_operations_v1
  for each row execute function public.guard_buyer_mentorship_abandonment_dispatch_v1();
create trigger guard_buyer_mentorship_abandonment_dispatch_v1 before insert or update on public.buyer_mentorship_activation_operations_v1
  for each row execute function public.guard_buyer_mentorship_abandonment_dispatch_v1();
-- First receipts intentionally remain recordable. A late captured payment must
-- still reach the existing once-only ledger, while activation stays stopped.
revoke all on function public.guard_buyer_mentorship_abandonment_hold_v1(),
  public.guard_buyer_mentorship_abandonment_dispatch_v1(),
  public.request_buyer_mentorship_abandonment_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.request_buyer_mentorship_abandonment_v1(uuid,uuid,jsonb) to service_role;
commit;
