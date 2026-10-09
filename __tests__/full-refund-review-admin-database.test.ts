/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const context={mode:"test",platformAccountId:"acct_owned"};
const attempt="10000000-0000-4000-8000-000000000001";
const read=async(after:string|null=null,c:object=context)=>(await db.query<any>("select read_full_refund_review_admin_v1($1,$2) r",[c,after])).rows[0].r;
beforeAll(async()=>{
  db=createLocalPostgres();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table exact_installment_context_pin_v2(singleton boolean,context jsonb);
    create table profiles(id uuid primary key,role text);
    create table server_payment_protocols_v1(attempt_id uuid primary key,context jsonb,kind text);
    create table full_server_payment_financial_holds_v1(attempt_id uuid primary key,payment_intent_id text,financial_hold_at timestamptz default now(),revision bigint default 0);
    create table full_server_payment_refund_object_events_v1(event_id text primary key,attempt_id uuid,refund_id text,charge_id text,observed_at timestamptz default now(),applied_at timestamptz,disposition text,details jsonb);
    create table full_server_payment_refund_observations_v1(event_id text,observation jsonb);
  `);await db.query("insert into exact_installment_context_pin_v2 values(true,$1)",[context]);
  for(const file of ["20260923061943_full_refund_review_backlog.sql","20260923063056_full_refund_review_admin.sql","20260923063821_full_refund_review_acknowledgement.sql"])
    await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
});
afterAll(async()=>{await db.close();});
beforeEach(async()=>{
  await db.exec("truncate full_refund_review_acknowledgements_v1,profiles,full_server_payment_refund_object_events_v1,full_server_payment_refund_observations_v1,full_server_payment_financial_holds_v1,server_payment_protocols_v1");
  await db.query("insert into server_payment_protocols_v1 values($1,$2,'full')",[attempt,context]);
  await db.query("insert into full_server_payment_financial_holds_v1(attempt_id,payment_intent_id) values($1,'pi_original')",[attempt]);
});
const actor="10000000-0000-4000-8000-000000000002",request="10000000-0000-4000-8000-000000000003";
const ack=async(revision=0,eventId="evt_A",requestId=request)=>(await db.query<any>("select acknowledge_full_refund_review_v1($1,$2,$3,$4,$5) r",[context,actor,requestId,eventId,revision])).rows[0].r;
test("review acknowledgement is durable, replayable, stale-aware and cannot reduce backlog or change the hold",async()=>{
  await event("evt_A");await db.query("insert into profiles values($1,'admin')",[actor]);
  const before=await read(),first=await ack();expect(first).toMatchObject({status:"review_recorded_hold_retained",current:true});
  expect(await ack()).toEqual(first);
  expect((await db.query<any>("select read_full_refund_review_admin_ack_v1($1,null) r",[context])).rows[0].r.rows[0].last_review).toMatchObject({revision:0,recordedAt:first.recordedAt});
  expect((await read()).backlog.needsReview).toBe(before.backlog.needsReview);
  await db.exec("update full_server_payment_financial_holds_v1 set revision=1");
  expect(await ack()).toMatchObject({current:false,recordedAt:first.recordedAt});
  await expect(ack(0,"evt_A","10000000-0000-4000-8000-000000000004")).rejects.toThrow("snapshot changed");
  await expect(ack(1)).rejects.toThrow("identity differs");
  expect((await db.query("select * from full_refund_review_acknowledgements_v1")).rows).toHaveLength(1);
  expect((await db.query<any>("select revision from full_server_payment_financial_holds_v1")).rows[0].revision).toBe(1);
});
test("acknowledgement rechecks admin role, original event and context",async()=>{
  await event("evt_A");await expect(ack()).rejects.toThrow("admin review context");
  await db.query("insert into profiles values($1,'admin')",[actor]);await expect(ack(0,"evt_wrong")).rejects.toThrow("held refund");
  await ack();await db.exec("update profiles set role='user'");await expect(ack()).rejects.toThrow("admin review context");
});
test.each(["anon","authenticated","service_role"])("%s cannot modify acknowledgement history directly",async role=>{
  await db.exec(`set role ${role}`);try{await expect(db.exec("delete from full_refund_review_acknowledgements_v1")).rejects.toThrow("permission denied");}finally{await db.exec("reset role");}
});
async function event(eventId:string){await db.query("insert into full_server_payment_refund_object_events_v1(event_id,attempt_id,refund_id,charge_id) values($1,$2,'re_original','ch_original')",[eventId,attempt]);}
test("bounded C-order pagination retains global deduplicated backlog and has no skipped boundary",async()=>{
  for(let n=0;n<28;n++)await event(`evt_${String(n).padStart(3,"0")}`);
  const first=await read();expect(first.rows).toHaveLength(26);expect(first.backlog).toMatchObject({needsReview:1,events:28,unapplied:28});
  const second=await read(first.rows[24].event_id);expect(second.rows.map((r:any)=>r.event_id)).toEqual(["evt_025","evt_026","evt_027"]);
  expect(second.backlog.events).toBe(28);expect((await read("evt_999")).rows).toEqual([]);
});
test("recorded observations remain held and raw details are never projected",async()=>{
  await event("evt_A");await db.exec(`update full_server_payment_refund_object_events_v1 set applied_at=now(),disposition='refund_observed',details='{"status":"succeeded","amountCents":100,"secret":"private"}';
    insert into full_server_payment_refund_observations_v1 values('evt_A','{}'),('evt_A','{"status":"pending"}');`);
  const result=await read();expect(result.rows[0]).toMatchObject({observations:2,refund_status:"succeeded",amount_cents:100,revision:0});
  expect(result.backlog.needsReview).toBe(1);expect(JSON.stringify(result)).not.toContain("private");
  expect((await db.query("select * from full_server_payment_financial_holds_v1")).rows).toHaveLength(1);
});
test("wrong pin, foreign context, wrong kind and malformed cursor fail closed",async()=>{
  await event("evt_A");await expect(read(null,{...context,mode:"live"})).rejects.toThrow("context required");
  await expect(read("invalid")).rejects.toThrow("cursor");
  await db.exec("update server_payment_protocols_v1 set kind='first_installment'");expect((await read()).rows).toEqual([]);
  await db.query("update server_payment_protocols_v1 set kind='full',context=$1",[{...context,mode:"live"}]);expect((await read()).rows).toEqual([]);
});
test.each(["anon","authenticated"])("%s cannot read details",async role=>{
  await db.exec(`set role ${role}`);try{await expect(read()).rejects.toThrow("permission denied");}finally{await db.exec("reset role");}
});
test("service role can read the exact context projection",async()=>{
  await event("evt_A");await db.exec("set role service_role");try{expect((await read()).rows).toHaveLength(1);}finally{await db.exec("reset role");}
});
