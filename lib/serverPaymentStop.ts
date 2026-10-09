import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {inspectServerPaymentIntent,inspectServerUncapturedCharge,serverPaymentCreateRequest,type ServerPaymentContract} from "./serverPaymentConfirmation";

const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original manual payment stop requires review");};
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id??null;
const providerOptions={apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000};
type Database={rpc(name:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:unknown}>};
export type ServerPaymentTerminalProof={version:"server-payment-intent-terminal-v1";paymentIntentId:string;status:"canceled";
  amountReceived:0;amountCapturable:0;canceledAt:number;chargeIds:string[];observedAt:number};
type Arguments={contract:ServerPaymentContract;binding:{paymentIntentId:string;firstDispatchAt:number};admin:Database;
  stripe:Pick<Stripe,"paymentIntents"|"charges">;contextEvidence:()=>Promise<unknown>;env?:Record<string,string|undefined>;now?:()=>number};

/** Independently inspect ALL charge history for this original canceled intent.
 * A fully refunded/captured charge is not an unpaid abandonment. A partial list
 * or timeout cannot authorize release. The caller separately checks source and
 * any held subscription before considering selection release.
 */
export async function inspectServerPaymentTerminal(args:Arguments,pi:Stripe.PaymentIntent):Promise<ServerPaymentTerminalProof>{
  const now=args.now??(()=>Math.floor(Date.now()/1000)),c=args.contract;
  inspectServerPaymentIntent(c,await args.contextEvidence(),pi,args.binding,now());
  check(pi.status==="canceled"&&pi.amount_received===0&&pi.amount_capturable===0&&pi.next_action===null&&
    Number.isSafeInteger(pi.canceled_at)&&pi.canceled_at!>=args.binding.firstDispatchAt-5&&pi.canceled_at!<=now());
  const seen=new Set<string>();let cursor:string|undefined;
  for(let pageNumber=0;;pageNumber++){
    check(pageNumber<100);
    const page=await args.stripe.charges.list({payment_intent:pi.id,limit:100,...(cursor?{starting_after:cursor}:{})},providerOptions);
    check(page.object==="list"&&Array.isArray(page.data)&&typeof page.has_more==="boolean");
    for(const ch of page.data){
      check(!seen.has(ch.id));inspectServerUncapturedCharge(c,ch,pi.id,args.binding.firstDispatchAt,now());
      seen.add(ch.id);
    }
    if(!page.has_more)break;
    const next=page.data.at(-1)?.id;check(next&&next!==cursor);cursor=next;
  }
  const latest=id(pi.latest_charge);check(latest===null?seen.size===0:seen.has(latest));
  return {version:"server-payment-intent-terminal-v1",paymentIntentId:pi.id,status:"canceled",amountReceived:0,amountCapturable:0,
    canceledAt:pi.canceled_at!,chargeIds:[...seen].sort(),observedAt:now()};
}

/** Cancel only a bound original manual intent after persisting a stop. The
 * original cancellation request/key is durable before dispatch. No new intent,
 * confirmation, refund, debt waiver or selection release is performed here.
 */
export async function stopServerPaymentIntent(args:Arguments){
  try{
    const env=args.env??process.env;
    const enabled=()=>check(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY==="true"&&
      env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY==="true");
    enabled();
    const c=JSON.parse(JSON.stringify(args.contract)) as ServerPaymentContract,binding={...args.binding};
    const dependencies={...args,contract:c,binding},now=args.now??(()=>Math.floor(Date.now()/1000));
    const scope={p_attempt_id:c.attemptId,p_buyer_id:c.buyerId,p_context:c.context};
    const rpc=async(name:string,extra:Record<string,unknown>={})=>{
      serverPaymentCreateRequest(c,await args.contextEvidence());const result=await args.admin.rpc(name,{...scope,...extra});
      check(!result.error);return result.data as any;
    };
    const stopped=await rpc("request_server_payment_stop_v1");
    check(stopped?.attemptId===c.attemptId&&stopped.releaseAllowed===false);
    const source=async()=>{
      const original=await rpc("read_server_payment_cancellation_source_v1");
      check(original&&isDeepStrictEqual(original.contract,c)&&original.bound_at&&original.payment_intent_id===binding.paymentIntentId&&
        Math.floor(Date.parse(original.first_dispatch_at)/1000)===binding.firstDispatchAt);
    };
    const read=async()=>inspectServerPaymentIntent(c,await args.contextEvidence(),
      await args.stripe.paymentIntents.retrieve(binding.paymentIntentId,providerOptions),binding,now());
    await source();let pi=await read();
    const terminal=async()=>{
      const proof=await inspectServerPaymentTerminal(dependencies,pi);
      // Ensure the original terminal state still matches after paginated reads.
      const again=await read();check(isDeepStrictEqual(again,pi));await source();
      const saved=await rpc("record_server_payment_terminal_v1",{p_proof:proof});
      check(saved&&isDeepStrictEqual({...saved,observedAt:proof.observedAt},proof)&&Number.isSafeInteger(saved.observedAt)&&saved.observedAt<=proof.observedAt);
      return {status:"intent_canceled_unreleased" as const,releaseAllowed:false as const,proof};
    };
    if(pi.status==="canceled")return await terminal();
    if(!["requires_payment_method","requires_confirmation","requires_action"].includes(pi.status))
      return {status:"reconciliation_required" as const,releaseAllowed:false as const};
    const claim=await rpc("claim_server_payment_cancellation_v1");
    check(claim&&["dispatch","busy","terminal","reconciliation_required"].includes(claim.status));
    if(claim.status!=="dispatch")return {status:claim.status==="busy"?"busy" as const:"reconciliation_required" as const,releaseAllowed:false as const};
    const op=claim.operation;assertAgreementId(op?.lease_token);
    const request={apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/payment_intents/${binding.paymentIntentId}/cancel`,
      params:{cancellation_reason:"requested_by_customer" as const}};
    check(op.attempt_id===c.attemptId&&op.payment_intent_id===binding.paymentIntentId&&isDeepStrictEqual(op.request,request)&&
      typeof op.idempotency_key==="string"&&/^cn-server-intent-cancel-v1:[0-9a-f-]{36}$/.test(op.idempotency_key));
    const first=Date.parse(op.first_dispatch_at),deadline=Date.parse(op.dispatch_before);
    const inWindow=()=>check(Number.isFinite(first)&&first<=now()*1000+1000&&Number.isFinite(deadline)&&
      deadline>now()*1000&&deadline<=now()*1000+31000&&deadline<=first+23*3600000);
    await source();pi=await read();
    if(pi.status==="canceled")return await terminal();
    if(!["requires_payment_method","requires_confirmation","requires_action"].includes(pi.status))
      return {status:"reconciliation_required" as const,releaseAllowed:false as const};
    const allowed=await rpc("assert_server_payment_cancellation_v1",{p_lease_token:op.lease_token});
    check(isDeepStrictEqual(allowed,op));enabled();inWindow();
    try{await args.stripe.paymentIntents.cancel(pi.id,request.params,{...providerOptions,idempotencyKey:op.idempotency_key});}
    catch{/* Original terminal read resolves races/lost responses; never rotate key. */}
    pi=await read();
    return pi.status==="canceled"?await terminal():{status:"reconciliation_required" as const,releaseAllowed:false as const};
  }catch{throw Error("Original manual payment stop requires review");}
}
