import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime,assertFreshExactRuntimeContextObservation} from "./installments/contextRuntime";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original product checkout requires reconciliation");};
// Server-only full row preserves stop markers across gate rollback while still
// reading schemas that predate the marker. Never return this row to the browser.
const columns="*";

/** Shared independent-session check for recovery and original stop observation. */
export function assertOriginalProductCheckoutSession(session:Stripe.Checkout.Session,params:Stripe.Checkout.SessionCreateParams,live:boolean,id?:string){
  const amount=params.line_items?.[0]?.price_data?.unit_amount,currency=params.line_items?.[0]?.price_data?.currency;
  check(/^cs_[A-Za-z0-9_]+$/.test(session.id)&&(!id||session.id===id)&&session.mode==="payment"&&
    session.livemode===live&&session.amount_total===amount&&session.amount_subtotal===amount&&
    session.currency===currency&&isDeepStrictEqual(session.metadata,params.metadata)&&isDeepStrictEqual(session.payment_method_types,["card"])&&
    session.total_details?.amount_discount===0&&session.total_details?.amount_shipping===0&&session.total_details?.amount_tax===0);
  // Honor the saved request without upgrading historical uncertain operations.
  // New requests that require an address must retain that provider setting.
  if (params.billing_address_collection === "required") check(session.billing_address_collection === "required");
  return session;
}

/** Internal composition of existing checkout attempts and exact-context reads.
 * Returns the independently retrieved original session, never payment/access or
 * release proof. A lost create reply retains SQL admission and the original key. */
export async function recoverProductCheckoutOriginalRequest(args:{buyerId:string;attemptId:string;attemptKey:string;
  candidate?:Stripe.Checkout.SessionCreateParams;env?:Record<string,string|undefined>}):Promise<Stripe.Checkout.Session>{
  const env=args.env??process.env;
  check(env.CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY==="true"&&env.CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY==="true");
  for(const id of [args.buyerId,args.attemptId,args.attemptKey])assertAgreementId(id);
  const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
  let observation=await runtime.observeContext();assertFreshExactRuntimeContextObservation(observation);
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const read=async()=>{
    const result=await admin.from("product_checkout_attempts").select(columns).eq("id",args.attemptId).eq("buyer_id",args.buyerId).eq("attempt_key",args.attemptKey).maybeSingle();
    const a=result.data;
    check(!result.error&&a&&a.id===args.attemptId&&a.buyer_id===args.buyerId&&a.attempt_key===args.attemptKey&&
      a.checkout_kind==="full"&&a.original_request_protocol==="product-checkout-original-v1"&&!a.original_stop_requested_at);
    return a;
  };
  const initial=await read();
  check(initial.original_request || args.candidate);
  const candidate=args.candidate && JSON.parse(JSON.stringify({apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:"/v1/checkout/sessions",params:args.candidate}));
  const original=initial.original_request??candidate;
  check(original.apiVersion===CONTEXT_CUSTOMER_API_VERSION&&original.method==="POST"&&original.path==="/v1/checkout/sessions");
  const params=original.params as Stripe.Checkout.SessionCreateParams;
  const metadata=params.metadata;
  check(params.mode==="payment"&&isDeepStrictEqual(params.payment_method_types,["card"])&&metadata&&
    metadata.buyer_id===args.buyerId&&metadata.creator_id===initial.creator_id&&metadata.product_id===initial.product_id&&
    metadata.order_id===initial.order_id&&metadata.checkout_attempt_key===args.attemptKey&&
    metadata.checkout_terms_fingerprint===initial.terms_fingerprint&&isDeepStrictEqual(params.payment_intent_data?.metadata,metadata));
  check(!initial.original_request||isDeepStrictEqual(initial.original_request_context,config.approvedContext));
  const item=params.line_items?.[0], amount=item?.price_data?.unit_amount, currency=item?.price_data?.currency;
  const destination=params.payment_intent_data?.transfer_data?.destination;
  check(params.line_items?.length===1&&item?.quantity===1&&Number.isSafeInteger(amount)&&Number(amount)>0&&currency==="usd"&&
    typeof destination==="string"&&/^acct_[A-Za-z0-9]+$/.test(destination));
  const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
  const inspect=(session:Stripe.Checkout.Session,id?:string)=>{
    return assertOriginalProductCheckoutSession(session,params,config.approvedContext.mode==="live",id);
  };
  const result=await admin.rpc("claim_product_checkout_original_request_v1",{p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,
    p_attempt_key:args.attemptKey,p_context:config.approvedContext,p_request:initial.original_request?null:original});
  const claim=result.data,a=claim?.attempt;
  check(!result.error&&a&&a.id===initial.id&&a.buyer_id===initial.buyer_id&&a.attempt_key===initial.attempt_key&&
    a.order_id===initial.order_id&&a.terms_fingerprint===initial.terms_fingerprint&&
    isDeepStrictEqual(a.original_request,original)&&isDeepStrictEqual(a.original_request_context,config.approvedContext));
  if(claim.status==="bound"){
    check(typeof a.stripe_checkout_session_id==="string");
    return inspect(await stripe.checkout.sessions.retrieve(a.stripe_checkout_session_id),a.stripe_checkout_session_id);
  }
  check(claim.status==="dispatch"&&claim.idempotency_key===`creatornet-product-checkout:${args.attemptKey}`);
  assertAgreementId(a.original_request_lease_token);
  const deadline=Date.parse(claim.dispatch_before),started=Date.parse(a.original_request_started_at);
  const inWindow=()=>check(Number.isFinite(deadline)&&Number.isFinite(started)&&started<=Date.now()&&deadline>Date.now()&&
    deadline<=Date.now()+35000&&deadline<=started+23*3600000);
  inWindow();
  const creator=await stripe.accounts.retrieve(destination);
  check(creator.id===destination&&creator.charges_enabled&&creator.payouts_enabled&&creator.capabilities?.transfers==="active");
  observation=await runtime.observeContext();assertFreshExactRuntimeContextObservation(observation);
  const fresh=await read();
  check(fresh.original_request_lease_token===a.original_request_lease_token&&fresh.stripe_checkout_session_id===null&&
    fresh.status==="creating"&&isDeepStrictEqual(fresh.original_request,original)&&isDeepStrictEqual(fresh.original_request_context,config.approvedContext));
  inWindow();assertFreshExactRuntimeContextObservation(observation);
  const created=await stripe.checkout.sessions.create(params,{idempotencyKey:claim.idempotency_key,maxNetworkRetries:0});
  const session=inspect(await stripe.checkout.sessions.retrieve(created.id),created.id);
  const bound=await admin.from("product_checkout_attempts").update({stripe_checkout_session_id:session.id,stripe_checkout_url:session.url,
    status:session.status==="complete"||session.payment_status==="paid"?"complete":"open",updated_at:new Date().toISOString()})
    .eq("id",args.attemptId).eq("buyer_id",args.buyerId).eq("attempt_key",args.attemptKey)
    .eq("original_request_lease_token",a.original_request_lease_token).is("stripe_checkout_session_id",null).select("id,stripe_checkout_session_id").maybeSingle();
  check(!bound.error&&bound.data?.id===args.attemptId&&bound.data.stripe_checkout_session_id===session.id);
  return session;
}
