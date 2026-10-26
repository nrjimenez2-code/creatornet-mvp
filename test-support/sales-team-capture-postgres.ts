import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "./sales-team-sale-postgres";
import {teamFixtureId as id} from "./sales-team-postgres";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import {teamIntentRequest,type TeamPaymentContract} from "@/lib/salesTeams/paymentProtocol";
import {inspectTeamReceipt} from "@/lib/salesTeams/receiptPolicy";
import {teamCaptureFixture} from "./sales-team-capture-fixture";
import type {TeamCollection} from "@/lib/salesTeams/collection";
const json=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
export const captureRpc=async<T=Record<string,unknown>>(db:PGlite,name:string,args:unknown[]=[])=>json((await db.query<{r:T}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) r`,args)).rows[0].r);
export async function teamCaptureDatabase(db:PGlite){
 await salesTeamSaleDatabase(db,{sharedAdmission:true});
 await db.exec(`create table public.profiles(id uuid primary key,stripe_account_id text,total_earnings_cents bigint not null default 0);insert into profiles(id) select id from auth.users;
  create table public.stripe_connect_account_creations(creator_id uuid primary key,idempotency_key uuid unique not null default gen_random_uuid(),email text,created_at timestamptz not null default now(),stripe_account_id text);
  grant select,insert,update on profiles,stripe_connect_account_creations to service_role;`);
 for(const file of ["20261021215909_sales_team_provider_journal_and_ledger.sql","20261021220845_sales_team_receipt_accounting.sql","20261022223942_sales_team_recipient_onboarding.sql","20261022230849_sales_team_payment_collection.sql","20261022233620_sales_team_verified_capture.sql"])await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
 return db;
}
export async function seedTeamCapture(db:PGlite,options:{beforeSetup?:()=>Promise<void>;beforeApproval?:()=>Promise<void>;paymentKind?:"installments"|"monthly"}={}){
 const rpc=<T=Record<string,unknown>>(name:string,args:unknown[]=[])=>captureRpc<T>(db,name,args);
 await options.beforeSetup?.();await enableTeamSalesFixture(db);await options.beforeApproval?.();
 const paymentKind=options.paymentKind??"installments";
 const offer=await approveTeamOffer(db,paymentKind==="monthly"?[]:[3]),draft=await draftTeamSale(db,offer.options.find(o=>o.kind===paymentKind)!.id),sale=draft.saleId,buyer=id(10),context=json(draft.source.financialConfig.context);
 await rpc("accept_sales_team_sale_v1",[sale,buyer,draft.quote.fingerprint,true]);await db.exec("update sales_team_controls_v1 set payment_collection_enabled=true,receipt_recording_enabled=true");
 const scope=(kind:TeamOperationScope["kind"],scopeKey:string):TeamOperationScope=>({scopeId:sale,saleId:sale,creatorId:id(1),actorId:buyer,kind,scopeKey,workerRunId:null});
 const bind=async(s:TeamOperationScope,request:unknown,providerId:string)=>{const op=teamOperationId(s);await rpc("claim_sales_team_provider_operation_v1",[op,s,context,request]);await rpc("bind_sales_team_provider_operation_v1",[op,providerId,"req_bound",false]);return op;};
 const customerScope=scope("customer","customer:v1");await rpc("reserve_sales_team_customer_v1",[sale,buyer,teamOperationId(customerScope),context]);let saved=await rpc<TeamCollection>("read_sales_team_payment_v1",[sale,buyer]);
 await bind(customerScope,saved.setup!.customer_request,"cus_original");await rpc("bind_sales_team_customer_v1",[sale,buyer,"cus_original"]);saved=await rpc<TeamCollection>("read_sales_team_payment_v1",[sale,buyer]);
 const intentScope=scope("intent",`intent:${saved.obligation!.id}`),operationId=teamOperationId(intentScope);
 const contract:TeamPaymentContract={protocol:saved.sale.terms.protocol,saleId:sale,obligationId:saved.obligation!.id,operationId,terms:saved.sale.terms,fingerprint:saved.sale.fingerprint,context,customerId:"cus_original",periodNumber:1,
  amountCents:saved.obligation!.amount_cents,acceptedAt:Math.floor(Date.parse(saved.sale.accepted_at)/1000),expiresAt:Math.floor(Date.parse(saved.setup!.expires_at)/1000),kind:"payment"};
 const evidence={approvedContext:context,vercelEnvironment:"preview" as const,stripeSecretKeyMode:"test" as const,stripePublishableKeyMode:"test" as const,observedPlatformAccountId:context.platformAccountId,
  observedSupabaseProjectRef:context.supabaseProjectRef,configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin};
 const request=teamIntentRequest(contract,evidence);await rpc("reserve_sales_team_intent_v1",[sale,buyer,operationId,contract,request]);await bind(intentScope,request,"pi_original");
 const stamp=Math.floor(Date.now()/1000);
 await rpc("record_sales_team_payment_state_v1",[contract.obligationId,{context,obligationId:contract.obligationId,paymentIntentId:"pi_original",status:"requires_payment_method",paymentMethodId:null,amountReceived:0,amountCapturable:0,unpaidMethod:true,
  providerRequestId:"req_unpaidRead",observedAt:stamp,readStartedAt:Date.now()}]);
 const confirmationScope=scope("confirmation",`confirm:${id(70)}`),confirmationId=teamOperationId(confirmationScope),base=teamCaptureFixture(contract);
 base.confirmation={...base.confirmation,operationId:confirmationId,firstDispatchAt:stamp,lastDispatchAt:stamp,tokenProof:{...base.confirmation.tokenProof,createdAt:stamp,expiresAt:stamp+600}};
 await rpc("reserve_sales_team_confirmation_v1",[sale,buyer,id(70),confirmationId,"token",base.confirmation.tokenProof,base.confirmation.request]);await bind(confirmationScope,base.confirmation.request,"pi_original");
 base.paymentIntent.created=stamp;base.charge.created=stamp;base.balance.created=stamp;base.balance.available_on=stamp+86400;base.evidence=evidence;base.nowSeconds=stamp;
 const proof=()=>inspectTeamReceipt({...base,financialInspection:true}),capture=()=>({receipt:proof(),readback:{intentRequestId:"req_intentRead",chargeRequestId:"req_chargeRead",balanceRequestId:base.balance?"req_balanceRead":null,readStartedAt:Date.now(),observedAt:Math.floor(Date.now()/1000)}});
 const record=()=>rpc("record_verified_sales_team_capture_v1",[sale,buyer,contract.obligationId,confirmationId,capture()]);
 return {sale,buyer,contract,evidence,confirmationId,base,proof,capture,record,rpc};
}
