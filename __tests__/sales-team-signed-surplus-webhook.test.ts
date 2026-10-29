/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import type {SupabaseClient} from "@supabase/supabase-js";
import Stripe from "stripe";
import {NextRequest} from "next/server";
import {signedSurplusDatabase,seedSignedSurplus,signedSurplusCandidate} from "@/test-support/sales-team-surplus-ingress-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {observeTeamDailySurplus} from "@/lib/salesTeams/surplusObservations";
import {reserveTeamDailySurplus} from "@/lib/salesTeams/surplusReservations";
import {readTeamSurplusPayout} from "@/lib/salesTeams/surplusPayoutReadback";
import type {TeamSurplusMoneySource} from "@/lib/salesTeams/surplusPayoutPolicy";
import {locateTeamSurplusEvent} from "@/lib/salesTeams/surplusWebhook";
const verifier=new Stripe("sk_test_SyntheticNoNetwork"),secret="synthetic-surplus-secret",compose=jest.fn(),legacy=jest.fn();
let admin:SupabaseClient;
jest.mock("@supabase/supabase-js",()=>({createClient:()=>admin}));
jest.mock("@/lib/supabaseClient",()=>({supabase:{}}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>compose()}));
jest.mock("@/lib/stripeClient",()=>({getStripe:()=>({webhooks:verifier.webhooks})}));
jest.mock("@/lib/mentorshipInstallmentWebhook",()=>({handoffBuyerMentorshipDisputeWebhook:(...a:unknown[])=>legacy(...a),handoffBuyerMentorshipRefundWebhook:(...a:unknown[])=>legacy(...a)}));
jest.mock("@/lib/paymentRefunds",()=>({confirmAdminRefundWebhookDelivery:(...a:unknown[])=>legacy(...a)}));
jest.mock("@/lib/posthogServer",()=>({trackServerEvent:jest.fn()}));
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,h:Awaited<ReturnType<typeof seedSignedSurplus>>,POST:(req:NextRequest)=>Promise<Response>,advance:(ms:number)=>Promise<void>;
const env={...process.env};
beforeAll(async()=>{
 db=createLocalPostgres();advance=await installTeamLocalClock(db);await signedSurplusDatabase(db);
 const base=teamSupabaseFixture(db);admin={...base,rpc:(name:string,args:Record<string,unknown>)=>h.rpc(name,args)} as unknown as SupabaseClient;
 Object.assign(process.env,{VERCEL_ENV:"preview",STRIPE_SECRET_KEY:"sk_test_SyntheticNoNetwork",STRIPE_WEBHOOK_SECRET:secret,STRIPE_CONNECT_WEBHOOK_SECRET:"",NEXT_PUBLIC_SUPABASE_URL:"https://fixture.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic"});
 POST=(await import("@/app/api/stripe/webhook/route")).POST;
},30000);
beforeEach(async()=>{
 await db.exec("begin");h=await seedSignedSurplus(db);jest.clearAllMocks();
 // Only fake process-local schema readiness; no new-money flags are enabled.
 for(const key of readFileSync("lib/salesTeams/policy.ts","utf8").match(/CREATOR_[A-Z_]+SCHEMA_READY/g)??[])process.env[key]="true";
 compose.mockReturnValue(h.c);legacy.mockImplementation(()=>{throw Error("Owned surplus reached legacy effects");});
 jest.spyOn(console,"log").mockImplementation(()=>{});jest.spyOn(console,"error").mockImplementation(()=>{});
});
afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback;reset role");});
afterAll(async()=>{process.env={...env};await db?.close();});
const event=(type="payout.created",object:unknown=h.payout,eventId="evt_signedSurplus")=>({...h.event,id:eventId,type,data:{object}});
async function deliver(value=event(),key=secret){const payload=JSON.stringify(value);return POST(new NextRequest("https://fixture.invalid/api/stripe/webhook",{method:"POST",body:payload,headers:{"stripe-signature":verifier.webhooks.generateTestHeaderString({payload,secret:key})}}));}
const count=async(table:string)=>(await db.query<{n:number}>(`select count(*)::int n from ${table}`)).rows[0].n;
const epoch=async()=>(await db.query<{n:number}>("select epoch::int n from sales_team_cash_epoch_v1")).rows[0].n;
const noNewMoney=async()=>db.exec("do $$ declare c record;begin for c in select attname from pg_attribute where attrelid='public.sales_team_controls_v1'::regclass and atttypid='boolean'::regtype and attname<>'singleton' and not attisdropped loop execute format('update public.sales_team_controls_v1 set %I=false',c.attname);end loop;end $$");
const claim=(eventId="evt_signedSurplus",token=id(300),type="payout.created")=>h.invoke<string>("claim_stripe_event",{p_event_id:`stripe:${eventId}`,p_event_type:type,p_lease_seconds:300,p_claim_token:token});
const begin=(token:string|null=id(300),eventId="evt_signedSurplus",type="payout.created")=>h.invoke("begin_sales_team_surplus_event_v1",{p_event_id:eventId,p_event_type:type,p_event_created:h.event.created,p_payout_id:h.payout.id,p_request_id:h.q.id,p_context:h.c.context,p_claim_token:token});

test("signed original uses actual shared claims and independent money once with new-money disabled",async()=>{
 await h.dispatch();await noNewMoney();h.raw.mockClear();await db.exec("set local role service_role");
 expect((await deliver()).status).toBe(200);expect(legacy).not.toHaveBeenCalled();expect(h.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect(await count("sales_team_surplus_event_results_v1")).toBe(1);expect(await count("sales_team_surplus_balance_entries_v1")).toBe(1);
 expect((await db.query("select status from stripe_events")).rows).toEqual([{status:"completed"}]);
 const before=await epoch(),reads=h.raw.mock.calls.length;expect((await deliver()).status).toBe(200);expect(h.raw.mock.calls).toHaveLength(reads);expect(await epoch()).toBe(before);
 expect((await db.query("select proof->>'bankConfirmed' bank from sales_team_surplus_event_results_v1")).rows).toEqual([{bank:"false"}]);
});
test("lost original response recovers by exact creation event without another POST",async()=>{
 h.losePost();await h.dispatch();await noNewMoney();h.raw.mockClear();
 expect((await deliver()).status).toBe(200);expect(h.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect((await db.query("select status,provider_id from sales_team_provider_operations_v1 where id=$1",[h.q.operation_id])).rows).toEqual([{status:"bound",provider_id:"po_original"}]);
 expect(await count("sales_team_surplus_recovery_proofs_v1")).toBe(1);expect(legacy).not.toHaveBeenCalled();
});
test("saved payout binding locates an original without metadata",async()=>{
 await h.dispatch();expect((await deliver(event("payout.paid",{...h.payout,metadata:{}}))).status).toBe(200);expect(legacy).not.toHaveBeenCalled();
});
test("bad signature, mode and connected source fail before a shared claim",async()=>{
 expect((await deliver(event(),"wrong-secret")).status).toBe(400);
 expect((await deliver({...event(),livemode:true})).status).toBe(400);
 expect((await deliver({...event(),account:"acct_foreign"})).status).toBe(400);
 expect(h.rpc.mock.calls.some(([name])=>name==="claim_stripe_event")).toBe(false);expect(h.raw).not.toHaveBeenCalled();
});
test.each(["foreign_payout","foreign_request","foreign_operation","non_payout","foreign_marker"])("forged %s cannot reach money reads or legacy",async fault=>{
 await h.dispatch();h.raw.mockClear();const object={...h.payout,metadata:{...(h.payout.metadata as Record<string,string>)}};
 if(fault==="foreign_payout")object.id="po_foreign";
 if(fault==="foreign_request")object.metadata.team_surplus_request_id=id(999);
 if(fault==="foreign_operation")object.metadata.team_provider_operation_id=id(999);
 if(fault==="foreign_marker")object.metadata.team_protocol="foreign";
 if(fault==="non_payout")Object.assign(object,{object:"payment_intent",id:"pi_foreign"});
 expect((await deliver(event("payout.created",object))).status).toBe(500);expect(h.raw).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();expect(await count("stripe_events")).toBe(0);
});
test("disabled schema readiness still admits a durable hold without acknowledging",async()=>{
 await h.dispatch();delete process.env.CREATOR_TEAM_SURPLUS_EVENTS_SCHEMA_READY;h.raw.mockClear();const before=await epoch();
 expect((await deliver()).status).toBe(500);expect(await count("sales_team_surplus_events_v1")).toBe(1);expect(await epoch()).toBe(before+1);
 expect(await count("sales_team_surplus_event_results_v1")).toBe(0);expect(h.raw).not.toHaveBeenCalled();expect(compose).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();
 process.env.CREATOR_TEAM_SURPLUS_EVENTS_SCHEMA_READY="true";expect((await deliver()).status).toBe(200);
});
test("pending debit remains durable and unacknowledged until an independent available read",async()=>{
 await h.dispatch();h.debit.status="pending";h.raw.mockClear();
 expect((await deliver()).status).toBe(500);expect(await count("sales_team_surplus_events_v1")).toBe(1);expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
 expect(await count("stripe_events")).toBe(0);h.debit.status="available";expect((await deliver()).status).toBe(200);expect(h.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
test("old shared completion without a surplus result reconciles the exact original",async()=>{
 await h.dispatch();await claim();await h.invoke("complete_stripe_event",{p_event_id:"stripe:evt_signedSurplus",p_claim_token:id(300)});h.raw.mockClear();
 expect((await deliver()).status).toBe(200);expect(await count("sales_team_surplus_event_results_v1")).toBe(1);expect(h.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);expect(legacy).not.toHaveBeenCalled();
});
test("organization context on a signed platform payout is rejected before claim",async()=>{
 expect((await deliver({...event(),context:"acct_foreign"})).status).toBe(400);
 expect(h.rpc.mock.calls.some(([name])=>name==="claim_stripe_event")).toBe(false);expect(h.raw).not.toHaveBeenCalled();
});
test("busy claims are not acknowledged and expired claims fence old tokens",async()=>{
 await h.dispatch();expect(await claim()).toBe("new");h.raw.mockClear();
 expect((await deliver()).status).toBe(500);expect(h.raw).not.toHaveBeenCalled();expect(await count("sales_team_surplus_events_v1")).toBe(0);
 await db.exec("update stripe_events set claimed_at=clock_timestamp()-interval '301 seconds'");expect(await claim("evt_signedSurplus",id(301))).toBe("new");
 await expect(begin()).rejects.toThrow(/DURABLE_SIGNED_SURPLUS_CLAIM_REQUIRED/);
 for(const name of ["complete_stripe_event","release_stripe_event"])expect(await h.invoke(name,{p_event_id:"stripe:evt_signedSurplus",p_claim_token:id(300)})).toBe(false);
 await begin(id(301));expect(await count("sales_team_surplus_events_v1")).toBe(1);
 await db.exec("update stripe_events set claimed_at=clock_timestamp()-interval '301 seconds'");expect((await deliver()).status).toBe(200);expect(legacy).not.toHaveBeenCalled();
});
test.each(["missing","wrong_type","wrong_token","null_token","expired","future"])("SQL rejects a %s shared claim",async fault=>{
 await h.dispatch();if(fault!=="missing")await claim("evt_signedSurplus",id(300),fault==="wrong_type"?"payout.failed":"payout.created");
 if(fault==="expired")await db.exec("update stripe_events set claimed_at=clock_timestamp()-interval '301 seconds'");
 if(fault==="future")await db.exec("update stripe_events set claimed_at=clock_timestamp()+interval '10 seconds'");
 await expect(begin(fault==="null_token"?null:fault==="wrong_token"?id(301):id(300))).rejects.toThrow(/DURABLE_SIGNED_SURPLUS_CLAIM_REQUIRED/);
 expect(await count("sales_team_surplus_events_v1")).toBe(0);
});
test("a reclaimed claim during independent reads fences stale completion and release",async()=>{
 await h.dispatch();const original=h.raw.getMockImplementation()!;let reclaimed=false;
 h.raw.mockImplementation(async(method,path)=>{
  if(path==="/v1/payouts/po_original"&&!reclaimed){reclaimed=true;await db.exec("update stripe_events set claimed_at=clock_timestamp()-interval '301 seconds'");expect(await claim("evt_signedSurplus",id(301))).toBe("new");}
  return original(method,path);
 });
 expect((await deliver()).status).toBe(500);expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
 expect((await db.query("select status,claim_token from stripe_events")).rows).toEqual([{status:"processing",claim_token:id(301)}]);
 await db.exec("update stripe_events set claimed_at=clock_timestamp()-interval '301 seconds'");expect((await deliver()).status).toBe(200);
});
test("an old shared completion with failed read stays held until exact duplicate recovery",async()=>{
 await h.dispatch();await claim();await h.invoke("complete_stripe_event",{p_event_id:"stripe:evt_signedSurplus",p_claim_token:id(300)});
 const original=h.raw.getMockImplementation()!;h.raw.mockRejectedValue(Error("synthetic unavailable"));
 expect((await deliver()).status).toBe(500);expect(await count("sales_team_surplus_events_v1")).toBe(1);expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
 expect((await db.query("select status from stripe_events")).rows).toEqual([{status:"completed"}]);h.raw.mockImplementation(original);expect((await deliver()).status).toBe(200);
});
test.each(["missing_return","pending_return","stale_provider"])("late failure with %s holds cash and selects the original next day",async fault=>{
 await h.dispatch();expect((await deliver()).status).toBe(200);const resolution=(await db.query("select * from sales_team_surplus_resolutions_v1")).rows;
 expect(await h.invoke("finish_sales_team_surplus_run_v1",{p_run_id:h.run.runId,p_lease_token:h.run.leaseToken,p_context:h.c.context,p_failed:false})).toMatchObject({status:"complete"});
 const before=await epoch();h.payout.status=fault==="stale_provider"?"paid":"failed";h.payout.failure_balance_transaction=fault==="pending_return"?"txn_return":null;h.returned.status="pending";
 expect((await deliver(event("payout.failed",h.payout,"evt_lateFailure"))).status).toBe(500);expect(await epoch()).toBeGreaterThan(before);
 expect((await db.query("select creatornet_team_private.surplus_policy_ready_v1($1) ready",[h.c.context])).rows).toEqual([{ready:false}]);
 await noNewMoney();const now=Date.now;await advance(86400000);jest.spyOn(Date,"now").mockImplementation(()=>now()+86400000);
 const run=await h.claim(id(310),false);expect(run.status).toBe("claimed");
 expect(await reserveTeamDailySurplus(h.c,{...run,requestId:id(311)})).toMatchObject({status:"original",request:{id:h.q.id}});
 expect(await h.invoke("finish_sales_team_surplus_run_v1",{p_run_id:run.runId,p_lease_token:run.leaseToken,p_context:h.c.context,p_failed:false})).toMatchObject({status:"review_required"});
 h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";h.returned.status="available";
 expect((await deliver(event("payout.failed",h.payout,"evt_lateFailure"))).status).toBe(200);
 expect((await db.query("select * from sales_team_surplus_resolutions_v1")).rows).toEqual(resolution);
 expect(await count("sales_team_surplus_balance_entries_v1")).toBe(2);expect(await count("sales_team_surplus_event_results_v1")).toBe(2);
 expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);expect(legacy).not.toHaveBeenCalled();
});
test("one result cannot clear another signed event's hold",async()=>{
 await h.dispatch();await claim();await begin();await claim("evt_secondSurplus",id(301));await begin(id(301),"evt_secondSurplus");
 await h.invoke("release_stripe_event",{p_event_id:"stripe:evt_signedSurplus",p_claim_token:id(300)});
 expect((await deliver()).status).toBe(200);expect((await db.query("select creatornet_team_private.surplus_policy_ready_v1($1) ready",[h.c.context])).rows).toEqual([{ready:false}]);
 expect(await count("sales_team_surplus_event_results_v1")).toBe(1);
});
test.each(["locator","begin","complete"])("missing %s schema never allows an owned payout to fall through",async owner=>{
 await h.dispatch();const signatures={locator:"locate_sales_team_surplus_event_v1(text,uuid,uuid,text)",begin:"begin_sales_team_surplus_event_v1(text,text,bigint,text,uuid,jsonb,uuid)",complete:"complete_sales_team_surplus_event_v1(text,uuid,uuid,jsonb)"};
 await db.exec(`alter function public.${signatures[owner as keyof typeof signatures]} rename to fixture_missing_${owner}`);h.raw.mockClear();
 expect((await deliver()).status).toBe(500);expect(legacy).not.toHaveBeenCalled();expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
 expect((await deliver(event("payout.updated",{...h.payout,metadata:{}}))).status).toBe(500);expect(legacy).not.toHaveBeenCalled();
});
test("a changed duplicate payload cannot change immutable event ownership",async()=>{
 await h.dispatch();expect((await deliver()).status).toBe(200);const before=await epoch();h.raw.mockClear();
 expect((await deliver({...event(),created:h.event.created+1})).status).toBe(500);
 expect((await deliver(event("payout.failed"))).status).toBe(500);expect(await epoch()).toBe(before);expect(h.raw).not.toHaveBeenCalled();
});
test("a pre-event observation cannot complete a newly admitted event",async()=>{
 await h.dispatch();await observeTeamDailySurplus(h.c,h.q.id,"00000000-0000-4000-8000-000000000320");const now=Date.now;await advance(100);jest.spyOn(Date,"now").mockImplementation(()=>now()+100);
 await claim();await begin();await expect(h.invoke("complete_sales_team_surplus_event_v1",{p_event_id:"evt_signedSurplus",p_claim_token:id(300),p_check_id:id(320),p_context:h.c.context})).rejects.toThrow(/INDEPENDENT_COMPLETE_SURPLUS_EVENT_MONEY_REQUIRED/);
 expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
});
test("an observation admitted before the event cannot serve as its later completion",async()=>{
 await h.dispatch();const args={p_check_id:id(320),p_request_id:h.q.id,p_context:h.c.context};
 const source=await h.invoke<TeamSurplusMoneySource>("begin_sales_team_surplus_check_v1",args);
 const now=Date.now;await advance(100);jest.spyOn(Date,"now").mockImplementation(()=>now()+100);await claim();await begin();
 const proof=await readTeamSurplusPayout(h.c,source,h.payout.id);await h.invoke("complete_sales_team_surplus_check_v1",{...args,p_proof:proof});
 await expect(h.invoke("complete_sales_team_surplus_event_v1",{p_event_id:"evt_signedSurplus",p_claim_token:id(300),p_check_id:id(320),p_context:h.c.context})).rejects.toThrow(/INDEPENDENT_COMPLETE_SURPLUS_EVENT_MONEY_REQUIRED/);
});
test("non-payout traffic returns before any surplus database lookup",async()=>{
 expect(await locateTeamSurplusEvent({event:event("payment_intent.succeeded",{id:"pi_unrelated",object:"payment_intent",metadata:{}}) as unknown as Stripe.Event,admin,env:process.env})).toBeNull();
 expect(h.rpc).not.toHaveBeenCalled();expect(h.raw).not.toHaveBeenCalled();
});
test.each([
 {name:"unowned",owned:false,ready:false,code:null,allowed:true},
 {name:"durably owned",owned:true,ready:false,code:null,allowed:false},
 {name:"installed readiness",owned:false,ready:true,code:null,allowed:false},
 {name:"absent table",owned:false,ready:false,code:"42P01",allowed:true},
 {name:"absent cached table",owned:false,ready:false,code:"PGRST205",allowed:true},
 {name:"other database error",owned:false,ready:false,code:"XX000",allowed:false},
])("missing locator fallback: $name, with timeout before single-row query",async fault=>{
 const order:string[]=[],chain={select:()=>chain,eq:()=>chain,abortSignal:(signal:AbortSignal)=>{expect(signal).toBeInstanceOf(AbortSignal);order.push("timeout");return chain;},
  maybeSingle:async()=>{order.push("single");return {data:fault.owned?{id:id(300)}:null,error:fault.code?{code:fault.code}:null};}};
 jest.spyOn(admin,"rpc").mockImplementation((()=>Promise.resolve({data:null,error:{code:"PGRST202",message:"synthetic absent locator"}})) as unknown as typeof admin.rpc);
 jest.spyOn(admin,"from").mockReturnValue(chain as unknown as ReturnType<typeof admin.from>);
 const result=locateTeamSurplusEvent({event:event("payout.updated",{...h.payout,metadata:{}}) as unknown as Stripe.Event,admin,env:fault.ready?process.env:{}});
 if(fault.allowed)expect(await result).toBeNull();else await expect(result).rejects.toThrow();
 expect(order).toEqual(["timeout","single"]);expect(h.raw).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();
});
test("installed locator leaves an unrelated unmarked payout to its existing owner",async()=>{
 expect(await locateTeamSurplusEvent({event:event("payout.updated",{...h.payout,id:"po_unrelated",metadata:{}}) as unknown as Stripe.Event,admin,env:process.env})).toBeNull();
 expect(h.raw).not.toHaveBeenCalled();
});
test.each([20000,-1000])("elapsed context budget %i keeps a durable hold without admitting more provider work",async offset=>{
 await h.dispatch();h.raw.mockClear();const now=Date.now;let shifted=false;
 compose.mockReturnValue({...h.c,observeContext:async()=>{if(!shifted){shifted=true;jest.spyOn(Date,"now").mockImplementation(()=>now()+offset);}return h.c.context;}});
 expect((await deliver()).status).toBe(500);expect(h.raw).not.toHaveBeenCalled();expect(await count("sales_team_surplus_events_v1")).toBe(1);expect(await count("sales_team_surplus_event_results_v1")).toBe(0);expect(legacy).not.toHaveBeenCalled();
});
test("unknown original recovery cannot complete a signed event for a different payout",async()=>{
 h.losePost();await h.dispatch();h.raw.mockClear();expect((await deliver(event("payout.created",{...h.payout,id:"po_foreign"}))).status).toBe(500);
 expect(await count("sales_team_surplus_events_v1")).toBe(1);expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
 expect((await db.query("select provider_id from sales_team_provider_operations_v1 where id=$1",[h.q.operation_id])).rows).toEqual([{provider_id:"po_original"}]);
 expect(h.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);expect(legacy).not.toHaveBeenCalled();
});
test("signed event histories have RLS, service SELECT-only grants and immutable records",async()=>{
 await h.dispatch();expect((await deliver()).status).toBe(200);
 for(const table of ["sales_team_surplus_events_v1","sales_team_surplus_event_results_v1"]){
  expect((await db.query("select relrowsecurity rls from pg_class where oid=$1::regclass",[`public.${table}`])).rows).toEqual([{rls:true}]);
  for(const role of ["anon","authenticated","service_role"]){
   expect((await db.query("select has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE') allowed",[role,`public.${table}`])).rows).toEqual([{allowed:false}]);
   expect((await db.query("select has_table_privilege($1,$2,'SELECT') allowed",[role,`public.${table}`])).rows).toEqual([{allowed:role==="service_role"}]);
  }
  await db.exec("savepoint immutable_surplus");await expect(db.exec(`delete from public.${table}`)).rejects.toThrow(/IMMUTABLE/);await db.exec("rollback to savepoint immutable_surplus");
 }
 for(const signature of ["public.locate_sales_team_surplus_event_v1(text,uuid,uuid,text)","public.begin_sales_team_surplus_event_v1(text,text,bigint,text,uuid,jsonb,uuid)","public.complete_sales_team_surplus_event_v1(text,uuid,uuid,jsonb)","creatornet_team_private.signed_surplus_claim_v1(text,text,uuid)","creatornet_team_private.surplus_request_pending_v1(uuid)","creatornet_team_private.surplus_policy_before_events_v1(jsonb)","creatornet_team_private.surplus_policy_ready_v1(jsonb)"]){
  for(const role of ["anon","authenticated","service_role"])expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows).toEqual([{allowed:role==="service_role"}]);
 }
});
test.each(["public.locate_sales_team_surplus_event_v1(text,uuid,uuid,text)","public.begin_sales_team_surplus_event_v1(text,text,bigint,text,uuid,jsonb,uuid)","public.complete_sales_team_surplus_event_v1(text,uuid,uuid,jsonb)","creatornet_team_private.signed_surplus_claim_v1(text,text,uuid)","creatornet_team_private.surplus_request_pending_v1(uuid)","creatornet_team_private.surplus_policy_before_events_v1(jsonb)","creatornet_team_private.surplus_policy_ready_v1(jsonb)"])("all five financial digests bind %s",async signature=>{
 const digests=["transfer_contract_digest_v1","shared_cash_contract_digest_v1","retained_cash_contract_digest_v1","recovery_contract_digest_v1","surplus_contract_digest_v1"],read=async()=>Promise.all(digests.map(async n=>(await db.query<{d:string}>(`select creatornet_team_private.${n}() d`)).rows[0].d));
 const before=await read(),body=(await db.query<{s:string}>("select pg_get_functiondef($1::regprocedure) s",[signature])).rows[0].s;
 await db.exec(body.replace(/AS \$function\$/i,"AS $function$\n-- synthetic drift\n"));(await read()).forEach((value,i)=>expect(value).not.toBe(before[i]));
});
test.each(["dependency","shared_claim","predicate","late_grant"])("F43 %s installation failure rolls back schema and functions",async fault=>{
 const isolated=createLocalPostgres();try{await signedSurplusDatabase(isolated,false);
  if(fault==="dependency")await isolated.exec("alter function creatornet_team_private.surplus_contract_digest_v1() rename to fixture_missing_digest");
  if(fault==="shared_claim")await isolated.exec("alter function public.claim_stripe_event(text,text,integer,uuid) rename to fixture_missing_shared_claim");
  const inventory=async()=>(await isolated.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text grants from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) order by oid")).rows,before=await inventory();
  let sql=readFileSync(signedSurplusCandidate,"utf8");if(fault==="predicate")sql=sql.replace("needle:='not exists(select 1", "needle:='MISSING not exists(select 1");
  if(fault==="late_grant")sql=sql.replace("commit;","grant execute on function public.missing_signed_surplus_grant() to service_role;commit;");
  await expect(isolated.exec(sql)).rejects.toThrow();await isolated.exec("rollback");expect(await inventory()).toEqual(before);
  expect((await isolated.query("select to_regclass('public.sales_team_surplus_events_v1') event,to_regclass('public.sales_team_surplus_event_results_v1') result")).rows).toEqual([{event:null,result:null}]);
 }finally{await isolated.close();}
},30000);
