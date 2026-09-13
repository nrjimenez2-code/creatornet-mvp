begin;
-- Preserve installed return shapes and other reviewed feed changes. Abort rather
-- than replacing a function whose eligibility predicate is unfamiliar.
do $$ declare f record; body text; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname in ('get_feed_v2','get_feed_v3') loop
  body:=pg_get_functiondef(f.oid);
  if body !~* 'banned_at' then
   if body !~* 'p\.hidden_at[[:space:]]+is[[:space:]]+null' then raise exception 'Feed eligibility requires review';end if;
   body:=regexp_replace(body,'p\.hidden_at[[:space:]]+is[[:space:]]+null',
    'p.hidden_at is null and not exists (select 1 from public.profiles banned_creator where banned_creator.id=p.creator_id and banned_creator.banned_at is not null)','gi');
   execute body;
  end if;
 end loop;
end $$;
create schema if not exists discover_private;
revoke all on schema discover_private from public,anon,authenticated;
create or replace function discover_private.like_changed_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare uid uuid; pid uuid; p public.posts;
begin
 if tg_op='DELETE' then uid:=old.user_id;pid:=old.post_id;else uid:=new.user_id;pid:=new.post_id;end if;
 select * into p from public.posts where id=pid;
 if not found or uid=p.creator_id then return null;end if;
 if tg_op='DELETE' then
  update public.discover_events_v1 set valid=false where kind='like' and entity_key=uid::text||':'||pid::text;
 else
  insert into public.discover_events_v1(actor,user_id,post_id,creator_id,kind,entity_key,categories,topics)
  values('user:'||uid::text,uid,pid,p.creator_id,'like',uid::text||':'||pid::text,
    public.canonical_interests_v1(p.interests),coalesce(p.topics,'{}'))
  on conflict(kind,entity_key) do update set valid=true;
 end if;
 return null;
end $$;
revoke all on function discover_private.like_changed_v1() from public,anon,authenticated;
drop trigger if exists discover_like_changed_v1 on public.likes;
create trigger discover_like_changed_v1 after insert or delete on public.likes
 for each row execute function discover_private.like_changed_v1();
-- Private metrics preserve free calls separately from money and expose maturity.
create or replace view public.discover_measurement_v1 with (security_invoker=true) as
 select post_id,creator_id,audience,offer_type,
 count(*) filter(where kind='exposure') exposure_events,
 count(distinct actor) filter(where kind='exposure') unique_exposure,
 count(distinct actor) filter(where kind='qualified_view' and valid) qualified_viewers,
 count(distinct actor) filter(where kind='product_tap' and valid) product_tappers,
 count(distinct actor) filter(where kind='checkout_start' and valid) checkout_starters,
 count(distinct actor) filter(where kind='booking_setup_complete' and valid) booking_setups,
 count(distinct actor) filter(where kind='booking_scheduled' and valid) scheduled_bookers,
 count(distinct actor) filter(where kind in ('purchase','mentorship_purchase') and valid) purchasers,
 count(*) filter(where kind='mentorship_purchase' and valid) booking_to_sales,
 count(distinct post_id) post_count,
 count(*) filter(where kind='exposure')-count(distinct actor) filter(where kind='exposure') repeat_exposure,
 count(*) filter(where kind='exposure' and occurred_at<=now()-interval '7 days') matured_exposures
 from public.discover_events_v1 where occurred_at>=now()-interval '28 days'
 group by post_id,creator_id,audience,offer_type;
revoke all on public.discover_measurement_v1 from public,anon,authenticated;
grant select on public.discover_measurement_v1 to service_role;
-- Revenue always remains separated by currency; free calls have no revenue rows.
create or replace view public.discover_revenue_v1 with (security_invoker=true) as
 select post_id,creator_id,currency,sum(amount_cents) net_amount_cents
 from public.discover_events_v1 where kind in ('purchase','mentorship_purchase') and valid
 group by post_id,creator_id,currency;
revoke all on public.discover_revenue_v1 from public,anon,authenticated;
grant select on public.discover_revenue_v1 to service_role;
create or replace view public.discover_variety_v1 with (security_invoker=true) as
 select actor,date_trunc('day',occurred_at) as exposure_day,count(*) exposure_events,
 count(distinct post_id) distinct_posts,count(distinct creator_id) distinct_creators,
 count(*)-count(distinct post_id) repeat_exposure
 from public.discover_events_v1 where kind='exposure' and occurred_at>=now()-interval '28 days'
 group by actor,date_trunc('day',occurred_at);
revoke all on public.discover_variety_v1 from public,anon,authenticated;
grant select on public.discover_variety_v1 to service_role;
-- Reduce repeated raw receipts to unique-viewer evidence inside PostgreSQL.
-- JSON is one RPC result, avoiding PostgREST's row cap for many topic cohorts.
create or replace function public.discover_rank_evidence_v1(p_posts uuid[])
returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
 if cardinality(p_posts)>200 then raise exception 'Evidence batch too large';end if;
 with per_actor as (
  select post_id,actor,case when grouping(audience)=1 then '' else audience end audience,
   bool_or(kind='exposure') exposed,bool_or(kind in ('purchase','mentorship_purchase')) sale,
   bool_or(kind='booking_scheduled') booked,bool_or(kind='checkout_start') intent,
   bool_or(kind='product_tap') tapped,bool_or(kind='qualified_view') viewed,
   max(occurred_at) filter(where kind='exposure') last_exposure
  from public.discover_events_v1
  where post_id=any(p_posts) and valid and occurred_at>=now()-interval '90 days'
   and kind in ('exposure','purchase','mentorship_purchase','booking_scheduled','checkout_start','product_tap','qualified_view')
  group by grouping sets ((post_id,actor,audience),(post_id,actor))
 ), summaries as (
  select post_id,audience,count(*) exposures,
   count(*) filter(where sale) sales,count(*) filter(where booked) bookings,
   count(*) filter(where intent) intents,count(*) filter(where tapped) taps,
   count(*) filter(where viewed) views,count(*) filter(where sale or booked) commercial,
   max(last_exposure) last_exposure
  from per_actor where exposed group by post_id,audience
 ) select coalesce(jsonb_agg(to_jsonb(summaries)),'[]'::jsonb) into result from summaries;
 return result;
end $$;
revoke all on function public.discover_rank_evidence_v1(uuid[]) from public,anon,authenticated;
grant execute on function public.discover_rank_evidence_v1(uuid[]) to service_role;
commit;
