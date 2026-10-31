/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

declare const createLocalPostgres:()=>PGlite;
const fixture=JSON.parse(readFileSync(join(__dirname,'../test-support/broad-database-security-fixture.json'),'utf8')) as {functions:{signature:string;definition:string}[];views:{relname:string;definition:string}[]};
const migration=readFileSync(join(__dirname,'../supabase/migrations/20261023015517_broad_database_security_hardening.sql'),'utf8');
const legacyFeeds=JSON.parse(readFileSync(join(__dirname,'../test-support/legacy-feed-security-fixture.json'),'utf8')) as {signature:string;definition:string}[];
const post='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let db:PGlite,legacyRemaining:number,legacyForgedBookings:number,legacyAmbiguousProducts:number,legacyModeratedRows:number,originalBodies:string;
const bodyHash=async()=>String((await db.query<{hash:string}>("select md5(string_agg(proname||prosrc,E'\\n' order by oid)) as hash from pg_proc where pronamespace='public'::regnamespace")).rows[0].hash);
beforeAll(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 revoke create on schema public from public;
 create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('audit.uid',true),'')::uuid$$;grant usage on schema auth to anon,authenticated,service_role;
 create table posts(id uuid primary key,creator_id uuid,title text,created_at timestamptz default now(),video_url text,poster_url text,likes_count integer,interests text[],hashtags text[],hidden_at timestamptz,removed_at timestamptz,product_id uuid,price_cents integer,booking_url text,booking_url_override text,allow_booking boolean,tags text[],comments_count integer,shares_count integer,active boolean default true);
 create table follows(follower_id uuid,following_id uuid);
 create table profiles(id uuid,review_rating numeric,review_count bigint,banned_at timestamptz);
 create table purchases(post_id uuid,created_at timestamptz,is_refund boolean,is_suspect boolean);
 create table post_metrics(post_id uuid,views integer,completions integer,post_conversion_score numeric);
 create table user_interest_scores(user_id uuid,category text,score numeric);
 create table post_engagements(post_id uuid,watch_time_ms integer,liked boolean,commented boolean,created_at timestamptz);
 create table bookings(id uuid primary key,post_id uuid,buyer_id uuid,creator_id uuid,status text,linked_order_id uuid,created_at timestamptz default now());
 create table products(id uuid primary key default gen_random_uuid(),product_id uuid unique,creator_id uuid,title text,description text,type text,price_cents text,external_url text,thumbnail_url text,is_active text,created_at text,active text,updated_at text,plan_months text,stripe_price_id text,fulfillment text,discord_channel_id text,whop_listing_id text,deliver_url text,discord_invite_url text,whop_listing_url text,amount_cents text,currency text,post_id uuid,product_type text,premium_video_url text,membership_terms text,fixed_service_months text,delivery_revision text);
 alter table products enable row level security;create policy own_products on products for all using(creator_id=auth.uid()) with check(creator_id=auth.uid());
 grant select,insert,update,delete on products to authenticated;
 grant insert(id,product_id),update(id,product_id) on products to authenticated;
 insert into products(id,creator_id,title)values('${post}','cccccccc-cccc-4ccc-8ccc-cccccccccccc','Victim'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${post}','Owned');
 alter table bookings enable row level security;
 create policy legacy_booking_insert on bookings for insert with check(buyer_id=auth.uid());
 create policy legacy_booking_read on bookings for select using(buyer_id=auth.uid());
 grant select,insert,update,delete on bookings to anon,authenticated;
 grant insert(id,buyer_id),update(status) on bookings to authenticated;
 insert into bookings(id,buyer_id,status) values('${post}','${post}','existing');
 create materialized view sales_velocity_mv as select null::uuid post_id,0::double precision sv_1h,0::double precision sv_24h,0::double precision sv_7d where false;
 insert into posts(id,title,video_url,likes_count,interests) values('${post}','Synthetic','https://example.invalid/preview',1,array['test']);
 insert into profiles values('${post}',4.5,3,null);
 alter table posts enable row level security;create policy deny_client on posts using(false);
 grant all on all tables in schema public to service_role;`);
 for(const fn of fixture.functions)await db.exec(fn.definition);
 for(const fn of legacyFeeds){await db.exec(fn.definition);await db.exec(`grant execute on function public.${fn.signature} to anon,authenticated,service_role`);}
 for(const view of fixture.views)await db.exec(`create view public.${view.relname} as ${view.definition}`);
 await db.exec('grant all on post_freshness,feed_debug,trending_hashtags,post_engagement_daily,sales_velocity_mv to anon,authenticated,service_role;revoke select on post_freshness,feed_debug,trending_hashtags,post_engagement_daily,sales_velocity_mv from anon,authenticated;');
 // Reproduce the old writable-owner-view bypass ONLY in this synthetic database.
 await db.exec('begin;set local role anon;delete from public.post_freshness;reset role;');
 legacyRemaining=(await db.query<{n:number}>('select count(*)::integer n from public.posts')).rows[0].n;
 await db.exec('rollback;');
 await db.exec(`begin;update posts set hidden_at=now(),removed_at=now();set local role anon;`);
 legacyModeratedRows=(await db.query('select * from public.get_feed_discover(10,null)')).rows.length;
 await db.exec('rollback;');
 await db.exec(`begin;set local audit.uid='${post}';set local role authenticated;insert into products(id,creator_id,product_id) values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','${post}','${post}');reset role;`);
 legacyAmbiguousProducts=(await db.query<{n:number}>(`select count(*)::integer n from products where id='${post}'or product_id='${post}'`)).rows[0].n;
 await db.exec('rollback;');
 await db.exec(`begin;set local audit.uid='${post}';set local role authenticated;insert into bookings(id,buyer_id,creator_id,status) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${post}','${post}','completed');reset role;`);
 legacyForgedBookings=(await db.query<{n:number}>("select count(*)::integer n from bookings where status='completed'")).rows[0].n;
 await db.exec('rollback;');
 originalBodies=await bodyHash();
 await db.exec(migration);
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});

test('legacy view allowed anonymous deletion despite denied base-table RLS; migration preserves the synthetic row',async()=>{
 expect(legacyRemaining).toBe(0);
 expect((await db.query<{n:number}>('select count(*)::integer n from posts')).rows[0].n).toBe(1);
});
test.each(['anon','authenticated'])('%s cannot delete through the legacy view after hardening',async role=>{
 await db.exec(`set local role ${role}`);
 await expect(db.exec('delete from public.post_freshness')).rejects.toMatchObject({code:'42501'});
});
test.each(['anon','authenticated'])('%s has no remaining legacy-view write privileges',async role=>{
 const result=await db.query<{allowed:boolean}>("select bool_or(has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) allowed from pg_class c where c.oid=any(array['post_freshness'::regclass,'feed_debug'::regclass,'trending_hashtags'::regclass,'post_engagement_daily'::regclass,'sales_velocity_mv'::regclass])",[role]);
 expect(result.rows[0].allowed).toBe(false);
});
test('security-invoker view still applies base-table RLS if a future SELECT grant is added',async()=>{
 await db.exec('grant select on posts,post_freshness to anon;set local role anon;');
 expect((await db.query('select * from public.post_freshness')).rows).toEqual([]);
});
test('existing service-role view access and feed calculation remain usable',async()=>{
 await db.exec('set local role service_role;');
 expect((await db.query('select * from public.post_freshness')).rows).toHaveLength(1);
 expect((await db.query('select * from public.get_feed_v2(null,1,0)')).rows).toHaveLength(1);
});
test('function bodies and grants are unchanged while all ten lookup paths are pinned',async()=>{
 expect(await bodyHash()).toBe(originalBodies);
 const configs=await db.query<{proconfig:string[]}>("select proconfig from pg_proc where pronamespace='public'::regnamespace and proname not in ('get_feed_v1','get_feed_discover','get_feed_following')");
 expect(configs.rows).toHaveLength(10);
 for(const row of configs.rows)expect(row.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
 expect((await db.query("select has_function_privilege('anon','public.jsonb_to_text_array(jsonb)','execute') allowed")).rows[0]).toEqual({allowed:true});
 expect((await db.query('select public.minmax_norm(5,0,10) n')).rows[0]).toEqual({n:0.5});
 expect((await db.query('select * from public.get_profile_rating($1)',[post])).rows[0]).toMatchObject({avg_rating:'4.50',review_count:3});
});
test('temporary objects cannot shadow the fixed public feed relations',async()=>{
 await db.exec('create temp table posts(id uuid);set local search_path=pg_temp;set local role service_role;');
 expect((await db.query('select post_id from public.get_feed_v2(null,1,0)')).rows[0]).toEqual({post_id:post});
});
test('legacy self-buyer booking insertion could fabricate completed state in the local fixture',()=>{expect(legacyForgedBookings).toBe(1);});
test('direct booking writes including column grants are denied while owned recovery reads remain',async()=>{
 expect((await db.query("select has_column_privilege('authenticated','bookings','id','INSERT') allowed")).rows[0]).toEqual({allowed:false});
 await db.exec(`set local audit.uid='${post}';set local role authenticated;`);
 expect((await db.query('select id from public.bookings')).rows).toHaveLength(1);
 await expect(db.exec(`insert into public.bookings(id,buyer_id,status) values(gen_random_uuid(),'${post}','completed')`)).rejects.toMatchObject({code:'42501'});
});
test('service-role booking creation remains available',async()=>{
 await db.exec(`set local role service_role;insert into public.bookings(id,buyer_id,status) values(gen_random_uuid(),'${post}','pending');`);
 expect((await db.query('select id from public.bookings')).rows).toHaveLength(2);
});
test('the old product alias grant could make a victim canonical-id lookup ambiguous',()=>{expect(legacyAmbiguousProducts).toBe(2);});
test.each(['insert','update'])('client %s cannot supply cross-column product identities',async operation=>{
 await db.exec(`set local audit.uid='${post}';set local role authenticated;`);
 const query=operation==='insert'?`insert into products(id,creator_id) values(gen_random_uuid(),'${post}')`:`update products set product_id='${post}'where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`;
 await expect(db.exec(query)).rejects.toMatchObject({code:'42501'});
});
test('legacy authenticated product creation and normal owned-field edits remain supported',async()=>{
 await db.exec(`set local audit.uid='${post}';set local role authenticated;`);
 const row=(await db.query<{id:string}>('insert into products(creator_id,title) values($1,$2)returning id',[post,'New'])).rows[0];
 expect(row.id).not.toBe(post);
 await db.query('update products set title=$1 where id=$2',['Edited',row.id]);
 expect((await db.query('select title from products where id=$1',[row.id])).rows[0]).toEqual({title:'Edited'});
});

test('the captured legacy discover function could return moderated rows despite client RLS',()=>{expect(legacyModeratedRows).toBe(1);});

test.each(legacyFeeds.map(fn=>fn.signature))('obsolete %s denies both client roles while service execution and body survive',async signature=>{
 for(const role of ['anon','authenticated']){
  expect((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,`public.${signature}`])).rows[0]).toEqual({allowed:false});
 }
 expect((await db.query('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') allowed',[`public.${signature}`])).rows[0]).toEqual({allowed:true});
 expect(await bodyHash()).toBe(originalBodies);
});
