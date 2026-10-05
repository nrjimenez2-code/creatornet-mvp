import type {NextRequest} from "next/server";
import {createClient} from "@supabase/supabase-js";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {assertAgreementId} from "@/lib/installments/agreementStore";
import {exactContextServerConfig} from "@/lib/installments/contextServer";
import {createExactContextRuntime,assertFreshExactRuntimeContextObservation} from "@/lib/installments/contextRuntime";
import {readFullManualCheckoutRequest,acceptSavedFullManualCheckout,releaseUnreservedFullManualCheckout} from "@/lib/fullManualCheckoutRequest";
import {prepareFullServerPayment,confirmFullServerPayment,authenticateFullServerPayment} from "@/lib/fullServerPayment";
import {releaseFullServerPayment} from "@/lib/fullServerPaymentRelease";
import {accountFullServerPayment} from "@/lib/fullServerPaymentReadback";
import {parseManualPaymentAction,type ManualPaymentAction} from "@/lib/manualPaymentAction";
import {manualPaymentAdmissionPaused,isManualPaymentRecoveryAction} from "@/lib/manualPaymentAdmission";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store",
  Vary:"Cookie, Authorization","Referrer-Policy":"no-referrer"}});
/** Every payable action resolves immutable server identities from the owner's
 * saved request. Neither body-supplied owner/intent/order nor fresh retries are
 * accepted. A success observation is reconciled before any paid projection. */
export async function POST(req:NextRequest,route:{params:Promise<{requestId:string}>}){
  try{
    const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to continue your payment."},401);
    if(process.env.CREATOR_FULL_MANUAL_CHECKOUT_REQUESTS_SCHEMA_READY!=="true"||process.env.CREATOR_FULL_MANUAL_CHECKOUT_ACTIONS_READY!=="true")
      return json({error:"Payment actions are not enabled."},409);
    const config=exactContextServerConfig();if(req.headers.get("origin")!==config.approvedContext.siteOrigin)return json({error:"Invalid request origin."},403);
    let requestId:string,action:ManualPaymentAction;
    try{
      requestId=(await route.params).requestId;assertAgreementId(requestId);
      if(req.nextUrl.searchParams.size||req.headers.get("content-type")?.split(";")[0].trim()!=="application/json")throw Error();
      const text=await req.text();if(text.length>2048)throw Error();action=parseManualPaymentAction(JSON.parse(text));
    }catch{return json({error:"Invalid original payment action."},400);}
    const admissionPaused=manualPaymentAdmissionPaused();
    if(admissionPaused&&!isManualPaymentRecoveryAction(action))return json({status:"admission_paused",
      error:"New payments are temporarily paused. You can still check or stop your original payment and complete bank verification.",
      canSwitchPaymentMode:false,accessGranted:false},409);
    const observation=await createExactContextRuntime(config).observeContext();assertFreshExactRuntimeContextObservation(observation);
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const scope={admin,buyerId:user.id,requestId,context:config.approvedContext,contextEvidence:observation.contextEvidence};
    const saved=await readFullManualCheckoutRequest(scope);if(!saved)return json({error:"Original payment request not found."},404);
    const original={buyerId:user.id,attemptId:saved.attemptId,attemptKey:saved.attemptKey};
    if(saved.releasedAt)return json({requestId,status:"released",releasedAt:saved.releasedAt,canSwitchPaymentMode:true,accessGranted:false},action.kind==="stop"?200:409);
    if(action.kind==="stop"){
      const unreserved=await releaseUnreservedFullManualCheckout(scope);
      if(unreserved)return json({requestId,status:"released",releasedAt:unreserved.releasedAt,canSwitchPaymentMode:true,accessGranted:false});
      const result=await releaseFullServerPayment(original);
      return result.status==="released"?json({requestId,status:"released",releasedAt:result.releasedAt,canSwitchPaymentMode:true,accessGranted:false}):
        json({requestId,status:"reconciliation_required",canSwitchPaymentMode:false,accessGranted:false},409);
    }
    if(action.kind==="prepare"){
      await acceptSavedFullManualCheckout({...scope,origin:req.headers.get("origin")});
      const result=await prepareFullServerPayment(original);
      return result.status==="bound_unpublished"?json({requestId,status:"payment_prepared",amountCents:saved.terms.amountCents,
        currency:"usd",canSwitchPaymentMode:false,accessGranted:false}):json({requestId,status:"reconciliation_required",canSwitchPaymentMode:false,accessGranted:false},409);
    }
    if(action.kind==="authenticate"){
      if(process.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY!=="true")return json({error:"Bank verification is not enabled."},409);
      const result=await authenticateFullServerPayment({...original,operationId:action.operationId});
      if(result.status!=="authentication_required"||result.operationId!==action.operationId)throw Error();
      return json({requestId,status:result.status,operationId:result.operationId,paymentIntentId:result.paymentIntentId,clientSecret:result.clientSecret});
    }
    const result=await confirmFullServerPayment({...original,action});
    if(result.status==="busy")return json({requestId,status:"busy",canSwitchPaymentMode:false,accessGranted:false});
    if(result.status!=="observed")throw Error();
    if(result.observation.status==="succeeded"){
      const accounted=await accountFullServerPayment(original);
      if(accounted.status!=="original_capture_accounted")throw Error();
      // The accounting engine retains any financial/access hold. The client
      // reads entitlement through its existing access path, never this reply.
      return json({requestId,status:"payment_accounted",purchaseId:accounted.purchaseId,canSwitchPaymentMode:false});
    }
    return json({requestId,status:"payment_observed",operationId:result.operationId,paymentStatus:result.observation.status,
      replacementAllowed:!admissionPaused&&result.observation.status==="requires_payment_method"&&Boolean(result.observation.failure),canSwitchPaymentMode:false,accessGranted:false});
  }catch{return json({error:"Your original payment needs reconciliation. Keep its request and token; do not start another payment."},409);}
}
