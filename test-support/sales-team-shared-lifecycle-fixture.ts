import type {PGlite} from "@electric-sql/pglite";
import type Stripe from "stripe";
import {teamSupabaseFixture} from "./sales-team-supabase-fixture";
import {teamPaymentFixture} from "./sales-team-payment-fixture";
import {teamCaptureFixture} from "./sales-team-capture-fixture";
import type {seedTeamCapture} from "./sales-team-capture-postgres";
import {teamFixtureId as id} from "./sales-team-postgres";
import {prepareNextTeamCollection,confirmTeamCollection,readTeamCollection} from "@/lib/salesTeams/collection";
import {recordTeamCapture,type TeamReceiptComposition} from "@/lib/salesTeams/receipts";
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

/** In-memory provider only. Uses real preparation, confirmation and independent
 * capture owners; no network client, credentials or provider state is involved. */
export function sharedLifecycleFixture(db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>){
 const admin=teamSupabaseFixture(db),objects=new Map<string,unknown>();let sequence=0;
 let pi:Stripe.PaymentIntent,token:Stripe.ConfirmationToken;
 const remember=(capture:Pick<ReturnType<typeof teamCaptureFixture>,"paymentIntent"|"charge"|"balance">)=>{
  for(const value of [capture.paymentIntent,capture.charge,capture.balance]){
   if(!value.id)throw Error("Synthetic original provider ID required");objects.set(value.id,value);
  }
 };
 remember(f.base);
 const refunds:Record<string,unknown>[]=[],disputes:Record<string,unknown>[]=[];
 const raw=jest.fn(async(method:string,path:string,params:Record<string,unknown>={})=>{
  const stamp=Math.floor(Date.now()/1000),key=path.split("/").at(-1)!;
  const response=(value:unknown)=>clone({...value as object,lastResponse:{requestId:`req_combined${++sequence}`,headers:{},statusCode:200}});
  if(method==="GET"&&path==="/v1/customers/cus_original"){
   const saved=await readTeamCollection({admin},f.sale,f.buyer);
   return response({id:"cus_original",object:"customer",livemode:false,created:Math.floor(Date.parse(saved.setup!.created_at)/1000),metadata:saved.setup!.customer_request.params.metadata});
  }
  if(method==="POST"&&path==="/v1/payment_intents"){
   const period=(params.metadata as Record<string,string>).period_number,base=teamPaymentFixture("installments");
   pi={...clone(base.pi),...params,id:`pi_combined${period}`,created:stamp,setup_future_usage:params.setup_future_usage??null} as Stripe.PaymentIntent;
   token={...clone(base.token),id:`ctoken_combined${period}`,created:stamp,expires_at:stamp+3600,setup_future_usage:params.setup_future_usage??null} as Stripe.ConfirmationToken;
   objects.set(pi.id,pi);objects.set(token.id,token);return response(pi);
  }
  if(method==="POST"&&path===`/v1/payment_intents/${pi?.id}/confirm`){
   const saved=await readTeamCollection({admin},f.sale,f.buyer,pi.metadata.team_obligation_id),contract=saved.attempt!.contract,capture=teamCaptureFixture(contract),period=contract.periodNumber;
   capture.paymentIntent={...pi,status:"succeeded",amount_received:pi.amount,payment_method:"pm_original",latest_charge:`ch_combined${period}`};
   capture.charge={...capture.charge,id:`ch_combined${period}`,payment_intent:pi.id,balance_transaction:`txn_combined${period}`,created:stamp};
   capture.balance={...capture.balance,id:`txn_combined${period}`,source:capture.charge.id,created:stamp,available_on:stamp+86400};
   pi=capture.paymentIntent;token.payment_intent=pi.id;token.expires_at=null;remember(capture);return response(pi);
  }
  if(method==="GET"&&path==="/v1/refunds")return response({object:"list",data:refunds.filter(r=>r.charge===params.charge),has_more:false});
  if(method==="GET"&&path==="/v1/disputes")return response({object:"list",data:disputes.filter(r=>r.charge===params.charge),has_more:false});
  if(method==="GET"&&objects.has(key))return response(objects.get(key));
  throw Error(`Unexpected synthetic provider operation ${method} ${path}`);
 });
 const c:TeamReceiptComposition={admin,stripe:{rawRequest:raw},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence};
 const later=async()=>{
  const prepared=await prepareNextTeamCollection(c,f.sale,f.buyer),period=prepared.saved.obligation!.period_number;
  await confirmTeamCollection(c,f.sale,f.buyer,{obligationId:prepared.saved.obligation!.id,requestId:id(300+period),kind:"token",tokenId:token.id});
  const captured=await recordTeamCapture(c,f.sale,f.buyer,prepared.saved.obligation!.id);
  if(captured.status!=="verified"||!("receiptId" in captured))throw Error("Verified later receipt required");
  return {receiptId:captured.receiptId,obligationId:prepared.saved.obligation!.id};
 };
 return {c,raw,later,objects,refunds,disputes};
}
