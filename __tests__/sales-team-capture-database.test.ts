/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {teamCaptureDatabase,seedTeamCapture,captureRpc} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {TEAM_STRIPE_API_VERSION} from "@/lib/salesTeams/providerOperation";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>;
const denied=async(fn:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(fn()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
beforeAll(async()=>{db=await teamCaptureDatabase(createLocalPostgres());},30000);
beforeEach(async()=>{await db.exec("begin");f=await seedTeamCapture(db);});afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
test("verified original capture earns commission once with at least fourteen days after verification",async()=>{
 const receipt=await f.record(),before=(await db.query<Record<string,unknown>>("select * from sales_team_financial_ledger_v1")).rows.length;await f.record();
 expect((await db.query<Record<string,unknown>>("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:1}]);expect((await db.query<Record<string,unknown>>("select * from sales_team_financial_ledger_v1")).rows).toHaveLength(before);
 const balances=(await db.query<{earned_cents:number;hold_until:string}>("select earned_cents,hold_until from sales_team_commission_balances_v1")).rows[0];expect(Number(balances.earned_cents)).toBe(333);
 // PGlite returns direct timestamptz columns as Date objects. Date.parse coerces
 // those through Date.toString(), discarding milliseconds; clone the timestamp.
 expect(new Date(balances.hold_until).getTime()).toBeGreaterThanOrEqual(Date.parse(String(receipt.observed_at))+14*86400000);
 expect(Number((await db.query<{ms:number}>("select extract(epoch from balance.hold_until-receipt.observed_at)*1000 ms from sales_team_commission_balances_v1 balance join sales_team_receipts_v1 receipt on receipt.id=balance.receipt_id")).rows[0].ms)).toBeGreaterThanOrEqual(14*86400000);
 expect((await db.query<Record<string,unknown>>("select count(*)::int n from sales_team_capture_provenance_v1")).rows).toEqual([{n:1}]);
});
test("new receipt recording is independently held, while existing receipt recovery survives disabled activity",async()=>{
 await db.exec("update sales_team_controls_v1 set receipt_recording_enabled=false");await denied(f.record,/TEAM_RECEIPT_RECORDING_HELD/);
 await db.exec("update sales_team_controls_v1 set receipt_recording_enabled=true");await f.record();await db.exec("update sales_team_controls_v1 set receipt_recording_enabled=false,access_enabled=false,new_sales_enabled=false,payment_collection_enabled=false");
 expect((await f.record()).id).toBeTruthy();
});
test("foreign buyers, obligations and confirmations cannot bind an original receipt",async()=>{
 await denied(()=>f.rpc("read_sales_team_capture_source_v1",[f.sale,id(11),f.contract.obligationId]),/OWNED_SALE_REQUIRED/);
 await denied(()=>f.rpc("record_verified_sales_team_capture_v1",[f.sale,f.buyer,id(90),f.confirmationId,f.capture()]),/ORIGINAL_TEAM_CAPTURE_REQUIRED/);
 await denied(()=>f.rpc("record_verified_sales_team_capture_v1",[f.sale,f.buyer,f.contract.obligationId,id(90),f.capture()]),/ORIGINAL_TEAM_CAPTURE_REQUIRED/);
});
test("unbound confirmation and stale readback cannot authorize accounting",async()=>{
 await db.query<Record<string,unknown>>("update sales_team_provider_operations_v1 set provider_id=null,provider_request_id=null,bound_at=null,status='unknown' where id=$1",[f.confirmationId]);
 await denied(f.record,/ORIGINAL_TEAM_CAPTURE_REQUIRED/);
 await db.query<Record<string,unknown>>("update sales_team_provider_operations_v1 set provider_id='pi_original',provider_request_id='req_bound',bound_at=clock_timestamp(),status='bound' where id=$1",[f.confirmationId]);
 const captured=f.capture();captured.readback.readStartedAt-=120000;await denied(()=>f.rpc("record_verified_sales_team_capture_v1",[f.sale,f.buyer,f.contract.obligationId,f.confirmationId,captured]),/ORIGINAL_TEAM_CAPTURE_REQUIRED/);
});
test("a journal admitted in a long transaction records actual dispatch time rather than transaction start",async()=>{
 const begin=(await db.query<{stamp:string}>("select transaction_timestamp() stamp")).rows[0].stamp;
 await db.query("select pg_sleep(1.05)");await f.rpc("stop_sales_team_payment_v1",[f.sale,f.buyer]);
 const scope={scopeId:f.sale,saleId:f.sale,creatorId:id(1),actorId:f.buyer,kind:"cancellation",scopeKey:`cancel:${f.contract.obligationId}`,workerRunId:null};
 const request={method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:"/v1/payment_intents/pi_original/cancel",params:{cancellation_reason:"requested_by_customer"}};
 const claimed=await f.rpc<{operation:{first_dispatch_at:string}}>("claim_sales_team_provider_operation_v1",[id(90),scope,f.contract.context,request]);
 expect(Date.parse(claimed.operation.first_dispatch_at)).toBeGreaterThan(Date.parse(begin)+1000);
});
test("late actual costs replace the processing reserve without creating another receipt or resetting its hold",async()=>{
 const pending=f.capture();pending.receipt={...pending.receipt,balanceTransactionId:null,processingCostCents:null,availableOn:null};pending.readback.balanceRequestId=null;
 await f.rpc("record_verified_sales_team_capture_v1",[f.sale,f.buyer,f.contract.obligationId,f.confirmationId,pending]);
 const before=(await db.query<{processing_reserve_cents:number}>("select processing_reserve_cents from sales_team_creator_balances_v1")).rows[0];expect(Number(before.processing_reserve_cents)).toBe(127);
 const hold=(await db.query<Record<string,unknown>>("select hold_until from sales_team_commission_balances_v1")).rows[0];await f.record();
 expect((await db.query<Record<string,unknown>>("select hold_until from sales_team_commission_balances_v1")).rows[0]).toEqual(hold);
 expect((await db.query<{processing_reserve_cents:number;actual_processing_cost_cents:number}>("select processing_reserve_cents,actual_processing_cost_cents from sales_team_creator_balances_v1")).rows.map(v=>[Number(v.processing_reserve_cents),Number(v.actual_processing_cost_cents)])).toEqual([[0,127]]);
});
test("a financial hold cannot be cleared by the late-cost-only recovery path",async()=>{
 const pending=f.capture();pending.receipt={...pending.receipt,balanceTransactionId:null,processingCostCents:null,availableOn:null};pending.readback.balanceRequestId=null;
 await f.rpc("record_verified_sales_team_capture_v1",[f.sale,f.buyer,f.contract.obligationId,f.confirmationId,pending]);await db.exec("update sales_team_receipts_v1 set dispute_hold=true");
 await denied(f.record,/TEAM_FINANCIAL_RECONCILIATION_REQUIRED/);expect((await db.query<Record<string,unknown>>("select dispute_hold from sales_team_receipts_v1")).rows).toEqual([{dispute_hold:true}]);
});
test("captured refund/dispute evidence is recorded with delivery and settlement held",async()=>{
 f.base.charge.amount_refunded=50;f.base.charge.disputed=true;const receipt=await f.record();expect(receipt.review_hold).toBe(true);
 expect(Number(receipt.refunded_subtotal_cents)).toBe(50);expect(receipt.dispute_hold).toBe(true);
 expect((await db.query<Record<string,unknown>>("select earned_cents from sales_team_commission_balances_v1")).rows.map(v=>Number(v.earned_cents))).toEqual([328]);
 expect((await db.query<Record<string,unknown>>("select creator_released_cents from sales_team_creator_balances_v1")).rows.map(v=>Number(v.creator_released_cents))).toEqual([0]);
});
test("immutable provenance and service-only permissions protect captured financial identities",async()=>{
 const receipt=await f.record();await denied(()=>db.query<Record<string,unknown>>("update sales_team_capture_provenance_v1 set readback='{}' where receipt_id=$1",[receipt.id]),/permission denied|IMMUTABLE/);
 await db.exec("set local role authenticated");await denied(()=>db.query<Record<string,unknown>>("select * from sales_team_capture_provenance_v1"),/permission denied/);
 await denied(()=>captureRpc(db,"read_sales_team_capture_source_v1",[f.sale,f.buyer,null]),/permission denied/);
});
