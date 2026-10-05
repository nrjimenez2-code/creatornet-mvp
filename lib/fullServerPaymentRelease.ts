import "server-only";
import {createClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./installments/agreementStore";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime,assertFreshExactRuntimeContextObservation} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {stopFullServerPayment} from "./fullServerPayment";

const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original full manual release requires review");};

/** Release the owned original only after the shared cancellation engine reads
 * the canceled PI and its complete zero-money charge history. No fresh payment,
 * receipt, automatic mode selection or hold clearing is performed here. */
export async function releaseFullServerPayment(args:{buyerId:string;attemptId:string;attemptKey:string;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    if(env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_SCHEMA_READY!=="true")return {status:"not_enabled" as const};
    for(const value of [args.buyerId,args.attemptId,args.attemptKey])assertAgreementId(value);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),context=config.approvedContext;
    const observe=async()=>{
      const observation=await runtime.observeContext();assertFreshExactRuntimeContextObservation(observation);
      validateExactPaymentContext(context,observation.contextEvidence);return observation;
    };
    await observe();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const scope={p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_attempt_key:args.attemptKey,p_context:context};
    const result=(h:any)=>{
      check(h?.attempt_id===args.attemptId&&typeof h.product_id==="string");assertAgreementId(h.product_id);
      check(typeof h.released_at==="string"&&Number.isFinite(Date.parse(h.released_at))&&Date.parse(h.released_at)>0&&Date.parse(h.released_at)<=Date.now()+5000);
      return {status:"released" as const,attemptId:args.attemptId,productId:h.product_id as string,releasedAt:h.released_at as string,releaseAllowed:true as const};
    };
    // Read historical completion even when the mutation gate is rolled back.
    const archived=await admin.rpc("read_full_manual_release_v1",scope);check(!archived.error);
    if(archived.data)return result(archived.data);
    if(env.CREATOR_FULL_UNCLAIMED_RELEASE_READY==="true"){
      const unclaimed=await admin.rpc("release_unclaimed_full_payment_v1",scope);check(!unclaimed.error);
      if(unclaimed.data)return result(unclaimed.data);
    }
    if(env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_READY!=="true")return {status:"not_enabled" as const};
    const stopped=await stopFullServerPayment(args);
    if(stopped.status!=="intent_canceled_unreleased")return {status:"reconciliation_required" as const,releaseAllowed:false as const};
    const original=await admin.rpc("read_full_server_payment_contract_v1",{
      p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_context:context});
    const c=original.data;
    check(!original.error&&c?.attemptId===args.attemptId&&c.buyerId===args.buyerId&&c.kind==="full"&&
      c.sourceMetadata?.checkout_attempt_key===args.attemptKey&&Number.isSafeInteger(c.amountCents)&&c.amountCents>=50);
    validateExactPaymentContext(c.context,(await observe()).contextEvidence);
    const proof={version:"full-manual-payment-stop-v1",manualPayment:stopped.proof,amountCents:c.amountCents,currency:"usd",
      paymentIntent:{id:stopped.proof.paymentIntentId,status:"canceled",amountReceived:0,amountCapturable:0},observedAt:stopped.proof.observedAt};
    check(env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_READY==="true");
    const released=await admin.rpc("release_product_checkout_stop_v1",{...scope,p_proof:proof});check(!released.error);
    const release=result(released.data);check(release.productId===c.productId);
    return release;
  }catch{throw Error("Original full manual release requires review");}
}
