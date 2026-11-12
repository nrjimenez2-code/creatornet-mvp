import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime,assertFreshExactRuntimeContextObservation} from "./installments/contextRuntime";
import {assertOriginalProductCheckoutSession} from "./productCheckoutOriginalRequest";
import {retireProductCheckoutSession} from "./productCheckoutExpiry";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original checkout stop requires reconciliation");};
export type ProductCheckoutStopProof={version:"product-unpaid-stop-v1";sessionId:string;checkoutStatus:"expired";paymentStatus:"unpaid";
 amountCents:number;currency:"usd";paymentIntent:{id:string;status:"canceled";amountReceived:0;amountCapturable:0}|null;observedAt:number};
export const PRODUCT_CHECKOUT_STOP_FLAGS=["CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY","CREATOR_PRODUCT_CHECKOUT_STOP_SCHEMA_READY",
 "CREATOR_PRODUCT_CHECKOUT_STOP_OPERATIONS_SCHEMA_READY","CREATOR_PRODUCT_CHECKOUT_STOP_READY","CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_SCHEMA_READY",
 "CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_READY","CREATOR_PRODUCT_CHECKOUT_RELEASE_SCHEMA_READY","CREATOR_PRODUCT_CHECKOUT_RELEASE_READY",
 "CREATOR_PRODUCT_CHECKOUT_STOP_UI_READY"] as const;

/** Internal only. Persists stop before expiry, retaining original request/key
 * after uncertainty. Separate proof/release gates require durable evidence and
 * atomic historical archive before the active purchase identity is released. */
export async function stopOriginalProductCheckout(args:{buyerId:string;attemptId:string;attemptKey:string;env?:Record<string,string|undefined>}){
 const env=args.env??process.env;
 check(["CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY","CREATOR_PRODUCT_CHECKOUT_STOP_SCHEMA_READY",
  "CREATOR_PRODUCT_CHECKOUT_STOP_OPERATIONS_SCHEMA_READY","CREATOR_PRODUCT_CHECKOUT_STOP_READY"].every(key=>env[key]==="true"));
 for(const value of [args.buyerId,args.attemptId,args.attemptKey])assertAgreementId(value);
 const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
 const observe=async()=>{const observation=await runtime.observeContext();assertFreshExactRuntimeContextObservation(observation);return observation;};
 await observe();
 const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
 const releaseReady=env.CREATOR_PRODUCT_CHECKOUT_RELEASE_READY==="true";
 if(releaseReady){
  check(["CREATOR_PRODUCT_CHECKOUT_RELEASE_SCHEMA_READY","CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_SCHEMA_READY",
   "CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_READY"].every(key=>env[key]==="true"));
  // Lost release replies recover the same immutable archive before touching any
  // newer active attempt. No catalog lookup or provider write is needed.
  const archived=await admin.from("product_checkout_releases_v1").select("*").eq("attempt_id",args.attemptId).eq("buyer_id",args.buyerId).eq("attempt_key",args.attemptKey).maybeSingle();
  check(!archived.error);
  const h=archived.data;
  if(h){
   check(h.attempt_id===args.attemptId&&h.buyer_id===args.buyerId&&h.attempt_key===args.attemptKey&&isDeepStrictEqual(h.context,config.approvedContext)&&
    h.original_attempt?.id===args.attemptId&&h.original_attempt.buyer_id===args.buyerId&&h.original_attempt.attempt_key===args.attemptKey&&
    h.original_attempt.product_id===h.product_id&&/^cs_[A-Za-z0-9_]+$/.test(h.original_attempt.stripe_checkout_session_id)&&
    typeof h.released_at==="string"&&Number.isFinite(Date.parse(h.released_at))&&Date.parse(h.released_at)<=Date.now()+5000);
   return {attemptId:args.attemptId,productId:h.product_id as string,sessionId:h.original_attempt.stripe_checkout_session_id as string,
    status:"released" as const,releasedAt:h.released_at as string,releaseAllowed:true as const};
  }
 }
 const read=async()=>{
  const result=await admin.from("product_checkout_attempts").select("*").eq("id",args.attemptId).eq("buyer_id",args.buyerId).eq("attempt_key",args.attemptKey).maybeSingle();
  const a=result.data;
  check(!result.error&&a&&a.id===args.attemptId&&a.buyer_id===args.buyerId&&a.attempt_key===args.attemptKey&&
   a.checkout_kind==="full"&&a.original_request_protocol==="product-checkout-original-v1"&&
   a.original_request?.apiVersion===CONTEXT_CUSTOMER_API_VERSION&&a.original_request.method==="POST"&&a.original_request.path==="/v1/checkout/sessions"&&
   isDeepStrictEqual(a.original_request_context,config.approvedContext)&&/^cs_[A-Za-z0-9_]+$/.test(a.stripe_checkout_session_id));
  const p=a.original_request.params;
  check(p?.mode==="payment"&&isDeepStrictEqual(p.payment_method_types,["card"])&&p.metadata?.buyer_id===args.buyerId&&p.metadata.order_id===a.order_id&&
   p.metadata.product_id===a.product_id&&p.metadata.creator_id===a.creator_id&&p.metadata.checkout_attempt_key===args.attemptKey&&
   p.metadata.checkout_terms_fingerprint===a.terms_fingerprint&&isDeepStrictEqual(p.payment_intent_data?.metadata,p.metadata));
  return a;
 };
 const initial=await read();
 const input={p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_attempt_key:args.attemptKey,p_context:config.approvedContext};
 const hold=await admin.rpc("request_product_checkout_stop_v1",input);
 check(!hold.error&&hold.data?.attempt_id===args.attemptId&&hold.data.release_allowed===false&&typeof hold.data.requested_at==="string");
 const stable=async()=>{
  const a=await read();check(a.original_stop_requested_at===hold.data.requested_at&&a.stripe_checkout_session_id===initial.stripe_checkout_session_id&&
   isDeepStrictEqual(a.original_request,initial.original_request));return a;
 };
 await stable();
 const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
 const readSession=async(id:string)=>{
  check(id===initial.stripe_checkout_session_id);await stable();await observe();
  return assertOriginalProductCheckoutSession(await stripe.checkout.sessions.retrieve(id),initial.original_request.params,config.approvedContext.mode==="live",id);
 };
 const expected=await readSession(initial.stripe_checkout_session_id);
 const guarded={checkout:{sessions:{retrieve:readSession,expire:async(id:string,params:unknown,options:{idempotencyKey?:string})=>{
  check(id===expected.id&&isDeepStrictEqual(params,{})&&options.idempotencyKey===`creatornet-product-checkout:${args.attemptKey}:expire`);
  await stable();await observe();
  const result=await admin.rpc("claim_product_checkout_stop_operation_v1",input),o=result.data?.operation;
  check(!result.error&&result.data?.status==="dispatch"&&o?.attempt_id===args.attemptId&&o.buyer_id===args.buyerId&&o.attempt_key===args.attemptKey&&
   isDeepStrictEqual(o.context,config.approvedContext)&&o.idempotency_key===options.idempotencyKey&&
   isDeepStrictEqual(o.request,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/checkout/sessions/${id}/expire`,params:{}}));
  assertAgreementId(o.lease_token);
  const deadline=Date.parse(result.data.dispatch_before),started=Date.parse(o.started_at);
  const inWindow=()=>check(Number.isFinite(deadline)&&Number.isFinite(started)&&started<=Date.now()&&deadline>Date.now()&&
   deadline<=Date.now()+35000&&deadline<=started+23*3600000);
  inWindow();await stable();const observation=await observe();
  const fresh=await admin.from("product_checkout_stop_operations_v1").select("*").eq("attempt_id",args.attemptId).maybeSingle();
  check(!fresh.error&&isDeepStrictEqual(fresh.data,o));inWindow();assertFreshExactRuntimeContextObservation(observation);
  return stripe.checkout.sessions.expire(id,o.request.params,{idempotencyKey:o.idempotency_key,maxNetworkRetries:0});
 }}},paymentIntents:stripe.paymentIntents} as unknown as Pick<Stripe,"checkout"|"paymentIntents">;
 const state=await retireProductCheckoutSession({stripe:guarded,session:expected,attemptKey:args.attemptKey});
 // Independent final observation covers lost expiry replies and any capture race.
 await stable();await observe();
 const terminal:{proof?:ProductCheckoutStopProof}={};
 const final=state==="expired"?await retireProductCheckoutSession({stripe:guarded,session:expected,attemptKey:args.attemptKey,
  onTerminalUnpaid:(session,intent)=>{
   check(Number.isSafeInteger(session.amount_total)&&Number(session.amount_total)>=50&&session.currency==="usd");
   terminal.proof={version:"product-unpaid-stop-v1",sessionId:session.id,checkoutStatus:"expired",paymentStatus:"unpaid",
    amountCents:session.amount_total!,currency:"usd",paymentIntent:intent?{id:intent.id,status:"canceled",amountReceived:0,amountCapturable:0}:null,
    observedAt:Math.floor(Date.now()/1000)};
  }}):state;
 if(final==="expired"&&env.CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_SCHEMA_READY==="true"&&env.CREATOR_PRODUCT_CHECKOUT_STOP_PROOF_READY==="true"){
  check(terminal.proof);await stable();await observe();
  const recorded=await admin.rpc("record_product_checkout_stop_proof_v1",{...input,p_proof:terminal.proof});
  const saved=recorded.data?.proof;
  check(!recorded.error&&recorded.data?.attempt_id===args.attemptId&&saved&&
   isDeepStrictEqual({...saved,observedAt:terminal.proof.observedAt},terminal.proof));
  if(releaseReady){
   await stable();await observe();
   const release=await admin.rpc("release_product_checkout_stop_v1",{...input,p_proof:terminal.proof}),h=release.data;
   check(!release.error&&h?.attempt_id===args.attemptId&&h.product_id===initial.product_id&&typeof h.released_at==="string"&&
    Number.isFinite(Date.parse(h.released_at))&&Date.parse(h.released_at)<=Date.now()+5000);
   return {attemptId:args.attemptId,productId:initial.product_id as string,sessionId:expected.id,status:"released" as const,
    releasedAt:h.released_at as string,releaseAllowed:true as const};
  }
 }
 return {attemptId:args.attemptId,sessionId:expected.id,status:final==="expired"?"terminal_unpaid" as const:"reconciliation_required" as const,releaseAllowed:false as const};
}
