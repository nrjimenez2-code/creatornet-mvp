-- Add a reversible presentation choice without changing any release flags or product rows.
begin;
alter table public.website_release_settings_v1
  add column public_page text not null default 'coming-soon'
  constraint website_public_page_valid check (public_page in ('blank','coming-soon'));

create function public.set_website_public_page_v1(p_actor uuid, p_revision bigint, p_public_page text) returns void
language plpgsql security invoker set search_path = '' as $$
declare previous public.website_release_settings_v1;
begin
  select * into strict previous from public.website_release_settings_v1
    where id='00000000-0000-4000-8000-000000000001' for update;
  if p_actor is null or p_actor is distinct from previous.owner_id
    or not website_release_private.verified_account_v1(p_actor) then raise exception 'Release owner required'; end if;
  if p_revision is null or p_revision <> previous.revision then raise exception 'Release settings changed; reload'; end if;
  if p_public_page is null or p_public_page not in ('blank','coming-soon') then raise exception 'Invalid public page'; end if;
  update public.website_release_settings_v1 set public_page=p_public_page,revision=revision+1,updated_at=now() where id=previous.id;
  insert into public.admin_actions(actor_id,action,target_table,target_id,reason)
    values(p_actor,'website_public_page_update','website_release_settings_v1',previous.id,
      jsonb_build_object('before',jsonb_build_object('public_page',previous.public_page,'revision',previous.revision),
        'after',jsonb_build_object('public_page',p_public_page,'revision',p_revision+1))::text);
end;
$$;
revoke all on function public.set_website_public_page_v1(uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.set_website_public_page_v1(uuid,bigint,text) to service_role;
commit;
