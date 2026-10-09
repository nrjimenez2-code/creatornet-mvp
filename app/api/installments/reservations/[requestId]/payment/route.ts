import type {NextRequest} from "next/server";
import {createClient} from "@supabase/supabase-js";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {assertAgreementId} from "@/lib/installments/agreementStore";
import {exactContextServerConfig} from "@/lib/installments/contextServer";
import {createExactContextRuntime,assertFreshExactRuntimeContextObservation} from "@/lib/installments/contextRuntime";
import {readBuyerMentorshipInstallmentReservation} from "@/lib/mentorshipInstallmentReservation";
import {prepareBuyerMentorshipServerPayment,confirmBuyerMentorshipServerPayment,authenticateBuyerMentorshipServerPayment} from "@/lib/mentorshipServerPayment";
import {recordBuyerMentorshipFirstPayment} from "@/lib/mentorshipInstallmentAccounting";
import {activateBuyerMentorship} from "@/lib/mentorshipInstallmentActivationRuntime";
import {releaseBuyerMentorshipUnpreparedSelection} from "@/lib/mentorshipInstallmentBootstrap";
import {stopBuyerMentorshipUnpaidCheckout} from "@/lib/mentorshipInstallmentAbandonment";
import {parseManualPaymentAction,type ManualPaymentAction} from "@/lib/manualPaymentAction";
import {manualPaymentAdmissionPaused,isManualPaymentRecoveryAction} from "@/lib/manualPaymentAdmission";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store",
  Vary:"Cookie, Authorization","Referrer-Policy":"no-referrer"}});

/** Initial manual installment actions on the original accepted reservation.
 * Initial capture uses the existing immutable first receipt/accounting and
 * activation engines. No later invoice is prepared or paid by this endpoint. */
export async function POST(req:NextRequest,route:{params:Promise<{requestId:string}>}){
  try{
    const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to continue your payment plan."},401);
    if(process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY!=="true"||
      process.env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_ACTIONS_READY!=="true")return json({error:"Payment-plan actions are not enabled."},409);
    const config=exactContextServerConfig();if(req.headers.get("origin")!==config.approvedContext.siteOrigin)return json({error:"Invalid request origin."},403);
    let requestId:string,action:ManualPaymentAction;
    try{
      requestId=(await route.params).requestId;assertAgreementId(requestId);
      if(req.nextUrl.searchParams.size||req.headers.get("content-type")?.split(";")[0].trim()!=="application/json")throw Error();
      const text=await req.text();if(text.length>2048)throw Error();action=parseManualPaymentAction(JSON.parse(text));
    }catch{return json({error:"Invalid original payment-plan action."},400);}
    const admissionPaused=manualPaymentAdmissionPaused();
    if(admissionPaused&&!isManualPaymentRecoveryAction(action))return json({status:"admission_paused",
      error:"New payments are temporarily paused. You can still check or stop your original payment and complete bank verification.",
      canSwitchPaymentMode:false,accessGranted:false},409);
    const observed=await createExactContextRuntime(config).observeContext();assertFreshExactRuntimeContextObservation(observed);
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const saved=await readBuyerMentorshipInstallmentReservation({admin,buyerId:user.id,requestId,
      context:config.approvedContext,contextEvidence:observed.contextEvidence});
    if(!saved)return json({error:"Original payment plan not found."},404);
    const original={buyerId:user.id,requestId};
    const released=(releasedAt:string)=>json({requestId,status:"released",releasedAt,canSwitchPaymentMode:true,accessGranted:false});
    // Read the owner's immutable release before any provider work. The existing
    // reservation reader validates the released timestamp and owner/context.
    if(saved.releasedAt)return action.kind==="stop"?released(saved.releasedAt):
      json({requestId,status:"released",releasedAt:saved.releasedAt,canSwitchPaymentMode:true,accessGranted:false},409);
    if(action.kind==="stop"){
      if(process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY==="true"){
        const result=await releaseBuyerMentorshipUnpreparedSelection({...original,
          ...(process.env.CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY==="true"?{includeNonpayablePreparation:true}:{})});
        if(result.status==="released")return released(result.releasedAt);
      }
      const result=await stopBuyerMentorshipUnpaidCheckout({...original,requestStop:true});
      return result.status==="released"?released(result.releasedAt):
        json({requestId,status:"reconciliation_required",canSwitchPaymentMode:false,accessGranted:false},409);
    }
    if(action.kind==="prepare"){
      const result=await prepareBuyerMentorshipServerPayment(original);
      const first=saved.terms.payments[0];
      if(result.status!=="bound_unpublished"||first?.number!==1||!Number.isSafeInteger(first.amountCents)||first.amountCents<50)
        return json({requestId,status:"reconciliation_required",canSwitchPaymentMode:false,accessGranted:false},409);
      return json({requestId,status:"payment_prepared",amountCents:first.amountCents,currency:"usd",canSwitchPaymentMode:false,accessGranted:false});
    }
    if(action.kind==="authenticate"){
      if(process.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY!=="true")return json({error:"Bank verification is not enabled."},409);
      const result=await authenticateBuyerMentorshipServerPayment({...original,operationId:action.operationId});
      if(result.status!=="authentication_required"||result.operationId!==action.operationId)throw Error();
      return json({requestId,status:result.status,operationId:result.operationId,paymentIntentId:result.paymentIntentId,clientSecret:result.clientSecret});
    }
    const result=await confirmBuyerMentorshipServerPayment({...original,action});
    if(result.status==="busy")return json({requestId,status:"busy",canSwitchPaymentMode:false,accessGranted:false});
    if(result.status!=="observed")throw Error();
    if(result.observation.status==="succeeded"){
      const accounted=await recordBuyerMentorshipFirstPayment(original);
      let activationStatus="pending";
      if(process.env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY==="true"){
        const activation=await activateBuyerMentorship(original);
        if(activation.status!=="activated_held"&&activation.status!=="collection_enabled")throw Error();
        activationStatus=activation.status;
      }
      return json({requestId,status:"payment_accounted",purchaseId:accounted.purchaseId,activationStatus,canSwitchPaymentMode:false});
    }
    return json({requestId,status:"payment_observed",operationId:result.operationId,paymentStatus:result.observation.status,
      replacementAllowed:!admissionPaused&&result.observation.status==="requires_payment_method"&&Boolean(result.observation.failure),canSwitchPaymentMode:false,accessGranted:false});
  }catch{return json({error:"Your original payment plan needs reconciliation. Keep its request and token; do not start another payment."},409);}
}
