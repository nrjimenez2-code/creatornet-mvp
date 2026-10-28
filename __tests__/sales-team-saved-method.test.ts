/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture,captureRpc} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamPaymentFixture} from "@/test-support/sales-team-payment-fixture";
import {inspectTeamConfirmationToken,teamConfirmationRequest,type TeamTokenProof} from "@/lib/salesTeams/paymentProtocol";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import {readTeamSavedMethodQuote,inspectTeamSavedMethod,recordTeamSavedMethod,savedMethodPaymentResponse,type TeamSavedMethodQuote,type TeamSavedMethodSource} from "@/lib/salesTeams/savedMethod";
import {teamSavedMethodReady,teamSavedMethodSchemaReady} from "@/lib/salesTeams/policy";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261027021620_sales_team_saved_method_authority.sql";
const predecessors=[sharedCashReconciliationCandidate,...["20261023042321_sales_team_retained_refund_funding.sql","20261023060912_sales_team_automatic_recovery.sql","20261023063905_sales_team_worker_refund_recovery.sql","20261023174324_sales_team_no_outbound_shared_recovery.sql","20261023180144_sales_team_transfer_reservations.sql","20261023182527_sales_team_transfer_observations.sql","20261023184139_sales_team_transfer_execution.sql","20261023190044_sales_team_automatic_settlement.sql","20261024210829_sales_team_transfer_reversal_observations.sql","20261024213841_sales_team_transfer_recovery_reservations.sql","20261024215948_sales_team_transfer_recovery_execution.sql","20261025184802_sales_team_transfer_reversal_recovery.sql","20261025191826_sales_team_combined_settlement.sql","20261025195351_sales_team_later_collection.sql","20261026185425_sales_team_payment_lifecycle.sql","20261026193046_sales_team_expired_collection_retry.sql"].map(n=>`supabase/migrations/${n}`)];
let db:PGlite;const rpc=<T=Record<string,unknown>>(name:string,args:unknown[]=[])=>captureRpc<T>(db,name,args);
beforeAll(async()=>{db=createLocalPostgres();await sharedCashDatabase(db);for(const path of [...predecessors,candidate,"supabase/migrations/20261027024721_sales_team_automatic_collection.sql","supabase/migrations/20261027232440_sales_team_protected_daily_surplus.sql","supabase/migrations/20261028000209_sales_team_surplus_execution.sql","supabase/migrations/20261028222238_sales_team_surplus_recovery.sql"])await db.exec(readFileSync(path,"utf8"));},30000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied");}};
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const admin={rpc:async(name:string,args:Record<string,unknown>)=>{try{if(!/^[a-z_0-9]+$/.test(name)||Object.keys(args).some(k=>!/^p_[a-z_]+$/.test(k)))throw Error("Invalid fixture RPC");return {data:copy((await db.query<{r:unknown}>(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(",")}) r`,Object.values(args))).rows[0].r),error:null};}catch(error){return {data:null,error};}}} as unknown as SupabaseClient;
async function fixture(options:{monthly?:boolean;stopped?:boolean;consent?:boolean}={}){
 let token:Stripe.ConfirmationToken,quote:TeamSavedMethodQuote,proof:TeamTokenProof;
 await db.exec("update sales_team_controls_v1 set fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true");
 const f=await seedTeamCapture(db,{paymentKind:options.monthly?"monthly":"installments",beforeApproval:options.monthly?async()=>{await db.query("update products set type='mentorship',membership_terms=$1",[{version:"monthly-mentorship-v1",minimumMonths:3,autoRenew:true}]);}:undefined,
  beforeConfirmation:async(contract,baseProof)=>{
   token=copy(teamPaymentFixture(options.monthly?"monthly":"installments").token);token.created=baseProof.createdAt;token.expires_at=baseProof.expiresAt;token.payment_method_preview!.card!.fingerprint="fp_saved";
   const evidence=teamPaymentFixture().evidence;proof=inspectTeamConfirmationToken(contract,evidence,token,token.id,baseProof.createdAt);
   quote=await rpc<TeamSavedMethodQuote>("read_sales_team_saved_method_quote_v1",[contract.saleId,contract.terms.buyerId,contract.obligationId]);
   if(options.consent!==false){await db.exec("update sales_team_controls_v1 set saved_method_enabled=true");await rpc("accept_sales_team_saved_method_v1",[contract.saleId,contract.terms.buyerId,contract.obligationId,id(70),contract.context,quote.fingerprint,true,proof]);}
   return proof;
  }});
 await db.exec("update sales_team_controls_v1 set fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true");
 const receipt=await f.record();await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]);
 token!.payment_intent="pi_original";token!.expires_at=null;
 const method={object:"payment_method",id:"pm_original",livemode:false,type:"card",customer:"cus_original",card:{...token!.payment_method_preview!.card},billing_details:token!.payment_method_preview!.billing_details} as unknown as Stripe.PaymentMethod;
 if(options.stopped)await rpc("stop_sales_team_payment_v1",[f.sale,f.buyer]);
 const source=await rpc<TeamSavedMethodSource|null>("read_sales_team_saved_method_source_v1",[f.sale,f.buyer,f.contract.obligationId]);
 return {...f,token:token!,quote:quote!,tokenProof:proof!,method,source:source!,receiptId:receipt.id};
}
test("saved-method authority is independently default off and has no historical enrollment",async()=>{
 expect(teamSavedMethodSchemaReady({})).toBe(false);expect(teamSavedMethodReady({})).toBe(false);expect((await db.query("select saved_method_enabled from sales_team_controls_v1")).rows).toEqual([{saved_method_enabled:false}]);
 const f=await fixture({consent:false});expect(f.source).toBeNull();expect((await db.query("select count(*)::int n from sales_team_saved_method_consents_v1")).rows).toEqual([{n:0}]);
});
test.each([false,true])("written %s monthly consent retains exact accepted plan, purpose and Stop terms",async monthly=>{
 const f=await fixture({monthly});expect(f.quote).toMatchObject({version:"creatornet-team-saved-method-v1",automaticAuthorized:true,currentAmountCents:monthly?10001:3333,paymentKind:monthly?"monthly":"installments"});
 expect(f.quote.authorization).toContain("only for this sale");expect(f.quote.authorization).toContain("Stop does not waive");
 if(monthly)expect(f.quote).toMatchObject({monthlyAmountCents:10001,minimumMonths:3,autoRenew:true});else expect(f.quote.payments.map(p=>p.amountCents)).toEqual([3333,3333,3335]);
 expect(f.source.consent.token_proof).toEqual(f.tokenProof);expect(f.source.receiptId).toBe(f.receiptId);
});
test("exact consent replay is retained while mismatched identity, token, acceptance and quote are denied",async()=>{
 const f=await fixture(),args:unknown[]=[f.sale,f.buyer,f.contract.obligationId,id(70),f.contract.context,f.quote.fingerprint,true,f.tokenProof];
 expect(await rpc("accept_sales_team_saved_method_v1",args)).toMatchObject({id:id(70),automatic_authorized:true});
 for(const [index,value] of [[1,id(11)],[2,id(99)],[5,"b".repeat(64)],[6,false],[7,{...f.tokenProof,tokenId:"ctoken_foreign"}]] as [number,unknown][]){const changed=[...args];changed[index]=value;await denied(()=>rpc("accept_sales_team_saved_method_v1",changed),/CONSENT_REQUIRED/);}
});
test.each(["customer","fingerprint","expiry","country","token","preview","intent","mode"])("%s mismatch cannot authorize a saved card",async fault=>{
 const f=await fixture(),method=copy(f.method),token=copy(f.token),pi=copy(f.base.paymentIntent);
 if(fault==="customer")method.customer="cus_foreign";if(fault==="fingerprint")method.card!.fingerprint="fp_foreign";if(fault==="expiry")method.card!.exp_year=2020;if(fault==="country")method.billing_details.address!.country="CA";
 if(fault==="token")token.payment_intent="pi_foreign";if(fault==="preview")token.payment_method_preview!.card!.fingerprint="fp_foreign";if(fault==="intent")pi.amount++;if(fault==="mode")method.livemode=true;
 expect(()=>inspectTeamSavedMethod(f.source,f.evidence,pi,token,method,Math.floor(Date.now()/1000))).toThrow();
});
function harness(f:Awaited<ReturnType<typeof fixture>>){let n=0;const provider=jest.fn(async(http:string,path:string)=>{
 if(http!=="GET")throw Error("No financial write allowed");const value=path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/confirmation_tokens/ctoken_original"?f.token:path==="/v1/payment_methods/pm_original"?f.method:null;if(!value)throw Error(path);
 return copy({...value,lastResponse:{requestId:`req_saved${++n}`}});
 });return {provider,c:{admin,stripe:{rawRequest:provider as unknown as Stripe["rawRequest"]},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence}};}
test("fresh GET-only proof records one exact saved authority, including after Stop, without restoring permission",async()=>{
 const f=await fixture({stopped:true}),h=harness(f);expect(await recordTeamSavedMethod(h.c,f.sale,f.buyer)).toEqual({status:"verified"});expect(await recordTeamSavedMethod(h.c,f.sale,f.buyer)).toEqual({status:"verified"});
 expect(h.provider.mock.calls.every(([method])=>method==="GET")).toBe(true);expect((await db.query("select count(*)::int n from sales_team_saved_methods_v1")).rows).toEqual([{n:1}]);expect((await db.query("select stop_requested_at is not null stopped from sales_team_payment_runtime_v1")).rows).toEqual([{stopped:true}]);
});
test.each(["review","refund","dispute","shared"])("%s cannot supply reusable authority",async fault=>{
 const f=await fixture();if(fault==="review")await db.exec("update sales_team_receipts_v1 set review_hold=true");if(fault==="refund")await db.exec("update sales_team_receipts_v1 set refunded_subtotal_cents=1");if(fault==="dispute")await db.exec("update sales_team_receipts_v1 set dispute_hold=true");if(fault==="shared")await db.exec("set constraints all immediate;alter table sales_team_shared_receipts_v1 disable trigger user;delete from sales_team_shared_receipts_v1");
 const h=harness(f);expect(await recordTeamSavedMethod(h.c,f.sale,f.buyer)).toEqual({status:"not_eligible"});expect(h.provider).not.toHaveBeenCalled();
});
test.each(["anon","authenticated"])("%s cannot read or create private written consents or saved authorities",async role=>{
 const f=await fixture();await db.exec(`set role ${role}`);await denied(()=>rpc("read_sales_team_saved_method_quote_v1",[f.sale,f.buyer]),/permission denied/i);await denied(()=>db.exec("select * from sales_team_saved_methods_v1"),/permission denied/i);await denied(()=>db.exec("select * from sales_team_saved_method_consents_v1"),/permission denied/i);
});
test("service has no direct write authority and saved consent/card history is immutable",async()=>{
 const f=await fixture(),h=harness(f);await recordTeamSavedMethod(h.c,f.sale,f.buyer);await denied(()=>db.exec("update sales_team_saved_method_consents_v1 set automatic_authorized=false"),/IMMUTABLE/);await denied(()=>db.exec("delete from sales_team_saved_methods_v1"),/IMMUTABLE/);
 await db.exec("set role service_role");await denied(()=>db.exec("insert into sales_team_saved_methods_v1 default values"),/permission denied/i);await denied(()=>readTeamSavedMethodQuote({admin},f.sale,id(11)),/OWNED_TEAM/);
});
test.each(["missing_consent","disabled","Stop","changed_quote","post_claim_disable"])("%s cannot start a fresh saved-card confirmation",async fault=>{
 await db.exec("update sales_team_controls_v1 set fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true");
 await expect(seedTeamCapture(db,{beforeConfirmation:async(contract,proof)=>{
  await db.exec("update sales_team_controls_v1 set saved_method_enabled=true");const quote=await rpc<TeamSavedMethodQuote>("read_sales_team_saved_method_quote_v1",[contract.saleId,contract.terms.buyerId,contract.obligationId]);
  const evidence=teamPaymentFixture().evidence,request=teamConfirmationRequest(contract,evidence,"pi_original",proof,proof.createdAt),scope:TeamOperationScope={scopeId:contract.saleId,saleId:contract.saleId,creatorId:contract.terms.creatorId,actorId:contract.terms.buyerId,kind:"confirmation",scopeKey:`confirm:${id(70)}`,workerRunId:null},operation=teamOperationId(scope);
  const reserve=()=>rpc("reserve_sales_team_confirmation_v1",[contract.saleId,contract.terms.buyerId,id(70),operation,"token",proof,request]);
  if(fault==="missing_consent")await denied(reserve,/EXPLICIT_TEAM_SAVED_METHOD_CONSENT_REQUIRED/);
  else{
   await rpc("accept_sales_team_saved_method_v1",[contract.saleId,contract.terms.buyerId,contract.obligationId,id(70),contract.context,quote.fingerprint,true,proof]);await reserve();
   expect(await rpc("sales_team_operation_admitted_v1",[scope,contract.context])).toBe(true);
   if(fault==="post_claim_disable"){
    const claim=await rpc<{status:string;operation:{lease_token:string}}>("claim_sales_team_provider_operation_v1",[operation,scope,contract.context,request]);expect(claim.status).toBe("dispatch");await db.exec("update sales_team_controls_v1 set saved_method_enabled=false");
    await denied(()=>rpc("assert_sales_team_provider_dispatch_v1",[operation,claim.operation.lease_token]),/PROVIDER_DISPATCH_NO_LONGER_ADMITTED/);throw Error("fixture unpaid boundary inspected");
   }
   if(fault==="disabled")await db.exec("update sales_team_controls_v1 set saved_method_enabled=false");
   if(fault==="Stop")await rpc("stop_sales_team_payment_v1",[contract.saleId,contract.terms.buyerId]);
   if(fault==="changed_quote")await db.exec("update sales_team_payment_runtime_v1 set anchor_at=clock_timestamp()");
   expect(await rpc("sales_team_operation_admitted_v1",[scope,contract.context])).toBe(false);
   expect(await rpc("claim_sales_team_provider_operation_v1",[operation,scope,contract.context,request])).toMatchObject({status:"not_enabled"});
   expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where id=$1",[operation])).rows).toEqual([{n:0}]);
  }
  throw Error("fixture unpaid boundary inspected");
 }})).rejects.toThrow("fixture unpaid boundary inspected");
});
test("schema/readiness decoration is default off and never borrows ordinary payment readiness",async()=>{
 const env={...process.env};try{delete process.env.CREATOR_TEAM_SAVED_METHOD_SCHEMA_READY;expect(await savedMethodPaymentResponse(admin,id(20),id(10),{phase:"needs_method",saveForFuture:true})).toEqual({});
  for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_LATER_COLLECTION_SCHEMA_READY","CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY","CREATOR_TEAM_COLLECTION_RETRY_SCHEMA_READY","CREATOR_TEAM_SAVED_METHOD_SCHEMA_READY"])process.env[key]="true";
  const f=await fixture();expect(await savedMethodPaymentResponse(admin,f.sale,f.buyer,{phase:"needs_method",saveForFuture:true})).toMatchObject({savedMethodConsentRequired:true,savedMethodConsentEnabled:false,collectionEnabled:false,savedMethodConsent:{saleId:f.sale}});
  expect(await savedMethodPaymentResponse(admin,f.sale,f.buyer,{phase:"needs_method",saveForFuture:false})).toEqual({});
 }finally{process.env=env;}
});
const digests=async()=>(await db.query<Record<string,string>>("select creatornet_team_private.transfer_contract_digest_v1() transfer,creatornet_team_private.shared_cash_contract_digest_v1() shared,creatornet_team_private.retained_cash_contract_digest_v1() retained,creatornet_team_private.recovery_contract_digest_v1() recovery")).rows[0];
test.each(["creatornet_team_private.team_saved_method_quote_v1(uuid,uuid)","creatornet_team_private.guard_team_saved_method_consent_v1()","public.accept_sales_team_saved_method_v1(uuid,uuid,uuid,uuid,jsonb,text,boolean,jsonb)","public.read_sales_team_saved_method_source_v1(uuid,uuid,uuid)","public.record_sales_team_saved_method_v1(uuid,uuid,uuid,jsonb)","public.sales_team_operation_admitted_v1(jsonb,jsonb)"])("all reviewed financial digests bind %s",async signature=>{
 const before=await digests(),source=(await db.query<{s:string}>("select pg_get_functiondef($1::regprocedure) s",[signature])).rows[0].s;await db.exec(source.replace(/AS \$function\$/i,"AS $function$\n-- synthetic consent authority mutation\n"));const after=await digests();for(const name of Object.keys(before))expect(after[name]).not.toBe(before[name]);
});
test.each(["dependency","late_grant"])("%s failure rolls back saved-method tables, control, alias, definitions and grants",async fault=>{
 const isolated=createLocalPostgres();try{
  await sharedCashDatabase(isolated);for(const path of predecessors)await isolated.exec(readFileSync(path,"utf8"));
  if(fault==="dependency")await isolated.exec("alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to fixture_missing_saved_method_dependency");
  const names=[fault==="dependency"?"fixture_missing_saved_method_dependency":"sales_team_operation_admitted_v1","transfer_contract_digest_v1","shared_cash_contract_digest_v1","retained_cash_contract_digest_v1","recovery_contract_digest_v1"];
  const inventory=async()=>(await isolated.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text grants from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) and proname=any($1::text[]) order by oid",[names])).rows,before=await inventory();
  const sql=readFileSync(candidate,"utf8");await expect(isolated.exec(fault==="late_grant"?sql.replace("commit;","grant execute on function public.missing_saved_method_final_grant() to service_role;commit;"):sql)).rejects.toThrow(fault==="dependency"?/sales_team_operation_admitted_v1/:/missing_saved_method_final_grant/);await isolated.exec("rollback");expect(await inventory()).toEqual(before);
  expect((await isolated.query("select to_regclass('public.sales_team_saved_method_consents_v1') consent,to_regclass('public.sales_team_saved_methods_v1') method,to_regprocedure('public.sales_team_operation_before_saved_method_v1(jsonb,jsonb)') alias")).rows).toEqual([{consent:null,method:null,alias:null}]);
  expect((await isolated.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='sales_team_controls_v1' and column_name='saved_method_enabled'")).rows).toEqual([{n:0}]);
 }finally{await isolated.close();}
},30000);
