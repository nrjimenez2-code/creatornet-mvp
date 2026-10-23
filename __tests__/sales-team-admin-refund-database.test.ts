/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import {inspectTeamReceiptFinancials,reviewTeamRefundResponsibility} from "@/lib/salesTeams/financialChecks";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {reserveTeamAdminRefund,processTeamAdminRefund,previewTeamAdminRefund} from "@/lib/salesTeams/adminRefunds";
import {readTeamFinancialSnapshot,observeTeamPaymentEvent} from "@/lib/salesTeams/financialReadback";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,receiptId:string,c:TeamReceiptComposition,raw:jest.Mock,refunds:Record<string,unknown>[],balances:Record<string,unknown>;
beforeAll(async()=>{
 db=await teamSharedDatabase(createLocalPostgres());await db.exec("alter table profiles add column role text");
 for(const name of ["20261021230016_sales_team_financial_statements.sql","20261023000533_sales_team_payment_events.sql","20261023002620_sales_team_financial_reconciliation.sql","20261023010604_sales_team_booked_offer_associations.sql","20261023012742_sales_team_admin_refund_dispatch.sql"])await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,refund_review_enabled=true,refund_dispatch_enabled=true,fulfillment_enabled=true");
 f=await seedTeamCapture(db);await db.query("update profiles set role='admin' where id=$1",[id(29)]);receiptId=String((await f.record()).id);refunds=[];balances={};let sequence=0;
 raw=jest.fn(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Database financial fixture is GET-only");
  const value=path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:
   path==="/v1/refunds"?{object:"list",data:refunds,has_more:false}:path==="/v1/disputes"?{object:"list",data:[],has_more:false}:path.startsWith("/v1/refunds/")?refunds.find(r=>r.id===path.split("/").at(-1)):balances[path.split("/").at(-1)!];
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_refundDb${++sequence}`}}));
 });
 c={admin:teamSupabaseFixture(db),stripe:{rawRequest:raw},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence};
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
type Request={id:string;operation_id:string;scope:TeamOperationScope;request:Record<string,unknown>;receipt:{revision:number}};
async function reserve(requestId=id(25),amount=1000){const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1 where id=$1",[receiptId])).rows[0].r);return f.rpc<Request>("reserve_sales_team_refund_v1",[id(29),requestId,receiptId,revision,amount,"creator","creator_discretionary",c.context]);}
const inspect=()=>inspectTeamReceiptFinancials(c,receiptId,id(29));
test("refund request freezes the original separate charge and original provider identity before reads",async()=>{
 const q=await reserve();expect(q.operation_id).toBe(teamOperationId(q.scope));expect(q.request).toMatchObject({method:"POST",path:"/v1/refunds",params:{charge:"ch_original",amount:1000}});
 expect(q.request).not.toHaveProperty("params.reverse_transfer");expect(raw).not.toHaveBeenCalled();
 expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:true}]);
});
test("only a fresh completed financial inspection can admit the exact frozen refund operation",async()=>{
 const q=await reserve();expect(await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request])).toEqual({status:"not_enabled"});
 const checked=await inspect();expect(checked.held).toBe(true);await f.rpc("attach_sales_team_refund_check_v1",[id(29),q.id,checked.checkId]);
 expect(await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request])).toMatchObject({status:"dispatch"});
 await denied(()=>f.rpc("cancel_unsent_sales_team_refund_v1",[id(29),q.id,c.context]),/ORIGINAL_RECOVERY_REQUIRED/);
});
test("an unstarted request can be canceled, while stale totals and ordinary creator authority are denied",async()=>{
 await denied(()=>f.rpc("reserve_sales_team_refund_v1",[id(1),id(25),receiptId,1,1000,"creator","creator_discretionary",c.context]),/FINANCIAL_ADMIN_REQUIRED/);
 await denied(()=>f.rpc("reserve_sales_team_refund_v1",[id(29),id(25),receiptId,-1,1000,"creator","creator_discretionary",c.context]),/CURRENT_TOTALS_REQUIRED/);
 const q=await reserve();expect(await f.rpc("cancel_unsent_sales_team_refund_v1",[id(29),q.id,c.context])).toMatchObject({result:{status:"canceled_before_dispatch"}});
 expect(await inspect()).toMatchObject({held:false});
});
function transaction(key:string,kind:string,amount:number,fee=0){return {id:key,object:"balance_transaction",source:"re_original",type:kind,reporting_category:kind,amount,fee,net:amount-fee,currency:"usd",exchange_rate:null,created:f.base.charge.created,available_on:f.base.charge.created+86400,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]};}
async function successfulRefund(){
 f.base.charge.amount_refunded=1000;refunds=[{id:"re_original",object:"refund",charge:"ch_original",payment_intent:"pi_original",amount:1000,currency:"usd",status:"succeeded",created:f.base.charge.created,balance_transaction:"txn_debit",failure_balance_transaction:null,transfer_reversal:null,source_transfer_reversal:null}];balances={txn_debit:transaction("txn_debit","refund",-1000,40)};
 await inspect();const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1")).rows[0].r);
 await reviewTeamRefundResponsibility(c,{actorId:id(29),receiptId,requestId:id(24),expectedRevision:revision,refundId:"re_original",responsibility:"platform",reasonCode:"platform_technical_error"});await inspect();
}
test("a succeeded refund that later fails restores principal only through the actual unused failure credit",async()=>{
 const before=Number((await db.query<{n:string}>("select earned_cents n from sales_team_commission_balances_v1")).rows[0].n);await successfulRefund();
 refunds[0].status="failed";refunds[0].failure_balance_transaction="txn_return";f.base.charge.amount_refunded=0;balances.txn_return=transaction("txn_return","refund_failure",1000,-10);
 expect(await inspect()).toMatchObject({held:false});expect((await db.query("select refunded_subtotal_cents::int refunded,financial_adjustment_cost_cents::int aux,financial_processing_credit_cents::int credit,platform_processing_credit_cents::int original_credit from sales_team_receipts_v1")).rows).toEqual([{refunded:0,aux:30,credit:30,original_credit:0}]);
 expect(Number((await db.query<{n:string}>("select earned_cents n from sales_team_commission_balances_v1")).rows[0].n)).toBe(before);
 expect((await db.query("select transaction_id,amount_cents::int amount from sales_team_refund_return_credits_v1")).rows).toEqual([{transaction_id:"txn_return",amount:1000}]);
 await inspect();expect((await db.query("select count(*)::int n from sales_team_refund_return_credits_v1")).rows).toEqual([{n:1}]);
 await db.exec("set constraints all immediate");
});
const requestRefund=async(responsibility:"creator"|"platform"="creator")=>{
 const preview=await previewTeamAdminRefund(c,id(29),receiptId,1000,responsibility,responsibility==="creator"?"creator_discretionary":"platform_technical_error");
 return reserveTeamAdminRefund(c,{actorId:id(29),requestId:id(25),receiptId,expectedRevision:preview.revision,amountCents:1000,responsibility,reasonCode:preview.reasonCode});
};
function provider(status="succeeded",loseResponse=false){
 const original=raw.getMockImplementation()!,events:Record<string,unknown>[]=[];
 raw.mockImplementation(async(method:string,path:string,params:Record<string,unknown>={},opts:{idempotencyKey?:string}={})=>{
  if(method==="POST"){
   expect(path).toBe("/v1/refunds");expect(params).not.toHaveProperty("reverse_transfer");expect(params).not.toHaveProperty("refund_application_fee");
   const now=Math.floor(Date.now()/1000);refunds=[{id:"re_original",object:"refund",charge:"ch_original",payment_intent:"pi_original",amount:params.amount,currency:"usd",status,created:now,metadata:params.metadata,balance_transaction:"txn_debit",failure_balance_transaction:status==="failed"?"txn_return":null,transfer_reversal:null,source_transfer_reversal:null}];
   balances={txn_debit:{...transaction("txn_debit","refund",-1000,40),created:now}};
   if(status==="failed")balances.txn_return={...transaction("txn_return","refund_failure",1000,-10),created:now};
   f.base.charge.amount_refunded=status==="succeeded"?1000:0;
   events.push({id:"evt_refundCreated",object:"event",type:"refund.created",created:now,livemode:false,request:{id:"req_createOriginal",idempotency_key:opts.idempotencyKey},data:{object:JSON.parse(JSON.stringify(refunds[0]))}});
   if(loseResponse)throw Error("synthetic lost original POST response");return {...refunds[0],lastResponse:{requestId:"req_createOriginal"}};
  }
  if(path==="/v1/events")return {object:"list",data:events,has_more:false,lastResponse:{requestId:"req_eventList"}};
  return original(method,path);
 });return {events};
}
test("explicit admin dispatch refunds the frozen separate charge once and accounts its costs",async()=>{
 const q=await requestRefund();provider();expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"refund_observed",refundId:"re_original",held:false});
 const posts=raw.mock.calls.filter(([method])=>method==="POST");expect(posts).toHaveLength(1);expect(posts[0][3]).toMatchObject({idempotencyKey:`cn-team-v1:${q.operation_id}`,maxNetworkRetries:0});
 expect((await db.query("select refunded_subtotal_cents::int refunded,financial_adjustment_cost_cents::int aux from sales_team_receipts_v1")).rows).toEqual([{refunded:1000,aux:40}]);
 await processTeamAdminRefund(c,id(29),q.id,true);expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("uncertain POST recovers only through original provider-event idempotency provenance",async()=>{
 const q=await requestRefund("platform");provider("succeeded",true);expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"reconciliation_required",held:true});
 await db.exec("update sales_team_controls_v1 set refund_dispatch_enabled=false");
 expect(await processTeamAdminRefund(c,id(29),q.id,false)).toMatchObject({disposition:"refund_observed",held:false});expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
 expect((await db.query("select event_id,original_request_id from sales_team_refund_recovery_proofs_v1")).rows).toEqual([{event_id:"evt_refundCreated",original_request_id:"req_createOriginal"}]);
});
test("matching refund metadata without original event provenance cannot trigger retry or adoption",async()=>{
 const q=await requestRefund(),evidence=provider("succeeded",true);await processTeamAdminRefund(c,id(29),q.id,true);evidence.events.splice(0);
 expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"reconciliation_required",held:true});expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
 expect((await db.query("select count(*)::int n from sales_team_refund_request_results_v1")).rows).toEqual([{n:0}]);
});
test("pending refund stays held and later success uses the same original object",async()=>{
 const q=await requestRefund();provider("pending");expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"refund_pending",held:true});
 refunds[0].status="succeeded";f.base.charge.amount_refunded=1000;expect(await processTeamAdminRefund(c,id(29),q.id,false)).toMatchObject({disposition:"refund_observed",held:false});expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("late failed refund restores the actual principal without issuing another refund",async()=>{
 const q=await requestRefund("platform");provider();await processTeamAdminRefund(c,id(29),q.id,true);refunds[0].status="failed";refunds[0].failure_balance_transaction="txn_return";f.base.charge.amount_refunded=0;balances.txn_return={...transaction("txn_return","refund_failure",1000,-10),created:Number(refunds[0].created)};
 expect(await processTeamAdminRefund(c,id(29),q.id,false)).toMatchObject({disposition:"refund_not_completed",providerStatus:"failed",held:false});expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
 await db.exec("set constraints all immediate");
});
test("a failure during the final financial read reports that newer audited status",async()=>{
 const q=await requestRefund("platform");provider();const original=raw.getMockImplementation()!;
 raw.mockImplementation((method,path,...args)=>{
  if(method==="GET"&&path==="/v1/payment_intents/pi_original"&&refunds[0]?.status==="succeeded"){
   refunds[0].status="failed";refunds[0].failure_balance_transaction="txn_return";f.base.charge.amount_refunded=0;balances.txn_return={...transaction("txn_return","refund_failure",1000,-10),created:Number(refunds[0].created)};
  }return original(method,path,...args);
 });
 expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"refund_not_completed",providerStatus:"failed",held:false});
 expect((await db.query("select status from sales_team_refund_request_results_v1")).rows).toEqual([{status:"succeeded"}]);
 expect((await db.query("select observed_by,financial_check_id is not null linked,proof->>'status' status from sales_team_refund_request_observations_v1 order by observation_number desc limit 1")).rows).toEqual([{observed_by:null,linked:true,status:"failed"}]);
 expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("a missing bound refund cannot clear its hold, and exact recovery reuses the pending check",async()=>{
 const q=await requestRefund();provider("pending");const original=raw.getMockImplementation()!,rpc=c.admin.rpc.bind(c.admin);let omit=true;
 raw.mockImplementation((method,path,...args)=>method==="GET"&&path==="/v1/refunds"&&refunds.length&&omit?{object:"list",data:[],has_more:false,lastResponse:{requestId:"req_emptyOriginal"}}:original(method,path,...args));
 c.admin.rpc=(async(name:string,args:Record<string,unknown>)=>{
  if(name!=="complete_sales_team_financial_check_v1")return rpc(name,args);
  await db.exec("savepoint missing_original");const result=await rpc(name,args);if(result.error)await db.exec("rollback to savepoint missing_original");await db.exec("release savepoint missing_original");return result;
 }) as unknown as typeof c.admin.rpc;
 try{await expect(processTeamAdminRefund(c,id(29),q.id,true)).rejects.toThrow(/ORIGINAL_TEAM_REFUND_STATE_REQUIRES_REVIEW/);}finally{c.admin.rpc=rpc;}
 expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:true}]);
 const pending=(await db.query<{id:string}>("select id from sales_team_financial_checks_v1 c where not exists(select 1 from sales_team_financial_check_results_v1 r where r.check_id=c.id)")).rows;expect(pending).toHaveLength(1);
 omit=false;refunds[0].status="succeeded";f.base.charge.amount_refunded=1000;expect(await processTeamAdminRefund(c,id(29),q.id,false)).toMatchObject({disposition:"refund_observed",held:false});expect((await db.query("select check_id from sales_team_financial_check_results_v1 where check_id=$1",[pending[0].id])).rows).toHaveLength(1);expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("event-backed refund observations retain their actual check provenance without impersonating an admin",async()=>{
 const q=await requestRefund("platform");provider();await processTeamAdminRefund(c,id(29),q.id,true);refunds[0].status="failed";refunds[0].failure_balance_transaction="txn_return";f.base.charge.amount_refunded=0;balances.txn_return={...transaction("txn_return","refund_failure",1000,-10),created:Number(refunds[0].created)};
 const eventId="evt_refundRequestLateFailure";await f.rpc("begin_sales_team_payment_event_v1",[eventId,"refund.failed",Math.floor(Date.now()/1000),"re_original","pi_original","ch_original",c.context]);
 expect(await observeTeamPaymentEvent(c,q.source,eventId,true)).toMatchObject({held:false});
 expect((await db.query("select observed.observed_by,observed.proof->>'status' status,checks.event_id from sales_team_refund_request_observations_v1 observed join sales_team_financial_checks_v1 checks on checks.id=observed.financial_check_id where checks.event_id=$1",[eventId])).rows).toEqual([{observed_by:null,status:"failed",event_id:eventId}]);
 expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);await db.exec("set constraints all immediate");
});
test("an independent snapshot cannot regress a failed original to pending or clear its durable hold",async()=>{
 const q=await requestRefund("platform");provider("failed");expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"refund_not_completed",held:false});refunds[0].status="pending";
 const begun=await f.rpc<{checkId:string;source:Parameters<typeof readTeamFinancialSnapshot>[1]}>("begin_sales_team_financial_check_v1",[id(84),receiptId,id(29),null,null,c.context]),read=await readTeamFinancialSnapshot(c,begun.source,{eventId:null,balances:true});
 await denied(()=>f.rpc("complete_sales_team_financial_check_v1",[begun.checkId,read.revision,read.snapshot]),/ORIGINAL_TEAM_REFUND_STATE_REQUIRES_REVIEW/);
 expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:true}]);expect((await db.query("select count(*)::int n from sales_team_refund_request_observations_v1 where proof->>'status'='pending'")).rows).toEqual([{n:0}]);expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("another admin can recover an original but cannot initiate its unstarted dispatch",async()=>{
 const q=await requestRefund();await db.query("update profiles set role='admin' where id=$1",[id(28)]);provider();expect(await processTeamAdminRefund(c,id(28),q.id,true)).toMatchObject({disposition:"not_dispatched",held:true});expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(0);
});
test("a failed status without its independently owned failure balance cannot restore commission",async()=>{
 await successfulRefund();refunds[0].status="failed";f.base.charge.amount_refunded=0;
 await denied(inspect,/VERIFIED_REFUND_RETURN|REFUND_RETURN_REQUIRED/);
 expect((await db.query("select refunded_subtotal_cents::int refunded from sales_team_receipts_v1")).rows).toEqual([{refunded:1000}]);
});

test("a failed GET of a previously reconciled original first persists a hold and resumes the same inspection",async()=>{
 const q=await requestRefund();provider();await processTeamAdminRefund(c,id(29),q.id,true);const original=raw.getMockImplementation()!;
 raw.mockRejectedValueOnce(Error("synthetic original GET failure"));await expect(processTeamAdminRefund(c,id(29),q.id,false)).rejects.toThrow();
 const pending=(await db.query<{id:string}>("select id from sales_team_financial_checks_v1 c where not exists(select 1 from sales_team_financial_check_results_v1 r where r.check_id=c.id)")).rows;
 expect(pending).toHaveLength(1);expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:true}]);
 raw.mockImplementation(original);expect(await processTeamAdminRefund(c,id(29),q.id,false)).toMatchObject({held:false});
 expect((await db.query("select check_id from sales_team_financial_check_results_v1 where check_id=$1",[pending[0].id])).rows).toHaveLength(1);expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("pending refund holds survive another inspection and block competing new requests",async()=>{
 const q=await requestRefund();provider("pending");await processTeamAdminRefund(c,id(29),q.id,true);
 expect(await inspect()).toMatchObject({held:true});await denied(()=>reserve(id(26)),/FINANCIAL_REVIEW_REQUIRED/);
 const queue=await f.rpc<{rows:{refundRequests:unknown[]}[]}>("read_sales_team_financial_admin_queue_v1",[id(29),c.context,null,20]);expect(queue.rows[0].refundRequests).toEqual([expect.objectContaining({requestId:q.id,providerStatus:"pending",resolved:false})]);
});
test("frozen request bytes, context and a changed observation cannot admit fresh dispatch",async()=>{
 const q=await requestRefund(),checked=await inspect();await f.rpc("attach_sales_team_refund_check_v1",[id(29),q.id,checked.checkId]);
 await denied(()=>f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,{...q.request,params:{...q.request.params,amount:999}}]),/ORIGINAL_TEAM_REFUND_OPERATION_REQUIRED/);
 await denied(()=>f.rpc("read_sales_team_refund_request_v1",[id(29),q.id,{...c.context,mode:"live"}]),/FINANCIAL_ADMIN_REQUIRED|CONTEXT_CHANGED/);
 await inspect();expect(await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request])).toEqual({status:"not_enabled"});
});
test("new refund dispatch stops if signed-event reconciliation is disabled after preview",async()=>{
 const q=await requestRefund(),checked=await inspect();await f.rpc("attach_sales_team_refund_check_v1",[id(29),q.id,checked.checkId]);await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=false");
 expect(await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request])).toEqual({status:"not_enabled"});expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
test("an audited unsent cancellation fences an already reviewed late dispatch",async()=>{
 const q=await requestRefund(),checked=await inspect();await f.rpc("attach_sales_team_refund_check_v1",[id(29),q.id,checked.checkId]);
 await f.rpc("cancel_unsent_sales_team_refund_v1",[id(29),q.id,c.context]);expect(await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request])).toEqual({status:"not_enabled"});
 expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"canceled_before_dispatch",held:false});expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
test("current admin can recover a departed administrator's bound original without new-money controls",async()=>{
 const q=await requestRefund();provider();await processTeamAdminRefund(c,id(29),q.id,true);
 await db.query("update profiles set role=null where id=$1",[id(29)]);await db.query("update profiles set role='admin' where id=$1",[id(28)]);await db.exec("update sales_team_controls_v1 set refund_dispatch_enabled=false,refund_review_enabled=false");
 expect(await processTeamAdminRefund(c,id(28),q.id,false)).toMatchObject({disposition:"refund_observed",held:false});expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("a consumed failure credit cannot authorize a second principal return",async()=>{
 await successfulRefund();refunds[0].status="failed";refunds[0].failure_balance_transaction="txn_return";f.base.charge.amount_refunded=0;balances.txn_return=transaction("txn_return","refund_failure",1000,-10);await inspect();
 refunds.push({...refunds[0],id:"re_second",status:"succeeded",balance_transaction:"txn_second",failure_balance_transaction:null});balances.txn_second={...transaction("txn_second","refund",-1000),source:"re_second"};f.base.charge.amount_refunded=1000;await inspect();
 const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1")).rows[0].r);await reviewTeamRefundResponsibility(c,{actorId:id(29),receiptId,requestId:id(27),expectedRevision:revision,refundId:"re_second",responsibility:"creator",reasonCode:"creator_discretionary"});await inspect();
 const begun=await f.rpc<{checkId:string;source:Parameters<typeof readTeamFinancialSnapshot>[1]}>("begin_sales_team_financial_check_v1",[id(83),receiptId,id(29),null,null,c.context]);
 const read=await readTeamFinancialSnapshot(c,begun.source,{eventId:null,balances:true}),snapshot={...read.snapshot,proof:{...read.snapshot.proof,refundedCents:0},capture:{...read.snapshot.capture,receipt:{...read.snapshot.capture.receipt,refundedCents:0}}};
 await denied(()=>db.query("select creatornet_team_private.authorize_refund_return_v1($1,$2,$3)",[begun.checkId,read.revision,snapshot]),/VERIFIED_UNCONSUMED_REFUND_RETURN_REQUIRED/);
 expect((await db.query("select sum(amount_cents)::int n from sales_team_refund_return_credits_v1")).rows).toEqual([{n:1000}]);
});
test("refund history is immutable and ordinary authenticated users cannot invoke private financial seams",async()=>{
 const q=await requestRefund();await denied(()=>db.query("update sales_team_refund_requests_v1 set amount_cents=1 where id=$1",[q.id]),/IMMUTABLE|immutable/i);
 await db.exec("set local role authenticated");
 await denied(()=>db.query("select * from sales_team_refund_requests_v1"),/permission denied/i);
 await denied(()=>db.query("select read_sales_team_refund_request_v1($1,$2,$3)",[id(29),q.id,c.context]),/permission denied/i);
 await denied(()=>db.query("select creatornet_team_private.authorize_refund_return_v1($1,0,'{}'::jsonb)",[id(83)]),/permission denied/i);
 await db.exec("reset role");
});
test("a failure at the final refund grant rolls back the new tables, wrappers, gates and journal kind",async()=>{
 const isolated=await teamSharedDatabase(createLocalPostgres());
 try{
  await isolated.exec("alter table profiles add column role text");for(const name of ["20261021230016_sales_team_financial_statements.sql","20261023000533_sales_team_payment_events.sql","20261023002620_sales_team_financial_reconciliation.sql"])await isolated.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
  const candidate=readFileSync("supabase/migrations/20261023012742_sales_team_admin_refund_dispatch.sql","utf8"),fault=candidate.replace("pg_get_serial_sequence('public.sales_team_refund_request_observations_v1','observation_number')","pg_get_serial_sequence('public.sales_team_refund_request_observations_v1','unknown_final_column')");
  expect(fault).not.toBe(candidate);await expect(isolated.exec(fault)).rejects.toThrow(/unknown_final_column/);await isolated.exec("rollback");
  expect((await isolated.query("select to_regclass('public.sales_team_refund_requests_v1') requests,to_regprocedure('public.complete_sales_team_event_before_refund_return_v1(text,integer,jsonb)')::text wrapper")).rows).toEqual([{requests:null,wrapper:null}]);
  expect((await isolated.query("select count(*)::int n from information_schema.columns where table_name='sales_team_controls_v1' and column_name='refund_dispatch_enabled'")).rows).toEqual([{n:0}]);
  expect((await isolated.query<{definition:string}>("select pg_get_constraintdef(oid) definition from pg_constraint where conname='sales_team_provider_operations_v1_kind_check'")).rows[0].definition).not.toContain("'refund'");
 }finally{await isolated.close();}
},30000);
