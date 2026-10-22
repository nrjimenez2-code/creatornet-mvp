/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamFixtureId as id,addTeamMember} from "@/test-support/sales-team-postgres";
import {teamOperationId,TEAM_STRIPE_API_VERSION,type TeamOperationScope,type TeamProviderRequest} from "@/lib/salesTeams/providerOperation";
import {teamIntentRequest,type TeamPaymentContract} from "@/lib/salesTeams/paymentProtocol";
import type {TeamCollection} from "@/lib/salesTeams/collection";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,sale:string,context:TeamPaymentContract["context"];
const rpc=async<T=Record<string,unknown>>(name:string,args:unknown[]=[])=> (await db.query<{r:T}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) r`,args)).rows[0].r;
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
const read=()=>rpc<TeamCollection>("read_sales_team_payment_v1",[sale,id(10)]);
const scope=(kind:TeamOperationScope["kind"],scopeKey:string):TeamOperationScope=>({scopeId:sale,saleId:sale,creatorId:id(1),actorId:id(10),kind,scopeKey,workerRunId:null});
async function claim(s:TeamOperationScope,request:TeamProviderRequest){return rpc<{status:string;operation:Record<string,unknown>}>("claim_sales_team_provider_operation_v1",[teamOperationId(s),s,context,request]);}
const bind=(operationId:string,providerId:string,req="req_original")=>rpc("bind_sales_team_provider_operation_v1",[operationId,providerId,req,false]);
beforeAll(async()=>{
 db=await salesTeamSaleDatabase(createLocalPostgres(),{sharedAdmission:true});
 await db.exec(`create table public.profiles(id uuid primary key,stripe_account_id text);insert into public.profiles(id) select id from auth.users;
  create table public.stripe_connect_account_creations(creator_id uuid primary key,idempotency_key uuid unique not null default gen_random_uuid(),email text,created_at timestamptz not null default now(),stripe_account_id text);
  grant select,insert,update on public.profiles,public.stripe_connect_account_creations to service_role;`);
 for(const name of ["20261021215909_sales_team_provider_journal_and_ledger.sql","20261021220845_sales_team_receipt_accounting.sql","20261022223942_sales_team_recipient_onboarding.sql","20261022230849_sales_team_payment_collection.sql"]){
  try{await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));}catch(e){const err=e as {message:string;position:string;internalPosition:string;internalQuery:string;where:string};throw Error(JSON.stringify({migration:name,message:err.message,position:err.position,internalPosition:err.internalPosition,internalQuery:err.internalQuery,where:err.where}));}
 }
},30000);
beforeEach(async()=>{
 await db.exec("begin");await enableTeamSalesFixture(db);const offer=await approveTeamOffer(db,[3]),draft=await draftTeamSale(db,offer.options.find(o=>o.kind==="installments")!.id);
 await rpc("accept_sales_team_sale_v1",[draft.saleId,id(10),draft.quote.fingerprint,true]);sale=draft.saleId;context=JSON.parse(JSON.stringify(draft.source.financialConfig.context));
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
async function customer(){
 await db.exec("update sales_team_controls_v1 set payment_collection_enabled=true");const customerScope=scope("customer","customer:v1"),operationId=teamOperationId(customerScope);
 await rpc("reserve_sales_team_customer_v1",[sale,id(10),operationId,context]);const s=await read();expect(await claim(customerScope,s.setup!.customer_request)).toMatchObject({status:"dispatch"});
 await bind(operationId,"cus_original");await rpc("bind_sales_team_customer_v1",[sale,id(10),"cus_original"]);return read();
}
async function attempt(){
 const s=await customer(),intentScope=scope("intent",`intent:${s.obligation!.id}`),operationId=teamOperationId(intentScope);
 const contract:TeamPaymentContract={protocol:s.sale.terms.protocol,saleId:sale,obligationId:s.obligation!.id,operationId,terms:s.sale.terms,fingerprint:s.sale.fingerprint,context,
  customerId:"cus_original",periodNumber:1,amountCents:s.obligation!.amount_cents,acceptedAt:Math.floor(Date.parse(s.sale.accepted_at)/1000),expiresAt:Math.floor(Date.parse(s.setup!.expires_at)/1000),kind:"payment"};
 const evidence={approvedContext:context,vercelEnvironment:"preview" as const,stripeSecretKeyMode:"test" as const,stripePublishableKeyMode:"test" as const,observedPlatformAccountId:context.platformAccountId,
  observedSupabaseProjectRef:context.supabaseProjectRef,configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin};
 const request=teamIntentRequest(contract,evidence);await rpc("reserve_sales_team_intent_v1",[sale,id(10),operationId,contract,request]);return {s:await read(),scope:intentScope,operationId,contract,request};
}
async function state(status="requires_payment_method",request="req_state",extra:Record<string,unknown>={}){
 const s=await read(),proof={context,obligationId:s.obligation!.id,paymentIntentId:"pi_original",status,paymentMethodId:null,amountReceived:0,amountCapturable:0,unpaidMethod:true,providerRequestId:request,observedAt:Math.floor(Date.now()/1000),readStartedAt:Date.now(),...extra};
 await rpc("record_sales_team_payment_state_v1",[s.obligation!.id,proof]);return proof;
}
const tokenProof=()=>({tokenId:"ctoken_original",createdAt:Math.floor(Date.now()/1000),expiresAt:Math.floor(Date.now()/1000)+600,previewHash:"a".repeat(64),country:"US"});
function confirmationRequest(token=true):TeamProviderRequest{return {method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:"/v1/payment_intents/pi_original/confirm",params:{...(token?{confirmation_token:"ctoken_original"}:{}),use_stripe_sdk:true,return_url:`${context.siteOrigin}/purchase/team/${sale}`}};}

test("collection is independently default-off and ownership cannot be selected by the caller",async()=>{
 await denied(()=>rpc("reserve_sales_team_customer_v1",[sale,id(10),id(90),context]),/TEAM_PAYMENT_COLLECTION_HELD/);
 await denied(()=>rpc("reserve_sales_team_customer_v1",[sale,id(11),id(90),context]),/OWNED_SALE_REQUIRED/);
 await denied(()=>rpc("read_sales_team_payment_v1",[sale,id(11)]),/OWNED_SALE_REQUIRED/);
 expect((await read()).setup).toBeNull();
});
test("customer creation is frozen, bound to its original journal and never replaced",async()=>{
 const s=await customer();expect(s.runtime!.customer_id).toBe("cus_original");
 await denied(()=>rpc("reserve_sales_team_customer_v1",[sale,id(10),id(91),context]),/ORIGINAL_TEAM_PAYMENT_CHANGED/);
 await denied(()=>rpc("bind_sales_team_customer_v1",[sale,id(10),"cus_new"]),/TEAM_CUSTOMER_PROOF_REQUIRED/);
 await denied(()=>db.query("update sales_team_payment_setups_v1 set customer_request='{}' where sale_id=$1",[sale]),/IMMUTABLE|immutable|HISTORY/);
});
test("an unsaved or altered provider request cannot bypass the durable contract",async()=>{
 const a=await attempt();await denied(()=>claim(a.scope,{...a.request,params:{...a.request.params,amount:1}}),/SAVED_TEAM_PAYMENT_REQUEST_REQUIRED/);
 await denied(()=>rpc("reserve_sales_team_intent_v1",[sale,id(10),a.operationId,{...a.contract,amountCents:1},a.request]),/ORIGINAL_TEAM_PAYMENT_CHANGED/);
 expect(await claim(a.scope,a.request)).toMatchObject({status:"dispatch"});await bind(a.operationId,"pi_original");await state();
 expect((await read()).state).toMatchObject({payment_intent_id:"pi_original",status:"requires_payment_method"});
});
test("Stop fences an admitted original before dispatch even with a live lease",async()=>{
 const a=await attempt(),claimed=await claim(a.scope,a.request);await rpc("stop_sales_team_payment_v1",[sale,id(10)]);
 await denied(()=>rpc("assert_sales_team_provider_dispatch_v1",[a.operationId,claimed.operation.lease_token]),/NO_LONGER_ADMITTED/);
 await denied(()=>rpc("close_unpaid_sales_team_payment_v1",[sale,id(10),{noIntentDispatched:true}]),/NOT_CONCLUSIVELY_UNPAID/);
 expect((await read()).closed).toBe(false);
});
test("Stop before any intent dispatch closes only the original admission and permits a newly approved review",async()=>{
 await customer();await rpc("stop_sales_team_payment_v1",[sale,id(10)]);await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,payment_collection_enabled=false");
 await rpc("close_unpaid_sales_team_payment_v1",[sale,id(10),{noIntentDispatched:true}]);expect((await read()).closed).toBe(true);
 expect((await db.query("select status from sales_team_purchase_admissions_v1")).rows).toEqual([{status:"closed_unpaid"}]);
 expect((await db.query("select accepted_sale_id from sales_team_assignments_v1")).rows).toEqual([{accepted_sale_id:null}]);
 expect((await db.query("select count(*)::int n from sales_team_sale_agreements_v1")).rows).toEqual([{n:1}]);
 await db.exec("update sales_team_controls_v1 set access_enabled=true,new_sales_enabled=true");const offer=await approveTeamOffer(db,[3]);const next=await draftTeamSale(db,offer.options.find(o=>o.kind==="full")!.id,id(31));
 await rpc("accept_sales_team_sale_v1",[next.saleId,id(10),next.quote.fingerprint,true]);expect((await db.query("select count(*)::int n from sales_team_sale_agreements_v1")).rows).toEqual([{n:2}]);
});
test("unresolved confirmation prevents a second card, and exact original retries retain the request",async()=>{
 const a=await attempt();await claim(a.scope,a.request);await bind(a.operationId,"pi_original");await state();
 const proof=tokenProof(),request=confirmationRequest(),cScope=scope("confirmation",`confirm:${id(70)}`),op=teamOperationId(cScope),args=[sale,id(10),id(70),op,"token",proof,request];
 expect(await rpc("reserve_sales_team_confirmation_v1",args)).toMatchObject({operation_id:op,step_number:1});expect(await rpc("reserve_sales_team_confirmation_v1",args)).toMatchObject({operation_id:op});
 await denied(()=>rpc("reserve_sales_team_confirmation_v1",[sale,id(10),id(71),id(72),"token",{...proof,tokenId:"ctoken_new"},request]),/NEEDS_RECONCILIATION/);
 await denied(()=>rpc("reserve_sales_team_confirmation_v1",[...args.slice(0,5),{...proof,tokenId:"ctoken_new"},request]),/ORIGINAL_TEAM_CONFIRMATION_CHANGED/);
 expect(await claim(cScope,request)).toMatchObject({status:"dispatch"});
});
test("manual SCA reconfirmation requires the independently observed original token and method",async()=>{
 const a=await attempt();await claim(a.scope,a.request);await bind(a.operationId,"pi_original");await state();
 const proof=tokenProof(),request=confirmationRequest(),cScope=scope("confirmation",`confirm:${id(70)}`),op=teamOperationId(cScope);
 await rpc("reserve_sales_team_confirmation_v1",[sale,id(10),id(70),op,"token",proof,request]);await claim(cScope,request);await bind(op,"pi_original","req_confirm");
 await state("requires_confirmation","req_sca",{paymentMethodId:"pm_original"});
 await denied(()=>rpc("reserve_sales_team_confirmation_v1",[sale,id(10),id(71),id(72),"reconfirm",proof,confirmationRequest(false)]),/RECONFIRMATION_PROOF_REQUIRED/);
 await state("requires_confirmation","req_scaVerified",{paymentMethodId:"pm_original",authorizedTokenId:proof.tokenId,authorizedPaymentMethodId:"pm_original"});
 expect(await rpc("reserve_sales_team_confirmation_v1",[sale,id(10),id(71),id(72),"reconfirm",proof,confirmationRequest(false)])).toMatchObject({kind:"reconfirm",step_number:2});
});
test("only independently canceled and unpaid evidence releases an original dispatched purchase",async()=>{
 const a=await attempt();await claim(a.scope,a.request);await bind(a.operationId,"pi_original");await state();await rpc("stop_sales_team_payment_v1",[sale,id(10)]);
 await denied(()=>rpc("close_unpaid_sales_team_payment_v1",[sale,id(10),{noIntentDispatched:true}]),/NOT_CONCLUSIVELY_UNPAID/);
 const proof=await state("canceled","req_canceled");await rpc("close_unpaid_sales_team_payment_v1",[sale,id(10),proof]);expect((await read()).closed).toBe(true);
 await rpc("close_unpaid_sales_team_payment_v1",[sale,id(10),proof]);expect((await db.query("select count(*)::int n from sales_team_payment_closures_v1")).rows).toEqual([{n:1}]);
});
test("captured funds and an unproven failed charge cannot be declared safely unpaid",async()=>{
 const a=await attempt();await claim(a.scope,a.request);await bind(a.operationId,"pi_original");await rpc("stop_sales_team_payment_v1",[sale,id(10)]);
 const proof=await state("canceled","req_unproven",{unpaidMethod:false});await denied(()=>rpc("close_unpaid_sales_team_payment_v1",[sale,id(10),proof]),/NOT_CONCLUSIVELY_UNPAID/);
 await denied(()=>state("succeeded","req_badAmount"),/STATE_PROOF_REQUIRED/);
});
test("a delayed old read cannot regress a terminal observation or reopen card collection",async()=>{
 const a=await attempt();await claim(a.scope,a.request);await bind(a.operationId,"pi_original");await state("succeeded","req_paid",{amountReceived:a.contract.amountCents});
 await denied(()=>state("requires_payment_method","req_late",{readStartedAt:Date.now()-1000}),/READ_STALE/);
 expect((await read()).state!.status).toBe("succeeded");
});
test("new payment gates and account context changes stop fresh dispatch without removing original recovery",async()=>{
 const a=await attempt();await db.exec("update sales_team_controls_v1 set payment_collection_enabled=false");expect(await claim(a.scope,a.request)).toMatchObject({status:"not_enabled"});
 await db.exec("update sales_team_controls_v1 set payment_collection_enabled=true");await db.query("update sales_team_financial_config_v1 set context=$1",[{...context,platformAccountId:"acct_changed"}]);
 expect(await claim(a.scope,a.request)).toMatchObject({status:"not_enabled"});expect((await read()).attempt!.intent_operation_id).toBe(a.operationId);
});
test("financial source tables and RPCs are denied to browser roles",async()=>{
 await customer();await db.exec("set local role authenticated");await denied(()=>db.query("select * from public.sales_team_payment_setups_v1"),/permission denied/);
 await denied(()=>read(),/permission denied/);await denied(()=>rpc("stop_sales_team_payment_v1",[sale,id(10)]),/permission denied/);
});
test("the payment wrapper retains the separately scoped recipient journal admission",async()=>{
 await db.exec("update sales_team_controls_v1 set recipient_onboarding_enabled=true,payment_collection_enabled=false");
 await addTeamMember(db,3);await db.query("delete from sales_team_recipients_v1 where user_id=$1",[id(3)]);
 const setup=await rpc<{id:string;request:TeamProviderRequest}>("reserve_sales_team_recipient_v1",[id(3),context,true]);
 const s:TeamOperationScope={scopeId:id(3),scopeKey:`recipient:${setup.id}`,kind:"recipient",saleId:null,creatorId:null,actorId:id(3),workerRunId:null};
 expect(await claim(s,setup.request)).toMatchObject({status:"dispatch"});
});
