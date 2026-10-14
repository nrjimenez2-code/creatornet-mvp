/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const context={mode:"test",platformAccountId:"acct_owned"};
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const read=async(c:object=context)=>(await db.query<any>("select read_full_refund_review_backlog_v1($1) r",[c])).rows[0].r;
beforeAll(async()=>{
  db=createLocalPostgres();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table exact_installment_context_pin_v2(singleton boolean,context jsonb);
    create table server_payment_protocols_v1(attempt_id uuid primary key,context jsonb,kind text);
    create table full_server_payment_financial_holds_v1(attempt_id uuid primary key);
    create table full_server_payment_refund_object_events_v1(event_id text primary key,attempt_id uuid,observed_at timestamptz default now(),applied_at timestamptz,disposition text);
  `);await db.query("insert into exact_installment_context_pin_v2 values(true,$1)",[context]);
  await db.exec(readFileSync("supabase/migrations/20260923061943_full_refund_review_backlog.sql","utf8"));
});
afterAll(async()=>{await db.close();});
beforeEach(async()=>{await db.exec("truncate full_server_payment_refund_object_events_v1,full_server_payment_financial_holds_v1,server_payment_protocols_v1");});
async function event(n:number,attempt:number,disposition:string|null=null,ctx:object=context,kind="full") {
  await db.query("insert into server_payment_protocols_v1 values($1,$2,$3) on conflict do nothing",[id(attempt),ctx,kind]);
  await db.query("insert into full_server_payment_financial_holds_v1 values($1) on conflict do nothing",[id(attempt)]);
  await db.query("insert into full_server_payment_refund_object_events_v1(event_id,attempt_id,applied_at,disposition) values($1,$2,case when $3::text is null then null else now() end,$3)",[`evt_${n}`,id(attempt),disposition]);
}
test("empty is explicit, not inferred from errors",async()=>{expect(await read()).toMatchObject({context,needsReview:0,events:0,unapplied:0,reviewRecorded:0,oldestObservedAt:null});});
test("unapplied and applied events for one held original remain one attention item",async()=>{
  await event(1,1);await event(2,1,"refund_review_recorded");await event(3,1,"refund_observed");await event(4,2,"refund_observed");
  expect(await read()).toMatchObject({needsReview:2,events:4,unapplied:1,reviewRecorded:1});
  expect((await db.query("select * from full_server_payment_financial_holds_v1")).rows).toHaveLength(2);
  expect(await read()).toMatchObject({needsReview:2,events:4,unapplied:1,reviewRecorded:1});
});
test("foreign context and installment originals do not contaminate counts",async()=>{
  await event(1,1,null,{...context,mode:"live"});await event(2,2,null,context,"first_installment");await event(3,3);
  expect(await read()).toMatchObject({needsReview:1,events:1});
  await expect(read({...context,mode:"live"})).rejects.toThrow("Current refund review context required");
});
test.each(["anon","authenticated"])("%s cannot read service backlog",async role=>{
  await db.exec(`set role ${role}`);try{await expect(read()).rejects.toThrow("permission denied");}finally{await db.exec("reset role");}
});
test("service role can read only the pinned context",async()=>{
  await event(1,1);await db.exec("set role service_role");try{expect((await read()).needsReview).toBe(1);}finally{await db.exec("reset role");}
});
