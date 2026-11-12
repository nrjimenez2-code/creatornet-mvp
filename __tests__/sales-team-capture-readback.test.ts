/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import type {SupabaseClient} from "@supabase/supabase-js";
import type Stripe from "stripe";
import {teamCaptureDatabase,seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {recordTeamCapture} from "@/lib/salesTeams/receipts";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,sequence:number;const rawRequest=jest.fn(),json=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const admin={rpc:async(name:string,args:Record<string,unknown>)=>{
 const keys=Object.keys(args);try{const r=await db.query<{r:unknown}>(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(",")}) r`,Object.values(args));return {data:json(r.rows[0].r),error:null};}catch(error){return {data:null,error};}
}} as unknown as SupabaseClient;
const composition=()=>({admin,stripe:{rawRequest:rawRequest as Stripe["rawRequest"]},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence});
beforeAll(async()=>{db=await teamCaptureDatabase(createLocalPostgres());},30000);
beforeEach(async()=>{
 await db.exec("begin");f=await seedTeamCapture(db);sequence=0;rawRequest.mockReset();rawRequest.mockImplementation(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Receipt readback must not write to the provider");
  const value=path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:null;
  if(!value)throw Error(path);return json({...value,lastResponse:{requestId:`req_read${++sequence}`}});
 });
});afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
const run=()=>recordTeamCapture(composition(),f.sale,f.buyer);
test("independent intent, charge and actual balance evidence records a receipt without any provider POST",async()=>{
 expect(await run()).toMatchObject({status:"verified",processingCostPending:false});await run();expect(rawRequest.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect(rawRequest.mock.calls.filter(([,path])=>path==="/v1/charges/ch_original")).toHaveLength(4);
 expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:1}]);
});
test("captured money survives new-sales disablement and closer removal",async()=>{
 await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,payment_collection_enabled=false;update sales_team_memberships_v1 set status='removed'");
 expect((await run()).status).toBe("verified");
});
test("a refund racing the independent reread is held before any clean receipt is recorded",async()=>{
 const original=rawRequest.getMockImplementation()!;let reads=0;rawRequest.mockImplementation((method,path)=>{if(path==="/v1/charges/ch_original"&&++reads===2)f.base.charge.amount_refunded=50;return original(method,path);});
 await expect(run()).rejects.toThrow(/reconciliation/);expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:0}]);
});
test("an original asynchronous capture retains cost uncertainty until independent balance evidence appears",async()=>{
 f.base.charge.balance_transaction=null;expect(await run()).toMatchObject({status:"verified",processingCostPending:true});
 f.base.charge.balance_transaction="txn_original";expect(await run()).toMatchObject({status:"verified",processingCostPending:false});
});
test("foreign provider context or binding cannot account for an unrelated charge",async()=>{
 await expect(recordTeamCapture({...composition(),observeContext:async()=>({...f.contract.context,platformAccountId:"acct_foreign"})},f.sale,f.buyer)).rejects.toThrow();expect(rawRequest).not.toHaveBeenCalled();
 f.base.charge.payment_intent="pi_foreign";await expect(run()).rejects.toThrow();expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:0}]);
});
