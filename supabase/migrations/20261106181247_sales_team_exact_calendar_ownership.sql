-- Local apply-once candidate. Exact team appointment ownership over the existing
-- native calendar/capacity owner; no provider, financial or feature activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Filled from the source-built predecessor inventory, then checked unchanged on
-- native PostgreSQL too. Unknown installed contracts stop; never normalize them.
do $parents$
declare expected jsonb:='{"begin_google_booking_mutation_v1(uuid,uuid)":"a02ea20e2dbc43f5b96b31859c0f2571b096b26f43e28a6f7673b3dd308e49c6","claim_google_booking_job_v1(uuid)":"314229c412063880862531a6ed14168b2a023175e62cb8120abb473861ecff66","complete_google_booking_job_v1(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone)":"37c4f93bae6b4178efcd4a70ede3eba6dabb2ddb4a3f5e6aaac66ce93be3347f","configure_google_calendar_v1(uuid,uuid,uuid,text,text[],jsonb,text,uuid)":"521176b33f22f014143b9c3683a8ab5471c94492bb2a5c1830465369cbf44d74","enqueue_google_booking_create_v1(uuid,uuid)":"88bd615618e80cec28b2534e6547902b941c59bb85f841fd9a122ba72f0afedb","fail_unattempted_google_booking_v1(uuid,uuid,text)":"2e057543eed204f61f1e4304814d179e92a5dff1cb43b0d9124bb4ad420fa707","google_reserved_intervals_v1(uuid,timestamp with time zone,timestamp with time zone,uuid)":"9a38b4fe22d2b0d72880509422062ceb19afe1c3ea6e942654d86ad2248379d6","reconcile_google_calendar_booking_v1(uuid,uuid,uuid,bigint,text,text,timestamp with time zone,timestamp with time zone,boolean)":"3c490b1d982a32b4bf596d33579f3df3acc74be387a1b0b550ac9e7e7dbab172","recover_google_reschedule_v1(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,boolean)":"c4f4432f5504cfa00c29756d482532f942ad33fe6eec4bbdfbd0048773dabf6c","request_google_booking_change_v1(uuid,uuid,bigint,text,timestamp with time zone,timestamp with time zone)":"04ea978f30bdef1f9d9deb2b9317ec72609481050d20452b393a978f2015c54d","reschedule_google_booking_checked_v1(uuid,uuid,bigint,timestamp with time zone,timestamp with time zone,jsonb)":"02ad6628926f86c270404d13aa72699daa2791a73496a3efdec49241f7077084","reserve_google_booking_checked_v1(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid,uuid,text,jsonb)":"32a51e437296fcfa00425ebedd4731a2b2d19ead4627a54aa857d86b62c534d6","reserve_google_booking_v1(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid,uuid)":"a86f70dc9e9f88c7a32a86906206ed04c6355cdc2a375e29fb4adcac52d6df48","validate_google_booking_attribution_v1()":"6ebc264ae1ffe1bc31e191b733fd9884efc1677a936861e860716f07fe09d892"}'; signature text; digest text; routine oid; actual_digest text;
-- Exact inventoried source LF encodings, alongside the original CRLF encodings.
-- No installed definition, owner, ACL or trigger is changed to make it match.
expected_lf jsonb:='{"begin_google_booking_mutation_v1(uuid,uuid)":"95c4d5f8ef199236e0b984814a8a4aa1de342d63755f444f963012bfd77e2521","claim_google_booking_job_v1(uuid)":"6192fa9bfcc7fdd67e29c436d59a2dd420fe7a75ed9dfb0ad2b8a28ee7c28fb4","complete_google_booking_job_v1(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone)":"943dfb1b53df731a0943e907a9ed203d02033395eaec8f2ec8e518bec5ef4242","configure_google_calendar_v1(uuid,uuid,uuid,text,text[],jsonb,text,uuid)":"36588e09a15f22881e52c37ef038ad31b2f7d20fd90fc71b5afc511ec9995661","enqueue_google_booking_create_v1(uuid,uuid)":"26e41e12645d1d49812af8cb1db304d6951d3fc3fb6b508a32f18d0532edc608","fail_unattempted_google_booking_v1(uuid,uuid,text)":"ba29cf64e772fcd8668c5013f3193db1d32f64118ba159ed7d7f7821ec136708","google_reserved_intervals_v1(uuid,timestamp with time zone,timestamp with time zone,uuid)":"fcb6704748acdea3cf600e4598a9c8f4229e33102b20a37dead1f3dd7f1893a8","reconcile_google_calendar_booking_v1(uuid,uuid,uuid,bigint,text,text,timestamp with time zone,timestamp with time zone,boolean)":"1145cfd27bed8a8c602e00b6449fcb62d90f11816b2a1eda32f6633be83b6a76","recover_google_reschedule_v1(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,boolean)":"59c1e41fe3cb360b570cf456661e63e467e431cea4d42fb008243bca4e2b70e0","request_google_booking_change_v1(uuid,uuid,bigint,text,timestamp with time zone,timestamp with time zone)":"d964d6e2a73e28269a1814c3faacf3098f9020f5f73fb678494f9b9997a2abfc","reschedule_google_booking_checked_v1(uuid,uuid,bigint,timestamp with time zone,timestamp with time zone,jsonb)":"2da20e4386d6da179ca0f242180f94f21969efc640245b81dc1f7e48c95e2717","reserve_google_booking_checked_v1(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid,uuid,text,jsonb)":"f8d76e6b111b38e102ebff431de0b1beaad7f95572f2722490e6277e942416c7","reserve_google_booking_v1(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid,uuid)":"5e9e5e694772f7c9f035cd1fe598b21bead915b381c435bafcab2c03d4d84f80","validate_google_booking_attribution_v1()":"20facec231af2aec99f480b0b3f0c9e55bf11d8cd4145d775e634e33ee207d7b","assign_sales_team_booking_v1(uuid,uuid,uuid)":"c4f5d2f5da030ca7e297e1e4e079b65e41b08a2e3b42aa0fcf9b55b392c0811d","clear_google_booking_recovery_v1()":"6e7f61656d7afc86a596f060ed977b6c590814ab8a237a34d014ff112485ea80","manage_sales_team_v1(uuid,uuid,text,jsonb)":"3efacfa091af1b1ae8a61077e0702c474f14aadcbbe0ffbe8ded7eb20254e638","sales_team_member_ready_v1(uuid)":"b7e087d61f8ce1cd90c4f45685351765f461d52be446f6b791750ca24335186e","wake_google_booking_retries_v1()":"3e0d0938c5235e888b3dd96cece69af6677126b9ebf620e5bcef2175e0488412","seed_sales_team_booking_v1(uuid,uuid,uuid,text,uuid)":"4c0ca3394ad966e9ce00bbb58853497246ddc116b89fe5787df66033311903cb"}';
begin
 if to_regclass('public.team_calendar_policy_v1') is not null then raise exception 'TEAM_CALENDAR_ALREADY_INSTALLED';end if;
 expected:=expected||'{"assign_sales_team_booking_v1(uuid,uuid,uuid)":"c4f5d2f5da030ca7e297e1e4e079b65e41b08a2e3b42aa0fcf9b55b392c0811d","clear_google_booking_recovery_v1()":"ef7788c67a7f02eff516678f863affa8753308df35a4810b1716eaca5f57585d","manage_sales_team_v1(uuid,uuid,text,jsonb)":"3efacfa091af1b1ae8a61077e0702c474f14aadcbbe0ffbe8ded7eb20254e638","sales_team_member_ready_v1(uuid)":"b7e087d61f8ce1cd90c4f45685351765f461d52be446f6b791750ca24335186e","wake_google_booking_retries_v1()":"33b9d804d47717f330f9a111fede8955dcba8daca35b872c51a932c8a94fee98"}'::jsonb;
 expected:=expected||'{"seed_sales_team_booking_v1(uuid,uuid,uuid,text,uuid)":"4c0ca3394ad966e9ce00bbb58853497246ddc116b89fe5787df66033311903cb"}'::jsonb;
 perform 'public.sales_team_member_ready_v1(uuid)'::regprocedure;
 for signature,digest in select key,value from jsonb_each_text(expected) loop
  routine:=to_regprocedure('public.'||signature);
  actual_digest:=case when routine is not null then encode(sha256(convert_to(pg_get_functiondef(routine),'UTF8')),'hex') end;
  if routine is null or (actual_digest is distinct from digest and actual_digest is distinct from (expected_lf->>signature))
   or (select prosecdef from pg_proc where oid=routine)
   or (select proowner<>(select oid from pg_roles where rolname=current_user) from pg_proc where oid=routine)
   or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid=routine and (a.grantee not in (p.proowner,(select oid from pg_roles where rolname='service_role')) or a.is_grantable))
   or has_function_privilege('anon',routine,'EXECUTE') or has_function_privilege('authenticated',routine,'EXECUTE')
   or (signature<>'clear_google_booking_recovery_v1()' and not has_function_privilege('service_role',routine,'EXECUTE'))
   or (signature='clear_google_booking_recovery_v1()' and exists(select 1 from pg_proc p where p.oid=routine and (
    not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.grantee=p.proowner and a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
    or (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))) not in (1,2)
    or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.grantor<>p.proowner or a.privilege_type<>'EXECUTE')
    or has_function_privilege('service_role',routine,'EXECUTE') is distinct from exists(
     select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.grantee=(select oid from pg_roles where rolname='service_role') and a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable))))
  then raise exception 'TEAM_CALENDAR_PREDECESSOR_DIFFERS: %',signature;end if;
 end loop;
end $parents$;

-- These retained triggers carry attribution, recovery and reconnect semantics.
-- Pin their relation, function, complete shape and enabled state before wrapping
-- admissions; do not repair drift while installing the candidate.
do $triggers$
declare expected record; actual record;
begin
 for expected in select * from (values
 ('google_booking_reservations_v1','clear_google_booking_recovery_v1','clear_google_booking_recovery_v1()',
  'CREATE TRIGGER clear_google_booking_recovery_v1 BEFORE UPDATE ON public.google_booking_reservations_v1 FOR EACH ROW EXECUTE FUNCTION clear_google_booking_recovery_v1()'),
 ('google_booking_reservations_v1','google_booking_attribution_guard_v1','validate_google_booking_attribution_v1()',
  'CREATE TRIGGER google_booking_attribution_guard_v1 BEFORE INSERT OR UPDATE OF attribution_id, buyer_id, connection_id, original_post_id ON public.google_booking_reservations_v1 FOR EACH ROW EXECUTE FUNCTION validate_google_booking_attribution_v1()'),
 ('sales_team_booking_sources_v1','sales_team_booking_sources_immutable_v1','creatornet_team_private.reject_history_change()',
  'CREATE TRIGGER sales_team_booking_sources_immutable_v1 BEFORE DELETE OR UPDATE ON public.sales_team_booking_sources_v1 FOR EACH ROW EXECUTE FUNCTION creatornet_team_private.reject_history_change()'),
 ('scheduling_connections_v1','google_reconnect_retry_wakeup_v1','wake_google_booking_retries_v1()',
  'CREATE TRIGGER google_reconnect_retry_wakeup_v1 AFTER UPDATE OF status ON public.scheduling_connections_v1 FOR EACH ROW WHEN (((new.provider = ''google''::text) AND (new.status = ''connected''::text) AND (old.status IS DISTINCT FROM new.status))) EXECUTE FUNCTION wake_google_booking_retries_v1()')
 ) v(relation,name,routine,definition) loop
  select t.tgfoid,t.tgenabled,pg_get_triggerdef(t.oid) definition into actual from pg_trigger t
   where t.tgrelid=to_regclass('public.'||expected.relation) and t.tgname=expected.name and not t.tgisinternal;
  if not found or actual.tgenabled<>'O' or actual.tgfoid is distinct from to_regprocedure(case when expected.routine like 'creatornet_team_private.%' then expected.routine else 'public.'||expected.routine end)
   or actual.definition is distinct from expected.definition then raise exception 'TEAM_CALENDAR_PREDECESSOR_TRIGGER_DIFFERS: %',expected.name;end if;
 end loop;
end $triggers$;
do $source_parent$ declare p pg_proc;begin
 select * into p from pg_proc where oid=to_regprocedure('creatornet_team_private.reject_history_change()');
 if not found or p.prosecdef or p.proowner<>(select oid from pg_roles where rolname=current_user)
  or p.prorettype<>'trigger'::regtype or p.prolang<>(select oid from pg_language where lanname='plpgsql')
  or p.proconfig is distinct from array['search_path=pg_catalog']::text[]
  or p.prosrc not in (E'\nbegin raise exception ''TEAM_HISTORY_IS_IMMUTABLE''; end ',E'\r\nbegin raise exception ''TEAM_HISTORY_IS_IMMUTABLE''; end ')
  or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee<>p.proowner or a.is_grantable)
 then raise exception 'TEAM_CALENDAR_SOURCE_PREDECESSOR_DIFFERS';end if;
end $source_parent$;

create schema creatornet_calendar_team_private;
revoke all on schema creatornet_calendar_team_private from public,anon,authenticated;
grant usage on schema creatornet_calendar_team_private to service_role;
do $isolation$ begin if current_setting('transaction_isolation')<>'read committed'
 then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;end $isolation$;
-- No adoption/backfill of an earlier team installation. Serialize the empty
-- history check through all trigger/column installation; contention stops only
-- this migration. Never wait while holding a subset of these parent locks.
lock table public.sales_team_booking_sources_v1,public.bookings,
 public.discover_booking_attribution_v1,public.free_booking_checkouts,
 public.google_booking_reservations_v1 in access exclusive mode nowait;
do $history$ begin
 if exists(select 1 from public.sales_team_booking_sources_v1) then
  raise exception 'TEAM_CALENDAR_SOURCE_HISTORY_REVIEW_REQUIRED';end if;
end $history$;
alter table public.sales_team_booking_sources_v1 add column source_session_id text
 check(source_session_id is null or source_session_id like 'cs\_%' escape '\');
create index sales_team_original_session_v1 on public.sales_team_booking_sources_v1(source_session_id)
 where source_session_id is not null;
create table public.team_calendar_policy_v1(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 origin text check(origin~'^https://[^/@?#[:space:]]+$'),
 contract_sha256 text check(contract_sha256~'^[a-f0-9]{64}$'),
 recovery_contract_sha256 text check(recovery_contract_sha256~'^[a-f0-9]{64}$')
);
insert into public.team_calendar_policy_v1(singleton) values(true);
create table public.team_calendar_bindings_v1(
 reservation_id uuid primary key references public.google_booking_reservations_v1(id) deferrable initially deferred,
 booking_id uuid not null references public.bookings(id) on delete restrict,
 generation integer not null check(generation>0),
 creator_id uuid not null references auth.users(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 post_id uuid not null references public.posts(id) on delete restrict,
 source_identity text not null,
 assignment_revision integer not null check(assignment_revision>0),
 membership_id uuid not null references public.sales_team_memberships_v1(id) on delete restrict,
 target_id uuid not null references public.booking_targets(id) on delete restrict,
 connection_id uuid not null references public.scheduling_connections_v1(id) on delete restrict,
 calendar_owner_id uuid not null references public.profiles(id) on delete restrict,
 provider text not null default 'google' check(provider='google'),
 account_id text not null check(length(account_id)>0),
 calendar_id text not null check(length(calendar_id)>0),
 destination_url text not null,
 origin text not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(booking_id,generation),
 foreign key(creator_id,buyer_id,post_id,source_identity)
  references public.sales_team_booking_sources_v1(creator_id,buyer_id,post_id,source_identity) on delete restrict
);
create index team_calendar_binding_booking_v1 on public.team_calendar_bindings_v1(booking_id,generation desc);
-- Historical reservations stay unbound. The explicit marker lets native workers
-- recognize a retained team appointment even if new-activity flags are shut off.
alter table public.google_booking_reservations_v1 add column team_calendar_binding_id uuid,
 add constraint team_calendar_reservation_marker_v1 check(team_calendar_binding_id is null or team_calendar_binding_id=id),
 add constraint team_calendar_reservation_binding_fk_v1 foreign key(team_calendar_binding_id)
  references public.team_calendar_bindings_v1(reservation_id) deferrable initially deferred;
alter table public.team_calendar_policy_v1 enable row level security;
alter table public.team_calendar_bindings_v1 enable row level security;
revoke all on public.team_calendar_policy_v1,public.team_calendar_bindings_v1 from public,anon,authenticated,service_role;
grant select on public.team_calendar_policy_v1,public.team_calendar_bindings_v1 to service_role;
grant insert on public.team_calendar_bindings_v1 to service_role;

create function creatornet_calendar_team_private.reject_binding_change_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin raise exception 'TEAM_CALENDAR_ORIGINAL_BINDING_IMMUTABLE';end $$;
create trigger team_calendar_binding_immutable_v1 before update or delete on public.team_calendar_bindings_v1
 for each row execute function creatornet_calendar_team_private.reject_binding_change_v1();

create function creatornet_calendar_team_private.intent_id_v1(p_booking uuid,p_generation integer)
returns uuid language sql immutable security invoker set search_path=pg_catalog as $$
 select (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
 from (select encode(sha256(convert_to('team-calendar-v1:'||p_booking::text||':'||p_generation::text,'UTF8')),'hex') h) value;
$$;
create function creatornet_calendar_team_private.contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(coalesce(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||
 coalesce(p.proacl::text,'')||':'||p.proowner::text,E'\n' order by p.oid::regprocedure::text collate "C"),'')||':'||
 coalesce((select string_agg(t.tgrelid::regclass::text||':'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text,E'\n' order by t.tgrelid,t.tgname collate "C")
 from pg_trigger t where not t.tgisinternal and (t.tgrelid,t.tgname) in
 (('public.team_calendar_bindings_v1'::regclass,'team_calendar_binding_immutable_v1'),
  ('public.team_calendar_bindings_v1'::regclass,'team_calendar_binding_insert_v1'),
  ('public.google_booking_reservations_v1'::regclass,'team_calendar_reservation_identity_v1'),
  ('public.google_booking_jobs_v1'::regclass,'team_calendar_job_identity_v1'),
  ('public.google_booking_jobs_v1'::regclass,'team_calendar_job_mutation_v1'),
  ('public.google_booking_reservations_v1'::regclass,'google_booking_attribution_guard_v1'),
  ('public.google_booking_reservations_v1'::regclass,'clear_google_booking_recovery_v1'),
  ('public.scheduling_connections_v1'::regclass,'google_reconnect_retry_wakeup_v1'),
  ('public.sales_team_booking_sources_v1'::regclass,'team_original_source_insert_v1'),
  ('public.sales_team_booking_sources_v1'::regclass,'sales_team_booking_sources_immutable_v1'),
  ('public.discover_booking_attribution_v1'::regclass,'team_original_attribution_identity_v1'),
  ('public.free_booking_checkouts'::regclass,'team_original_free_identity_v1'),
  ('public.bookings'::regclass,'team_original_booking_identity_v1'))),''),'UTF8')),'hex')
 from pg_proc p where p.pronamespace='creatornet_calendar_team_private'::regnamespace
 or p.oid=to_regprocedure('creatornet_team_private.reject_history_change()') or
 (p.pronamespace='public'::regnamespace and (p.proname in
 ('read_team_google_booking_v1','reserve_team_google_booking_v1','read_team_calendar_reservation_v1','read_team_booking_scheduling_v1',
  'recover_unsent_team_calendar_job_v1','reserve_google_booking_v1','reserve_google_booking_checked_v1','enqueue_google_booking_create_v1',
  'request_google_booking_change_v1','reschedule_google_booking_checked_v1','begin_google_booking_mutation_v1','complete_google_booking_job_v1',
  'reconcile_google_calendar_booking_v1','recover_google_reschedule_v1','fail_unattempted_google_booking_v1',
  'validate_google_booking_attribution_v1','google_reserved_intervals_v1','assign_sales_team_booking_v1','sales_team_member_ready_v1',
  'clear_google_booking_recovery_v1','wake_google_booking_retries_v1','manage_sales_team_v1',
  'claim_google_booking_job_v1','configure_google_calendar_v1','seed_sales_team_booking_v1','resolve_original_team_booking_v1')
 or p.proname like '%_before_team_calendar_v1'));
$$;
create function creatornet_calendar_team_private.ready_v1()
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.team_calendar_policy_v1 where singleton and enabled and origin is not null
 and contract_sha256=creatornet_calendar_team_private.contract_digest_v1());
$$;

-- Automatic routing selects only exact, currently supported native destinations.
-- This is a selection snapshot; reservation and provider dispatch still recheck
-- current authority. No provider/watch lock is acquired during the weighted scan.
create function creatornet_calendar_team_private.eligible_native_destination_v1(
 p_creator uuid,p_member uuid,p_target uuid,p_buyer uuid,p_origin text,p_url text default null)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select p_origin is not null and exists(select 1 from public.sales_team_memberships_v1 m
 join public.sales_team_destination_bindings_v1 d on d.membership_id=m.id and d.creator_id=m.creator_id
 join public.booking_targets t on t.id=d.target_id and t.creator_id=d.creator_id
 join public.scheduling_connections_v1 c on c.creator_id=m.user_id and c.provider='google' and c.status='connected'
 join public.google_booking_settings_v1 s on s.connection_id=c.id and s.active
 where m.id=p_member and m.creator_id=p_creator and t.id=p_target and m.user_id<>p_buyer
  and public.sales_team_member_ready_v1(m.id) and t.is_active and coalesce(t.active,false) and t.weight>0
  and length(c.account_id)>0 and length(s.calendar_id)>0 and (p_url is null or t.booking_url=p_url)
  and (t.booking_url=p_origin||'/scheduling/book/'||c.id::text or t.booking_url='/scheduling/book/'||c.id::text)
  and exists(select 1 from public.google_calendar_watches_v1 w where w.id::text=c.webhook_id and w.connection_id=c.id
   and w.calendar_id=s.calendar_id and w.status='active' and w.expires_at>clock_timestamp()));
$$;

-- Preserve the pinned owner's identity, ACL, locks, accepted-sale freeze and
-- explicit manager reassignment. Only the automatic/new-link branch is fenced.
create or replace function public.assign_sales_team_booking_v1(p_booking_id uuid,p_actor_id uuid,p_membership_id uuid default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_booking public.bookings;v_existing public.sales_team_assignments_v1;v_binding public.sales_team_destination_bindings_v1;
 v_creator uuid;v_role text;v_before jsonb;v_after jsonb;v_target public.booking_targets;v_origin text;
begin
 if p_actor_id is null then raise exception 'BOOKING_UNAVAILABLE';end if;
 select creator_id into v_creator from public.bookings where id=p_booking_id;
 if v_creator is null then raise exception 'BOOKING_UNAVAILABLE';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||v_creator::text,0));
 select * into v_booking from public.bookings where id=p_booking_id for update;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled) then raise exception 'TEAM_SALES_DISABLED';end if;
 v_role:=public.sales_team_actor_role_v1(v_creator,p_actor_id);
 if p_membership_id is not null then
  if v_role is null or v_role not in ('owner','manager') then raise exception 'TEAM_MANAGER_REQUIRED';end if;
 elsif p_actor_id<>v_booking.buyer_id and (v_role is null or v_role not in ('owner','manager')) then raise exception 'BOOKING_UNAVAILABLE';end if;
 if not exists(select 1 from public.posts p where p.id=v_booking.post_id and p.creator_id=v_creator and p.allow_booking) then raise exception 'BOOKING_OFFER_MISMATCH';end if;
 if p_membership_id is null then
  select origin into v_origin from public.team_calendar_policy_v1 where singleton and enabled and origin is not null
   and contract_sha256=creatornet_calendar_team_private.contract_digest_v1();
  if v_origin is null then raise exception 'TEAM_CALENDAR_NOT_ENABLED';end if;
  if not exists(select 1 from public.sales_team_creator_settings_v1 where creator_id=v_creator and routing_enabled) then raise exception 'TEAM_ROUTING_NOT_ENABLED';end if;
  if not exists(select 1 from public.sales_team_booking_sources_v1 where booking_id=v_booking.id and creator_id=v_creator
   and buyer_id=v_booking.buyer_id and post_id=v_booking.post_id) then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
  if not exists(select 1 from public.posts p where p.id=v_booking.post_id and p.creator_id=v_creator and p.video_action='book'
   and p.product_id is null and p.active is not false and p.hidden_at is null and p.removed_at is null) then raise exception 'BOOKING_OFFER_MISMATCH';end if;
 end if;
 select * into v_existing from public.sales_team_assignments_v1 where booking_id=p_booking_id for update;
 if v_existing.booking_id is not null then
  if p_membership_id is null or p_membership_id=v_existing.membership_id then
   select * into v_target from public.booking_targets where id=v_existing.target_id;
   if not public.sales_team_member_ready_v1(v_existing.membership_id) or not v_target.is_active or not coalesce(v_target.active,false) or v_target.weight<=0 then raise exception 'ASSIGNED_MEMBER_UNAVAILABLE';end if;
   if p_membership_id is null and not creatornet_calendar_team_private.eligible_native_destination_v1(v_creator,v_existing.membership_id,v_existing.target_id,v_booking.buyer_id,v_origin,v_target.booking_url)
    then raise exception 'TEAM_CALENDAR_DESTINATION_REVIEW_REQUIRED';end if;
   return jsonb_build_object('assignment',to_jsonb(v_existing),'booking_url',v_target.booking_url,'reused',true);
  end if;
  if v_existing.accepted_sale_id is not null then raise exception 'SALE_ATTRIBUTION_FROZEN';end if;
 end if;
 if v_booking.status='completed' or v_booking.linked_order_id is not null then raise exception 'HISTORICAL_PAYMENT_NOT_ASSIGNABLE';end if;
 select b.* into v_binding from public.sales_team_destination_bindings_v1 b
 join public.booking_targets t on t.id=b.target_id and t.creator_id=b.creator_id
 where b.creator_id=v_creator and t.is_active and coalesce(t.active,false) and t.weight>0
  and public.sales_team_member_ready_v1(b.membership_id)
  and (p_membership_id is null or b.membership_id=p_membership_id)
  and (p_membership_id is not null or creatornet_calendar_team_private.eligible_native_destination_v1(v_creator,b.membership_id,b.target_id,v_booking.buyer_id,v_origin))
 order by b.route_count::numeric/t.weight,b.last_assigned_at nulls first,b.target_id limit 1 for update of b;
 if v_binding.target_id is null then raise exception 'NO_ELIGIBLE_TEAM_DESTINATION';end if;
 v_before:=to_jsonb(v_existing);
 insert into public.sales_team_assignments_v1(booking_id,creator_id,target_id,membership_id,source,assigned_by)
 values(p_booking_id,v_creator,v_binding.target_id,v_binding.membership_id,case when p_membership_id is null then 'weighted' else 'manual' end,p_actor_id)
 on conflict(booking_id) do update set target_id=excluded.target_id,membership_id=excluded.membership_id,source=excluded.source,
  assigned_by=p_actor_id,assigned_at=clock_timestamp(),revision=public.sales_team_assignments_v1.revision+1
 returning to_jsonb(sales_team_assignments_v1.*) into v_after;
 update public.sales_team_destination_bindings_v1 set route_count=route_count+1,last_assigned_at=clock_timestamp() where target_id=v_binding.target_id;
 insert into public.sales_team_audit_v1(creator_id,actor_id,action,subject_id,before_state,after_state)
 values(v_creator,p_actor_id,'assign_booking',p_booking_id,v_before,v_after);
 select * into v_target from public.booking_targets where id=v_binding.target_id;
 if p_membership_id is null and not creatornet_calendar_team_private.eligible_native_destination_v1(v_creator,v_binding.membership_id,v_binding.target_id,v_booking.buyer_id,v_origin,v_target.booking_url)
  then raise exception 'TEAM_CALENDAR_DESTINATION_REVIEW_REQUIRED';end if;
 return jsonb_build_object('assignment',v_after,'booking_url',v_target.booking_url,'reused',false);
end $$;

-- Identity is independent of current employment/assignment. It survives original
-- cancellation, provider read-before-retry and reconciliation after departure.
create function creatornet_calendar_team_private.assert_identity_v1(p_id uuid)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare b public.team_calendar_bindings_v1;r public.google_booking_reservations_v1;
begin
 select * into b from public.team_calendar_bindings_v1 where reservation_id=p_id;
 if not found then return;end if;
 if not exists(select 1 from public.bookings k join public.sales_team_booking_sources_v1 s on s.booking_id=k.id
  where k.id=b.booking_id and k.creator_id=b.creator_id and k.buyer_id=b.buyer_id and k.post_id=b.post_id
   and s.creator_id=b.creator_id and s.buyer_id=b.buyer_id and s.post_id=b.post_id and s.source_identity=b.source_identity)
  or not exists(select 1 from public.scheduling_connections_v1 c where c.id=b.connection_id and c.provider=b.provider
   and c.creator_id=b.calendar_owner_id and c.account_id=b.account_id)
 then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
 select * into r from public.google_booking_reservations_v1 where id=p_id;
 if found and (r.connection_id is distinct from b.connection_id or r.buyer_id is distinct from b.buyer_id
  or r.original_post_id is distinct from b.post_id or r.calendar_id is distinct from b.calendar_id
  or r.attribution_id is not null or r.purchase_id is not null or r.team_calendar_binding_id is distinct from b.reservation_id)
 then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
end $$;
create function creatornet_calendar_team_private.admitted_v1(p_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select creatornet_calendar_team_private.ready_v1() and exists(
 select 1 from public.team_calendar_bindings_v1 b
 join public.sales_team_assignments_v1 a on a.booking_id=b.booking_id and a.creator_id=b.creator_id
  and a.revision=b.assignment_revision and a.membership_id=b.membership_id and a.target_id=b.target_id
 join public.sales_team_memberships_v1 m on m.id=b.membership_id and m.creator_id=b.creator_id and m.user_id=b.calendar_owner_id
 join public.sales_team_destination_bindings_v1 d on d.target_id=b.target_id and d.creator_id=b.creator_id and d.membership_id=b.membership_id
 join public.booking_targets t on t.id=b.target_id and t.creator_id=b.creator_id and t.booking_url=b.destination_url
 join public.bookings k on k.id=b.booking_id and k.creator_id=b.creator_id and k.buyer_id=b.buyer_id and k.post_id=b.post_id
 join public.posts p on p.id=b.post_id and p.creator_id=b.creator_id
 join public.scheduling_connections_v1 c on c.id=b.connection_id and c.creator_id=b.calendar_owner_id and c.provider='google' and c.account_id=b.account_id
 join public.google_booking_settings_v1 s on s.connection_id=c.id and s.calendar_id=b.calendar_id
 join public.team_calendar_policy_v1 policy on policy.singleton and policy.origin=b.origin
 where b.reservation_id=p_id and b.calendar_owner_id<>b.buyer_id and public.sales_team_member_ready_v1(m.id)
  and t.is_active and coalesce(t.active,false) and t.weight>0 and c.status='connected' and s.active
  and p.allow_booking and p.video_action='book' and p.product_id is null and p.active is not false and p.hidden_at is null and p.removed_at is null
  and exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled)
  and exists(select 1 from public.google_calendar_watches_v1 w where w.id::text=c.webhook_id and w.connection_id=c.id
   and w.calendar_id=s.calendar_id and w.status='active' and w.expires_at>clock_timestamp())
  and not exists(select 1 from public.team_calendar_bindings_v1 sibling left join public.google_booking_reservations_v1 prior on prior.id=sibling.reservation_id
   where sibling.booking_id=b.booking_id and sibling.reservation_id<>b.reservation_id and
    (prior.id is null or prior.status<>'canceled' and not (prior.status='failed' and prior.event_id is null
     and not exists(select 1 from public.google_booking_jobs_v1 j where j.reservation_id=prior.id and (j.status<>'failed' or j.mutation_started_at is not null))))));
$$;

-- Common booking lock is taken BEFORE any retained calendar/job lock, including
-- both outer checked owners and their nested raw owners.
create function creatornet_calendar_team_private.admit_v1(p_id uuid,p_action text,p_buyer uuid default null)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare b public.team_calendar_bindings_v1;r public.google_booking_reservations_v1; needs_current boolean:=true;
begin
 select * into b from public.team_calendar_bindings_v1 where reservation_id=p_id;
 if not found then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||b.creator_id::text,0));
 perform 1 from public.bookings where id=b.booking_id for update;
 perform creatornet_calendar_team_private.assert_identity_v1(p_id);
 if p_buyer is not null and p_buyer is distinct from b.buyer_id then raise exception 'TEAM_CALENDAR_BUYER_REQUIRED';end if;
 select * into r from public.google_booking_reservations_v1 where id=p_id;
 if p_action='cancel' then needs_current:=false;
 elsif p_action='reserve' and r.status in ('creating','confirmed','rescheduling','canceling') then needs_current:=false;
 elsif p_action='enqueue' and exists(select 1 from public.google_booking_jobs_v1 where reservation_id=p_id and revision=r.revision and action='create') then needs_current:=false;
 end if;
 if needs_current and not creatornet_calendar_team_private.admitted_v1(p_id) then raise exception 'TEAM_CALENDAR_CURRENT_ASSIGNMENT_REQUIRED';end if;
end $$;

create function creatornet_calendar_team_private.guard_binding_insert_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||new.creator_id::text,0));
 perform 1 from public.bookings where id=new.booking_id for update;
 if exists(select 1 from public.google_booking_reservations_v1 where id=new.reservation_id) then raise exception 'TEAM_CALENDAR_LEGACY_ADOPTION_DENIED';end if;
 if new.buyer_id=new.calendar_owner_id or new.reservation_id is distinct from creatornet_calendar_team_private.intent_id_v1(new.booking_id,new.generation)
  or not exists(select 1 from public.bookings k join public.sales_team_booking_sources_v1 s on s.booking_id=k.id
   join public.sales_team_assignments_v1 a on a.booking_id=k.id and a.creator_id=k.creator_id
   join public.sales_team_memberships_v1 m on m.id=a.membership_id and m.creator_id=a.creator_id
   join public.booking_targets t on t.id=a.target_id and t.creator_id=a.creator_id
   join public.sales_team_destination_bindings_v1 d on d.target_id=t.id and d.creator_id=a.creator_id and d.membership_id=m.id
   join public.scheduling_connections_v1 c on c.id=new.connection_id and c.creator_id=m.user_id and c.provider='google'
   join public.google_booking_settings_v1 settings on settings.connection_id=c.id
   join public.team_calendar_policy_v1 policy on policy.singleton and policy.origin=new.origin
   where k.id=new.booking_id and k.creator_id=new.creator_id and k.buyer_id=new.buyer_id and k.post_id=new.post_id
    and s.creator_id=new.creator_id and s.buyer_id=new.buyer_id and s.post_id=new.post_id and s.source_identity=new.source_identity
    and a.revision=new.assignment_revision and a.membership_id=new.membership_id and a.target_id=new.target_id
    and c.creator_id=new.calendar_owner_id and c.account_id=new.account_id and settings.calendar_id=new.calendar_id
    and t.booking_url=new.destination_url and (t.booking_url=new.origin||'/scheduling/book/'||c.id::text or t.booking_url='/scheduling/book/'||c.id::text))
 then raise exception 'TEAM_CALENDAR_BINDING_DIFFERS';end if;
 if new.generation<>(select coalesce(max(generation),0)+1 from public.team_calendar_bindings_v1 where booking_id=new.booking_id)
 then raise exception 'TEAM_CALENDAR_INTENT_CHANGED';end if;
 if exists(select 1 from public.team_calendar_bindings_v1 b left join public.google_booking_reservations_v1 r on r.id=b.reservation_id
  where b.booking_id=new.booking_id and (r.id is null or r.status<>'canceled' and not (r.status='failed' and r.event_id is null
   and not exists(select 1 from public.google_booking_jobs_v1 j where j.reservation_id=r.id and (j.status<>'failed' or j.mutation_started_at is not null)))))
 then raise exception 'TEAM_CALENDAR_ORIGINAL_APPOINTMENT_PENDING';end if;
 return new;
end $$;
create trigger team_calendar_binding_insert_v1 before insert on public.team_calendar_bindings_v1
 for each row execute function creatornet_calendar_team_private.guard_binding_insert_v1();
create function creatornet_calendar_team_private.guard_reservation_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare b public.team_calendar_bindings_v1; v public.google_booking_reservations_v1;
begin
 if tg_op='UPDATE' and old.id is distinct from new.id and
  exists(select 1 from public.team_calendar_bindings_v1 where reservation_id in (old.id,new.id))
 then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
 if tg_op='DELETE' then v:=old;else v:=new;end if;
 select * into b from public.team_calendar_bindings_v1 where reservation_id=v.id;
 if not found then
  if v.team_calendar_binding_id is not null then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
  if tg_op='UPDATE' and (old.id,old.connection_id,old.buyer_id,old.original_post_id,old.attribution_id,old.purchase_id)
   is distinct from (new.id,new.connection_id,new.buyer_id,new.original_post_id,new.attribution_id,new.purchase_id)
  then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
  if tg_op='INSERT' or tg_op='UPDATE' and old.status in ('failed','canceled') and new.status not in ('failed','canceled') then
   -- Direct writes/delegates may already own native locks. Never wait in the
   -- opposite order; ordered public reserve owners already hold these locks.
   perform creatornet_calendar_team_private.admit_ordinary_source_v1(v.buyer_id,v.original_post_id,v.attribution_id,true,v.purchase_id);
  end if;
  return v;
 end if;
 if tg_op='INSERT' then
  if new.team_calendar_binding_id is not null and new.team_calendar_binding_id is distinct from b.reservation_id
   then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
  new.team_calendar_binding_id:=b.reservation_id;v:=new;
 elsif v.team_calendar_binding_id is distinct from b.reservation_id then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
 perform creatornet_calendar_team_private.assert_identity_v1(v.id);
 if tg_op='DELETE' then
  if old.event_id is not null or old.status not in ('held','failed') or exists(select 1 from public.google_booking_jobs_v1 where reservation_id=old.id)
   then raise exception 'TEAM_CALENDAR_ORIGINAL_RESERVATION_IMMUTABLE';end if;
  return old;
 end if;
 if v.connection_id is distinct from b.connection_id or v.buyer_id is distinct from b.buyer_id or v.original_post_id is distinct from b.post_id
  or v.calendar_id is distinct from b.calendar_id or v.attribution_id is not null or v.purchase_id is not null
 then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
 if tg_op='UPDATE' and old.id is distinct from new.id then raise exception 'TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS';end if;
 if tg_op='UPDATE' and old.event_id is not null and new.event_id is distinct from old.event_id
  then raise exception 'TEAM_CALENDAR_ORIGINAL_EVENT_IMMUTABLE';end if;
 if new.event_id is not null and new.event_id is distinct from encode(sha256(convert_to('creatornet-booking:'||new.id::text,'UTF8')),'hex')
 then raise exception 'TEAM_CALENDAR_PROVIDER_EVENT_DIFFERS';end if;
 if new.status='confirmed' and (new.event_id is null or coalesce(length(new.event_etag),0)=0)
 then raise exception 'TEAM_CALENDAR_CONFIRMED_EVIDENCE_REQUIRED';end if;
 if (tg_op='INSERT' or new.status in ('held','creating','rescheduling') and
  (old.status is distinct from new.status or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
   or new.desired_starts_at is distinct from old.desired_starts_at or new.desired_ends_at is distinct from old.desired_ends_at))
  and not creatornet_calendar_team_private.admitted_v1(v.id) then raise exception 'TEAM_CALENDAR_CURRENT_ASSIGNMENT_REQUIRED';end if;
 if new.status='failed' and (new.event_id is not null or exists(select 1 from public.google_booking_jobs_v1 where reservation_id=v.id and mutation_started_at is not null))
  then raise exception 'TEAM_CALENDAR_UNCERTAIN_OUTCOME_REMAINS_RESERVED';end if;
 if new.status='canceled' and (tg_op='INSERT' or old.event_id is null or new.event_id is distinct from old.event_id
  or old.status not in ('confirmed','rescheduling','canceling','canceled'))
  then raise exception 'TEAM_CALENDAR_UNCERTAIN_OUTCOME_REMAINS_RESERVED';end if;
 if tg_op='UPDATE' and new.status='held' and (old.status not in ('held','failed') or new.event_id is not null
  or exists(select 1 from public.google_booking_jobs_v1 where reservation_id=v.id and (status<>'failed' or mutation_started_at is not null)))
  then raise exception 'TEAM_CALENDAR_UNCERTAIN_OUTCOME_REMAINS_RESERVED';end if;
 return new;
end $$;
create trigger team_calendar_reservation_identity_v1 before insert or update or delete on public.google_booking_reservations_v1
 for each row execute function creatornet_calendar_team_private.guard_reservation_v1();

-- Six admission owners retain their exact bodies/OIDs as delegates. Completion,
-- attribution, sweep and recovery owners are not replaced.
alter function public.reserve_google_booking_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid) rename to reserve_google_booking_before_team_calendar_v1;
alter function public.reserve_google_booking_checked_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid,text,jsonb) rename to reserve_google_booking_checked_before_team_calendar_v1;
alter function public.enqueue_google_booking_create_v1(uuid,uuid) rename to enqueue_google_booking_create_before_team_calendar_v1;
alter function public.request_google_booking_change_v1(uuid,uuid,bigint,text,timestamptz,timestamptz) rename to request_google_booking_change_before_team_calendar_v1;
alter function public.reschedule_google_booking_checked_v1(uuid,uuid,bigint,timestamptz,timestamptz,jsonb) rename to reschedule_google_booking_checked_before_team_calendar_v1;
alter function public.begin_google_booking_mutation_v1(uuid,uuid) rename to begin_google_booking_mutation_before_team_calendar_v1;
alter function public.reserve_google_booking_before_team_calendar_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid) set schema creatornet_calendar_team_private;
alter function public.reserve_google_booking_checked_before_team_calendar_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid,text,jsonb) set schema creatornet_calendar_team_private;
alter function public.enqueue_google_booking_create_before_team_calendar_v1(uuid,uuid) set schema creatornet_calendar_team_private;
alter function public.request_google_booking_change_before_team_calendar_v1(uuid,uuid,bigint,text,timestamptz,timestamptz) set schema creatornet_calendar_team_private;
alter function public.reschedule_google_booking_checked_before_team_calendar_v1(uuid,uuid,bigint,timestamptz,timestamptz,jsonb) set schema creatornet_calendar_team_private;
alter function public.begin_google_booking_mutation_before_team_calendar_v1(uuid,uuid) set schema creatornet_calendar_team_private;
create function public.reserve_google_booking_v1(p_id uuid,p_connection uuid,p_buyer uuid,p_post uuid,p_start timestamptz,p_end timestamptz,p_attribution uuid default null,p_purchase uuid default null)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
begin if not exists(select 1 from public.team_calendar_bindings_v1 where reservation_id=p_id) then
 perform creatornet_calendar_team_private.admit_ordinary_source_v1(p_buyer,p_post,p_attribution,true,p_purchase);end if;
 perform creatornet_calendar_team_private.admit_v1(p_id,'reserve',p_buyer);
 return creatornet_calendar_team_private.reserve_google_booking_before_team_calendar_v1(p_id,p_connection,p_buyer,p_post,p_start,p_end,p_attribution,p_purchase);end $$;
create function public.reserve_google_booking_checked_v1(p_id uuid,p_connection uuid,p_buyer uuid,p_post uuid,p_start timestamptz,p_end timestamptz,p_attribution uuid,p_purchase uuid,p_calendar text,p_policy jsonb)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
begin if not exists(select 1 from public.team_calendar_bindings_v1 where reservation_id=p_id) then
 perform creatornet_calendar_team_private.admit_ordinary_source_v1(p_buyer,p_post,p_attribution,false,p_purchase);end if;
 perform creatornet_calendar_team_private.admit_v1(p_id,'reserve',p_buyer);
 return creatornet_calendar_team_private.reserve_google_booking_checked_before_team_calendar_v1(p_id,p_connection,p_buyer,p_post,p_start,p_end,p_attribution,p_purchase,p_calendar,p_policy);end $$;
create function public.enqueue_google_booking_create_v1(p_id uuid,p_buyer uuid)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
begin perform creatornet_calendar_team_private.admit_v1(p_id,'enqueue',p_buyer);
 return creatornet_calendar_team_private.enqueue_google_booking_create_before_team_calendar_v1(p_id,p_buyer);end $$;
create function public.request_google_booking_change_v1(p_id uuid,p_buyer uuid,p_revision bigint,p_action text,p_start timestamptz default null,p_end timestamptz default null)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
begin perform creatornet_calendar_team_private.admit_v1(p_id,p_action,p_buyer);
 return creatornet_calendar_team_private.request_google_booking_change_before_team_calendar_v1(p_id,p_buyer,p_revision,p_action,p_start,p_end);end $$;
create function public.reschedule_google_booking_checked_v1(p_id uuid,p_buyer uuid,p_revision bigint,p_start timestamptz,p_end timestamptz,p_policy jsonb)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
begin perform creatornet_calendar_team_private.admit_v1(p_id,'reschedule',p_buyer);
 return creatornet_calendar_team_private.reschedule_google_booking_checked_before_team_calendar_v1(p_id,p_buyer,p_revision,p_start,p_end,p_policy);end $$;
create function public.begin_google_booking_mutation_v1(p_job uuid,p_worker uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare j public.google_booking_jobs_v1;
begin select * into j from public.google_booking_jobs_v1 where id=p_job;
 perform creatornet_calendar_team_private.admit_v1(j.reservation_id,case when j.action='cancel' then 'cancel' else 'dispatch' end);
 perform creatornet_calendar_team_private.begin_google_booking_mutation_before_team_calendar_v1(p_job,p_worker);end $$;

create function creatornet_calendar_team_private.guard_job_identity_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare bound boolean;
begin
 if tg_op='INSERT' then
  if exists(select 1 from public.team_calendar_bindings_v1 where reservation_id=new.reservation_id) then
   perform creatornet_calendar_team_private.admit_v1(new.reservation_id,case new.action when 'cancel' then 'cancel' else 'dispatch' end);
  end if;
  return new;
 end if;
 select exists(select 1 from public.team_calendar_bindings_v1 where reservation_id=old.reservation_id) into bound;
 if tg_op='DELETE' then if bound then raise exception 'TEAM_CALENDAR_ORIGINAL_JOB_IMMUTABLE';end if;return old;end if;
 if (bound or exists(select 1 from public.team_calendar_bindings_v1 where reservation_id=new.reservation_id)) and
  (new.id is distinct from old.id or new.reservation_id is distinct from old.reservation_id or new.revision is distinct from old.revision or new.action is distinct from old.action)
 then raise exception 'TEAM_CALENDAR_ORIGINAL_JOB_IMMUTABLE';end if;
 if bound and old.mutation_started_at is not null and new.mutation_started_at is distinct from old.mutation_started_at
 then raise exception 'TEAM_CALENDAR_MUTATION_EVIDENCE_IMMUTABLE';end if;
 return new;
end $$;
create trigger team_calendar_job_identity_v1 before insert or update or delete on public.google_booking_jobs_v1
 for each row execute function creatornet_calendar_team_private.guard_job_identity_v1();
create function creatornet_calendar_team_private.guard_job_mutation_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if new.mutation_started_at is not null and exists(select 1 from public.team_calendar_bindings_v1 where reservation_id=new.reservation_id) then
  perform creatornet_calendar_team_private.admit_v1(new.reservation_id,case new.action when 'cancel' then 'cancel' else 'dispatch' end);
 end if;
 return new;
end $$;
create trigger team_calendar_job_mutation_v1 before update of mutation_started_at on public.google_booking_jobs_v1
 for each row execute function creatornet_calendar_team_private.guard_job_mutation_v1();

create function public.read_team_google_booking_v1(p_booking uuid,p_buyer uuid,p_connection uuid,p_origin text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare k public.bookings;a public.sales_team_assignments_v1;m public.sales_team_memberships_v1;t public.booking_targets;
 c public.scheduling_connections_v1;s public.google_booking_settings_v1;b public.team_calendar_bindings_v1;r public.google_booking_reservations_v1;
 source text;generation integer;intent uuid;
begin
 if not creatornet_calendar_team_private.ready_v1() or not exists(select 1 from public.team_calendar_policy_v1 where singleton and origin=p_origin)
 then raise exception 'TEAM_CALENDAR_NOT_ENABLED';end if;
 select * into k from public.bookings where id=p_booking and buyer_id=p_buyer;
 if not found then raise exception 'TEAM_CALENDAR_BOOKING_UNAVAILABLE';end if;
 select * into a from public.sales_team_assignments_v1 where booking_id=k.id and creator_id=k.creator_id;
 if not found then raise exception 'TEAM_CALENDAR_ASSIGNMENT_REQUIRED';end if;
 select * into m from public.sales_team_memberships_v1 where id=a.membership_id and creator_id=k.creator_id;
 select * into t from public.booking_targets where id=a.target_id and creator_id=k.creator_id;
 select * into c from public.scheduling_connections_v1 where id=p_connection and creator_id=m.user_id and provider='google';
 select * into s from public.google_booking_settings_v1 where connection_id=c.id;
 select source_identity into source from public.sales_team_booking_sources_v1 where booking_id=k.id and creator_id=k.creator_id
  and buyer_id=k.buyer_id and post_id=k.post_id order by created_at,source_identity collate "C" limit 1;
 if source is null then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 -- Reassignment never transfers the old appointment. Canonical booking, not
 -- source alias, owns the outstanding-attempt gate.
 select binding.* into b from public.team_calendar_bindings_v1 binding join public.google_booking_reservations_v1 reservation on reservation.id=binding.reservation_id
  where binding.booking_id=k.id and reservation.status<>'canceled' and not (reservation.status='failed' and reservation.event_id is null
   and not exists(select 1 from public.google_booking_jobs_v1 j where j.reservation_id=reservation.id and (j.status<>'failed' or j.mutation_started_at is not null)))
  order by binding.generation limit 1;
 if b.reservation_id is not null then
  if b.assignment_revision<>a.revision or b.membership_id<>a.membership_id or b.target_id<>a.target_id or b.connection_id is distinct from p_connection
   or b.calendar_id is distinct from s.calendar_id or b.account_id is distinct from c.account_id or b.destination_url is distinct from t.booking_url then
   select * into r from public.google_booking_reservations_v1 where id=b.reservation_id;
   return jsonb_build_object('blockedBy',jsonb_build_object('reservationId',b.reservation_id,'connectionId',b.connection_id,'status',r.status));
  end if;
  if not creatornet_calendar_team_private.admitted_v1(b.reservation_id) then raise exception 'TEAM_CALENDAR_CURRENT_ASSIGNMENT_REQUIRED';end if;
  return jsonb_build_object('bookingId',b.booking_id,'creatorId',b.creator_id,'buyerId',b.buyer_id,'postId',b.post_id,
   'sourceIdentity',b.source_identity,'assignmentRevision',b.assignment_revision,'membershipId',b.membership_id,'targetId',b.target_id,
   'connectionId',b.connection_id,'calendarOwnerId',b.calendar_owner_id,'accountId',b.account_id,'calendarId',b.calendar_id,
   'destinationUrl',b.destination_url,'origin',b.origin,'generation',b.generation,'reservationId',b.reservation_id);
 end if;
 if c.id is null or c.creator_id=k.buyer_id or c.status<>'connected' or not coalesce(s.active,false) or c.account_id is null
  or not public.sales_team_member_ready_v1(m.id) or not coalesce(t.is_active,false) or not coalesce(t.active,false) or t.weight<=0
  or not exists(select 1 from public.sales_team_destination_bindings_v1 where target_id=t.id and creator_id=k.creator_id and membership_id=m.id)
  or not (t.booking_url=p_origin||'/scheduling/book/'||c.id::text or t.booking_url='/scheduling/book/'||c.id::text)
  or not exists(select 1 from public.posts p where p.id=k.post_id and p.creator_id=k.creator_id and p.allow_booking and p.video_action='book'
   and p.product_id is null and p.active is not false and p.hidden_at is null and p.removed_at is null)
  or not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled)
  or not exists(select 1 from public.google_calendar_watches_v1 w where w.id::text=c.webhook_id and w.connection_id=c.id
   and w.calendar_id=s.calendar_id and w.status='active' and w.expires_at>clock_timestamp())
 then raise exception 'TEAM_CALENDAR_CURRENT_ASSIGNMENT_REQUIRED';end if;
 -- A proven-unsent same-assignment attempt retries its original reservation.
 select binding.* into b from public.team_calendar_bindings_v1 binding join public.google_booking_reservations_v1 reservation on reservation.id=binding.reservation_id
  where binding.booking_id=k.id and binding.assignment_revision=a.revision and binding.membership_id=m.id and binding.target_id=t.id
   and binding.connection_id=c.id and binding.calendar_id=s.calendar_id and binding.account_id=c.account_id and binding.destination_url=t.booking_url
   and reservation.status in ('held','failed') and reservation.event_id is null
   and not exists(select 1 from public.google_booking_jobs_v1 j where j.reservation_id=reservation.id and (j.status<>'failed' or j.mutation_started_at is not null))
  order by binding.generation desc limit 1;
 generation:=b.generation;
 if generation is null then select coalesce(max(binding.generation),0)+1 into generation from public.team_calendar_bindings_v1 binding where binding.booking_id=k.id;end if;
 intent:=creatornet_calendar_team_private.intent_id_v1(k.id,generation);
 return jsonb_build_object('bookingId',k.id,'creatorId',k.creator_id,'buyerId',k.buyer_id,'postId',k.post_id,
  'sourceIdentity',source,'assignmentRevision',a.revision,'membershipId',m.id,'targetId',t.id,
  'connectionId',c.id,'calendarOwnerId',c.creator_id,'accountId',c.account_id,'calendarId',s.calendar_id,
  'destinationUrl',t.booking_url,'origin',p_origin,'generation',generation,'reservationId',intent);
end $$;

create function public.reserve_team_google_booking_v1(p_booking uuid,p_buyer uuid,p_connection uuid,p_origin text,p_generation integer,
 p_assignment_revision integer,p_id uuid,p_start timestamptz,p_end timestamptz,p_calendar text,p_policy jsonb)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
declare context jsonb;b public.team_calendar_bindings_v1;creator uuid;
begin
 select creator_id into creator from public.bookings where id=p_booking and buyer_id=p_buyer;
 if creator is null then raise exception 'TEAM_CALENDAR_BOOKING_UNAVAILABLE';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||creator::text,0));
 perform 1 from public.bookings where id=p_booking and buyer_id=p_buyer for update;
 context:=public.read_team_google_booking_v1(p_booking,p_buyer,p_connection,p_origin);
 if context?'blockedBy' then raise exception 'TEAM_CALENDAR_ORIGINAL_APPOINTMENT_PENDING';end if;
 if context->>'reservationId' is distinct from p_id::text or (context->>'generation')::integer is distinct from p_generation
  or (context->>'assignmentRevision')::integer is distinct from p_assignment_revision or context->>'calendarId' is distinct from p_calendar
 then raise exception 'TEAM_CALENDAR_INTENT_CHANGED';end if;
 select * into b from public.team_calendar_bindings_v1 where reservation_id=p_id;
 if not found then
  insert into public.team_calendar_bindings_v1(reservation_id,booking_id,generation,creator_id,buyer_id,post_id,source_identity,
   assignment_revision,membership_id,target_id,connection_id,calendar_owner_id,account_id,calendar_id,destination_url,origin)
  values(p_id,p_booking,p_generation,(context->>'creatorId')::uuid,p_buyer,(context->>'postId')::uuid,context->>'sourceIdentity',
   p_assignment_revision,(context->>'membershipId')::uuid,(context->>'targetId')::uuid,p_connection,(context->>'calendarOwnerId')::uuid,
   context->>'accountId',p_calendar,context->>'destinationUrl',p_origin);
 end if;
 perform public.reserve_google_booking_checked_v1(p_id,p_connection,p_buyer,(context->>'postId')::uuid,p_start,p_end,null,null,p_calendar,p_policy);
 perform public.enqueue_google_booking_create_v1(p_id,p_buyer);
 return p_id;
end $$;

create function public.read_team_calendar_reservation_v1(p_id uuid,p_buyer uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare b public.team_calendar_bindings_v1;a public.sales_team_assignments_v1;url text;changed boolean;
begin
 select * into b from public.team_calendar_bindings_v1 where reservation_id=p_id and buyer_id=p_buyer;
 if not found then return null;end if;
 perform creatornet_calendar_team_private.assert_identity_v1(p_id);
 select * into a from public.sales_team_assignments_v1 where booking_id=b.booking_id and creator_id=b.creator_id;
 changed:=a.booking_id is null or a.revision<>b.assignment_revision or a.membership_id<>b.membership_id or a.target_id<>b.target_id;
 if creatornet_calendar_team_private.ready_v1() and exists(select 1 from public.google_booking_reservations_v1 r
  where r.id=p_id and (r.status='canceled' or (r.status='failed' and r.event_id is null and not exists(
   select 1 from public.google_booking_jobs_v1 j where j.reservation_id=r.id and (j.status<>'failed' or j.mutation_started_at is not null))))) then
  select policy.origin||'/scheduling/book/'||c.id::text||'?team_booking_id='||b.booking_id::text into url
   from public.sales_team_memberships_v1 m join public.booking_targets t on t.id=a.target_id and t.creator_id=a.creator_id
   join public.scheduling_connections_v1 c on c.creator_id=m.user_id and c.provider='google' and c.status='connected'
   cross join public.team_calendar_policy_v1 policy
   where m.id=a.membership_id and m.creator_id=a.creator_id and public.sales_team_member_ready_v1(m.id)
    and policy.singleton and t.is_active and coalesce(t.active,false) and t.weight>0
    and (t.booking_url=policy.origin||'/scheduling/book/'||c.id::text or t.booking_url='/scheduling/book/'||c.id::text);
 end if;
 return jsonb_build_object('bookingId',b.booking_id,'connectionId',b.connection_id,'postId',b.post_id,'calendarOwnerId',b.calendar_owner_id,
  'assignmentChanged',coalesce(changed,true),'canReschedule',exists(select 1 from public.google_booking_reservations_v1 r
   where r.id=p_id and r.status='confirmed' and creatornet_calendar_team_private.admitted_v1(p_id)),'rebookingUrl',url);
end $$;

-- A never-sent operation can be settled after authority loss. Possible delivery
-- remains bound/occupied and must be read/reconciled, never guessed absent.
create function public.recover_unsent_team_calendar_job_v1(p_job uuid,p_worker uuid,p_new_work_enabled boolean default true)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare j public.google_booking_jobs_v1;r public.google_booking_reservations_v1;b public.team_calendar_bindings_v1;
begin
 select binding.* into b from public.team_calendar_bindings_v1 binding join public.google_booking_jobs_v1 job on job.reservation_id=binding.reservation_id where job.id=p_job;
 if not found then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||b.creator_id::text,0));
 perform 1 from public.bookings where id=b.booking_id for update;
 select * into j from public.google_booking_jobs_v1 where id=p_job and status='processing' and lease_id=p_worker for update;
 if not found or j.lease_until<=clock_timestamp() then raise exception 'Booking worker lease expired';end if;
 if j.action not in ('create','reschedule') or j.mutation_started_at is not null or
  (coalesce(p_new_work_enabled,false) and creatornet_calendar_team_private.admitted_v1(b.reservation_id)) then return false;end if;
 select * into r from public.google_booking_reservations_v1 where id=b.reservation_id for update;
 if r.revision<>j.revision or r.status is distinct from (case j.action when 'create' then 'creating' else 'rescheduling' end)
  or (j.action='create' and r.event_id is not null) or (j.action='reschedule' and r.event_id is null) then return false;end if;
 update public.google_booking_reservations_v1 set status=case j.action when 'create' then 'failed' else 'confirmed' end,
  desired_starts_at=null,desired_ends_at=null,recovery_code=null,updated_at=clock_timestamp() where id=r.id;
 update public.google_booking_jobs_v1 set status='failed',last_error_code='team_calendar_authority_changed',lease_id=null,lease_until=null where id=j.id;
 return true;
end $$;

create function public.read_team_booking_scheduling_v1(p_creator uuid,p_actor uuid,p_bookings uuid[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare role text;member uuid;result jsonb;
begin
 if coalesce(cardinality(p_bookings),0)>100 then raise exception 'TEAM_CALENDAR_SCOPE_TOO_LARGE';end if;
 role:=public.sales_team_actor_role_v1(p_creator,p_actor);
 if role is null then raise exception 'TEAM_CALENDAR_ACCESS_DENIED';end if;
 if role='closer' then
  select id into member from public.sales_team_memberships_v1 where creator_id=p_creator and user_id=p_actor and status='active';
  if member is null or not public.sales_team_member_ready_v1(member) then raise exception 'TEAM_CALENDAR_ACCESS_DENIED';end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('bookingId',k.id,'buyerId',k.buyer_id,'postId',k.post_id,
  'teamManaged',(a.booking_id is not null or b.reservation_id is not null),
  'scheduling',case when b.reservation_id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
   'provider','google','assignmentRevision',b.assignment_revision,'membershipId',b.membership_id,'targetId',b.target_id,
   'status',case when (select count(*) from public.team_calendar_bindings_v1 sibling join public.google_booking_reservations_v1 prior on prior.id=sibling.reservation_id
     where sibling.booking_id=k.id and prior.status<>'canceled' and not (prior.status='failed' and prior.event_id is null
      and not exists(select 1 from public.google_booking_jobs_v1 j where j.reservation_id=prior.id and (j.status<>'failed' or j.mutation_started_at is not null))))>1 then 'review_required'
    when c.creator_id is distinct from b.calendar_owner_id or c.account_id is distinct from b.account_id then 'review_required'
    when r.status='confirmed' and (r.event_id is distinct from encode(sha256(convert_to('creatornet-booking:'||r.id::text,'UTF8')),'hex') or coalesce(length(r.event_etag),0)=0) then 'review_required'
    when r.status='confirmed' then 'scheduled' when r.status in ('rescheduling','canceling','canceled') then r.status
    when r.status='failed' then case when r.event_id is null and not exists(select 1 from public.google_booking_jobs_v1 j where j.reservation_id=r.id and (j.status<>'failed' or j.mutation_started_at is not null)) then 'not_scheduled' else 'review_required' end
    else 'awaiting_confirmation' end,
   'scheduledAt',case when r.status in ('confirmed','rescheduling','canceling','canceled') then r.starts_at else null end,
   'requestedAt',case when r.status='rescheduling' then r.desired_starts_at else null end,
   'observedAt',r.updated_at,
   'previousAssignment',a.revision is distinct from b.assignment_revision or a.membership_id is distinct from b.membership_id or a.target_id is distinct from b.target_id
  )) end) order by k.id),'[]'::jsonb) into result
 from public.bookings k left join public.sales_team_assignments_v1 a on a.booking_id=k.id and a.creator_id=k.creator_id
 left join lateral(select binding.* from public.team_calendar_bindings_v1 binding where binding.booking_id=k.id order by binding.generation desc limit 1) b on true
 left join public.google_booking_reservations_v1 r on r.id=b.reservation_id
 left join public.scheduling_connections_v1 c on c.id=b.connection_id and c.provider='google'
 where k.creator_id=p_creator and k.id=any(p_bookings) and (role in ('owner','manager') or a.membership_id=member);
 return result;
end $$;

-- Original source recovery is an installed compatibility prerequisite, not a
-- new-work flag. Missing RPC/schema/ACL is UNKNOWN to its application callers.
create function creatornet_calendar_team_private.recovery_ready_v1()
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.team_calendar_policy_v1 where singleton
  and recovery_contract_sha256=creatornet_calendar_team_private.contract_digest_v1());
$$;

create function creatornet_calendar_team_private.lock_original_v1(p_creator uuid,p_session text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||p_creator::text,0));
 if p_session is not null then
  perform pg_advisory_xact_lock(hashtextextended('sales-team-session:'||p_session,0));end if;
end $$;

-- This check is called BEFORE retained calendar/worker locks. Direct table
-- admissions also run it from the reservation identity trigger. Status and
-- cancellation of original ordinary reservations do not call this new-work gate.
create function creatornet_calendar_team_private.admit_ordinary_source_v1(p_buyer uuid,p_post uuid,p_attribution uuid,p_try boolean default false,p_purchase uuid default null)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.discover_booking_attribution_v1; owner_id uuid; captured_session text;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if p_attribution is null then
  select creator_id into owner_id from public.posts where id=p_post;
 else
  select * into a from public.discover_booking_attribution_v1 where id=p_attribution;
  if not found then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
  owner_id:=a.creator_id;captured_session:=a.setup_session_id;
 end if;
 if owner_id is null then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if p_try then
  if not pg_try_advisory_xact_lock(hashtextextended('sales-team:'||owner_id::text,0))
   or captured_session is not null and not pg_try_advisory_xact_lock(hashtextextended('sales-team-session:'||captured_session,0))
  then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 else perform creatornet_calendar_team_private.lock_original_v1(owner_id,captured_session);end if;
 if p_attribution is not null then
  select * into a from public.discover_booking_attribution_v1 where id=p_attribution;
  if not found or a.creator_id is distinct from owner_id or a.user_id is distinct from p_buyer or a.post_id is distinct from p_post
   or a.setup_session_id is distinct from captured_session then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 end if;
 if not creatornet_calendar_team_private.recovery_ready_v1() then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if exists(select 1 from public.sales_team_booking_sources_v1 s where
   s.source_identity='attribution:'||a.id::text or s.source_session_id=a.setup_session_id
   or s.creator_id=owner_id and s.buyer_id=p_buyer and s.post_id=p_post and s.source_identity='lead'
    and not coalesce(p_purchase is not null and a.setup_session_id='paid-call:'||p_purchase::text,false))
 then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
end $$;

create function creatornet_calendar_team_private.guard_original_source_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare session_id text; alias_id uuid;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if new.source_identity='lead' then session_id:=null;
 elsif new.source_identity like 'attribution:%' then
  alias_id:=substr(new.source_identity,13)::uuid;
  select setup_session_id into session_id from public.discover_booking_attribution_v1
   where id=alias_id and creator_id=new.creator_id and user_id=new.buyer_id and post_id=new.post_id;
 elsif new.source_identity like 'free_checkout:%' then
  alias_id:=substr(new.source_identity,15)::uuid;
  select stripe_session_id into session_id from public.free_booking_checkouts
   where id=alias_id and creator_id=new.creator_id and buyer_id=new.buyer_id and post_id=new.post_id and status='complete';
 else raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if new.source_identity<>'lead' and (session_id is null or session_id not like 'cs\_%' escape '\')
 then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if new.source_session_id is not null and new.source_session_id is distinct from session_id
 then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 perform creatornet_calendar_team_private.lock_original_v1(new.creator_id,session_id);
 if not creatornet_calendar_team_private.recovery_ready_v1() then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 -- Fresh reads after the lock. Never lock or write alias rows here: identity
 -- updates already hold their row before taking the session lock.
 if new.source_identity like 'attribution:%' and not exists(select 1 from public.discover_booking_attribution_v1
  where id=alias_id and creator_id=new.creator_id and user_id=new.buyer_id and post_id=new.post_id and setup_session_id=session_id)
 or new.source_identity like 'free_checkout:%' and not exists(select 1 from public.free_booking_checkouts
  where id=alias_id and creator_id=new.creator_id and buyer_id=new.buyer_id and post_id=new.post_id and stripe_session_id=session_id and status='complete')
 then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 perform 1 from public.bookings where id=new.booking_id and creator_id=new.creator_id and buyer_id=new.buyer_id and post_id=new.post_id for update;
 if not found then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if exists(select 1 from public.discover_booking_attribution_v1 where setup_session_id=session_id
  and (creator_id is distinct from new.creator_id or user_id is distinct from new.buyer_id or post_id is distinct from new.post_id))
 or exists(select 1 from public.free_booking_checkouts where stripe_session_id=session_id
  and (creator_id is distinct from new.creator_id or buyer_id is distinct from new.buyer_id or post_id is distinct from new.post_id))
 or exists(select 1 from public.sales_team_booking_sources_v1 where source_session_id=session_id
  and (creator_id is distinct from new.creator_id or buyer_id is distinct from new.buyer_id or post_id is distinct from new.post_id or booking_id is distinct from new.booking_id))
 then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if exists(select 1 from public.google_booking_reservations_v1 r left join public.discover_booking_attribution_v1 a on a.id=r.attribution_id
  where (a.setup_session_id=session_id or new.source_identity='lead' and r.buyer_id=new.buyer_id and r.original_post_id=new.post_id and r.team_calendar_binding_id is null
   and not coalesce(r.purchase_id is not null and a.setup_session_id='paid-call:'||r.purchase_id::text,false))
  and r.status<>'canceled' and not(r.status='failed' and r.event_id is null and not exists(
   select 1 from public.google_booking_jobs_v1 j where j.reservation_id=r.id and (j.status<>'failed' or j.mutation_started_at is not null))))
 then raise exception 'TEAM_CALENDAR_ORIGINAL_APPOINTMENT_PENDING';end if;
 new.source_session_id:=session_id;
 return new;
end $$;
create trigger team_original_source_insert_v1 before insert on public.sales_team_booking_sources_v1
 for each row execute function creatornet_calendar_team_private.guard_original_source_v1();

-- Alias identity is immutable once claimed. Later reciprocal aliases use only
-- the session lock and validate the exact tuple. Ordinary provider/status/time
-- updates take no new lock; no alias trigger acquires a creator lock.
create function creatornet_calendar_team_private.guard_original_alias_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare prior jsonb; value jsonb; old_session text; new_session text; session_key text; kind text; buyer_key text; session_key_name text;
begin
 kind:=case when tg_table_name='free_booking_checkouts' then 'free_checkout:' else 'attribution:' end;
 buyer_key:=case when tg_table_name='free_booking_checkouts' then 'buyer_id' else 'user_id' end;
 session_key_name:=case when tg_table_name='free_booking_checkouts' then 'stripe_session_id' else 'setup_session_id' end;
 if tg_op<>'INSERT' then prior:=to_jsonb(old);old_session:=prior->>session_key_name;end if;
 if tg_op<>'DELETE' then value:=to_jsonb(new);new_session:=value->>session_key_name;end if;
 if tg_op='UPDATE' and (prior->>'id',prior->>'creator_id',prior->>buyer_key,prior->>'post_id',old_session)
  is not distinct from (value->>'id',value->>'creator_id',value->>buyer_key,value->>'post_id',new_session) then return new;end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 for session_key in select distinct s collate "C" from unnest(array[old_session,new_session]) s where s is not null order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('sales-team-session:'||session_key,0));end loop;
 if tg_op<>'INSERT' and kind='attribution:' and exists(select 1 from public.google_booking_reservations_v1 r
  where r.attribution_id=(prior->>'id')::uuid and r.status<>'canceled' and not(r.status='failed' and r.event_id is null and not exists(
   select 1 from public.google_booking_jobs_v1 j where j.reservation_id=r.id and (j.status<>'failed' or j.mutation_started_at is not null))))
 then raise exception 'TEAM_CALENDAR_ORIGINAL_SOURCE_IMMUTABLE';end if;
 if tg_op<>'INSERT' and exists(select 1 from public.sales_team_booking_sources_v1 s
  where s.source_identity=kind||(prior->>'id') or s.source_session_id=old_session)
 then raise exception 'TEAM_CALENDAR_ORIGINAL_SOURCE_IMMUTABLE';end if;
 if tg_op<>'DELETE' and exists(select 1 from public.sales_team_booking_sources_v1 s
  where (s.source_session_id=new_session or s.source_identity=kind||(value->>'id')) and
  (s.creator_id::text is distinct from value->>'creator_id' or s.buyer_id::text is distinct from value->>buyer_key
   or s.post_id::text is distinct from value->>'post_id' or s.source_session_id is distinct from new_session))
 then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger team_original_attribution_identity_v1 before insert or update or delete on public.discover_booking_attribution_v1
 for each row execute function creatornet_calendar_team_private.guard_original_alias_v1();
create trigger team_original_free_identity_v1 before insert or update or delete on public.free_booking_checkouts
 for each row execute function creatornet_calendar_team_private.guard_original_alias_v1();

create function creatornet_calendar_team_private.guard_original_booking_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if tg_op='UPDATE' and (old.id,old.creator_id,old.buyer_id,old.post_id) is not distinct from (new.id,new.creator_id,new.buyer_id,new.post_id) then return new;end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'TEAM_CALENDAR_EXACT_SOURCE_REQUIRED';end if;
 if exists(select 1 from public.sales_team_booking_sources_v1 where booking_id=old.id)
 then raise exception 'TEAM_CALENDAR_ORIGINAL_SOURCE_IMMUTABLE';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger team_original_booking_identity_v1 before update or delete on public.bookings
 for each row execute function creatornet_calendar_team_private.guard_original_booking_v1();

create function public.resolve_original_team_booking_v1(p_creator uuid,p_buyer uuid,p_post uuid,
 p_session text default null,p_attribution uuid default null,p_free uuid default null,p_lead boolean default false)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.discover_booking_attribution_v1; f public.free_booking_checkouts; session_id text:=p_session; canonical uuid; count_ids integer; destination text;
begin
 if p_creator is null or p_buyer is null or p_post is null or p_lead is null or current_setting('transaction_isolation')<>'read committed' or not creatornet_calendar_team_private.recovery_ready_v1()
 then return jsonb_build_object('state','held');end if;
 if p_lead then
  if p_session is not null or p_attribution is not null or p_free is not null then return jsonb_build_object('state','held');end if;
 else
  if p_attribution is not null then
   select * into a from public.discover_booking_attribution_v1 where id=p_attribution;
   if not found or (a.creator_id,a.user_id,a.post_id) is distinct from (p_creator,p_buyer,p_post)
    or session_id is not null and session_id is distinct from a.setup_session_id then return jsonb_build_object('state','held');end if;
   session_id:=a.setup_session_id;
  end if;
  if p_free is not null then
   select * into f from public.free_booking_checkouts where id=p_free;
   if not found or (f.creator_id,f.buyer_id,f.post_id) is distinct from (p_creator,p_buyer,p_post) or f.status is distinct from 'complete'
    or session_id is not null and session_id is distinct from f.stripe_session_id then return jsonb_build_object('state','held');end if;
   session_id:=f.stripe_session_id;
  end if;
  if session_id is null or session_id not like 'cs\_%' escape '\' then return jsonb_build_object('state','held');end if;
 end if;
 perform creatornet_calendar_team_private.lock_original_v1(p_creator,session_id);
 -- This volatile function deliberately re-reads after waiting. Schema, ACL and
 -- all errors propagate as unknown; no exception handler turns them negative.
 if p_attribution is not null and not exists(select 1 from public.discover_booking_attribution_v1
  where id=p_attribution and (creator_id,user_id,post_id,setup_session_id) is not distinct from (p_creator,p_buyer,p_post,session_id))
 or p_free is not null and not exists(select 1 from public.free_booking_checkouts
  where id=p_free and (creator_id,buyer_id,post_id,stripe_session_id,status) is not distinct from (p_creator,p_buyer,p_post,session_id,'complete'))
 or exists(select 1 from public.discover_booking_attribution_v1 where setup_session_id=session_id
  and (creator_id,user_id,post_id) is distinct from (p_creator,p_buyer,p_post))
 or exists(select 1 from public.free_booking_checkouts where stripe_session_id=session_id
  and (creator_id,buyer_id,post_id) is distinct from (p_creator,p_buyer,p_post))
 then return jsonb_build_object('state','held');end if;
 if exists(select 1 from public.sales_team_booking_sources_v1 s where s.source_session_id=session_id
  and (s.creator_id,s.buyer_id,s.post_id) is distinct from (p_creator,p_buyer,p_post))
 then return jsonb_build_object('state','held');end if;
 select count(distinct s.booking_id),min(s.booking_id::text)::uuid into count_ids,canonical
 from public.sales_team_booking_sources_v1 s where
  (not p_lead and s.source_session_id=session_id) or (p_lead and s.source_identity='lead'
   and (s.creator_id,s.buyer_id,s.post_id) is not distinct from (p_creator,p_buyer,p_post));
 if count_ids>1 then return jsonb_build_object('state','held');end if;
 if canonical is not null then
  if not exists(select 1 from public.bookings where id=canonical and (creator_id,buyer_id,post_id) is not distinct from (p_creator,p_buyer,p_post))
  then return jsonb_build_object('state','held');end if;
  -- A current exact native link can be read without seeding, adopting another
  -- alias or advancing routing turns. Shutdown still returns positive ownership
  -- with no new-work destination. Native context retains its outstanding gate.
  select target.booking_url into destination from public.sales_team_assignments_v1 assignment
   join public.sales_team_destination_bindings_v1 d on d.membership_id=assignment.membership_id and d.target_id=assignment.target_id
   join public.booking_targets target on target.id=d.target_id and target.creator_id=d.creator_id
   join public.team_calendar_policy_v1 policy on policy.singleton
   join public.sales_team_creator_settings_v1 settings on settings.creator_id=p_creator
   where assignment.booking_id=canonical and settings.routing_enabled and creatornet_calendar_team_private.ready_v1()
   and exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled)
   and creatornet_calendar_team_private.eligible_native_destination_v1(p_creator,assignment.membership_id,assignment.target_id,p_buyer,policy.origin,target.booking_url);
  return jsonb_build_object('state','team','booking_id',canonical,'booking_url',destination);
 end if;
 -- Sessionless historical leads cannot be adopted by matching buyer/post.
 if not p_lead and exists(select 1 from public.sales_team_booking_sources_v1 where source_identity='lead'
  and (creator_id,buyer_id,post_id) is not distinct from (p_creator,p_buyer,p_post))
 then return jsonb_build_object('state','held');end if;
 return jsonb_build_object('state','legacy');
end $$;

do $acl$ declare routine record;begin
 for routine in select oid::regprocedure signature from pg_proc where pronamespace='creatornet_calendar_team_private'::regnamespace or
  oid=any(array[
   'public.read_team_google_booking_v1(uuid,uuid,uuid,text)'::regprocedure,
   'public.reserve_team_google_booking_v1(uuid,uuid,uuid,text,integer,integer,uuid,timestamptz,timestamptz,text,jsonb)'::regprocedure,
   'public.read_team_calendar_reservation_v1(uuid,uuid)'::regprocedure,
   'public.read_team_booking_scheduling_v1(uuid,uuid,uuid[])'::regprocedure,
   'public.recover_unsent_team_calendar_job_v1(uuid,uuid,boolean)'::regprocedure,
   'public.resolve_original_team_booking_v1(uuid,uuid,uuid,text,uuid,uuid,boolean)'::regprocedure,
   'public.reserve_google_booking_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid)'::regprocedure,
   'public.reserve_google_booking_checked_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,uuid,text,jsonb)'::regprocedure,
   'public.enqueue_google_booking_create_v1(uuid,uuid)'::regprocedure,
   'public.request_google_booking_change_v1(uuid,uuid,bigint,text,timestamptz,timestamptz)'::regprocedure,
   'public.reschedule_google_booking_checked_v1(uuid,uuid,bigint,timestamptz,timestamptz,jsonb)'::regprocedure,
   'public.begin_google_booking_mutation_v1(uuid,uuid)'::regprocedure]) loop
  execute format('revoke all on function %s from public,anon,authenticated',routine.signature);
  execute format('grant execute on function %s to service_role',routine.signature);
 end loop;
end $acl$;
-- Attest the installed recovery contract without enabling new routing/calendar
-- work. Service callers cannot update this policy or manufacture a negative.
update public.team_calendar_policy_v1 set recovery_contract_sha256=creatornet_calendar_team_private.contract_digest_v1() where singleton;
do $verify$ declare routine record;begin
 if (select enabled or origin is not null or contract_sha256 is not null from public.team_calendar_policy_v1 where singleton)
  then raise exception 'TEAM_CALENDAR_UNEXPECTED_ACTIVATION';end if;
 if has_table_privilege('service_role','public.team_calendar_policy_v1','UPDATE') or
  has_table_privilege('authenticated','public.team_calendar_bindings_v1','SELECT') or
  has_schema_privilege('authenticated','creatornet_calendar_team_private','USAGE')
  then raise exception 'TEAM_CALENDAR_PRIVILEGES_DIFFER';end if;
 for routine in select oid from pg_proc where pronamespace='creatornet_calendar_team_private'::regnamespace loop
  if (select prosecdef from pg_proc where oid=routine.oid) or has_function_privilege('anon',routine.oid,'EXECUTE')
   or has_function_privilege('authenticated',routine.oid,'EXECUTE') or not has_function_privilege('service_role',routine.oid,'EXECUTE')
  then raise exception 'TEAM_CALENDAR_PRIVILEGES_DIFFER';end if;
 end loop;
end $verify$;
-- No migration-time refresh, policy activation, grant to browsers, legacy
-- attribution adoption, provider call or financial write is included.
commit;
