begin;
alter table public.discover_sessions_v1 add column pilot_placements jsonb not null default '{}';
create table public.discover_pilot_exposures_v1 (
 session_id uuid not null, post_id uuid not null,
 experiment_id text not null, user_id uuid not null,
 variant text not null check(variant in ('control','commercial')),
 creator_id uuid not null, position integer not null check(position>=0),
 placement text not null check(placement in ('standard','cold_start','retest','related_trial')),
 age_days double precision not null check(age_days>=0),
 evidence_exposures integer not null check(evidence_exposures>=0),
 audience text not null, offer_type text not null, categories text[] not null, topics text[] not null,
 exposed_at timestamptz not null,
 primary key(session_id,post_id),
 foreign key(experiment_id,user_id) references public.discover_pilot_assignments_v1(experiment_id,user_id) on delete cascade
);
-- No session/post FK: evidence must survive snapshot expiry and post deletion.
alter table public.discover_pilot_exposures_v1 enable row level security;
revoke all on public.discover_pilot_exposures_v1 from public,anon,authenticated;
grant select,insert on public.discover_pilot_exposures_v1 to service_role;
create index discover_pilot_exposures_cohort_v1 on public.discover_pilot_exposures_v1(experiment_id,variant,exposed_at);
create function public.record_discover_pilot_exposure_v1() returns trigger language plpgsql set search_path='' as $$
declare s public.discover_sessions_v1; m jsonb; session_key text;
begin
 if new.kind<>'exposure' or new.user_id is null then return new; end if;
 session_key:=split_part(new.entity_key,':',1);
 if session_key !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return new; end if;
 select * into s from public.discover_sessions_v1 where id=session_key::uuid;
 if not found or s.pilot_id is null or s.tab<>'discover' or s.user_id is distinct from new.user_id
  or s.actor<>new.actor or s.expires_at<=new.occurred_at or new.post_id<>all(s.post_ids)
  or new.entity_key<>s.id::text||':'||new.post_id::text then return new; end if;
 if not exists(select 1 from public.discover_pilot_assignments_v1 a
  where a.experiment_id=s.pilot_id and a.user_id=new.user_id and a.variant=s.pilot_variant) then return new; end if;
 m:=s.pilot_placements->new.post_id::text;
 if m is null then return new; end if;
 insert into public.discover_pilot_exposures_v1(session_id,post_id,experiment_id,user_id,variant,creator_id,
  position,placement,age_days,evidence_exposures,audience,offer_type,categories,topics,exposed_at)
 values(s.id,new.post_id,s.pilot_id,new.user_id,s.pilot_variant,new.creator_id,
  array_position(s.post_ids,new.post_id)-1,m->>'placement',(m->>'ageDays')::double precision,
  (m->>'evidenceExposures')::integer,coalesce(s.audiences->>new.post_id::text,'general'),new.offer_type,new.categories,new.topics,new.occurred_at)
 on conflict(session_id,post_id) do nothing;
 return new;
end $$;
revoke all on function public.record_discover_pilot_exposure_v1() from public,anon,authenticated;
create trigger record_discover_pilot_exposure_v1 after insert on public.discover_events_v1
 for each row execute function public.record_discover_pilot_exposure_v1();
commit;
