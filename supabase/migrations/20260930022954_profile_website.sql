begin;

-- Abort on drift rather than broadening or repairing unrelated profile permissions.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass) then
    raise exception 'profiles RLS must be enabled before the website migration';
  end if;
  if has_column_privilege('anon', 'public.profiles', 'bio', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'stripe_account_id', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'total_earnings_cents', 'UPDATE') then
    raise exception 'profiles grants must match the existing protected-column baseline (schema 009)';
  end if;
end $$;

alter table public.profiles add column website_url text null
  constraint profiles_website_url_check check (
    website_url is null or (
      char_length(website_url) <= 2048
      and website_url ~ '^https?://[^/@[:space:]]+([/?#]|$)'
      and website_url !~ '[[:space:][:cntrl:]]'
      and position(chr(92) in website_url) = 0
    )
  );

-- Owner-only UPDATE/SELECT policies already apply to the new column.
-- Do not grant table writes, INSERT, or writes to protected columns.
grant update (website_url) on public.profiles to authenticated;
commit;
