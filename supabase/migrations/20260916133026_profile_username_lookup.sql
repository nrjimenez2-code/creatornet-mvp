-- Profile routes use exact username equality. The existing unique index on
-- lower(username) preserves case-insensitive uniqueness but cannot serve that
-- predicate. Add its lookup index without changing matching, rows or access.
begin;
set local lock_timeout = '1s';
set local statement_timeout = '10s';

create index profiles_username_lookup_idx
  on public.profiles using btree (username);

commit;
