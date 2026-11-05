/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {captureRpc as rpc,seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamCaptureFixture} from "@/test-support/sales-team-capture-fixture";
import {monthlySharedDatabase,monthlySharedReady,enableMonthlySharedFixture,seedMonthlySharedCapture,installedMonthlyGuardSha256} from "@/test-support/sales-team-monthly-shared-postgres";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import type {TeamCollection} from "@/lib/salesTeams/collection";
import type {TeamPaymentContract,TeamTokenProof} from "@/lib/salesTeams/paymentProtocol";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const controls="update sales_team_controls_v1 set fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true";
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{
 await db.exec("savepoint denied");
 try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}
};
type Dispatch={status:string;operation:{lease_token:string}};
beforeAll(async()=>{db=createLocalPostgres();await monthlySharedDatabase(db);},30000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{await db.exec("rollback;reset role");});
afterAll(async()=>{await db?.close();});
async function customer(){
 await enableTeamSalesFixture(db);
 await db.exec(controls+`;update products set type='mentorship',membership_terms='{"version":"monthly-mentorship-v1","minimumMonths":1,"autoRenew":true}'`);
 const offer=await approveTeamOffer(db),draft=await draftTeamSale(db,offer.options.find(o=>o.kind==="monthly")!.id);
 const sale=draft.saleId,buyer=id(10),context=draft.source.financialConfig.context;
 await rpc(db,"accept_sales_team_sale_v1",[sale,buyer,draft.quote.fingerprint,true]);
 await db.exec("update sales_team_controls_v1 set payment_collection_enabled=true,receipt_recording_enabled=true");
 const scope:TeamOperationScope={scopeId:sale,saleId:sale,creatorId:id(1),actorId:buyer,kind:"customer",scopeKey:"customer:v1",workerRunId:null},operation=teamOperationId(scope);
 await rpc(db,"reserve_sales_team_customer_v1",[sale,buyer,operation,context]);
 const saved=await rpc<TeamCollection>(db,"read_sales_team_payment_v1",[sale,buyer]);
 return {operation,claim:()=>rpc<Dispatch>(db,"claim_sales_team_provider_operation_v1",[operation,scope,context,saved.setup!.customer_request])};
}
async function fulfilled(){
 await enableMonthlySharedFixture(db);await db.exec(controls);
 const f=await seedMonthlySharedCapture(db),receipt=await f.record();
 const result=await f.rpc<{purchaseId:string;recorded:boolean}>("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]);
 const row=(await db.query<{v:Record<string,unknown>}>("select to_jsonb(p) v from purchases p where id=$1",[result.purchaseId])).rows[0].v;
 return {f,receipt,result,row};
}
test("installation is disabled and cannot enroll a new monthly provider operation",async()=>{
 expect(await monthlySharedReady(db)).toBe(false);const p=await customer();
 expect(await p.claim()).toMatchObject({status:"not_enabled"});
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1")).rows).toEqual([{n:0}]);
});
test("final dispatch holds on authority loss while unknown/bound original reconciliation survives",async()=>{
 const p=await customer();await enableMonthlySharedFixture(db);const claimed=await p.claim();expect(claimed.status).toBe("dispatch");
 await db.exec("update sales_team_monthly_shared_policy_v1 set enabled=false");
 await denied(()=>rpc(db,"assert_sales_team_provider_dispatch_v1",[p.operation,claimed.operation.lease_token]),/PROVIDER_DISPATCH_NO_LONGER_ADMITTED/);
 await rpc(db,"mark_sales_team_provider_unknown_v1",[p.operation,claimed.operation.lease_token]);
 expect(await p.claim()).toMatchObject({status:"reconciliation_required"});
 await rpc(db,"bind_sales_team_provider_operation_v1",[p.operation,"cus_original","req_reconciled",true]);
 expect(await p.claim()).toMatchObject({status:"bound"});
});
test("an actual confirmation reservation needs authority at claim and final pre-POST assertion",async()=>{
 await enableMonthlySharedFixture(db);await db.exec(controls);
 let staged:{contract:TeamPaymentContract;proof:TeamTokenProof}|undefined;
 await expect(seedTeamCapture(db,{paymentKind:"monthly",beforeApproval:async()=>{await db.query("update products set type='mentorship',membership_terms=$1",[{version:"monthly-mentorship-v1",minimumMonths:1,autoRenew:true}]);},beforeConfirmation:async(contract,proof)=>{
  staged={contract,proof};throw Error("PAUSED_FOR_CONFIRMATION_GATE_TEST");
 }})).rejects.toThrow("PAUSED_FOR_CONFIRMATION_GATE_TEST");
 const {contract:c,proof}=staged!,scope:TeamOperationScope={scopeId:c.saleId,saleId:c.saleId,creatorId:c.terms.creatorId,actorId:c.terms.buyerId,kind:"confirmation",scopeKey:"confirm:"+id(70),workerRunId:null};
 const operation=teamOperationId(scope),request=teamCaptureFixture(c).confirmation.request;
 await rpc(db,"reserve_sales_team_confirmation_v1",[c.saleId,c.terms.buyerId,id(70),operation,"token",proof,request]);
 const claim=()=>rpc<Dispatch>(db,"claim_sales_team_provider_operation_v1",[operation,scope,c.context,request]);
 await db.exec("update sales_team_monthly_shared_policy_v1 set enabled=false");expect(await claim()).toMatchObject({status:"not_enabled"});
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where id=$1",[operation])).rows).toEqual([{n:0}]);
 await enableMonthlySharedFixture(db);const dispatch=await claim();expect(dispatch.status).toBe("dispatch");
 await db.exec("update sales_team_monthly_shared_policy_v1 set enabled=false");
 await denied(()=>rpc(db,"assert_sales_team_provider_dispatch_v1",[operation,dispatch.operation.lease_token]),/PROVIDER_DISPATCH_NO_LONGER_ADMITTED/);
});
test("the pinned installed guard reproduces the blocker with no shared effects or lost receipt",async()=>{
 await enableMonthlySharedFixture(db);await db.exec(controls);const f=await seedMonthlySharedCapture(db),r=await f.record();
 await db.exec("update sales_team_monthly_shared_policy_v1 set enabled=false");
 await denied(()=>f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,r.id]),/Monthly offer requires its owned membership purchase/);
 for(const table of ["purchases","orders","sales_team_shared_receipts_v1"])expect((await db.query(`select count(*)::int n from ${table}`)).rows).toEqual([{n:0}]);
 expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:1}]);
 await enableMonthlySharedFixture(db);expect(await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,r.id])).toMatchObject({recorded:true});
});
test("verified same-receipt Library fulfillment is idempotent without legacy identity or entitlement flags",async()=>{
 const {f,receipt,result,row}=await fulfilled();expect(result.recorded).toBe(true);
 expect(row).toMatchObject({monthly_mentorship_id:null,access_granted:false,kind:"creatornet_team_v1"});
 expect(await f.rpc("read_sales_team_entitlement_v1",[result.purchaseId,f.buyer])).toMatchObject({allowed:true});
 expect(await f.rpc("read_sales_team_entitlement_v1",[result.purchaseId,id(11)])).toMatchObject({allowed:false});
 expect(await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id])).toMatchObject({recorded:false});
 expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);
});
test("every original identity field is required and fabricated purchases remain rejected",async()=>{
 const {row}=await fulfilled();
 const qualifies=async(value:Record<string,unknown>)=>(await db.query<{v:boolean}>("select creatornet_team_private.team_monthly_shared_purchase_v1($1) v",[value])).rows[0].v;
 expect(await qualifies(row)).toBe(true);
 for(const [field,value] of Object.entries({id:id(9999),sales_team_sale_id:id(9998),order_id:id(9997),buyer_id:id(11),buyer_user_id:id(11),creator_id:id(11),product_id:id(9997),post_id:id(9997),booking_id:id(9997),payment_intent_id:"pi_foreign",amount_cents:1,currency:"eur",access_granted:true,kind:"monthly_mentorship_v1",monthly_mentorship_id:id(9997),subscription_id:"sub_foreign"})){
  expect(await qualifies({...row,[field]:value})).toBe(false);
 }
 await denied(()=>db.query("insert into purchases select (jsonb_populate_record(null::public.purchases,$1)).*",[{...row,id:id(9999)}]),/Monthly offer requires its owned membership purchase/);
});
test("legitimate legacy monthly identity stays guarded and cannot be adopted as team history",async()=>{
 const {row}=await fulfilled();
 await db.query("insert into monthly_mentorship_agreements_v1(id,purchase_id,buyer_id,creator_id,product_id,post_id) values($1,$2,$3,$4,$5,$6)",[id(9000),id(9001),id(11),row.creator_id,row.product_id,row.post_id]);
 const legacy={...row,id:id(9001),buyer_id:id(11),buyer_user_id:id(11),sales_team_sale_id:null,monthly_mentorship_id:id(9000),kind:"monthly_mentorship_v1",status:"pending",paid_at:null,earnings_credited_at:null,earnings_credited_cents:0,paid_count:0,payment_intent_id:null,booking_id:null,order_id:null,subscription_id:null};
 await db.query("insert into purchases select (jsonb_populate_record(null::public.purchases,$1)).*",[legacy]);
 await denied(()=>db.query("update purchases set access_granted=true where id=$1",[legacy.id]),/Monthly service cannot use legacy ownership/);
 await denied(()=>db.query("update purchases set monthly_mentorship_id=$1 where id=$2",[id(9002),legacy.id]),/Monthly purchase identity cannot be replaced/);
 const columns=Object.keys(row).sort();expect(columns.every(k=>/^[a-z_]+$/.test(k))).toBe(true);
 await denied(()=>db.query(`update purchases set (${columns.map(k=>'"'+k+'"').join(",")})=(select ${columns.map(k=>'v."'+k+'"').join(",")} from jsonb_populate_record(null::public.purchases,$1) v) where id=$2`,[row,legacy.id]),/ORIGINAL_TEAM_ACCOUNTING_CHANGED/);
 expect((await db.query("select id,monthly_mentorship_id from purchases where id=$1",[legacy.id])).rows).toEqual([{id:legacy.id,monthly_mentorship_id:legacy.monthly_mentorship_id}]);
});
test.each(["sales_team_purchase_guard_v1","zz_team_monthly_shared_fence_v1"])("disabling %s invalidates monthly authority",async trigger=>{
 await enableMonthlySharedFixture(db);expect(await monthlySharedReady(db)).toBe(true);
 await db.exec(`alter table purchases disable trigger ${trigger}`);expect(await monthlySharedReady(db)).toBe(false);
});
test("non-monthly fulfillment remains available with the compatibility policy disabled",async()=>{
 await db.exec(controls);const f=await seedTeamCapture(db),r=await f.record();
 expect(await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,r.id])).toMatchObject({recorded:true});
 expect(await monthlySharedReady(db)).toBe(false);
});
test("the exact legacy guard body and private privileges are preserved",async()=>{
 expect((await db.query("select encode(sha256(convert_to(pg_get_functiondef('public.guard_monthly_mentorship_purchase_v1()'::regprocedure),'UTF8')),'hex') digest")).rows).toEqual([{digest:installedMonthlyGuardSha256}]);
 for(const role of ["anon","authenticated","service_role"]){
  expect((await db.query("select has_function_privilege($1,'public.guard_monthly_mentorship_purchase_v1()','EXECUTE') allowed",[role])).rows).toEqual([{allowed:false}]);
 }
});
test.each(["anon","authenticated"])("%s cannot read policy or call private authority",async role=>{
 await db.exec(`set role ${role}`);
 await denied(()=>db.exec("select * from sales_team_monthly_shared_policy_v1"),/permission denied/);
 await denied(()=>monthlySharedReady(db),/permission denied/);
});
test("service role cannot enable policy or change its digest",async()=>{
 await db.exec("set role service_role");
 await denied(()=>enableMonthlySharedFixture(db),/permission denied/);
});
