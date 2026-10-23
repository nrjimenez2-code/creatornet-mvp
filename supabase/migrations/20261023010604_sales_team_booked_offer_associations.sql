-- Local candidate. Keep the canonical public Book CTA exclusive. Booked sales
-- offers are separate prospective creator/manager decisions, never post edits.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column booked_offer_associations_enabled boolean not null default false;
create table public.sales_team_booked_offer_changes_v1 (
 id uuid primary key,
 booking_id uuid not null references public.bookings(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 actor_id uuid not null references auth.users(id) on delete restrict,
 attached boolean not null,
 revision integer not null check(revision>0),
 created_at timestamptz not null default clock_timestamp(),
 unique(booking_id,product_id,revision)
);
create index sales_team_booked_offer_creator_v1 on public.sales_team_booked_offer_changes_v1(creator_id,booking_id,product_id,revision desc);
alter table public.sales_team_booked_offer_changes_v1 enable row level security;
revoke all on public.sales_team_booked_offer_changes_v1 from public,anon,authenticated;
grant select,insert on public.sales_team_booked_offer_changes_v1 to service_role;
create trigger team_booked_offer_history_immutable before update or delete on public.sales_team_booked_offer_changes_v1 for each row execute function creatornet_team_private.reject_history_change();

create function public.sales_team_booked_offer_allowed_v1(p_booking_id uuid,p_product_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select coalesce((select case when latest.id is not null then latest.attached and exists(select 1 from public.sales_team_controls_v1 where singleton and booked_offer_associations_enabled)
  else p.product_id in (product.id,product.product_id) end
 from public.bookings b join public.posts p on p.id=b.post_id and p.creator_id=b.creator_id and p.allow_booking
 join public.products product on product.id=p_product_id and product.creator_id=b.creator_id
 left join lateral (select id,attached from public.sales_team_booked_offer_changes_v1 where booking_id=b.id and product_id=product.id and creator_id=b.creator_id order by revision desc limit 1) latest on true
 where b.id=p_booking_id and (coalesce(to_jsonb(p)->>'video_action','book')='book')),false)
$$;
create function public.manage_sales_team_booked_offer_v1(p_creator_id uuid,p_actor_id uuid,p_booking_id uuid,p_product_id uuid,p_request_id uuid,p_expected_revision integer,p_attached boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare b public.bookings;old public.sales_team_booked_offer_changes_v1;saved public.sales_team_booked_offer_changes_v1;product jsonb;begin
 if coalesce(public.sales_team_actor_role_v1(p_creator_id,p_actor_id),'') not in ('owner','manager') then raise exception 'TEAM_MANAGER_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||p_creator_id::text,0));
 select * into b from public.bookings where id=p_booking_id and creator_id=p_creator_id;
 if b.id is null or not exists(select 1 from public.posts p where p.id=b.post_id and p.creator_id=p_creator_id and p.allow_booking and coalesce(to_jsonb(p)->>'video_action','book')='book') then raise exception 'OWNED_SALES_CALL_REQUIRED';end if;
 select * into saved from public.sales_team_booked_offer_changes_v1 where id=p_request_id;
 if saved.id is not null then
  if saved.creator_id<>p_creator_id or saved.actor_id<>p_actor_id or saved.booking_id<>p_booking_id or saved.product_id<>p_product_id or saved.attached is distinct from p_attached or saved.revision-1 is distinct from p_expected_revision then raise exception 'ORIGINAL_BOOKED_OFFER_REQUEST_CHANGED';end if;
  return to_jsonb(saved);
 end if;
 if p_request_id is null or p_expected_revision is null or p_expected_revision<0 or p_attached is null then raise exception 'INVALID_BOOKED_OFFER_CHANGE';end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled and booked_offer_associations_enabled) then raise exception 'TEAM_BOOKED_OFFERS_HELD';end if;
 if b.status='completed' or b.linked_order_id is not null or exists(select 1 from public.sales_team_assignments_v1 where booking_id=b.id and accepted_sale_id is not null) then raise exception 'ACCEPTED_BOOKED_OFFER_FROZEN';end if;
 product:=public.sales_team_product_snapshot_v1(p_product_id);
 if product is null or product->>'creator_id' is distinct from p_creator_id::text or product->>'type' not in ('video','course','mentorship','bundle','call') or product->>'currency' is distinct from 'usd' or product->'active'='false'::jsonb or product->'is_active'='false'::jsonb then raise exception 'OWNED_ACTIVE_SALES_OFFER_REQUIRED';end if;
 select * into old from public.sales_team_booked_offer_changes_v1 where booking_id=b.id and product_id=p_product_id order by revision desc limit 1;
 if coalesce(old.revision,0) is distinct from p_expected_revision then raise exception 'BOOKED_OFFER_REVISION_CHANGED';end if;
 insert into public.sales_team_booked_offer_changes_v1(id,booking_id,creator_id,product_id,actor_id,attached,revision)
 values(p_request_id,b.id,p_creator_id,p_product_id,p_actor_id,p_attached,p_expected_revision+1) returning * into saved;
 insert into public.sales_team_audit_v1(creator_id,actor_id,action,subject_id,before_state,after_state)
 values(p_creator_id,p_actor_id,'booked_offer_association',p_request_id,case when old.id is null then null else to_jsonb(old) end,to_jsonb(saved));
 return to_jsonb(saved);
end $$;
create function public.read_sales_team_booked_offer_choices_v1(p_creator_id uuid,p_actor_id uuid,p_booking_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled) then raise exception 'TEAM_ACCESS_DISABLED';end if;
 if coalesce(public.sales_team_actor_role_v1(p_creator_id,p_actor_id),'') not in ('owner','manager') then raise exception 'TEAM_MANAGER_REQUIRED';end if;
 if not exists(select 1 from public.bookings b join public.posts p on p.id=b.post_id and p.creator_id=b.creator_id and p.allow_booking where b.id=p_booking_id and b.creator_id=p_creator_id and coalesce(to_jsonb(p)->>'video_action','book')='book') then raise exception 'OWNED_SALES_CALL_REQUIRED';end if;
 return jsonb_build_object('offers',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'type',p.type,'revision',coalesce(change.revision,0),'attached',public.sales_team_booked_offer_allowed_v1(p_booking_id,p.id)) order by p.id)
  from public.products p left join lateral (select revision from public.sales_team_booked_offer_changes_v1 where booking_id=p_booking_id and product_id=p.id order by revision desc limit 1) change on true
  where p.creator_id=p_creator_id and p.active is distinct from false and p.is_active is distinct from false and p.currency='usd' and p.type in ('video','course','mentorship','bundle','call')),'[]'::jsonb));
end $$;
create function public.read_sales_team_offer_catalog_v2(p_creator_id uuid,p_actor_id uuid,p_booking_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare role text;member public.sales_team_memberships_v1;offers jsonb;approvals jsonb;options jsonb;begin
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled) then raise exception 'TEAM_ACCESS_DISABLED';end if;
 role:=public.sales_team_actor_role_v1(p_creator_id,p_actor_id);
 if role is null then raise exception 'BOOKING_CLOSER_ACCESS_REQUIRED';end if;
 if role='closer' then
  select * into member from public.sales_team_memberships_v1 where creator_id=p_creator_id and user_id=p_actor_id and status='active';
  if p_booking_id is null or not public.sales_team_member_ready_v1(member.id) or not exists(select 1 from public.sales_team_assignments_v1 where booking_id=p_booking_id and creator_id=p_creator_id and membership_id=member.id) then raise exception 'BOOKING_CLOSER_ACCESS_REQUIRED';end if;
 end if;
 if p_booking_id is not null and not exists(select 1 from public.bookings where id=p_booking_id and creator_id=p_creator_id) then raise exception 'OWNED_SALES_CALL_REQUIRED';end if;
 select coalesce(jsonb_agg(public.sales_team_product_snapshot_v1(product.id) order by product.id),'[]'::jsonb) into offers from public.products product where product.creator_id=p_creator_id and product.active is distinct from false and product.is_active is distinct from false and
  (p_booking_id is not null and public.sales_team_booked_offer_allowed_v1(p_booking_id,product.id) or p_booking_id is null and (
   exists(select 1 from public.posts p where p.creator_id=p_creator_id and p.allow_booking and p.product_id in (product.id,product.product_id) and coalesce(to_jsonb(p)->>'video_action','book')='book') or
   exists(select 1 from public.bookings b where b.creator_id=p_creator_id and public.sales_team_booked_offer_allowed_v1(b.id,product.id))));
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'product_id',a.product_id,'revision',a.revision,'amount_cents',a.amount_cents) order by a.id),'[]'::jsonb) into approvals
  from public.sales_team_offer_approvals_v1 a where a.creator_id=p_creator_id and a.revoked_at is null and exists(select 1 from jsonb_array_elements(offers) p where p->>'id'=a.product_id::text);
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'approval_id',o.approval_id,'product_id',o.product_id,'kind',o.kind,'payment_count',o.payment_count) order by o.id),'[]'::jsonb) into options
  from public.sales_team_offer_options_v1 o where o.creator_id=p_creator_id and exists(select 1 from jsonb_array_elements(approvals) a where a->>'id'=o.approval_id::text);
 return jsonb_build_object('offers',offers,'approvals',approvals,'options',options);
end $$;
-- Refuse unrecognized predecessor functions instead of replacing their guards.
do $patch$ declare src text;needle text;replacement text;begin
 src:=replace(pg_get_functiondef('public.configure_sales_team_offer_v1(uuid,uuid,uuid,uuid,integer,smallint[])'::regprocedure),chr(13)||chr(10),chr(10));
 needle:=$old$not exists(select 1 from public.posts p where p.creator_id=p_creator_id and p.allow_booking and p.product_id in
    (select id from public.products where id=p_product_id union select product_id from public.products where id=p_product_id))$old$;
 replacement:='not (exists(select 1 from public.posts p where p.creator_id=p_creator_id and p.allow_booking and p.product_id in (select id from public.products where id=p_product_id union select product_id from public.products where id=p_product_id) and coalesce(to_jsonb(p)->>''video_action'',''book'')=''book'') or exists(select 1 from public.bookings b where b.creator_id=p_creator_id and public.sales_team_booked_offer_allowed_v1(b.id,p_product_id)))';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_BOOKED_OFFER_APPROVAL_DEPENDENCY_DIFFERS';end if;execute replace(src,needle,replacement);
 src:=replace(pg_get_functiondef('public.read_sales_team_sale_source_v1(uuid,uuid,uuid)'::regprocedure),chr(13)||chr(10),chr(10));
 needle:=$old$not exists(select 1 from public.posts p join public.products product on product.id=v_option.product_id
   where p.id=v_booking.post_id and p.creator_id=v_booking.creator_id and p.allow_booking and p.product_id in (product.id,product.product_id))$old$;
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_BOOKED_OFFER_SOURCE_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'not public.sales_team_booked_offer_allowed_v1(v_booking.id,v_option.product_id)');
 needle:=$old$'postId',v_booking.post_id)$old$;
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TEAM_BOOKED_OFFER_REVISION_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,$new$'postId',v_booking.post_id,'offerAttachmentRevision',coalesce((select revision from public.sales_team_booked_offer_changes_v1 where booking_id=v_booking.id and product_id=v_option.product_id order by revision desc limit 1),0))$new$);execute src;
end $patch$;
do $$ declare sig regprocedure;begin
 for sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('sales_team_booked_offer_allowed_v1','manage_sales_team_booked_offer_v1','read_sales_team_booked_offer_choices_v1','read_sales_team_offer_catalog_v2') loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $$;
commit;
