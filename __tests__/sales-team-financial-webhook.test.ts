/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import type {SupabaseClient} from "@supabase/supabase-js";
import Stripe from "stripe";
import {NextRequest} from "next/server";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
const verifier=new Stripe("sk_test_SyntheticNoNetwork"),secret="synthetic-financial-webhook-secret",claim=jest.fn(),complete=jest.fn(),release=jest.fn(),raw=jest.fn(),compose=jest.fn(),legacy=jest.fn();
let admin:SupabaseClient;
jest.mock("@supabase/supabase-js",()=>({createClient:()=>admin}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>compose()}));
jest.mock("@/lib/stripeClient",()=>({getStripe:()=>({webhooks:verifier.webhooks,rawRequest:raw})}));
jest.mock("@/lib/stripeEvents",()=>({claimStripeEvent:(...a:unknown[])=>claim(...a),completeStripeEvent:(...a:unknown[])=>complete(...a),releaseStripeEvent:(...a:unknown[])=>release(...a)}));
jest.mock("@/lib/mentorshipInstallmentWebhook",()=>({handoffBuyerMentorshipDisputeWebhook:(...a:unknown[])=>legacy(...a),handoffBuyerMentorshipRefundWebhook:(...a:unknown[])=>legacy(...a)}));
jest.mock("@/lib/paymentRefunds",()=>({confirmAdminRefundWebhookDelivery:(...a:unknown[])=>legacy(...a)}));
jest.mock("@/lib/posthogServer",()=>({trackServerEvent:jest.fn()}));
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,POST:(req:NextRequest)=>Promise<Response>,sequence:number,dispute:Record<string,unknown>;
const env={...process.env},json=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
beforeAll(async()=>{
 db=await teamSharedDatabase(createLocalPostgres());await db.exec("alter table profiles add column role text");
 for(const file of ["20261021230016_sales_team_financial_statements.sql","20261023000533_sales_team_payment_events.sql","20261023002620_sales_team_financial_reconciliation.sql","20261023010604_sales_team_booked_offer_associations.sql","20261023012742_sales_team_admin_refund_dispatch.sql"])await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
 admin=teamSupabaseFixture(db);Object.assign(process.env,{VERCEL_ENV:"preview",STRIPE_SECRET_KEY:"sk_test_SyntheticNoNetwork",STRIPE_WEBHOOK_SECRET:secret,STRIPE_CONNECT_WEBHOOK_SECRET:"",NEXT_PUBLIC_SUPABASE_URL:"https://fixture.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic"});
 POST=(await import("@/app/api/stripe/webhook/route")).POST;
},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true");
 f=await seedTeamCapture(db);sequence=0;jest.clearAllMocks();claim.mockResolvedValue({status:"new",claimToken:"synthetic-original-claim"});legacy.mockImplementation(()=>{throw Error("Team reached legacy accounting");});
 for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_RECORDING_READY","CREATOR_TEAM_FULFILLMENT_SCHEMA_READY","CREATOR_TEAM_FULFILLMENT_READY","CREATOR_TEAM_EVENT_SCHEMA_READY","CREATOR_TEAM_EVENT_RECONCILIATION_READY","CREATOR_TEAM_FINANCIAL_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY"])process.env[key]="true";
 delete process.env.CREATOR_SALES_TEAM_READY;delete process.env.CREATOR_TEAM_PAYMENT_COLLECTION_READY;
 dispute={id:"du_original",object:"dispute",charge:"ch_original",payment_intent:"pi_original",amount:1000,currency:"usd",status:"won",created:f.base.charge.created,livemode:false,balance_transactions:[{id:"txn_withdraw"},{id:"txn_restore"}]};f.base.charge.disputed=true;
 raw.mockImplementation(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Financial webhook must be GET-only");
  const adjustment=(key:string,amount:number,fee:number,kind:string)=>({id:key,object:"balance_transaction",source:"du_original",type:"adjustment",reporting_category:kind,currency:"usd",exchange_rate:null,amount,fee,net:amount-fee,created:f.base.charge.created,available_on:f.base.charge.created+86400,status:"available",fee_details:[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]});
  const value=path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:
   path==="/v1/refunds"?{object:"list",data:[],has_more:false}:path==="/v1/disputes"?{object:"list",data:[dispute],has_more:false}:
   path==="/v1/balance_transactions/txn_withdraw"?adjustment("txn_withdraw",-1000,1500,"dispute"):path==="/v1/balance_transactions/txn_restore"?adjustment("txn_restore",1000,-500,"dispute_reversal"):null;
  if(!value)throw Error(path);return json({...value,lastResponse:{requestId:`req_financial${++sequence}`}});
 });
 compose.mockReturnValue({admin,stripe:{rawRequest:raw},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence});
 await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,payment_collection_enabled=false");jest.spyOn(console,"log").mockImplementation(()=>{});jest.spyOn(console,"error").mockImplementation(()=>{});
});
afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback");});afterAll(async()=>{process.env={...env};await db.close();});
async function deliver(object=dispute,type="charge.dispute.closed",eventId="evt_originalFinancialHttp"){const payload=JSON.stringify({id:eventId,object:"event",type,created:f.base.charge.created,livemode:false,data:{object}});return POST(new NextRequest("https://fixture.invalid/api/stripe/webhook",{method:"POST",headers:{"stripe-signature":verifier.webhooks.generateTestHeaderString({payload,secret})},body:payload}));}
test("signed HTTP event reconciles independent costs and fulfills once while new sales are disabled",async()=>{
 expect((await deliver()).status).toBe(200);expect(legacy).not.toHaveBeenCalled();expect(complete).toHaveBeenCalledTimes(1);
 expect((await db.query("select financial_adjustment_cost_cents::int aux,review_hold,dispute_hold from sales_team_receipts_v1")).rows).toEqual([{aux:1000,review_hold:false,dispute_hold:false}]);
 expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_financial_checks_v1")).rows).toEqual([{n:1}]);
 claim.mockResolvedValue({status:"duplicate"});const before=raw.mock.calls.length;expect((await deliver()).status).toBe(200);expect(raw.mock.calls).toHaveLength(before);expect(legacy).not.toHaveBeenCalled();
});
test("failed original GET holds the signed event and exact retry recovers without a provider write",async()=>{
 const original=raw.getMockImplementation()!;raw.mockRejectedValueOnce(Error("original provider read failed"));expect((await deliver()).status).toBe(500);expect(release).toHaveBeenCalledTimes(1);
 expect((await db.query("select count(*)::int n from sales_team_payment_events_v1")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_payment_event_results_v1")).rows).toEqual([{n:0}]);
 raw.mockImplementation(original);expect((await deliver()).status).toBe(200);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);expect(legacy).not.toHaveBeenCalled();
});

async function refundedReceipt(){
 const {inspectTeamReceiptFinancials,reviewTeamRefundResponsibility}=await import("@/lib/salesTeams/financialChecks");
 await db.exec("update sales_team_controls_v1 set refund_review_enabled=true");await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 const receiptId=String((await f.record()).id),c=compose() as TeamReceiptComposition;
 f.base.charge.disputed=false;f.base.charge.amount_refunded=1000;
 const refund={id:"re_original",object:"refund",charge:"ch_original",payment_intent:"pi_original",amount:1000,currency:"usd",status:"succeeded",created:f.base.charge.created,balance_transaction:"txn_refundDebit",failure_balance_transaction:null as string|null,transfer_reversal:null,source_transfer_reversal:null};
 const adjustment=(key:string,amount:number,fee:number,kind:string)=>({id:key,object:"balance_transaction",source:refund.id,type:kind,reporting_category:kind,currency:"usd",exchange_rate:null,amount,fee,net:amount-fee,created:f.base.charge.created,available_on:f.base.charge.created+86400,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]});
 const original=raw.getMockImplementation()!;
 raw.mockImplementation(async(method:string,path:string)=>{
  const value=path==="/v1/refunds"?{object:"list",data:[refund],has_more:false}:path===`/v1/refunds/${refund.id}`?refund:path==="/v1/disputes"?{object:"list",data:[],has_more:false}:
   path==="/v1/balance_transactions/txn_refundDebit"?adjustment("txn_refundDebit",-1000,40,"refund"):path==="/v1/balance_transactions/txn_refundReturn"?adjustment("txn_refundReturn",1000,-10,"refund_failure"):null;
  if(method!=="GET")throw Error("Webhook must be GET-only");return value?json({...value,lastResponse:{requestId:`req_refundHttp${++sequence}`}}):original(method,path);
 });
 await inspectTeamReceiptFinancials(c,receiptId,id(29));const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1")).rows[0].r);
 await reviewTeamRefundResponsibility(c,{actorId:id(29),receiptId,requestId:id(24),expectedRevision:revision,refundId:refund.id,responsibility:"platform",reasonCode:"platform_technical_error"});await inspectTeamReceiptFinancials(c,receiptId,id(29));
 refund.status="failed";f.base.charge.amount_refunded=0;return {refund,receiptId};
}
test("signed late refund failure consumes the owned return credit atomically without reaching legacy",async()=>{
 const {refund}=await refundedReceipt();refund.failure_balance_transaction="txn_refundReturn";
 expect((await deliver(refund,"refund.failed")).status).toBe(200);expect(legacy).not.toHaveBeenCalled();
 expect((await db.query("select refunded_subtotal_cents::int refunded,review_hold from sales_team_receipts_v1")).rows).toEqual([{refunded:0,review_hold:false}]);
 expect((await db.query("select transaction_id,amount_cents::int amount from sales_team_refund_return_credits_v1")).rows).toEqual([{transaction_id:"txn_refundReturn",amount:1000}]);
 expect((await db.query("select count(*)::int n from sales_team_payment_event_results_v1")).rows).toEqual([{n:1}]);
 await db.exec("set constraints all immediate");claim.mockResolvedValue({status:"duplicate"});expect((await deliver(refund,"refund.failed")).status).toBe(200);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
test("signed late failure without return evidence leaves its original event held for exact recovery",async()=>{
 const {refund}=await refundedReceipt(),rpc=admin.rpc.bind(admin);
 // Isolate the failing completion RPC as PostgREST does, preserving the
 // original event admitted by the preceding independently committed RPC.
 admin.rpc=(async(name:string,args:Record<string,unknown>)=>{
  if(name!=="complete_sales_team_payment_event_v1")return rpc(name,args);
  await db.exec("savepoint signed_failure");const result=await rpc(name,args);if(result.error)await db.exec("rollback to savepoint signed_failure");await db.exec("release savepoint signed_failure");return result;
 }) as unknown as typeof admin.rpc;
 try{expect((await deliver(refund,"refund.failed")).status).toBe(500);}finally{admin.rpc=rpc;}
 expect((await db.query("select refunded_subtotal_cents::int refunded,review_hold from sales_team_receipts_v1")).rows).toEqual([{refunded:1000,review_hold:true}]);
 expect((await db.query("select count(*)::int n from sales_team_payment_events_v1")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_payment_event_results_v1")).rows).toEqual([{n:0}]);
 expect((await db.query("select count(*)::int n from sales_team_refund_return_credits_v1")).rows).toEqual([{n:0}]);
 refund.failure_balance_transaction="txn_refundReturn";expect((await deliver(refund,"refund.failed")).status).toBe(200);expect(legacy).not.toHaveBeenCalled();expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
