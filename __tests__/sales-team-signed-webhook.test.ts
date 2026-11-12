/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import Stripe from "stripe";
import {NextRequest} from "next/server";
import type {SupabaseClient} from "@supabase/supabase-js";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import type {TeamCollection} from "@/lib/salesTeams/collection";
const verifier=new Stripe("sk_test_SyntheticNoNetwork"),secret="synthetic-team-webhook-secret";
const claim=jest.fn(),complete=jest.fn(),release=jest.fn(),raw=jest.fn(),compose=jest.fn(),legacy=jest.fn();
let admin:SupabaseClient;
jest.mock("@supabase/supabase-js",()=>({createClient:()=>admin}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>compose()}));
jest.mock("@/lib/stripeClient",()=>({getStripe:()=>({webhooks:verifier.webhooks,rawRequest:raw})}));
jest.mock("@/lib/stripeEvents",()=>({claimStripeEvent:(...a:unknown[])=>claim(...a),completeStripeEvent:(...a:unknown[])=>complete(...a),releaseStripeEvent:(...a:unknown[])=>release(...a)}));
jest.mock("@/lib/mentorshipInstallmentWebhook",()=>({handoffBuyerMentorshipDisputeWebhook:(...a:unknown[])=>legacy(...a),handoffBuyerMentorshipRefundWebhook:(...a:unknown[])=>legacy(...a)}));
jest.mock("@/lib/paymentRefunds",()=>({confirmAdminRefundWebhookDelivery:(...a:unknown[])=>legacy(...a)}));
jest.mock("@/lib/posthogServer",()=>({trackServerEvent:jest.fn()}));
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,POST:(req:NextRequest)=>Promise<Response>,refunds:Record<string,unknown>[],disputes:Record<string,unknown>[],sequence:number;
const env={...process.env},json=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
beforeAll(async()=>{
 db=await teamSharedDatabase(createLocalPostgres());await db.exec(readFileSync("supabase/migrations/20261023000533_sales_team_payment_events.sql","utf8"));admin=teamSupabaseFixture(db);
 Object.assign(process.env,{VERCEL_ENV:"preview",STRIPE_SECRET_KEY:"sk_test_SyntheticNoNetwork",STRIPE_WEBHOOK_SECRET:secret,STRIPE_CONNECT_WEBHOOK_SECRET:"",NEXT_PUBLIC_SUPABASE_URL:"https://fixture.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic"});
 POST=(await import("@/app/api/stripe/webhook/route")).POST;
},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set event_reconciliation_enabled=true,fulfillment_enabled=true");f=await seedTeamCapture(db);refunds=[];disputes=[];sequence=0;
 jest.clearAllMocks();claim.mockResolvedValue({status:"new",claimToken:"synthetic-team-token"});legacy.mockImplementation(()=>{throw Error("Team event reached legacy effects");});
 for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_RECORDING_READY","CREATOR_TEAM_FULFILLMENT_SCHEMA_READY","CREATOR_TEAM_FULFILLMENT_READY","CREATOR_TEAM_EVENT_SCHEMA_READY","CREATOR_TEAM_EVENT_RECONCILIATION_READY"])process.env[key]="true";
 delete process.env.CREATOR_SALES_TEAM_READY;delete process.env.CREATOR_TEAM_PAYMENT_COLLECTION_READY;
 const setup=(await f.rpc<TeamCollection>("read_sales_team_payment_v1",[f.sale,f.buyer])).setup!;
 raw.mockImplementation(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Event reconciliation cannot mutate Stripe");
  const value=path==="/v1/customers/cus_original"?{id:"cus_original",object:"customer",livemode:false,metadata:setup.customer_request.params.metadata,created:Math.floor(Date.parse(setup.created_at)/1000)}:
   path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:
   path==="/v1/refunds"?{object:"list",data:refunds,has_more:false}:path==="/v1/disputes"?{object:"list",data:disputes,has_more:false}:null;
  if(!value)throw Error(path);return json({...value,lastResponse:{requestId:`req_eventRead${++sequence}`}});
 });
 compose.mockReturnValue({admin,stripe:{rawRequest:raw},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence});
 await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,payment_collection_enabled=false");
 jest.spyOn(console,"log").mockImplementation(()=>{});jest.spyOn(console,"error").mockImplementation(()=>{});
});
afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback");});afterAll(async()=>{process.env={...env};await db.close();});
const event=(type="payment_intent.succeeded",object:unknown=f.base.paymentIntent,eventId="evt_teamOriginal")=>({id:eventId,object:"event",type,created:f.base.charge.created,livemode:false,data:{object}});
async function deliver(value=event(),signingSecret=secret){const payload=JSON.stringify(value),signature=verifier.webhooks.generateTestHeaderString({payload,secret:signingSecret});return POST(new NextRequest("https://fixture.invalid/api/stripe/webhook",{method:"POST",headers:{"stripe-signature":signature},body:payload}));}
const fulfill=async()=>{const r=await f.record();return f.rpc<{purchaseId:string}>("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,r.id]);};
const refund=(amount=1000,status="succeeded")=>({id:"re_original",object:"refund",charge:"ch_original",payment_intent:"pi_original",amount,currency:"usd",status,created:f.base.charge.created,balance_transaction:"txn_refund",transfer_reversal:null,source_transfer_reversal:null});

test("real signed delivery independently captures and fulfills once with all new sales disabled",async()=>{
 expect((await deliver()).status).toBe(200);expect(legacy).not.toHaveBeenCalled();expect(complete).toHaveBeenCalledTimes(1);
 expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);
 expect((await db.query("select count(*)::int n from sales_team_commission_balances_v1")).rows).toEqual([{n:1}]);
 expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 claim.mockResolvedValue({status:"duplicate"});const before=raw.mock.calls.length;expect((await deliver()).status).toBe(200);expect(raw.mock.calls).toHaveLength(before);expect(legacy).not.toHaveBeenCalled();
});
test("saved binding routes the original even when event metadata is missing",async()=>{
 expect((await deliver(event("payment_intent.succeeded",{...f.base.paymentIntent,metadata:{}}))).status).toBe(200);expect(legacy).not.toHaveBeenCalled();
});
test("forged marked metadata cannot adopt an unrelated payment or enter legacy",async()=>{
 expect((await deliver(event("payment_intent.succeeded",{...f.base.paymentIntent,id:"pi_unbound"}))).status).toBe(500);expect(legacy).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});
test("invalid signature and wrong mode are rejected before claims and all effects",async()=>{
 expect((await deliver(event(),"wrong-secret")).status).toBe(400);expect((await deliver({...event(),livemode:true})).status).toBe(400);expect(claim).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled();
});
test("confirmed partial refunds immediately reduce commission and await responsibility review",async()=>{
 const {purchaseId}=await fulfill();f.base.charge.amount_refunded=1000;refunds=[refund()];
 expect((await deliver(event("charge.refunded",f.base.charge))).status).toBe(200);expect(legacy).not.toHaveBeenCalled();
 expect((await db.query("select refunded_subtotal_cents::int refunded,review_hold from sales_team_receipts_v1")).rows).toEqual([{refunded:1000,review_hold:true}]);
 expect(await f.rpc("read_sales_team_entitlement_v1",[purchaseId,f.buyer])).toMatchObject({allowed:false});
 const earned=(await db.query<{earned:number}>("select earned_cents::int earned from sales_team_commission_balances_v1")).rows[0].earned;
 expect(earned).toBe(Math.round((f.contract.amountCents-1000)*f.contract.terms.commission.commissionBps/10000));
 claim.mockResolvedValue({status:"duplicate"});expect((await deliver(event("charge.refunded",f.base.charge))).status).toBe(200);expect(legacy).not.toHaveBeenCalled();
});
test("provider failure leaves a durable pending hold and retry recovers only the original",async()=>{
 const {purchaseId}=await fulfill(),original=raw.getMockImplementation()!;raw.mockRejectedValue(new Error("synthetic provider unavailable"));
 expect((await deliver()).status).toBe(500);expect(release).toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
 expect(await f.rpc("read_sales_team_entitlement_v1",[purchaseId,f.buyer])).toMatchObject({allowed:false});
 expect((await db.query("select count(*)::int n from sales_team_payment_events_v1")).rows).toEqual([{n:1}]);
 raw.mockImplementation(original);expect((await deliver()).status).toBe(200);expect(await f.rpc("read_sales_team_entitlement_v1",[purchaseId,f.buyer])).toMatchObject({allowed:true});expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
test("application flags disabled retain installed ownership fencing and durable hold",async()=>{
 const {purchaseId}=await fulfill();delete process.env.CREATOR_TEAM_EVENT_SCHEMA_READY;
 expect((await deliver(event("charge.refunded",f.base.charge))).status).toBe(500);expect(legacy).not.toHaveBeenCalled();expect(compose).not.toHaveBeenCalled();
 expect(await f.rpc("read_sales_team_entitlement_v1",[purchaseId,f.buyer])).toMatchObject({allowed:false});
});
test("refund lacking a PaymentIntent locates through independent charge GET before receipt publication",async()=>{
 f.base.charge.amount_refunded=1000;refunds=[refund()];expect((await deliver(event("refund.updated",{...refund(),payment_intent:null}))).status).toBe(200);
 expect(raw.mock.calls[0].slice(0,2)).toEqual(["GET","/v1/charges/ch_original"]);expect(legacy).not.toHaveBeenCalled();
});
test("current noncaptured lifecycle is recorded without a purchase or new debit",async()=>{
 Object.assign(f.base.paymentIntent,{status:"processing",amount_received:0,latest_charge:null});
 expect((await deliver(event("payment_intent.processing"))).status).toBe(200);expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:0}]);
 expect((await db.query("select proof->>'status' status from sales_team_payment_event_results_v1")).rows).toEqual([{status:"processing"}]);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
test("dispute updates use current provider state and preserve unresolved balance-cost review",async()=>{
 const {purchaseId}=await fulfill();f.base.charge.disputed=true;
 disputes=[{id:"du_original",object:"dispute",charge:"ch_original",payment_intent:"pi_original",amount:f.contract.amountCents,currency:"usd",status:"under_review",created:f.base.charge.created,livemode:false,balance_transactions:[]}];
 expect((await deliver(event("charge.dispute.created",disputes[0]))).status).toBe(200);
 disputes[0].status="won";expect((await deliver(event("charge.dispute.closed",{...disputes[0],status:"lost"},"evt_teamWon"))).status).toBe(200);
 expect((await db.query("select dispute_hold,review_hold,confirmed_loss_subtotal_cents::int loss from sales_team_receipts_v1")).rows).toEqual([{dispute_hold:false,review_hold:true,loss:0}]);
 expect(await f.rpc("read_sales_team_entitlement_v1",[purchaseId,f.buyer])).toMatchObject({allowed:false});expect(legacy).not.toHaveBeenCalled();
});
test("a refund racing complete list rereads cannot publish a clean event result",async()=>{
 await fulfill();const original=raw.getMockImplementation()!;let reads=0;raw.mockImplementation((method,path,...args)=>{if(path==="/v1/refunds"&&++reads===2)refunds=[refund()];return original(method,path,...args);});
 expect((await deliver()).status).toBe(500);expect((await db.query("select count(*)::int n from sales_team_payment_event_results_v1")).rows).toEqual([{n:0}]);expect(legacy).not.toHaveBeenCalled();
});
test("one completed event cannot clear another delivery's pending financial hold",async()=>{
 const {purchaseId}=await fulfill();
 for(const key of ["evt_teamOriginal","evt_teamSecond"])await f.rpc("begin_sales_team_payment_event_v1",[key,"payment_intent.succeeded",f.base.charge.created,"pi_original","pi_original",null,f.contract.context]);
 expect((await deliver()).status).toBe(200);expect(await f.rpc("read_sales_team_entitlement_v1",[purchaseId,f.buyer])).toMatchObject({allowed:false});
 expect((await deliver(event("payment_intent.succeeded",f.base.paymentIntent,"evt_teamSecond"))).status).toBe(200);
 expect(await f.rpc("read_sales_team_entitlement_v1",[purchaseId,f.buyer])).toMatchObject({allowed:true});
});
test("event, result and refund-review history stay private and immutable",async()=>{
 expect((await deliver()).status).toBe(200);
 await db.exec("savepoint private_check;set local role authenticated");
 await expect(db.query("select * from sales_team_payment_events_v1")).rejects.toThrow(/permission denied/);
 await db.exec("rollback to private_check;savepoint private_rpc;set local role authenticated");
 await expect(f.rpc("locate_sales_team_payment_event_v1",["pi_original",null])).rejects.toThrow(/permission denied/);
 await db.exec("rollback to private_rpc;savepoint immutable_history");
 await expect(db.exec("update sales_team_payment_events_v1 set object_id='pi_foreign'")).rejects.toThrow();
 await db.exec("rollback to immutable_history");
});
test("an accounted event resumes pending shared fulfillment without another payment or receipt",async()=>{
 const original=admin.rpc.bind(admin);let failed=false;
 jest.spyOn(admin,"rpc").mockImplementation(((name:string,args:Record<string,unknown>)=>{
  if(name==="fulfill_sales_team_receipt_v1"&&!failed){failed=true;return Promise.resolve({data:null,error:{message:"synthetic pending shared fulfillment"}});}
  return original(name,args);
 }) as unknown as typeof admin.rpc);
 expect((await deliver()).status).toBe(500);
 expect((await db.query("select count(*)::int n from sales_team_payment_event_results_v1")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:0}]);
 expect((await deliver()).status).toBe(200);
 expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:1}]);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
test("a disputed charge with no resolved dispute identity cannot clear its financial hold",async()=>{
 f.base.charge.disputed=true;expect((await deliver()).status).toBe(200);
 expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:true}]);
 const row=(await db.query<{proof:{financial:{alerts:string[]}}}>("select proof from sales_team_payment_event_results_v1")).rows[0];expect(row.proof.financial.alerts).toContain("DISPUTE_IDENTITY_UNRECONCILED");
});
test("buyer receipt recovery cannot bypass a signed event that arrived before the first receipt",async()=>{
 await f.rpc("begin_sales_team_payment_event_v1",["evt_teamOriginal","payment_intent.succeeded",f.base.charge.created,"pi_original","pi_original",null,f.contract.context]);
 const {purchaseId}=await fulfill();expect(await f.rpc("read_sales_team_payment_v1",[f.sale,f.buyer])).toMatchObject({receipt:{held:true}});
 expect((await db.query("select team_financial_hold from payment_fee_ledger")).rows).toEqual([{team_financial_hold:true}]);
 expect(await f.rpc("read_sales_team_entitlement_v1",[purchaseId,f.buyer])).toMatchObject({allowed:false});
 expect((await deliver()).status).toBe(200);expect((await db.query("select team_financial_hold from payment_fee_ledger")).rows).toEqual([{team_financial_hold:false}]);
});
