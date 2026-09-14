begin;
create table public.discover_pilots_v1 (
 id text primary key check(id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 policy_version text not null check(policy_version='commercial-order-v1'),
 starts_at timestamptz not null, ends_at timestamptz not null,
 enabled boolean not null default false,
 followup_days integer not null default 90 check(followup_days between 1 and 90),
 protocol text not null check(length(protocol)>0),
 check(ends_at>starts_at)
);
create table public.discover_pilot_assignments_v1 (
 experiment_id text not null references public.discover_pilots_v1(id),
 user_id uuid not null references auth.users(id) on delete cascade,
 variant text not null check(variant in ('control','commercial')),
 assigned_at timestamptz not null default now(),
 primary key(experiment_id,user_id)
);
alter table public.discover_sessions_v1 add column pilot_id text references public.discover_pilots_v1(id);
alter table public.discover_sessions_v1 add column pilot_variant text;
alter table public.discover_sessions_v1 add constraint discover_session_pilot_pair check (
 (pilot_id is null and pilot_variant is null) or
 (pilot_id is not null and pilot_variant is not null and pilot_variant in ('control','commercial') and tab='discover' and user_id is not null)
);
alter table public.discover_pilots_v1 enable row level security;
alter table public.discover_pilot_assignments_v1 enable row level security;
revoke all on public.discover_pilots_v1,public.discover_pilot_assignments_v1 from public,anon,authenticated;
grant select,insert,update on public.discover_pilots_v1 to service_role;
-- Enrollment cannot change an existing viewer's arm or assignment date.
grant select,insert on public.discover_pilot_assignments_v1 to service_role;
-- Freeze the registered protocol once anyone is enrolled. Enabled is the
-- emergency stop; a materially different experiment requires a new ID.
create function public.freeze_discover_pilot_v1() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.id,new.policy_version,new.starts_at,new.ends_at,new.followup_days,new.protocol)
   is distinct from (old.id,old.policy_version,old.starts_at,old.ends_at,old.followup_days,old.protocol)
   and exists(select 1 from public.discover_pilot_assignments_v1 where experiment_id=old.id)
 then raise exception 'Enrolled pilot protocol is immutable'; end if;
 return new;
end $$;
create trigger freeze_discover_pilot_v1 before update on public.discover_pilots_v1
 for each row execute function public.freeze_discover_pilot_v1();
revoke all on function public.freeze_discover_pilot_v1() from public,anon,authenticated;

-- Intention-to-treat outcomes include all channels after enrollment, including
-- zero-event viewers. They are not claimed to be Discover-attributed exposures.
-- Retain individual randomization units; aggregate currency separately.
create view public.discover_pilot_outcomes_v1 with (security_invoker=true) as
 select a.experiment_id,a.user_id,a.variant,a.assigned_at,
 a.assigned_at+make_interval(days=>p.followup_days) as observation_ends_at,
 count(e.id) filter(where e.kind='exposure') as exposure_events,
 count(distinct e.post_id) filter(where e.kind='exposure') as distinct_posts,
 count(distinct e.creator_id) filter(where e.kind='exposure') as distinct_creators,
 count(e.id) filter(where e.kind='qualified_view' and e.valid) as qualified_views,
 count(e.id) filter(where e.kind='booking_scheduled' and e.valid) as scheduled_bookings,
 count(e.id) filter(where e.kind in ('purchase','mentorship_purchase') and e.valid) as purchases,
 count(e.id) filter(where e.kind='mentorship_purchase' and e.valid) as mentorship_purchases
 from public.discover_pilot_assignments_v1 a join public.discover_pilots_v1 p on p.id=a.experiment_id
 left join public.discover_events_v1 e on e.user_id=a.user_id
  and e.occurred_at>=a.assigned_at and e.occurred_at<a.assigned_at+make_interval(days=>p.followup_days)
 group by a.experiment_id,a.user_id,a.variant,a.assigned_at,p.followup_days;
revoke all on public.discover_pilot_outcomes_v1 from public,anon,authenticated;
grant select on public.discover_pilot_outcomes_v1 to service_role;
create view public.discover_pilot_revenue_v1 with (security_invoker=true) as
 select a.experiment_id,a.user_id,a.variant,e.currency,sum(e.amount_cents) as net_amount_cents
 from public.discover_pilot_assignments_v1 a join public.discover_pilots_v1 p on p.id=a.experiment_id
 join public.discover_events_v1 e on e.user_id=a.user_id
  and e.occurred_at>=a.assigned_at and e.occurred_at<a.assigned_at+make_interval(days=>p.followup_days)
 where e.kind in ('purchase','mentorship_purchase') and e.valid
 group by a.experiment_id,a.user_id,a.variant,e.currency;
revoke all on public.discover_pilot_revenue_v1 from public,anon,authenticated;
grant select on public.discover_pilot_revenue_v1 to service_role;
commit;
