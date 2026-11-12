import type {SupabaseClient} from "@supabase/supabase-js";
import {runTeamAutomaticRecovery} from "@/lib/salesTeams/recovery";
import {readTeamFinancialSnapshot,observeTeamPaymentEvent} from "@/lib/salesTeams/financialReadback";
import {refreshTeamBoundCollection} from "@/lib/salesTeams/collection";
import {teamAutomaticRecoveryReady,teamAutomaticRefundRecoveryReady,teamSharedUnsentRecoveryReady} from "@/lib/salesTeams/policy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
jest.mock("@/lib/salesTeams/financialReadback",()=>({readTeamFinancialSnapshot:jest.fn(),observeTeamPaymentEvent:jest.fn()}));
jest.mock("@/lib/salesTeams/collection",()=>({refreshTeamBoundCollection:jest.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
function fixture(completed=false){
 let task=0;const rpc=jest.fn(async(name:string):Promise<{data:unknown;error:null}>=>({data:name==="claim_sales_team_recovery_run_v1"?{status:"claimed",runId:id(80),leaseToken:id(81)}:name==="next_sales_team_recovery_task_v1"?task++===0?{id:id(90),kind:"financial",source_id:id(1),source:{receiptId:id(1)}}:null:name==="begin_sales_team_recovery_financial_v1"?{completed,held:false,checkId:id(90),source:{saleId:id(2),buyerId:id(3),obligationId:id(4),paymentIntentId:"pi_original",context}}:null,error:null}));
 const raw=jest.fn(async()=>({lastResponse:{requestId:"req_bounded",headers:{},statusCode:200}}));
 const c={admin:{rpc} as unknown as SupabaseClient,context,observeContext:async()=>context,observeEvidence:jest.fn(),stripe:{rawRequest:raw}} as TeamReceiptComposition;
 return {c,raw,rpc};
}
beforeEach(()=>{jest.mocked(readTeamFinancialSnapshot).mockReset();jest.mocked(observeTeamPaymentEvent).mockReset();jest.mocked(refreshTeamBoundCollection).mockReset();});
test("a delivery failure after event reconciliation remains held and records review",async()=>{
 const f=fixture(),base=f.rpc.getMockImplementation()!;let task=0;
 f.rpc.mockImplementation(async name=>{if(name==="next_sales_team_recovery_task_v1")return {data:task++===0?{id:id(90),kind:"event",source_id:"evt_original",source:{saleId:id(2),buyerId:id(3),obligationId:id(4),paymentIntentId:"pi_original",context}}:null,error:null};if(name==="fulfill_sales_team_receipt_v1")throw Error("synthetic delivery failure");return base(name);});
 jest.mocked(refreshTeamBoundCollection).mockResolvedValue({saved:{receipt:{id:id(1)}}} as unknown as Awaited<ReturnType<typeof refreshTeamBoundCollection>>);jest.mocked(observeTeamPaymentEvent).mockResolvedValue({receiptId:id(1),held:false});
 expect(await runTeamAutomaticRecovery(f.c,{fulfill:true})).toEqual({status:"review_required",observed:0,held:1});
});
test("a delegated reader cannot issue any provider POST",async()=>{
 const f=fixture();jest.mocked(readTeamFinancialSnapshot).mockImplementation(async c=>{await c.stripe.rawRequest("POST","/v1/refunds",{});throw Error("unreachable");});
 expect(await runTeamAutomaticRecovery(f.c)).toEqual({status:"review_required",observed:0,held:1});expect(f.raw).not.toHaveBeenCalled();
});
test("no more than forty object GETs are admitted in one invocation",async()=>{
 const f=fixture();jest.mocked(readTeamFinancialSnapshot).mockImplementation(async c=>{const reads=await Promise.allSettled(Array.from({length:41},()=>c.stripe.rawRequest("GET","/v1/charges/ch_original",{})));if(reads.some(r=>r.status==="rejected"))throw Error("bounded");throw Error("unexpected");});
 expect(await runTeamAutomaticRecovery(f.c)).toMatchObject({held:1});expect(f.raw).toHaveBeenCalledTimes(40);expect(f.raw.mock.calls[0]).toEqual(["GET","/v1/charges/ch_original",{},expect.objectContaining({maxNetworkRetries:0,timeout:10000})]);
});
test("a failed task drains every already admitted GET before completing its audit result",async()=>{
 const f=fixture();let release!:()=>void,started!:()=>void,slowDone=false;
 const gate=new Promise<void>(resolve=>{release=resolve;}),bothStarted=new Promise<void>(resolve=>{started=resolve;});
 f.raw.mockImplementation(async(...args:unknown[])=>{if(args[1]==="/v1/charges/ch_slow"){started();await gate;slowDone=true;return {lastResponse:{requestId:"req_slow",headers:{},statusCode:200}};}throw Error("synthetic failure");});
 jest.mocked(readTeamFinancialSnapshot).mockImplementation(async c=>{await Promise.all([c.stripe.rawRequest("GET","/v1/charges/ch_fail",{}),c.stripe.rawRequest("GET","/v1/charges/ch_slow",{})]);throw Error("unreachable");});
 const running=runTeamAutomaticRecovery(f.c);await bothStarted;expect(f.rpc.mock.calls.some(([name])=>name==="finish_sales_team_recovery_task_v1")).toBe(false);release();await running;expect(slowDone).toBe(true);
});
test("an exhausted observation budget cannot commit a stale financial snapshot",async()=>{
 const f=fixture();let now=1000;jest.mocked(readTeamFinancialSnapshot).mockImplementation(async()=>{now+=45000;return {} as Awaited<ReturnType<typeof readTeamFinancialSnapshot>>;});
 expect(await runTeamAutomaticRecovery(f.c,{now:()=>now})).toMatchObject({held:1});expect(f.rpc.mock.calls.some(([name])=>name==="complete_sales_team_recovery_financial_v1")).toBe(false);
});
test("new-money flags are independent of the explicit recovery schema and execution gates",()=>{
 const env={CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY:"true",CREATOR_TEAM_PAYMENT_SCHEMA_READY:"true",CREATOR_TEAM_RECEIPT_SCHEMA_READY:"true",CREATOR_TEAM_EVENT_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_SCHEMA_READY:"true",CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY:"true",CREATOR_TEAM_CASH_SCHEMA_READY:"true",CREATOR_TEAM_AUTOMATIC_RECOVERY_SCHEMA_READY:"true",CREATOR_TEAM_AUTOMATIC_RECOVERY_READY:"true"};
 expect(teamAutomaticRecoveryReady(env)).toBe(true);expect(teamAutomaticRecoveryReady({...env,CREATOR_TEAM_AUTOMATIC_RECOVERY_READY:"false"})).toBe(false);expect(teamAutomaticRecoveryReady({...env,CREATOR_TEAM_AUTOMATIC_RECOVERY_SCHEMA_READY:"false"})).toBe(false);
 expect(teamAutomaticRefundRecoveryReady(env)).toBe(false);
 const refunds={...env,CREATOR_TEAM_AUTOMATIC_REFUND_RECOVERY_SCHEMA_READY:"true",CREATOR_TEAM_AUTOMATIC_REFUND_RECOVERY_READY:"true"};
 expect(teamAutomaticRefundRecoveryReady(refunds)).toBe(true);expect(teamAutomaticRefundRecoveryReady({...refunds,CREATOR_TEAM_AUTOMATIC_REFUND_RECOVERY_SCHEMA_READY:"false"})).toBe(false);expect(teamAutomaticRefundRecoveryReady({...refunds,CREATOR_TEAM_AUTOMATIC_REFUND_RECOVERY_READY:"false"})).toBe(false);
 expect(teamSharedUnsentRecoveryReady(env)).toBe(false);
 const unsent={...env,CREATOR_TEAM_SHARED_UNSENT_RECOVERY_SCHEMA_READY:"true",CREATOR_TEAM_SHARED_UNSENT_RECOVERY_READY:"true"};
 expect(teamSharedUnsentRecoveryReady(unsent)).toBe(true);expect(teamSharedUnsentRecoveryReady({...unsent,CREATOR_TEAM_SHARED_UNSENT_RECOVERY_SCHEMA_READY:"false"})).toBe(false);expect(teamSharedUnsentRecoveryReady({...unsent,CREATOR_TEAM_SHARED_UNSENT_RECOVERY_READY:"false"})).toBe(false);
});

test("the refund option is omitted for the installed four argument F20 queue",async()=>{
 const f=fixture(true);await runTeamAutomaticRecovery(f.c);expect(f.rpc).toHaveBeenCalledWith("next_sales_team_recovery_task_v1",expect.not.objectContaining({p_refunds:expect.anything()}));
});
