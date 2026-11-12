/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import type Stripe from "stripe";
import {NextRequest} from "next/server";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import type {TeamCollection} from "@/lib/salesTeams/collection";
const readBuyer=jest.fn(),composition=jest.fn(),provider=jest.fn();
jest.mock("@/lib/salesTeams/checkout",()=>({readBuyerTeamSale:(...a:unknown[])=>readBuyer(...a),requireTeamCheckout:()=>{throw Error("Read-only recovery cannot admit a charge");}}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>composition()}));
import {POST} from "@/app/api/sales-team/sales/[saleId]/payment/route";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>;const env={...process.env};
beforeAll(async()=>{db=await teamSharedDatabase(createLocalPostgres());},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set fulfillment_enabled=true");f=await seedTeamCapture(db);jest.clearAllMocks();
 for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_RECORDING_READY","CREATOR_TEAM_FULFILLMENT_SCHEMA_READY","CREATOR_TEAM_FULFILLMENT_READY"])process.env[key]="true";
 delete process.env.CREATOR_SALES_TEAM_READY;delete process.env.CREATOR_TEAM_PAYMENT_COLLECTION_READY;
 const admin=teamSupabaseFixture(db),saved=await f.rpc<TeamCollection>("read_sales_team_payment_v1",[f.sale,f.buyer]);
 readBuyer.mockResolvedValue({admin,user:{id:f.buyer},sale:{status:"accepted"}});
 composition.mockReturnValue({admin,stripe:{rawRequest:provider as Stripe["rawRequest"]},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence});let sequence=0;
 provider.mockImplementation(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Receipt recovery cannot write to Stripe");
  const value=path==="/v1/customers/cus_original"?{id:"cus_original",object:"customer",livemode:false,metadata:saved.setup!.customer_request.params.metadata,created:Math.floor(Date.parse(saved.setup!.created_at)/1000)}:
   path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:null;
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_httpRead${++sequence}`}}));
 });
 await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,payment_collection_enabled=false");
});afterEach(async()=>{process.env={...env};await db.exec("rollback");});afterAll(async()=>{await db.close();});
const request=(action="refresh")=>new NextRequest(`https://fixture.vercel.app/api/sales-team/sales/${f.sale}/payment`,{method:"POST",headers:{origin:"https://fixture.vercel.app","content-type":"application/json"},body:JSON.stringify({action})});
test("buyer refresh connects independent capture to one Library purchase and commission while new activity is disabled",async()=>{
 const result=await POST(request(),{params:Promise.resolve({saleId:f.sale})});expect(result.status).toBe(200);expect((await result.json()).payment.phase).toBe("paid");
 const repeat=await POST(request(),{params:Promise.resolve({saleId:f.sale})});expect(repeat.status).toBe(200);
 expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{n:1}]);
 expect(provider.mock.calls.every(([method])=>method==="GET")).toBe(true);const purchase=(await db.query<{id:string}>("select id from purchases")).rows[0].id;
 expect(await f.rpc("read_sales_team_entitlement_v1",[purchase,f.buyer])).toMatchObject({applicable:true,allowed:true});
});
test("receipt verification without fulfillment admission reports pending delivery and grants no access",async()=>{
 delete process.env.CREATOR_TEAM_FULFILLMENT_READY;const result=await POST(request(),{params:Promise.resolve({saleId:f.sale})});expect(result.status).toBe(200);
 expect((await result.json()).payment.phase).toBe("receipt_verified");expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:0}]);
});
test("a captured dispute is accounted but stays under review before Library access",async()=>{
 f.base.charge.disputed=true;const result=await POST(request(),{params:Promise.resolve({saleId:f.sale})});expect(result.status).toBe(200);expect((await result.json()).payment.phase).toBe("payment_review");
 const purchase=(await db.query<{id:string}>("select id from purchases")).rows[0].id;expect(await f.rpc("read_sales_team_entitlement_v1",[purchase,f.buyer])).toMatchObject({allowed:false});
});
