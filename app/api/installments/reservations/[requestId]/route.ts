import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertAgreementId } from "@/lib/installments/agreementStore";
import { PAY_NOW_CONSENT_VERSION,FUTURE_CARD_CONSENT_VERSION } from "@/lib/installments/buyerRecoveryView";
import { exactContextServerConfig } from "@/lib/installments/contextServer";
import { createExactContextRuntime } from "@/lib/installments/contextRuntime";
import { readBuyerMentorshipInstallmentReservation } from "@/lib/mentorshipInstallmentReservation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status,
  headers: { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" } });

const abandonmentFlags=["ABANDONMENT_ACTIONS_READY","BOOTSTRAP_SCHEMA_READY","ABANDONMENT_SCHEMA_READY",
  "ABANDONMENT_REQUEST_READY","ABANDONMENT_OPERATIONS_SCHEMA_READY","ABANDONMENT_PROOF_SCHEMA_READY","ABANDONMENT_EXECUTOR_READY",
  "ABANDONMENT_RELEASE_SCHEMA_READY","ABANDONMENT_RELEASE_READY"];

/** Owned, read-only recovery. This endpoint cannot reserve, replace, publish or
 * collect anything. Remains readable when new installment offers are paused. */
export async function GET(req: NextRequest, route: { params: Promise<{ requestId: string }> }) {
  if (process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY !== "true")
    return json({ error: "Saved payment plans are not available." }, 409);
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: "Sign in to view your saved payment plan." }, 401);
    const { requestId } = await route.params;
    const management=req.nextUrl.searchParams.get("view")==="payments";
    try { assertAgreementId(requestId); if (req.nextUrl.searchParams.size && !(management && req.nextUrl.searchParams.size===1)) throw Error(); }
    catch { return json({ error: "Invalid saved payment plan request." }, 400); }
    if(management) {
      const {buyerMentorshipManagementEnabled,readBuyerMentorshipManagement}=await import("@/lib/mentorshipInstallmentManagement");
      if(!buyerMentorshipManagementEnabled(process.env))return json({error:"Payment management is not enabled."},409);
      const view=await readBuyerMentorshipManagement({buyerId:user.id,requestId});
      return view?json({view}):json({error:"Saved payment plan not found."},404);
    }
    const config = exactContextServerConfig();
    const observed = await createExactContextRuntime(config).observeContext();
    const admin = createClient(config.configuredSupabaseUrl, config.supabaseServiceKey,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const saved = await readBuyerMentorshipInstallmentReservation({ admin, buyerId: user.id, requestId,
      context: config.approvedContext, contextEvidence: observed.contextEvidence });
    const canAbandonUnpaid=Boolean(saved&&!saved.releasedAt&&[...abandonmentFlags,"ABANDONMENT_UI_READY",
      "UNPREPARED_RELEASE_SCHEMA_READY","UNPREPARED_RELEASE_READY"].every(flag=>process.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]==="true"));
    return saved ? json({...saved,canAbandonUnpaid}) : json({ error: "Saved payment plan not found." }, 404);
  } catch { return json({ error: "Your saved payment plan needs review before payment." }, 409); }
}

/** Authenticated owner actions for the existing purchase: debit revocation,
 * original-payment bank challenge, replacement-card review/pay and receipt check. Each action is gated;
 * no action waives the fixed balance or creates a replacement charge. */
export async function POST(req: NextRequest, route:{params:Promise<{requestId:string}>}) {
  if(process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY!=="true")
    return json({error:"Payment-plan management is not enabled."},409);
  try {
    const user=await getAuthenticatedUser(req);if(!user)return json({error:"Sign in to manage your payment plan."},401);
    const {requestId}=await route.params;
    let action:"abandon_unpaid"|"revoke_debit"|"bank_verification"|"check_payment"|"prepare_card"|"verify_card"|"open_card"|"review_retry"|"pay_retry",invoiceId:string|undefined,setupId:string|undefined,quoteId:string|undefined,futureCardOption:boolean|undefined,consent:unknown;
    try {
      assertAgreementId(requestId);if(req.nextUrl.searchParams.size)throw Error();
      const text=await req.text();if(text.length>1024)throw Error();const body=JSON.parse(text);
      if(!body || Array.isArray(body))throw Error();
      if(["revoke_debit","abandon_unpaid"].includes(body.action) && Object.keys(body).join(",")==="action")action=body.action;
      else if(["bank_verification","check_payment"].includes(body.action) && Object.keys(body).sort().join(",")==="action,invoiceId" &&
        typeof body.invoiceId==="string" && /^in_[A-Za-z0-9]+$/.test(body.invoiceId)){action=body.action;invoiceId=body.invoiceId;}
      else if(["prepare_card","verify_card","open_card"].includes(body.action) &&
        Object.keys(body).sort().join(",")===(body.action==="prepare_card"?"action,consent,invoiceId,setupId":"action,invoiceId,setupId") &&
        typeof body.invoiceId==="string" && /^in_[A-Za-z0-9]+$/.test(body.invoiceId) && typeof body.setupId==="string") {
        assertAgreementId(body.setupId);action=body.action;invoiceId=body.invoiceId;setupId=body.setupId;consent=body.consent;
        if(action==="prepare_card" && (!consent || typeof consent!=="object" || Array.isArray(consent) ||
          Object.keys(consent).sort().join(",")!=="accepted,consentVersion" ||
          (consent as {accepted?:unknown}).accepted!==true || (consent as {consentVersion?:unknown}).consentVersion!=="replacement-card-setup-v1"))throw Error();
      }
      else if(["review_retry","pay_retry"].includes(body.action) &&
        Object.keys(body).sort().join(",")===(body.action==="review_retry"?"action,futureCardOption,invoiceId,quoteId,setupId":"action,consent,invoiceId,quoteId,setupId") &&
        typeof body.invoiceId==="string" && /^in_[A-Za-z0-9]+$/.test(body.invoiceId) && typeof body.setupId==="string" && typeof body.quoteId==="string") {
        assertAgreementId(body.setupId);assertAgreementId(body.quoteId);
        action=body.action;invoiceId=body.invoiceId;setupId=body.setupId;quoteId=body.quoteId;
        if(action==="review_retry") {
          if(typeof body.futureCardOption!=="boolean")throw Error();futureCardOption=body.futureCardOption;
        } else {
          const c=body.consent;
          if(!c || typeof c!=="object" || Array.isArray(c) || c.accepted!==true || c.consentVersion!==PAY_NOW_CONSENT_VERSION ||
            !["accepted,consentVersion","accepted,consentVersion,futureCardConsentVersion"].includes(Object.keys(c).sort().join(",")) ||
            ("futureCardConsentVersion" in c && c.futureCardConsentVersion!==FUTURE_CARD_CONSENT_VERSION))throw Error();
          consent=c;
        }
      }
      else throw Error();
    } catch {return json({error:"Invalid payment-plan action."},400);}
    const retryAction=action==="review_retry" || action==="pay_retry";
    const flags=action==="abandon_unpaid"?abandonmentFlags:retryAction?["RETRY_ACTIONS_READY","RETRY_SCHEMA_READY","RETRY_READY","RETRY_RECEIPT_READY","RETRY_RECOVERY_SCHEMA_READY",
      "RECOVERY_SCHEMA_READY","RECOVERY_READY","LATER_RECEIPT_SCHEMA_READY","RECONCILIATION_READY"]:action==="revoke_debit"?["COLLECTION_CONTROLS_SCHEMA_READY","DEBIT_STOP_READY"]:
      ["prepare_card","verify_card","open_card"].includes(action)?["CARD_SETUP_SCHEMA_READY","CARD_SETUP_READY","RECOVERY_SCHEMA_READY","RECOVERY_READY",
        ...(action==="verify_card"?["SAVED_CARD_SCHEMA_READY","SAVED_CARD_READY"]:action==="open_card"?["CARD_SETUP_PUBLISH_READY"]:[])]:
      action==="bank_verification"?["BANK_SCHEMA_READY","BANK_READY","RECOVERY_SCHEMA_READY","RECOVERY_READY"]:["RECOVERY_SCHEMA_READY","RECOVERY_READY"];
    if(!flags.every(flag=>process.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]==="true"))return json({error:"Payment-plan management is not enabled."},409);
    const config=exactContextServerConfig();
    if(req.headers.get("origin")!==config.approvedContext.siteOrigin)return json({error:"Invalid request origin."},403);
    const observed=await createExactContextRuntime(config).observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const saved=await readBuyerMentorshipInstallmentReservation({admin,buyerId:user.id,requestId,
      context:config.approvedContext,contextEvidence:observed.contextEvidence});
    if(!saved)return json({error:"Saved payment plan not found."},404);
    if(action==="abandon_unpaid") {
      if(saved.releasedAt)return json({requestId,status:"released",releasedAt:saved.releasedAt,providerOperationsAllowed:false});
      const {releaseBuyerMentorshipUnpreparedSelection}=await import("@/lib/mentorshipInstallmentBootstrap");
      const {stopBuyerMentorshipUnpaidCheckout}=await import("@/lib/mentorshipInstallmentAbandonment");
      const args={buyerId:user.id,requestId};
      if(process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY==="true") {
        const unprepared=await releaseBuyerMentorshipUnpreparedSelection({ ...args,
          ...(process.env.CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY==="true" ? {includeNonpayablePreparation:true} : {}) });
        if(unprepared.status==="released")return json(unprepared);
      }
      const result=await stopBuyerMentorshipUnpaidCheckout({...args,requestStop:true});
      // Never expose internal provider proof or IDs through the buyer endpoint.
      return json(result.status==="released"?{requestId,status:"released",releasedAt:result.releasedAt,providerOperationsAllowed:false}:
        {requestId,status:"reconciliation_required",providerOperationsAllowed:false});
    }
    if(retryAction) {
      const {reviewBuyerMentorshipRetry,executeBuyerMentorshipRetry}=await import("@/lib/mentorshipInstallmentRetry");
      const args={buyerId:user.id,requestId,invoiceId:invoiceId!,setupId:setupId!,quoteId:quoteId!};
      return json(action==="review_retry"?await reviewBuyerMentorshipRetry({...args,futureCardOption}):
        await executeBuyerMentorshipRetry({...args,consent}));
    }
    if(action==="prepare_card" || action==="verify_card" || action==="open_card") {
      const {prepareBuyerMentorshipCardSetup,verifyBuyerMentorshipSavedCard,readBuyerMentorshipCardSetupRedirect}=await import("@/lib/mentorshipInstallmentCardSetup");
      const args={buyerId:user.id,requestId,invoiceId:invoiceId!,setupId:setupId!};
      if(action==="prepare_card") {
        const result=await prepareBuyerMentorshipCardSetup({...args,consent});
        return json({status:result.status,setupId:result.setupId});
      }
      return json(action==="verify_card"?await verifyBuyerMentorshipSavedCard(args):await readBuyerMentorshipCardSetupRedirect(args));
    }
    if(action!=="revoke_debit") {
      const {readBuyerMentorshipBankChallenge,recoverBuyerMentorshipPayment}=await import("@/lib/mentorshipInstallmentPaymentRecovery");
      const args={buyerId:user.id,requestId,invoiceId:invoiceId!};
      return json(action==="bank_verification"?await readBuyerMentorshipBankChallenge(args):await recoverBuyerMentorshipPayment(args));
    }
    const stopped=await admin.rpc("revoke_buyer_mentorship_debit_v1",{p_request_id:requestId,p_buyer_id:user.id,p_context:config.approvedContext});
    const result=stopped.data;
    if(stopped.error || !result || !["admitted_payment_pending","new_debits_stopped"].includes(result.status) ||
      !Array.isArray(result.pending) || result.pending.length>23 || !Number.isFinite(Date.parse(result.revokedAt)) ||
      (result.status==="admitted_payment_pending")!==(result.pending.length>0))throw Error("stop unresolved");
    assertAgreementId(result.reservationId);
    return json({requestId,status:result.status,revokedAt:result.revokedAt,pendingPayments:result.pending.length,
      message:result.pending.length?"New automatic payments are stopped. A payment already in progress still needs confirmation. Your agreed unpaid balance remains due.":
        "New automatic payments are stopped. Your agreed unpaid balance remains due."});
  } catch {return json({error:"Your payment-plan action needs confirmation. Retry this same saved payment plan or contact support@creatornet.net."},409);}
}
