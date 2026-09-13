/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const creator = "11111111-1111-4111-8111-111111111111", buyer = "22222222-2222-4222-8222-222222222222";
const connection = "33333333-3333-4333-8333-333333333333", post = "44444444-4444-4444-8444-444444444444";
const booking = "55555555-5555-4555-8555-555555555555", another = "66666666-6666-4666-8666-666666666666";
jest.setTimeout(90000);
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles(id uuid primary key); insert into profiles values('${creator}'),('${buyer}');`);
  for (const migration of ["20260913220917_scheduling_oauth_connections.sql", "20260913222716_google_calendar_reservations.sql", "20260913224148_google_calendar_setup.sql"])
    await db.exec(readFileSync("supabase/migrations/" + migration, "utf8"));
  await db.query(`insert into scheduling_connections_v1(id,creator_id,provider,status,account_id,credentials_ciphertext,
    webhook_id,webhook_secret_ciphertext,token_expires_at) values($1,$2,'google','connected','account','encrypted','channel','encrypted',now()+interval '1 hour')`, [connection, creator]);
  await db.query(`insert into google_booking_settings_v1(connection_id,calendar_id,conflict_calendar_ids,availability,title)
    values($1,'primary',array['primary'],'{"durationMinutes":30,"bufferBeforeMinutes":0,"bufferAfterMinutes":0}','Consultation')`, [connection]);
});
afterAll(async () => { await db.close(); });
afterEach(async () => {
  await db.exec("reset role; truncate google_booking_jobs_v1,google_booking_reservations_v1,google_calendar_watches_v1;");
  await db.query("update scheduling_connections_v1 set status='connected',lease_id=null,lease_until=null where id=$1", [connection]);
});
const reserve = (id = booking, minutes = 0, owner = buyer) => db.query(
  "select reserve_google_booking_v1($1,$2,$3,$4,date_trunc('day',now())+interval '2 days 10 hours'+make_interval(mins=>$5),date_trunc('day',now())+interval '2 days 10 hours 30 minutes'+make_interval(mins=>$5)) as id",
  [id, connection, owner, post, minutes]);

test("same reservation request is idempotent but different buyer cannot reuse it", async () => {
  expect((await reserve()).rows).toEqual([{ id: booking }]);
  expect((await reserve()).rows).toEqual([{ id: booking }]);
  await expect(reserve(booking, 0, creator)).rejects.toThrow(/does not match/);
  expect((await db.query("select count(*)::int n from google_booking_reservations_v1")).rows).toEqual([{ n: 1 }]);
});

test("overlapping reservations fail while adjacent times remain available", async () => {
  await reserve();
  await expect(reserve(another, 15)).rejects.toThrow(/no longer available/);
  await reserve(another, 30);
});

test("an expired unattempted hold can release its time", async () => {
  await reserve();
  await db.query("update google_booking_reservations_v1 set hold_expires_at=now()-interval '1 minute' where id=$1", [booking]);
  await reserve(another);
  expect((await db.query("select status from google_booking_reservations_v1 where id=$1", [booking])).rows).toEqual([{ status: "failed" }]);
});

test("an ambiguous Google creation retains the time after the original hold expires", async () => {
  await reserve();
  await db.query("select enqueue_google_booking_create_v1($1,$2)", [booking, buyer]);
  await db.query("update google_booking_reservations_v1 set hold_expires_at=now()-interval '1 day' where id=$1", [booking]);
  await expect(reserve(another)).rejects.toThrow(/no longer available/);
  await db.query("select enqueue_google_booking_create_v1($1,$2)", [booking, buyer]);
  expect((await db.query("select count(*)::int n from google_booking_jobs_v1")).rows).toEqual([{ n: 1 }]);
});

test("expired holds cannot be sent to Google and other buyers cannot enqueue them", async () => {
  await reserve();
  await expect(db.query("select enqueue_google_booking_create_v1($1,$2)", [booking, creator])).rejects.toThrow(/not found/);
  await db.query("update google_booking_reservations_v1 set hold_expires_at=now()-interval '1 minute' where id=$1", [booking]);
  await expect(db.query("select enqueue_google_booking_create_v1($1,$2)", [booking, buyer])).rejects.toThrow(/expired/);
});

test("disconnected calendars cannot admit new bookings", async () => {
  await db.query("update scheduling_connections_v1 set status='disconnected' where id=$1", [connection]);
  await expect(reserve()).rejects.toThrow(/not connected/);
});

test("browser roles cannot create reservations, queue events or read private scheduling data", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    await expect(reserve()).rejects.toThrow(/permission denied/);
    await expect(db.query("select enqueue_google_booking_create_v1($1,$2)", [booking, buyer])).rejects.toThrow(/permission denied/);
    await expect(db.query("select request_google_booking_change_v1($1,$2,0,'cancel')", [booking, buyer])).rejects.toThrow(/permission denied/);
    await expect(db.query("select claim_google_booking_job_v1($1)", [buyer])).rejects.toThrow(/permission denied/);
    await expect(db.query("select complete_google_booking_job_v1($1,$2,null,null)", [booking, buyer])).rejects.toThrow(/permission denied/);
    for (const table of ["google_booking_settings_v1", "google_calendar_watches_v1", "google_booking_reservations_v1", "google_booking_jobs_v1"])
      await expect(db.query("select * from " + table)).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  }
});

const worker = "77777777-7777-4777-8777-777777777777";
async function confirmInitial() {
  await reserve();
  await db.query("select enqueue_google_booking_create_v1($1,$2)", [booking, buyer]);
  const { rows } = await db.query<{ id: string }>("select * from claim_google_booking_job_v1($1)", [worker]);
  await db.query(`select complete_google_booking_job_v1($1,$2,'event','etag',r.starts_at,r.ends_at) from google_booking_reservations_v1 r where r.id=$3`, [rows[0].id, worker, booking]);
}
test("reschedule reserves both old and requested slots until Google confirms the move", async () => {
  await confirmInitial();
  const request = () => db.query(`select request_google_booking_change_v1($1,$2,0,'reschedule',r.starts_at+interval '1 hour',r.ends_at+interval '1 hour') as id from google_booking_reservations_v1 r where id=$1`, [booking, buyer]);
  expect((await request()).rows).toEqual((await request()).rows);
  await expect(reserve(another, 0)).rejects.toThrow(/no longer available/);
  await expect(reserve(another, 60)).rejects.toThrow(/no longer available/);
  const { rows } = await db.query<{ id: string }>("select * from claim_google_booking_job_v1($1)", [worker]);
  await db.query(`select complete_google_booking_job_v1($1,$2,'event','etag2',r.desired_starts_at,r.desired_ends_at) from google_booking_reservations_v1 r where r.id=$3`, [rows[0].id, worker, booking]);
  await reserve(another, 0);
});

test("cancellation retains its time until the remote cancellation is confirmed", async () => {
  await confirmInitial();
  await db.query("select request_google_booking_change_v1($1,$2,0,'cancel')", [booking, buyer]);
  await expect(reserve(another)).rejects.toThrow(/no longer available/);
  const { rows } = await db.query<{ id: string }>("select * from claim_google_booking_job_v1($1)", [worker]);
  await db.query("select complete_google_booking_job_v1($1,$2,null,null)", [rows[0].id, worker]);
  await reserve(another);
});

test("stale worker cannot finalize after another worker reclaims its job", async () => {
  await reserve();
  await db.query("select enqueue_google_booking_create_v1($1,$2)", [booking, buyer]);
  const first = await db.query<{ id: string }>("select * from claim_google_booking_job_v1($1)", [worker]);
  expect((await db.query("select * from claim_google_booking_job_v1($1)", [another])).rows).toHaveLength(0);
  await db.query("update google_booking_jobs_v1 set lease_until=now()-interval '1 minute' where id=$1", [first.rows[0].id]);
  const next = await db.query<{ id: string; attempts: number }>("select * from claim_google_booking_job_v1($1)", [another]);
  expect(next.rows[0]).toMatchObject({ id: first.rows[0].id, attempts: 2 });
  await expect(db.query("select complete_google_booking_job_v1($1,$2,'event','etag',now(),now())", [first.rows[0].id, worker])).rejects.toThrow(/lease expired/);
});

async function setupLease() {
  await db.query("update scheduling_connections_v1 set status='pending',lease_id=$2,lease_until=now()+interval '2 minutes' where id=$1",[connection,worker]);
  await db.query("insert into google_calendar_watches_v1(id,connection_id,calendar_id,resource_id,token_ciphertext,expires_at,status) values($1,$2,'primary','resource','encrypted',now()+interval '1 day','active')",[another,connection]);
}
const configure=()=>db.query(`select configure_google_calendar_v1($1,$2,$3,'primary',array['primary'],'{"durationMinutes":30,"bufferBeforeMinutes":0,"bufferAfterMinutes":0}','Call',$4)`,[connection,creator,worker,another]);
test("calendar setup commits settings and connected status only under a live lease and watch",async()=>{
  await setupLease();await configure();
  expect((await db.query("select status,webhook_id from scheduling_connections_v1 where id=$1",[connection])).rows).toEqual([{status:'connected',webhook_id:another}]);
  await db.query("update google_calendar_watches_v1 set expires_at=now()-interval '1 minute'");
  await expect(configure()).rejects.toThrow(/notifications are not ready/);
  await db.query("update scheduling_connections_v1 set lease_until=now()-interval '1 minute' where id=$1",[connection]);
  await expect(configure()).rejects.toThrow(/lease expired/);
});
test("disconnect invalidates holds and prevents dispatch or new reservations",async()=>{
  await reserve();await setupLease();await configure();
  await db.query("select begin_google_calendar_disconnect_v1($1,$2,$3)",[connection,creator,worker]);
  await expect(db.query("select enqueue_google_booking_create_v1($1,$2)",[booking,buyer])).rejects.toThrow(/cannot be created/);
  await expect(reserve(another)).rejects.toThrow(/not connected/);
  expect((await db.query("select status from google_booking_reservations_v1 where id=$1",[booking])).rows).toEqual([{status:'failed'}]);
});
test("disconnect waits for ambiguous mutations and cannot orphan an in-flight job",async()=>{
  await reserve();await db.query("select enqueue_google_booking_create_v1($1,$2)",[booking,buyer]);await setupLease();await configure();
  await expect(db.query("select begin_google_calendar_disconnect_v1($1,$2,$3)",[connection,creator,worker])).rejects.toThrow(/pending booking changes/);
  expect((await db.query("select status from scheduling_connections_v1 where id=$1",[connection])).rows).toEqual([{status:'connected'}]);
});
