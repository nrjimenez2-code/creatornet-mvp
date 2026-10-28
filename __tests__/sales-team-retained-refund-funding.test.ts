/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {inspectTeamReceiptFinancials} from "@/lib/salesTeams/financialChecks";
import {fundTeamAdminRefund} from "@/lib/salesTeams/cashFunding";
import {cancelUnsentTeamRefund,processTeamAdminRefund} from "@/lib/salesTeams/adminRefunds";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {observeTeamFinancialState} from "@/lib/salesTeams/financialObservation";

declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql";
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,available:number,raw:jest.Mock,refunds:Record<string,unknown>[],balances:Record<string,unknown>;
beforeAll(async()=>{db=await sharedCashDatabase(createLocalPostgres());await db.exec(readFileSync(sharedCashReconciliationCandidate,"utf8"));await db.exec(readFileSync(candidate,"utf8"));
 for(const name of ["20261023060912_sales_team_automatic_recovery.sql","20261023063905_sales_team_worker_refund_recovery.sql","20261023174324_sales_team_no_outbound_shared_recovery.sql","20261023180144_sales_team_transfer_reservations.sql","20261023182527_sales_team_transfer_observations.sql","20261023184139_sales_team_transfer_execution.sql","20261023190044_sales_team_automatic_settlement.sql","20261024210829_sales_team_transfer_reversal_observations.sql","20261024213841_sales_team_transfer_recovery_reservations.sql","20261024215948_sales_team_transfer_recovery_execution.sql","20261025184802_sales_team_transfer_reversal_recovery.sql","20261025191826_sales_team_combined_settlement.sql","20261025195351_sales_team_later_collection.sql","20261026185425_sales_team_payment_lifecycle.sql","20261026193046_sales_team_expired_collection_retry.sql","20261027021620_sales_team_saved_method_authority.sql","20261027024721_sales_team_automatic_collection.sql","20261027232440_sales_team_protected_daily_surplus.sql","20261028000209_sales_team_surplus_execution.sql"])await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,refund_review_enabled=true,refund_dispatch_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,retained_refund_funding_enabled=true");
 f=await seedTeamCapture(db);receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,evidence='{\"scope\":\"synthetic retained funding fixture only\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1()");
 available=1000000;refunds=[];balances={};let seq=0;
 raw=jest.fn(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Retained funding fixture permits GET only");
  const value=path==="/v1/balance"?{object:"balance",livemode:false,available:[{currency:"usd",amount:available,source_types:{card:available}}],pending:[]}:
   path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:
   path==="/v1/refunds"?{object:"list",data:refunds,has_more:false}:path==="/v1/disputes"?{object:"list",data:[],has_more:false}:path.startsWith("/v1/refunds/")?refunds.find(r=>r.id===path.split("/").at(-1)):balances[path.split("/").at(-1)!];
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_retained${++seq}`}}));
 });
 c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
});
afterEach(async()=>{await db.exec("rollback");await db.exec("reset role");});afterAll(async()=>{await db.close();});
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function request(responsibility:"creator"|"platform"="creator",amount=1000){
 const revision=Number((await db.query<{revision:number}>("select observation_revision revision from sales_team_receipts_v1 where id=$1",[receiptId])).rows[0].revision);
 const q=await f.rpc<{id:string;operation_id:string;scope:object;request:object}>("reserve_sales_team_refund_v1",[id(29),id(25),receiptId,revision,amount,responsibility,responsibility==="creator"?"creator_discretionary":"platform_technical_error",c.context]);
 const checked=await inspectTeamReceiptFinancials(c,receiptId,id(29));await f.rpc("attach_sales_team_refund_check_v1",[id(29),q.id,checked.checkId]);return q;
}
const plan=async()=> (await db.query<{r:{creatorCents:number;commissionCents:number;creatorFloorCents:number;commissionFloorCents:number}}>("select creatornet_team_private.refund_retained_cash_plan_v1($1) r",[id(25)])).rows[0].r;
const protection=async()=> (await db.query<{r:{teamCents:number;reserveCents:number;refundCostReserveCents:number;shared:{protectedCents:number}}}>("select creatornet_team_private.cash_protection_v1($1) r",[c.context])).rows[0].r;
const encumbered=async()=>Number((await db.query<{r:string}>("select creatornet_team_private.cash_encumbered_v1() r")).rows[0].r);
function transaction(key:string,kind:string,amount:number,fee=0){const stamp=Math.floor(Date.now()/1000);return {id:key,object:"balance_transaction",source:"re_original",type:kind,reporting_category:kind,amount,fee,net:amount-fee,currency:"usd",exchange_rate:null,balance_type:"payments",created:stamp,available_on:stamp,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]};}
function provider(status="succeeded",loseResponse=false){
 const original=raw.getMockImplementation()!,events:Record<string,unknown>[]=[];
 raw.mockImplementation(async(method:string,path:string,params:Record<string,unknown>={},opts:{idempotencyKey?:string}={})=>{
  if(method==="POST"){
   expect(path).toBe("/v1/refunds");const stamp=Math.floor(Date.now()/1000);
   refunds=[{id:"re_original",object:"refund",charge:"ch_original",payment_intent:"pi_original",amount:params.amount,currency:"usd",status,created:stamp,metadata:params.metadata,balance_transaction:"txn_retainedDebit",failure_balance_transaction:status==="failed"?"txn_retainedReturn":null,transfer_reversal:null,source_transfer_reversal:null}];
   balances={txn_retainedDebit:transaction("txn_retainedDebit","refund",-1000,40)};available-=1040;
   if(status==="failed"){balances.txn_retainedReturn=transaction("txn_retainedReturn","refund_failure",1000,-10);available+=1010;}
   f.base.charge.amount_refunded=status==="succeeded"?1000:0;
   events.push({id:"evt_retainedRefundCreated",object:"event",type:"refund.created",created:stamp,livemode:false,request:{id:"req_retainedOriginalPost",idempotency_key:opts.idempotencyKey},data:{object:JSON.parse(JSON.stringify(refunds[0]))}});
   if(loseResponse)throw Error("Synthetic original response lost");return {...refunds[0],lastResponse:{requestId:"req_retainedOriginalPost"}};
  }
  if(path==="/v1/events")return {object:"list",data:events,has_more:false,lastResponse:{requestId:"req_retainedOriginalEvents"}};
  return original(method,path);
 });
}

test.each(["creator","platform"] as const)("retained funding completes the %s refund through the real reconciler with one mocked POST",async responsibility=>{
 const q=await request(responsibility),p=await plan(),protectedCash=await protection();
 available=protectedCash.teamCents+protectedCash.reserveCents+1100-p.creatorCents-p.commissionCents;provider();
 expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"refund_observed",refundId:"re_original",held:false});
 expect(await encumbered()).toBe(0);expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
 const current=await protection();expect(available).toBeGreaterThanOrEqual(current.teamCents+current.reserveCents+current.shared.protectedCents);
 expect((await db.query("select refunded_subtotal_cents::int refunded,financial_adjustment_cost_cents::int cost,financial_processing_credit_cents::int credit from sales_team_receipts_v1")).rows).toEqual([{refunded:1000,cost:40,credit:responsibility==="platform"?40:0}]);
 await db.exec("set constraints all immediate");await processTeamAdminRefund(c,id(29),q.id,false);expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});

test("a failed refund restores protected principal only from its actual return trace",async()=>{
 const q=await request();provider();await processTeamAdminRefund(c,id(29),q.id,true);
 refunds[0].status="failed";refunds[0].failure_balance_transaction="txn_retainedReturn";balances.txn_retainedReturn=transaction("txn_retainedReturn","refund_failure",1000,-10);available+=1010;f.base.charge.amount_refunded=0;
 expect(await processTeamAdminRefund(c,id(29),q.id,false)).toMatchObject({refundId:"re_original",providerStatus:"failed",held:false});expect(await encumbered()).toBe(0);
 expect((await db.query("select transaction_id,amount_cents::int amount from sales_team_refund_return_credits_v1")).rows).toEqual([{transaction_id:"txn_retainedReturn",amount:1000}]);
 await processTeamAdminRefund(c,id(29),q.id,false);expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);await db.exec("set constraints all immediate");
});

test("lost-response recovery keeps the same original and completes with new-money gates disabled",async()=>{
 const q=await request();provider("succeeded",true);expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"reconciliation_required",held:true});
 expect(await encumbered()).toBeGreaterThan(0);await db.exec("update sales_team_controls_v1 set cash_reservations_enabled=false,retained_refund_funding_enabled=false,refund_dispatch_enabled=false");
 expect(await processTeamAdminRefund(c,id(29),q.id,false)).toMatchObject({refundId:"re_original",held:false});expect(await encumbered()).toBe(0);expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});

async function laterReceipt(period:number){
 // Structural projection fixture only. This creates no accepted provider
 // capture and does not establish later-installment collection acceptance.
 const obligation=id(90+period),receipt=id(94+period),amount=period===3?3335:3333;
 await db.query("insert into sales_team_payment_obligations_v1(id,sale_id,period_number,amount_cents,due_at,status,paid_at) values($1,$2,$3,$4,now(),'paid',now())",[obligation,f.sale,period,amount]);
 await db.query("insert into sales_team_receipts_v1(id,sale_id,obligation_id,payment_intent_id,charge_id,balance_transaction_id,subtotal_cents,processing_cost_cents,paid_at,available_on,source_event_id,proof) values($1,$2,$3,$4,$5,$6,$7,127,now(),now(),'structural-projection-fixture','{}')",[receipt,f.sale,obligation,`pi_later${period}`,`ch_later${period}`,`txn_later${period}`,amount]);
 await f.rpc("recompute_sales_team_balances_v1",[f.sale,`fixture-period-${period}`,{scope:"structural projection fixture only"}]);return receipt;
}
const saleUnpaid=async()=>Number((await db.query<{n:string}>("select sum(greatest(0,c.creator_proceeds_cents-c.creator_released_cents+c.creator_reversed_cents)+greatest(0,b.earned_cents-b.released_cents+b.reversed_cents)) n from sales_team_creator_balances_v1 c join sales_team_commission_balances_v1 b using(receipt_id) where c.sale_id=$1",[f.sale])).rows[0].n);

test.each([[997,"creator"],[1001,"platform"],[3333,"creator"]] as const)("retained offset stays within independently recomputed unpaid liabilities across installments (%i/%s)",async(amount,responsibility)=>{
 const later=await laterReceipt(2);await laterReceipt(3);
 await db.query("update sales_team_commission_balances_v1 set released_cents=earned_cents where receipt_id=$1",[later]);
 await request(responsibility,amount);const before=await saleUnpaid(),p=await plan(),offset=p.creatorCents+p.commissionCents;
 const observed=observeTeamFinancialState({chargeId:"ch_original",subtotalCents:3333,chargeRefundedCents:amount,actualProcessingCostCents:127,refundListComplete:true,refunds:[{id:"re_projection",chargeId:"ch_original",amountCents:amount,status:"succeeded",created:1}],decisions:[{refundId:"re_projection",chargeId:"ch_original",responsibility,reasonCode:responsibility==="creator"?"creator_discretionary":"platform_technical_error"}],disputes:[]});
 await db.query("update sales_team_receipts_v1 set refunded_subtotal_cents=$1,confirmed_loss_subtotal_cents=$1,platform_fee_return_cents=$2,platform_processing_credit_cents=$3,financial_adjustment_cost_cents=40,financial_processing_credit_cents=$4 where id=$5",[amount,observed.platformFeeReturnedCents,observed.platformProcessingCostCreditCents,responsibility==="platform"?40:0,receiptId]);
 await f.rpc("recompute_sales_team_balances_v1",[f.sale,"projection-comparison",{scope:"synthetic independent accounting comparison"}]);
 expect(offset).toBeGreaterThan(0);expect(offset).toBeLessThanOrEqual(before-await saleUnpaid());
});

test("tax and payout reserves remain fully protected beside a retained refund",async()=>{
 const q=await request();await db.query("update sales_team_creator_balances_v1 set tax_reserve_cents=500,payout_cost_reserve_cents=payout_cost_reserve_cents+300 where receipt_id=$1",[receiptId]);
 const protectedCash=await protection(),p=await plan();available=protectedCash.teamCents+protectedCash.reserveCents+1100-p.creatorCents-p.commissionCents-1;
 await denied(()=>fundTeamAdminRefund(c,id(29),q.id),/PROTECTED_PLATFORM_FUNDS_INSUFFICIENT/);expect(await encumbered()).toBe(0);
});

test("two reservations cannot consume the same sale's retained shares",async()=>{
 const second=await laterReceipt(2);const q=await request();await fundTeamAdminRefund(c,id(29),q.id);
 const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1 where id=$1",[second])).rows[0].r);
 await f.rpc("reserve_sales_team_refund_v1",[id(29),id(26),second,revision,1000,"creator","creator_discretionary",c.context]);
 await denied(()=>db.query("select creatornet_team_private.refund_retained_cash_plan_v1($1)",[id(26)]),/ORIGINAL_RETAINED_RESERVATION_REQUIRED/);
});

test("foreign beneficiary identity cannot create a retained funding plan",async()=>{
 await request();await db.query("update sales_team_commission_balances_v1 set creator_id=$1",[id(2)]);await denied(plan,/OWNED_RETAINED_SHARES_REQUIRED/);
});

test("a changed retained helper invalidates both reviewed cash hashes and removes its offset",async()=>{
 const q=await request();await fundTeamAdminRefund(c,id(29),q.id);expect(await encumbered()).toBeLessThan(1100);
 await db.exec("create or replace function creatornet_team_private.refund_retained_cash_plan_v1(p_request_id uuid) returns jsonb language sql stable security invoker set search_path=pg_catalog as $$select '{}'::jsonb$$");
 expect(await encumbered()).toBe(1100);await denied(protection,/SHARED_CASH_CONTRACT_REVIEW_REQUIRED/);
});

test("the refund can use its own retained creator and commission shares with exact protected cash",async()=>{
 const q=await request(),p=await plan(),held=p.creatorCents+p.commissionCents,protectedCash=await protection();expect(held).toBeGreaterThan(0);expect(held).toBeLessThanOrEqual(1000);
 available=protectedCash.teamCents+protectedCash.shared.protectedCents+protectedCash.reserveCents+protectedCash.refundCostReserveCents+1000-held;
 const before=(await db.query("select creator_proceeds_cents from sales_team_creator_balances_v1")).rows;
 await fundTeamAdminRefund(c,id(29),q.id);expect(await encumbered()).toBe(1100-held);
 expect((await db.query("select creator_proceeds_cents from sales_team_creator_balances_v1")).rows).toEqual(before);
 expect(await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request])).toMatchObject({status:"dispatch"});expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});

test("one cent below the complete protected threshold refuses funding",async()=>{
 const q=await request(),p=await plan(),protectedCash=await protection();available=protectedCash.teamCents+protectedCash.reserveCents+1100-p.creatorCents-p.commissionCents-1;
 await denied(()=>fundTeamAdminRefund(c,id(29),q.id),/PROTECTED_PLATFORM_FUNDS_INSUFFICIENT/);expect(await encumbered()).toBe(0);
});

test("already released shares cannot be borrowed from another creator or beneficiary",async()=>{
 const q=await request();await db.exec("update sales_team_creator_balances_v1 set creator_released_cents=creator_proceeds_cents;update sales_team_commission_balances_v1 set released_cents=earned_cents");
 expect(await plan()).toMatchObject({creatorCents:0,commissionCents:0});await fundTeamAdminRefund(c,id(29),q.id);expect(await encumbered()).toBe(1100);
});

test("a verified reduction of owned balances removes the duplicate offset as accounting changes",async()=>{
 const q=await request(),p=await plan();await fundTeamAdminRefund(c,id(29),q.id);const initial=await encumbered();expect(initial).toBeLessThan(1100);
 // Model the existing independent financial reconciler's derived balance write.
 // No provider outcome or reservation resolution is claimed by this mutation.
 await db.query("update sales_team_creator_balances_v1 set creator_proceeds_cents=$1",[p.creatorFloorCents]);await db.query("update sales_team_commission_balances_v1 set earned_cents=$1",[p.commissionFloorCents]);
 expect(await encumbered()).toBe(1100);expect((await db.query("select count(*)::int n from sales_team_cash_resolutions_v1")).rows).toEqual([{n:0}]);
});

test("unknown operations and elapsed time do not free the original encumbrance",async()=>{
 const q=await request();await fundTeamAdminRefund(c,id(29),q.id);const before=await encumbered();await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request]);
 await db.query("update sales_team_provider_operations_v1 set status='unknown',lease_until=now()-interval '1 day' where id=$1",[q.operation_id]);expect(await encumbered()).toBe(before);
});

test("canceling the audited unsent request releases once and invalidates old cash observations",async()=>{
 const q=await request();await fundTeamAdminRefund(c,id(29),q.id);expect(await encumbered()).toBeGreaterThan(0);
 const epoch=(await db.query("select epoch from sales_team_cash_epoch_v1")).rows;await cancelUnsentTeamRefund(c,id(29),q.id);expect(await encumbered()).toBe(0);expect((await db.query("select epoch from sales_team_cash_epoch_v1")).rows).not.toEqual(epoch);
});

test("disabling retained funding stops fresh dispatch while retaining its original reservation",async()=>{
 const q=await request();await fundTeamAdminRefund(c,id(29),q.id);const before=await encumbered();await db.exec("update sales_team_controls_v1 set retained_refund_funding_enabled=false");
 expect(await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request])).toMatchObject({status:"not_enabled"});expect(await encumbered()).toBe(before);
});

test("default-off retained funding preserves full extra-liquidity coverage",async()=>{
 const q=await request();await db.exec("update sales_team_controls_v1 set retained_refund_funding_enabled=false");expect(await plan()).toMatchObject({creatorCents:0,commissionCents:0});await fundTeamAdminRefund(c,id(29),q.id);expect(await encumbered()).toBe(1100);
});

test("missing reviewed source hash cannot enable retained-share admission",async()=>{
 const q=await request();await db.exec("update sales_team_cash_policy_v1 set retained_contract_sha256=null");await denied(()=>fundTeamAdminRefund(c,id(29),q.id),/RETAINED_CASH_CONTRACT_REVIEW_REQUIRED/);
});

test("service role can reserve immutable retained funding without acquiring new table privileges",async()=>{
 const q=await request();await db.exec("set role service_role");await fundTeamAdminRefund(c,id(29),q.id);await denied(()=>db.exec("update sales_team_cash_reservations_v1 set retained_creator_cents=0"),/permission denied|immutable/i);
});

test("the retained candidate rolls back every patch and column after a final grant failure",async()=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  await isolated.exec(readFileSync(sharedCashReconciliationCandidate,"utf8"));const original=(await isolated.query("select pg_get_functiondef('public.reserve_sales_team_refund_cash_v1(uuid,uuid,uuid,jsonb)'::regprocedure) source")).rows;
  const sql=readFileSync(candidate,"utf8"),fault=sql.replace("commit;","grant execute on function public.missing_retained_final_grant() to service_role;commit;");await expect(isolated.exec(fault)).rejects.toThrow(/missing_retained_final_grant/);await isolated.exec("rollback");
  expect((await isolated.query("select pg_get_functiondef('public.reserve_sales_team_refund_cash_v1(uuid,uuid,uuid,jsonb)'::regprocedure) source")).rows).toEqual(original);expect((await isolated.query("select column_name from information_schema.columns where table_name='sales_team_cash_reservations_v1' and column_name='retained_creator_cents'")).rows).toEqual([]);
 }finally{await isolated.close();}
},30000);
