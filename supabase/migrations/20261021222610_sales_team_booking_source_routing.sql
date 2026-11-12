-- Local candidate only. A source identifies lead creation, never a confirmed
-- calendar appointment. Multiple verified entry points may share one live lead.
create table public.sales_team_booking_sources_v1(
 creator_id uuid not null references auth.users(id),
 buyer_id uuid not null references auth.users(id),
 post_id uuid not null references public.posts(id),
 source_identity text not null check(length(source_identity) between 1 and 180),
 booking_id uuid not null references public.bookings(id),
 created_at timestamptz not null default clock_timestamp(),
 primary key(creator_id,buyer_id,post_id,source_identity)
);
create index sales_team_booking_sources_booking_v1 on public.sales_team_booking_sources_v1(booking_id);
alter table public.sales_team_booking_sources_v1 enable row level security;
revoke all on public.sales_team_booking_sources_v1 from public,anon,authenticated;
grant select,insert on public.sales_team_booking_sources_v1 to service_role;
create trigger sales_team_booking_sources_immutable_v1 before update or delete on public.sales_team_booking_sources_v1
for each row execute function creatornet_team_private.reject_history_change();

create function public.seed_sales_team_booking_v1(p_creator_id uuid,p_buyer_id uuid,p_post_id uuid,
 p_source_kind text default 'lead',p_source_id uuid default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_settings public.sales_team_creator_settings_v1; v_identity text;
 v_booking public.bookings; v_assignment jsonb; v_reused boolean;
begin
 if p_buyer_id is null or p_buyer_id=p_creator_id then raise exception 'BOOKING_BUYER_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||p_creator_id::text,0));
 select * into v_settings from public.sales_team_creator_settings_v1 where creator_id=p_creator_id for update;
 if not coalesce(v_settings.routing_enabled,false) then raise exception 'TEAM_ROUTING_NOT_ENABLED'; end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled)
 then raise exception 'TEAM_SALES_DISABLED'; end if;
 if not exists(select 1 from public.posts where id=p_post_id and creator_id=p_creator_id and allow_booking)
 then raise exception 'BOOKING_OFFER_MISMATCH'; end if;
 if p_source_kind='lead' and p_source_id is null then
   v_identity:='lead';
 elsif p_source_kind='attribution' and exists(select 1 from public.discover_booking_attribution_v1
   where id=p_source_id and user_id=p_buyer_id and creator_id=p_creator_id and post_id=p_post_id) then
   v_identity:='attribution:'||p_source_id::text;
 elsif p_source_kind='free_checkout' and exists(select 1 from public.free_booking_checkouts
   where id=p_source_id and buyer_id=p_buyer_id and creator_id=p_creator_id and post_id=p_post_id and status='complete') then
   v_identity:='free_checkout:'||p_source_id::text;
 else raise exception 'BOOKING_SOURCE_MISMATCH'; end if;
 select b.* into v_booking from public.sales_team_booking_sources_v1 s join public.bookings b on b.id=s.booking_id
 where s.creator_id=p_creator_id and s.buyer_id=p_buyer_id and s.post_id=p_post_id and s.source_identity=v_identity for update of b;
 v_reused:=v_booking.id is not null;
 if v_booking.id is null then
   -- Adopt only a current, unpaid, unaccepted lead created during this routing
   -- enrollment. Earlier payments and historical bookings remain unattributed.
   select b.* into v_booking from public.bookings b
   left join public.sales_team_assignments_v1 a on a.booking_id=b.id
   where b.creator_id=p_creator_id and b.buyer_id=p_buyer_id and b.post_id=p_post_id
    and b.created_at>=v_settings.routing_enabled_at and b.status not in ('completed','canceled','cancelled')
    and b.linked_order_id is null and a.accepted_sale_id is null
    and not exists(select 1 from public.booking_payments bp where bp.booking_id=b.id)
   order by b.created_at desc,b.id limit 1 for update of b;
   v_reused:=v_booking.id is not null;
   if v_booking.id is null then
     insert into public.bookings(id,creator_id,buyer_id,post_id,status,created_at)
     values(gen_random_uuid(),p_creator_id,p_buyer_id,p_post_id,'booked',clock_timestamp()) returning * into v_booking;
   end if;
   insert into public.sales_team_booking_sources_v1(creator_id,buyer_id,post_id,source_identity,booking_id)
   values(p_creator_id,p_buyer_id,p_post_id,v_identity,v_booking.id);
 end if;
 if v_booking.creator_id is distinct from p_creator_id or v_booking.buyer_id is distinct from p_buyer_id or
    v_booking.post_id is distinct from p_post_id then raise exception 'BOOKING_SOURCE_MISMATCH'; end if;
 v_assignment:=public.assign_sales_team_booking_v1(v_booking.id,p_buyer_id,null);
 return v_assignment||jsonb_build_object('booking_id',v_booking.id,'lead_reused',v_reused,'scheduling_status','awaiting_confirmation');
end $$;
revoke all on function public.seed_sales_team_booking_v1(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.seed_sales_team_booking_v1(uuid,uuid,uuid,text,uuid) to service_role;
