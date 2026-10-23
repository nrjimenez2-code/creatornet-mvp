-- Preserve booking payment identities when a creator deletes a booking.
-- This is a constraint-only change: it never deletes or rewrites business rows.
-- Review and apply separately from the application deployment. Do not blanket-push.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Fail closed if this is not the reviewed legacy relationship. In particular,
-- do not silently replace another table/column, update action or deferred FK.
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_attribute child on child.attrelid = c.conrelid and c.conkey = array[child.attnum]
    join pg_attribute parent on parent.attrelid = c.confrelid and c.confkey = array[parent.attnum]
    where c.conname = 'booking_payments_booking_id_fkey'
      and c.conrelid = 'public.booking_payments'::regclass
      and c.confrelid = 'public.bookings'::regclass
      and c.contype = 'f' and child.attname = 'booking_id' and parent.attname = 'id'
      and c.confdeltype = 'c' and c.confupdtype = 'a' and c.confmatchtype = 's'
      and not c.condeferrable and not c.condeferred and c.convalidated
  ) then
    raise exception 'Booking payment foreign key differs from the reviewed CASCADE relationship';
  end if;
end $$;

-- One atomic ALTER removes CASCADE and installs RESTRICT with no unguarded
-- write window. PostgreSQL's FK locks serialize concurrent payment insertion
-- against booking deletion; the route's early check is only user feedback.
alter table public.booking_payments
  drop constraint booking_payments_booking_id_fkey,
  add constraint booking_payments_booking_id_fkey
    foreign key (booking_id) references public.bookings(id)
    match simple on update no action on delete restrict not deferrable;
commit;
