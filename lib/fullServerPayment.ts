import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext,type ExactPaymentContext} from "./installments/paymentContext";
import {calculateCreatorFees,creatorFeeMetadata,type ProcessingFeeSchedule} from "./money";
import {productCheckoutOrderMatches} from "./productCheckoutOrder";
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest,type ServerPaymentContract} from "./serverPaymentConfirmation";
import {prepareServerPaymentIntent} from "./serverPaymentIntent";
import {runServerPaymentConfirmation,getServerPaymentAuthentication} from "./serverPaymentConfirmationStore";
import {stopServerPaymentIntent} from "./serverPaymentStop";

const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original full payment requires review");};
type Selection={attempt_id:string;buyer_id:string;product_id:string;kind:string;protocol:string;context:ExactPaymentContext;created_at:string;
  source:{id:string;buyer_id:string;creator_id:string;product_id:string;post_id:string|null;attempt_key:string;order_id:string;
    terms_fingerprint:string;purchase_consent_id:string}};
type Consent={id:string;accepted_at:string;terms:{kind:string;version:string;buyerId:string;creatorId:string;productId:string;
  postId:string|null;amountCents:number;currency:string;serviceVersion?:string;serviceMonths?:number}};

/** Initial candidate only, derived from the already pinned selection, accepted
 * consent and original order. Never infers an old fee schedule from current env.
 * Durable recovery loads the saved contract instead of rebuilding this value. */
export function fullServerPaymentContract(args:{selection:Selection;consent:Consent;order:Record<string,unknown>;
  destinationId:string;processingFees:ProcessingFeeSchedule;context:ExactPaymentContext}):ServerPaymentContract{
  const {selection:s,consent,order}=args,a=s.source,t=consent.terms;
  for(const value of [s.attempt_id,s.buyer_id,s.product_id,a.id,a.creator_id,a.attempt_key,a.order_id,a.purchase_consent_id])assertAgreementId(value);
  if(a.post_id!==null)assertAgreementId(a.post_id);
  check(s.kind==="full"&&s.protocol===SERVER_PAYMENT_PROTOCOL&&isDeepStrictEqual(s.context,args.context)&&
    s.attempt_id===a.id&&s.buyer_id===a.buyer_id&&s.product_id===a.product_id&&consent.id===a.purchase_consent_id&&
    t.kind==="one_time"&&t.buyerId===a.buyer_id&&t.creatorId===a.creator_id&&t.productId===a.product_id&&t.postId===a.post_id&&
    t.currency==="usd"&&typeof t.version==="string"&&t.version.length>0&&t.version.length<=200&&
    Number.isSafeInteger(t.amountCents)&&t.amountCents>=50&&t.amountCents<=99999999);
  const fees=calculateCreatorFees(t.amountCents,args.processingFees);
  check(productCheckoutOrderMatches(order,{orderId:a.order_id,buyerId:a.buyer_id,creatorId:a.creator_id,postId:a.post_id,
    amountCents:t.amountCents,currency:"usd",fees})&&!order.stripe_checkout_session_id&&!order.stripe_payment_intent_id);
  const acceptedAt=Math.floor(Date.parse(consent.accepted_at)/1000),createdAt=Math.floor(Date.parse(s.created_at)/1000);
  check(Number.isSafeInteger(acceptedAt)&&acceptedAt>0&&Number.isSafeInteger(createdAt)&&createdAt>=acceptedAt);
  if(t.serviceMonths!==undefined)check(Number.isSafeInteger(t.serviceMonths)&&t.serviceMonths>0&&t.serviceVersion==="fixed-service-months-v1");
  return {protocol:SERVER_PAYMENT_PROTOCOL,attemptId:a.id,buyerId:a.buyer_id,creatorId:a.creator_id,productId:a.product_id,
    termsFingerprint:a.terms_fingerprint,context:args.context,kind:"full",customerId:null,destinationId:args.destinationId,
    amountCents:t.amountCents,processingFees:{...args.processingFees},acceptedAt,expiresAt:createdAt+86400,
    sourceMetadata:{...creatorFeeMetadata(fees),buyer_id:a.buyer_id,buyer_user_id:a.buyer_id,creator_id:a.creator_id,product_id:a.product_id,
      post_id:a.post_id??"",order_id:a.order_id,checkout_attempt_key:a.attempt_key,checkout_terms_fingerprint:a.terms_fingerprint,
      purchase_consent_id:consent.id,purchase_policy_version:t.version,...(t.serviceMonths!==undefined?{fixed_service_version:t.serviceVersion!}:{})}};
}
type Args={buyerId:string;attemptId:string;attemptKey:string;env?:Record<string,string|undefined>;
  expectedEvent?:{paymentIntentId:string;livemode:boolean}};
type Action=Parameters<typeof runServerPaymentConfirmation>[0]["action"];
export async function prepareFullServerPayment(args:Args&{initialProcessingFees?:ProcessingFeeSchedule}){return run(args);}
export async function confirmFullServerPayment(args:Args&{action:Action}){return run(args);}
export async function authenticateFullServerPayment(args:Args&{operationId:string}){assertAgreementId(args.operationId);return run({...args,authenticationOperationId:args.operationId});}
export async function stopFullServerPayment(args:Args){return run({...args,stop:true});}

/** Internal composition only. Selection/order/consent must already exist; this
 * never fabricates a missing order or replaces an unknown provider operation.
 * Initial routes and full receipt/release publication remain separately gated. */
async function run(args:Args&{initialProcessingFees?:ProcessingFeeSchedule;action?:Action;authenticationOperationId?:string;stop?:boolean}){
  try{
    const env=args.env??process.env;
    const initialProcessingFees=args.initialProcessingFees?{...args.initialProcessingFees}:undefined;
    if(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY!=="true"||env.CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY!=="true")return {status:"not_enabled" as const};
    for(const value of [args.buyerId,args.attemptId,args.attemptKey])assertAgreementId(value);
    const config=exactContextServerConfig(env),context=config.approvedContext,runtime=createExactContextRuntime(config);
    if(args.expectedEvent)check(/^pi_[A-Za-z0-9]+$/.test(args.expectedEvent.paymentIntentId)&&args.expectedEvent.livemode===(context.mode==="live"));
    const contextEvidence=async()=>{const e=(await runtime.observeContext()).contextEvidence;validateExactPaymentContext(context,e);return e;};
    await contextEvidence();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const scope={p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_context:context};
    const source=await admin.rpc("read_server_payment_source_v1",{...scope,p_for_dispatch:false});
    const s=source.data as Selection;
    check(!source.error&&s&&s.attempt_id===args.attemptId&&s.buyer_id===args.buyerId&&s.kind==="full"&&
      s.protocol===SERVER_PAYMENT_PROTOCOL&&s.source?.attempt_key===args.attemptKey&&isDeepStrictEqual(s.context,context));
    const readContract=async()=>{const result=await admin.rpc("read_full_server_payment_contract_v1",scope);check(!result.error);return result.data as ServerPaymentContract|null;};
    const build=async(processingFees:ProcessingFeeSchedule)=>{
      const [consent,order,destination]=await Promise.all([
        admin.from("product_purchase_consents_v1").select("id,terms,accepted_at").eq("id",s.source.purchase_consent_id).maybeSingle(),
        admin.from("orders").select("id,buyer_id,creator_id,post_id,amount_cents,gross_amount,platform_fee,processing_fee,total_creator_deduction,creator_amount,fee_schedule_version,status,currency,stripe_checkout_session_id,stripe_payment_intent_id")
          .eq("id",s.source.order_id).eq("buyer_id",args.buyerId).maybeSingle(),
        admin.from("profiles").select("id,stripe_account_id,stripe_onboarding_complete").eq("id",s.source.creator_id).maybeSingle()]);
      check(!consent.error&&consent.data&&!order.error&&order.data&&!destination.error&&destination.data?.id===s.source.creator_id&&destination.data.stripe_onboarding_complete);
      return fullServerPaymentContract({selection:s,consent:consent.data as Consent,order:order.data,
        destinationId:destination.data.stripe_account_id,processingFees,context});
    };
    let c=await readContract();
    const original=await admin.rpc("read_server_payment_intent_v1",scope);check(!original.error);
    if(args.expectedEvent)check(original.data?.bound_at&&original.data.payment_intent_id===args.expectedEvent.paymentIntentId);
    if(args.stop){
      check(env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY==="true");
      const stopped=await admin.rpc("request_server_payment_stop_v1",scope);
      check(!stopped.error&&stopped.data?.attemptId===args.attemptId&&stopped.data.releaseAllowed===false);
      if(!c||!original.data?.bound_at)return {status:"reconciliation_required" as const,releaseAllowed:false as const};
    }
    if(args.action||args.authenticationOperationId)check(c&&original.data?.bound_at);
    if(!c){
      check(!original.data);if(env.CREATOR_FULL_SERVER_PAYMENT_SOURCE_READY!=="true")return {status:"not_enabled" as const};
      check(initialProcessingFees);c=await build(initialProcessingFees);
      const saved=await admin.rpc("save_full_server_payment_contract_v1",{...scope,p_contract:c,p_request:serverPaymentCreateRequest(c,await contextEvidence())});
      check(!saved.error&&isDeepStrictEqual(saved.data,c));
    }
    check(c.protocol===SERVER_PAYMENT_PROTOCOL&&c.kind==="full"&&c.attemptId===args.attemptId&&c.buyerId===args.buyerId&&
      c.productId===s.product_id&&c.creatorId===s.source.creator_id&&c.termsFingerprint===s.source.terms_fingerprint&&
      c.sourceMetadata.order_id===s.source.order_id&&c.sourceMetadata.checkout_attempt_key===args.attemptKey&&isDeepStrictEqual(c.context,context));
    if(original.data)check(isDeepStrictEqual(original.data.contract,c));
    const contract=c,stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const assertProviderSource=async()=>{
      check(isDeepStrictEqual(await readContract(),contract)&&isDeepStrictEqual(await build(contract.processingFees),contract));
      const destination=await stripe.accounts.retrieve(contract.destinationId);
      check(destination.id===contract.destinationId&&destination.charges_enabled&&destination.payouts_enabled&&destination.capabilities?.transfers==="active");
      await contextEvidence();
    };
    const dependencies={contract,admin,stripe,env,contextEvidence,assertProviderSource};
    if(args.action||args.authenticationOperationId||args.stop){
      check(original.data?.bound_at&&/^pi_[A-Za-z0-9]+$/.test(original.data.payment_intent_id)&&Number.isFinite(Date.parse(original.data.first_dispatch_at)));
      const bound={...dependencies,binding:{paymentIntentId:original.data.payment_intent_id,firstDispatchAt:Math.floor(Date.parse(original.data.first_dispatch_at)/1000)}};
      if(args.stop)return await stopServerPaymentIntent(bound);
      if(args.authenticationOperationId)return await getServerPaymentAuthentication({...bound,operationId:args.authenticationOperationId});
      check(args.action);return await runServerPaymentConfirmation({...bound,action:args.action});
    }
    return await prepareServerPaymentIntent(dependencies);
  }catch{throw Error("Original full payment requires review");}
}
