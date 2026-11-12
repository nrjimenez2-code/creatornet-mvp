-- Separate, default-off in-app history. No historical enrollment, provider
-- dispatch, timing inference, exception closure or BANK confirmation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ begin
 perform 'creatornet_team_private.bank_exception_snapshot_v1(uuid,uuid)'::regprocedure;
 perform 'public.sales_team_bank_exception_reviews_v1'::regclass;
end $parents$;

create table public.sales_team_bank_alert_policy_v1 (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,contract_sha256 text check(contract_sha256~'^[a-f0-9]{64}$')
);
insert into public.sales_team_bank_alert_policy_v1(singleton) values(true);
create table public.sales_team_bank_alerts_v1 (
 id uuid primary key default gen_random_uuid(),position bigint generated always as identity unique,
 request_id uuid not null references public.sales_team_transfer_completions_v1(request_id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 kind text not null check(kind in ('payout_state','acknowledged','escalated')),
 source_kind text not null check(source_kind in ('transfer','observation','reversal','review')),
 source_id uuid not null,signal_sha256 text not null check(signal_sha256~'^[a-f0-9]{64}$'),
 snapshot jsonb not null check(snapshot->'bankConfirmed'='false'::jsonb and snapshot->'outstanding'='true'::jsonb),
 created_at timestamptz not null default clock_timestamp(),unique(source_kind,source_id)
);
create index sales_team_bank_alert_scope_v1 on public.sales_team_bank_alerts_v1(creator_id,position desc);
create index sales_team_bank_alert_original_v1 on public.sales_team_bank_alerts_v1(request_id,kind,position desc);
create table public.sales_team_bank_alert_reads_v1 (
 alert_id uuid not null references public.sales_team_bank_alerts_v1(id) on delete restrict,
 actor_id uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),primary key(alert_id,actor_id)
);
create trigger sales_team_bank_alert_immutable_v1 before update or delete on public.sales_team_bank_alerts_v1
 for each row execute function creatornet_team_private.reject_history_change();
create trigger sales_team_bank_alert_read_immutable_v1 before update or delete on public.sales_team_bank_alert_reads_v1
 for each row execute function creatornet_team_private.reject_history_change();

create function creatornet_team_private.bank_alert_signal_v1(p_state jsonb)
returns text language sql immutable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to((p_state-'checkId'-'observedAt')::text,'UTF8')),'hex')
$$;
create function creatornet_team_private.bank_alert_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(coalesce(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\n' order by p.oid::regprocedure::text collate "C"),'')||':'||creatornet_team_private.bank_review_contract_digest_v1()||':'||
  (select string_agg(pg_get_triggerdef(t.oid)||':'||t.tgenabled::text,E'\n' order by t.tgname collate "C") from pg_trigger t
   where t.tgname in ('sales_team_bank_alert_transfer_v1','sales_team_bank_alert_observation_v1','sales_team_bank_alert_reversal_v1','sales_team_bank_alert_review_v1','sales_team_bank_alert_immutable_v1','sales_team_bank_alert_read_immutable_v1')),'UTF8')),'hex')
 from pg_proc p where (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in
 ('bank_alert_signal_v1','bank_alert_contract_digest_v1','bank_alert_ready_v1','bank_alert_access_v1','capture_bank_alert_v1')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('read_sales_team_bank_alerts_v1','mark_sales_team_bank_alert_read_v1'))
$$;
create function creatornet_team_private.bank_alert_ready_v1()
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_bank_alert_policy_v1 where singleton and enabled
  and contract_sha256=creatornet_team_private.bank_alert_contract_digest_v1())
$$;
create function creatornet_team_private.bank_alert_access_v1(p_creator_id uuid,p_actor_id uuid,p_request_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare access jsonb;begin
 access:=public.read_sales_team_statement_v1(p_creator_id,p_actor_id,null,1);
 if coalesce(access->>'scope','') not in ('creator','closer') or access->>'creatorId' is distinct from p_creator_id::text or
  (p_request_id is not null and not exists(select 1 from public.sales_team_transfer_requests_v1 q
   where q.id=p_request_id and q.creator_id=p_creator_id and
   (access->>'scope'='creator' or q.beneficiary='closer' and q.beneficiary_user_id=p_actor_id)))
 then raise exception 'BANK_ALERT_ACCESS_DENIED';end if;
 return access;
end $$;

create function creatornet_team_private.capture_bank_alert_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_request_id uuid;v_creator uuid;v_source_id uuid;v_source_kind text;v_kind text:='payout_state';v_snapshot jsonb;v_signal text;begin
 -- Disabled policy does not change any retained owner's behavior or backfill.
 if not exists(select 1 from public.sales_team_bank_alert_policy_v1 where singleton and enabled) then return new;end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'BANK_ALERT_READ_COMMITTED_REQUIRED';end if;
 if tg_table_name='sales_team_transfer_reversal_completions_v1' then v_request_id:=new.transfer_request_id;v_source_id:=new.operation_id;v_source_kind:='reversal';
 elsif tg_table_name='sales_team_beneficiary_payout_observations_v1' then v_request_id:=new.request_id;v_source_id:=new.check_id;v_source_kind:='observation';
 elsif tg_table_name='sales_team_bank_exception_reviews_v1' then v_request_id:=new.request_id;v_source_id:=new.id;v_source_kind:='review';v_kind:=new.action;
 else v_request_id:=new.request_id;v_source_id:=new.request_id;v_source_kind:='transfer';end if;
 select q.creator_id into v_creator from public.sales_team_transfer_requests_v1 q where q.id=v_request_id;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||v_creator::text,0));
 if not creatornet_team_private.bank_alert_ready_v1() then raise exception 'BANK_ALERT_AUTHORITY_REQUIRED';end if;
 if v_source_kind='review' then v_snapshot:=new.snapshot;else v_snapshot:=creatornet_team_private.bank_exception_snapshot_v1(v_creator,v_request_id);end if;
 v_signal:=creatornet_team_private.bank_alert_signal_v1(v_snapshot);
 -- Repeated provider observations with only a new check/time are not new alerts.
 -- A later return to an earlier state is a new transition, not globally deduped.
 if v_kind='payout_state' and v_signal is not distinct from (select a.signal_sha256 from public.sales_team_bank_alerts_v1 a
  where a.request_id=v_request_id and a.kind='payout_state' order by a.position desc limit 1) then return new;end if;
 insert into public.sales_team_bank_alerts_v1(request_id,creator_id,kind,source_kind,source_id,signal_sha256,snapshot)
 values(v_request_id,v_creator,v_kind,v_source_kind,v_source_id,v_signal,v_snapshot) on conflict do nothing;
 if not creatornet_team_private.bank_alert_ready_v1() then raise exception 'BANK_ALERT_AUTHORITY_REQUIRED';end if;
 return new;
end $$;
create trigger sales_team_bank_alert_transfer_v1 after insert on public.sales_team_transfer_completions_v1
 for each row execute function creatornet_team_private.capture_bank_alert_v1();
create trigger sales_team_bank_alert_observation_v1 after insert on public.sales_team_beneficiary_payout_observations_v1
 for each row execute function creatornet_team_private.capture_bank_alert_v1();
create trigger sales_team_bank_alert_reversal_v1 after insert on public.sales_team_transfer_reversal_completions_v1
 for each row execute function creatornet_team_private.capture_bank_alert_v1();
create trigger sales_team_bank_alert_review_v1 after insert on public.sales_team_bank_exception_reviews_v1
 for each row execute function creatornet_team_private.capture_bank_alert_v1();

create function public.read_sales_team_bank_alerts_v1(p_creator_id uuid,p_actor_id uuid,p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare access jsonb;cursor_position bigint;entries jsonb;more boolean;begin
 if not creatornet_team_private.bank_alert_ready_v1() then raise exception 'BANK_ALERT_AUTHORITY_REQUIRED';end if;
 access:=creatornet_team_private.bank_alert_access_v1(p_creator_id,p_actor_id);
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'INVALID_BANK_ALERT_LIMIT';end if;
 if p_cursor is not null then
  select a.position into cursor_position from public.sales_team_bank_alerts_v1 a join public.sales_team_transfer_requests_v1 q on q.id=a.request_id
  where a.id=p_cursor and a.creator_id=p_creator_id and (access->>'scope'='creator' or q.beneficiary='closer' and q.beneficiary_user_id=p_actor_id);
  if cursor_position is null then raise exception 'INVALID_BANK_ALERT_CURSOR';end if;
 end if;
 with candidates as materialized (
  select a.* from public.sales_team_bank_alerts_v1 a join public.sales_team_transfer_requests_v1 q on q.id=a.request_id
  where a.creator_id=p_creator_id and (access->>'scope'='creator' or q.beneficiary='closer' and q.beneficiary_user_id=p_actor_id)
   and (p_cursor is null or a.position<cursor_position) order by a.position desc limit p_limit+1
 ), visible as materialized (select * from candidates order by position desc limit p_limit)
 select coalesce((select jsonb_agg(jsonb_build_object('alertId',a.id,'kind',a.kind,'state',a.snapshot,
  'createdAt',to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'readAt',(select to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from public.sales_team_bank_alert_reads_v1 r where r.alert_id=a.id and r.actor_id=p_actor_id),
  'appliesToCurrentState',case when a.kind='payout_state' then a.signal_sha256=creatornet_team_private.bank_alert_signal_v1(creatornet_team_private.bank_exception_snapshot_v1(p_creator_id,a.request_id))
   else a.snapshot=creatornet_team_private.bank_exception_snapshot_v1(p_creator_id,a.request_id) end) order by a.position desc) from visible a),'[]'::jsonb),
  (select count(*)>p_limit from candidates) into entries,more;
 return jsonb_build_object('creatorId',p_creator_id,'scope',access->>'scope','membershipStatus',access->'membershipStatus',
  'entries',entries,'hasMore',more,'nextCursor',case when more then entries->(jsonb_array_length(entries)-1)->>'alertId' else null end);
end $$;

create function public.mark_sales_team_bank_alert_read_v1(p_creator_id uuid,p_actor_id uuid,p_alert_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare request_id uuid;stamp timestamptz;begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'BANK_ALERT_READ_COMMITTED_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||p_creator_id::text,0));
 if not creatornet_team_private.bank_alert_ready_v1() then raise exception 'BANK_ALERT_AUTHORITY_REQUIRED';end if;
 select a.request_id into request_id from public.sales_team_bank_alerts_v1 a where a.id=p_alert_id and a.creator_id=p_creator_id;
 if request_id is null then raise exception 'BANK_ALERT_ACCESS_DENIED';end if;
 perform creatornet_team_private.bank_alert_access_v1(p_creator_id,p_actor_id,request_id);
 insert into public.sales_team_bank_alert_reads_v1(alert_id,actor_id) values(p_alert_id,p_actor_id) on conflict do nothing;
 perform creatornet_team_private.bank_alert_access_v1(p_creator_id,p_actor_id,request_id);
 if not creatornet_team_private.bank_alert_ready_v1() then raise exception 'BANK_ALERT_AUTHORITY_REQUIRED';end if;
 select created_at into stamp from public.sales_team_bank_alert_reads_v1 where alert_id=p_alert_id and actor_id=p_actor_id;
 return jsonb_build_object('alertId',p_alert_id,'readAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'bankConfirmed',false,'outstanding',true);
end $$;

alter table public.sales_team_bank_alert_policy_v1 enable row level security;
alter table public.sales_team_bank_alerts_v1 enable row level security;
alter table public.sales_team_bank_alert_reads_v1 enable row level security;
revoke all on public.sales_team_bank_alert_policy_v1,public.sales_team_bank_alerts_v1,public.sales_team_bank_alert_reads_v1 from public,anon,authenticated,service_role;
revoke all on sequence public.sales_team_bank_alerts_v1_position_seq from public,anon,authenticated,service_role;
revoke all on function creatornet_team_private.bank_alert_signal_v1(jsonb),creatornet_team_private.bank_alert_contract_digest_v1(),creatornet_team_private.bank_alert_ready_v1(),creatornet_team_private.bank_alert_access_v1(uuid,uuid,uuid),creatornet_team_private.capture_bank_alert_v1() from public,anon,authenticated,service_role;
revoke all on function public.read_sales_team_bank_alerts_v1(uuid,uuid,uuid,integer),public.mark_sales_team_bank_alert_read_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_sales_team_bank_alerts_v1(uuid,uuid,uuid,integer),public.mark_sales_team_bank_alert_read_v1(uuid,uuid,uuid) to service_role;
commit;
