/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import type {SupabaseClient} from "@supabase/supabase-js";
import Stripe from "stripe";
import {NextRequest} from "next/server";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
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
 for(const file of ["20261021230016_sales_team_financial_statements.sql","20261023000533_sales_team_payment_events.sql","20261023002620_sales_team_financial_reconciliation.sql"])await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
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
async function deliver(){const payload=JSON.stringify({id:"evt_originalFinancialHttp",object:"event",type:"charge.dispute.closed",created:f.base.charge.created,livemode:false,data:{object:dispute}});return POST(new NextRequest("https://fixture.invalid/api/stripe/webhook",{method:"POST",headers:{"stripe-signature":verifier.webhooks.generateTestHeaderString({payload,secret})},body:payload}));}
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
