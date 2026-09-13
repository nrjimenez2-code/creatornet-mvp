/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const viewer = "11111111-1111-4111-8111-111111111111",
  creator = "22222222-2222-4222-8222-222222222222";
const post = "33333333-3333-4333-8333-333333333333",
  product = "44444444-4444-4444-8444-444444444444";
const purchase = "55555555-5555-4555-8555-555555555555",
  ledger = "66666666-6666-4666-8666-666666666666";
jest.setTimeout(90000);
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);insert into auth.users values('${viewer}'),('${creator}');
 create table profiles(id uuid primary key,interests jsonb,banned_at timestamptz);
 create table posts(id uuid primary key,creator_id uuid,interests text[],topics text[],product_id uuid,hidden_at timestamptz);
 create table likes(user_id uuid,post_id uuid,primary key(user_id,post_id));
 create table user_interest_scores(user_id uuid,category text,score int,updated_at timestamptz,primary key(user_id,category));
 create table purchases(id uuid primary key,buyer_user_id uuid,buyer_id uuid,post_id uuid,product_id uuid,booking_id uuid);
 create table products(id uuid primary key,product_id uuid,type text);
 create table bookings(id uuid primary key,post_id uuid,buyer_id uuid,creator_id uuid);
 create table booking_payments(id uuid primary key,booking_id uuid,product_id uuid);
 create table payment_fee_ledger(id uuid primary key,creator_id uuid,purchase_id uuid,booking_payment_id uuid,
 gross_amount_cents bigint,refunded_amount_cents bigint default 0,disputed_amount_cents bigint default 0,
 status text,currency text,created_at timestamptz default now());
 insert into profiles(id,interests) values('${viewer}',to_jsonb(array['Entrepreneurship'])),('${creator}',to_jsonb(array['Entrepreneurship']));
 insert into posts(id,creator_id,interests,topics,product_id) values('${post}','${creator}',array['Entrepreneurship'],array['ecommerce'],'${product}');
 insert into products values('${product}',null,'mentorship');
 insert into purchases values('${purchase}','${viewer}',null,'${post}','${product}',null);`);
  await db.exec(`create function public.get_feed_v3(p_tab text default 'discover',p_limit int default 20,p_offset int default 0)
 returns table(post_id uuid) language sql as 'select p.id from public.posts p where p.hidden_at is null order by p.id limit p_limit offset p_offset';`);
  for (const file of [
    "20260913004646_discover_taxonomy.sql",
    "20260913005126_discover_events_and_sessions.sql",
    "20260913010141_discover_verified_sales.sql",
    "20260913011108_discover_eligibility_and_measurement.sql",
    "20260913220917_scheduling_oauth_connections.sql",
    "20260913222716_google_calendar_reservations.sql",
    "20260913223807_google_booking_attribution.sql",
    "20260913224148_google_calendar_setup.sql",
    "20260913232056_google_calendar_reconciliation.sql",
  ])
    try { await db.exec(readFileSync("supabase/migrations/" + file, "utf8")); } catch (error) { throw new Error(file + ": " + JSON.stringify(error)); }
});

afterAll(async () => { await db.close(); });
const connection = "77777777-7777-4777-8777-777777777777", reservation = "88888888-8888-4888-8888-888888888888";
const attribution = "99999999-9999-4999-8999-999999999999", worker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeEach(async () => {
  await db.exec("truncate google_booking_jobs_v1,google_booking_reservations_v1,google_booking_settings_v1,scheduling_event_types_v1,scheduling_oauth_attempts_v1,google_calendar_watches_v1,scheduling_connections_v1,discover_booking_attribution_v1,discover_events_v1,payment_fee_ledger");
  await db.query("update purchases set post_id=$1 where id=$2", [post,purchase]);
  await db.query("insert into scheduling_connections_v1(id,creator_id,provider,status,account_id,credentials_ciphertext,webhook_id,webhook_secret_ciphertext,token_expires_at) values($1,$2,'google','connected','account','encrypted','watch','encrypted',now()+interval '1 hour')",[connection,creator]);
  await db.query(`insert into google_booking_settings_v1(connection_id,calendar_id,conflict_calendar_ids,availability,title) values($1,'primary',array['primary'],'{"durationMinutes":30,"bufferBeforeMinutes":0,"bufferAfterMinutes":0}','Call')`,[connection]);
  await db.query("insert into discover_booking_attribution_v1(id,setup_session_id,user_id,creator_id,post_id,created_at) values($1,'setup',$2,$3,$4,now()-interval '1 hour')",[attribution,viewer,creator,post]);
});
const reserve = (buyer=viewer, source=post) => db.query("select reserve_google_booking_v1($1,$2,$3,$4,date_trunc('day',now())+interval '2 days 10 hours',date_trunc('day',now())+interval '2 days 10 hours 30 minutes',$5)",[reservation,connection,buyer,source,attribution]);
async function claim() { return (await db.query<{id:string}>("select * from claim_google_booking_job_v1($1)",[worker])).rows[0].id; }
async function finish(id:string) {
  return db.query("select complete_google_booking_job_v1($1,$2,'google-event','etag',coalesce(r.desired_starts_at,r.starts_at),coalesce(r.desired_ends_at,r.ends_at)) from google_booking_reservations_v1 r where r.id=$3",[id,worker,reservation]);
}
async function create() { await reserve();await db.query("select enqueue_google_booking_create_v1($1,$2)",[reservation,viewer]);const id=await claim();await finish(id);return id; }

test("setup and queued work earn no scheduling credit; confirmation commits one attributed milestone", async () => {
  await reserve();await db.query("select enqueue_google_booking_create_v1($1,$2)",[reservation,viewer]);
  expect((await db.query("select count(*)::int n from discover_events_v1 where kind='booking_scheduled'")).rows).toEqual([{n:0}]);
  const id=await claim();await finish(id);
  expect((await db.query("select provider,provider_booking_id,post_id from discover_booking_attribution_v1")).rows).toEqual([{provider:'google',provider_booking_id:'google-event',post_id:post}]);
  expect((await db.query("select post_id,valid from discover_events_v1 where kind='booking_scheduled'")).rows).toEqual([{post_id:post,valid:true}]);
  await expect(finish(id)).rejects.toThrow(/lease expired/);
  expect((await db.query("select count(*)::int n from discover_events_v1 where kind='booking_scheduled'")).rows).toEqual([{n:1}]);
});

test("another buyer or source video cannot claim an attribution", async () => {
  await expect(reserve(creator)).rejects.toThrow(/attribution mismatch/);
  await expect(reserve(viewer,product)).rejects.toThrow(/attribution mismatch/);
  expect((await db.query("select count(*)::int n from google_booking_reservations_v1")).rows).toEqual([{n:0}]);
});

test("attribution failure rolls back reservation and job completion together", async () => {
  await reserve();await db.query("select enqueue_google_booking_create_v1($1,$2)",[reservation,viewer]);const id=await claim();
  await db.query("update discover_booking_attribution_v1 set provider_event_at=now()+interval '1 day' where id=$1",[attribution]);
  await expect(finish(id)).rejects.toThrow(/Could not commit/);
  expect((await db.query("select status from google_booking_reservations_v1")).rows).toEqual([{status:'creating'}]);
  expect((await db.query("select status from google_booking_jobs_v1")).rows).toEqual([{status:'processing'}]);
  expect((await db.query("select count(*)::int n from discover_events_v1 where kind='booking_scheduled'")).rows).toEqual([{n:0}]);
});

test("rescheduling keeps one original-video milestone and cancellation retracts it atomically", async () => {
  await create();
  await db.query("select request_google_booking_change_v1($1,$2,0,'reschedule',starts_at+interval '1 hour',ends_at+interval '1 hour') from google_booking_reservations_v1 where id=$1",[reservation,viewer]);
  await finish(await claim());
  expect((await db.query("select count(*)::int n from discover_events_v1 where kind='booking_scheduled' and valid")).rows).toEqual([{n:1}]);
  expect((await db.query("select a.scheduled_at=r.starts_at matches from discover_booking_attribution_v1 a join google_booking_reservations_v1 r on r.attribution_id=a.id")).rows).toEqual([{matches:true}]);
  await db.query("select request_google_booking_change_v1($1,$2,1,'cancel')",[reservation,viewer]);
  await db.query("select complete_google_booking_job_v1($1,$2,null,null)",[await claim(),worker]);
  expect((await db.query("select valid from discover_events_v1 where kind='booking_scheduled'")).rows).toEqual([{valid:false}]);
  expect((await db.query("select status from google_booking_reservations_v1")).rows).toEqual([{status:'canceled'}]);
});

test("a later mentorship purchase retains the Google call's original video", async () => {
  await create();
  await db.query("update purchases set post_id=$1 where id=$2",[product,purchase]);
  await db.query("insert into payment_fee_ledger(id,creator_id,purchase_id,gross_amount_cents,status,currency) values($1,$2,$3,10000,'paid','usd')",[ledger,creator,purchase]);
  expect((await db.query("select kind,post_id,valid from discover_events_v1 where kind in ('purchase','mentorship_purchase')")).rows).toEqual([{kind:'mentorship_purchase',post_id:post,valid:true}]);
});


test("an attribution cannot be attached to a second reservation", async () => {
  await reserve();
  await expect(db.query("select reserve_google_booking_v1($1,$2,$3,$4,date_trunc('day',now())+interval '3 days 10 hours',date_trunc('day',now())+interval '3 days 10 hours 30 minutes',$5)",[worker,connection,viewer,post,attribution])).rejects.toThrow(/unique constraint/);
});

test("delayed Google confirmation repairs a captured mentorship sale's origin", async () => {
  await reserve();await db.query("select enqueue_google_booking_create_v1($1,$2)",[reservation,viewer]);const id=await claim();
  await db.query("insert into payment_fee_ledger(id,creator_id,purchase_id,gross_amount_cents,status,currency) values($1,$2,$3,10000,'paid','usd')",[ledger,creator,purchase]);
  expect((await db.query("select kind from discover_events_v1 where kind in ('purchase','mentorship_purchase')")).rows).toEqual([{kind:'purchase'}]);
  await finish(id);
  expect((await db.query("select kind,post_id from discover_events_v1 where kind in ('purchase','mentorship_purchase')")).rows).toEqual([{kind:'mentorship_purchase',post_id:post}]);
});

test("browser roles cannot award Google scheduling credit or complete worker jobs", async () => {
  for (const role of ['anon','authenticated']) {
    await db.exec('set role '+role);
    try {
      await expect(db.query("select confirm_discover_booking_v1($1,'google','fake',now(),now(),false)",[attribution])).rejects.toThrow(/permission denied/);
      await expect(db.query("select complete_google_booking_job_v1($1,$2,null,null)",[reservation,worker])).rejects.toThrow(/permission denied/);
    } finally { await db.exec('reset role'); }
  }
});


const watchId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function claimSweep(){
 await db.query("insert into google_calendar_watches_v1(id,connection_id,calendar_id,resource_id,token_ciphertext,expires_at,status) values($1,$2,'primary','resource','encrypted',now()+interval '1 day','active')",[watchId,connection]);
 await db.query("select * from claim_google_calendar_sweep_v1($1)",[worker]);
}
test("external moves and cancellations update reservation and attribution under a sweep lease",async()=>{
 await create();await claimSweep();
 const move=await db.query("select reconcile_google_calendar_booking_v1($1,$2,r.id,r.revision,'google-event','external-etag',r.starts_at+interval '1 hour',r.ends_at+interval '1 hour',false) applied from google_booking_reservations_v1 r where id=$3",[watchId,worker,reservation]);
 expect(move.rows).toEqual([{applied:true}]);
 expect((await db.query("select a.scheduled_at=r.starts_at matches from discover_booking_attribution_v1 a join google_booking_reservations_v1 r on r.attribution_id=a.id")).rows).toEqual([{matches:true}]);
 await db.query("select reconcile_google_calendar_booking_v1($1,$2,$3,1,'google-event',null,null,null,true)",[watchId,worker,reservation]);
 expect((await db.query("select valid from discover_events_v1 where kind='booking_scheduled'")).rows).toEqual([{valid:false}]);
});
test("stale sweep leases and in-flight booking operations cannot be overwritten",async()=>{
 await create();await claimSweep();
 await db.query("update google_calendar_watches_v1 set lease_until=now()-interval '1 minute'");
 expect((await db.query("select reconcile_google_calendar_booking_v1($1,$2,$3,0,'google-event',null,null,null,true) applied",[watchId,worker,reservation])).rows).toEqual([{applied:false}]);
 await db.query("select * from claim_google_calendar_sweep_v1($1)",[worker]);await db.query("select request_google_booking_change_v1($1,$2,0,'cancel')",[reservation,viewer]);
 expect((await db.query("select reconcile_google_calendar_booking_v1($1,$2,$3,1,'google-event',null,null,null,true) applied",[watchId,worker,reservation])).rows).toEqual([{applied:false}]);
});
test("a notification arriving during a sweep remains pending after that sweep finishes",async()=>{
 await create();await claimSweep();await db.query("select request_google_calendar_sync_v1($1)",[watchId]);
 await db.query("select finish_google_calendar_sweep_v1($1,$2,null)",[watchId,worker]);
 expect((await db.query("select sync_generation>swept_generation pending from google_calendar_watches_v1 where id=$1",[watchId])).rows).toEqual([{pending:true}]);
 expect((await db.query("select id from claim_google_calendar_sweep_v1($1)",[worker])).rows).toEqual([{id:watchId}]);
});
