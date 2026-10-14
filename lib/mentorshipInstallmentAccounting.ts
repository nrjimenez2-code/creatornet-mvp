import "server-only";
import { createClient,type SupabaseClient } from "@supabase/supabase-js";
import { inspectBuyerMentorshipFirstPayment,assertBuyerFinancialInspectionReady } from "./mentorshipInstallmentReceipt";
import { exactContextServerConfig } from "./installments/contextServer";
import { createExactContextRuntime } from "./installments/contextRuntime";
import { validateExactPaymentContext } from "./installments/paymentContext";
import { assertAgreementId } from "./installments/agreementStore";

/** Internal first-credit composition. The PostgreSQL transaction creates the
 * receipt, purchase, existing ledger entry and creator credit together. Retry
 * never creates another provider payment. Collection and access remain gated
 * pending their independent integration and acceptance. */
export async function recordBuyerMentorshipFirstPayment(args: {
  buyerId: string; requestId: string; env?: Record<string, string | undefined>;
  expectedEvent?: { reservationId: string; customerId: string; livemode: boolean;
    object: "checkout.session" | "payment_intent" | "charge"; id: string };
}) {
  try {
    const env = args.env ?? process.env;
    if (env.CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_SCHEMA_READY !== "true" ||
      env.CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_READY !== "true") throw Error("disabled");
    assertAgreementId(args.buyerId); assertAgreementId(args.requestId);
    const proof = await inspectBuyerMentorshipFirstPayment({ buyerId:args.buyerId,requestId:args.requestId,env });
    if (proof.buyerId !== args.buyerId || proof.requestId !== args.requestId) throw Error("owner differs");
    if(proof.manualPayment&&env.CREATOR_SERVER_PAYMENT_RECEIPT_READY!=="true")throw Error("manual receipt disabled");
    if (args.expectedEvent) {
      const expected = args.expectedEvent;
      const observedId = expected.object === "checkout.session" ? proof.checkoutSessionId :
        expected.object === "payment_intent" ? proof.paymentIntentId : proof.chargeId;
      if (expected.reservationId !== proof.reservationId || expected.customerId !== proof.customerId ||
        expected.livemode !== (proof.context.mode === "live") || expected.id !== observedId) throw Error("event differs");
    }
    const config = exactContextServerConfig(env), observed = await createExactContextRuntime(config).observeContext();
    const context = validateExactPaymentContext(proof.context, observed.contextEvidence);
    const admin = createClient(config.configuredSupabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const result = await admin.rpc("record_buyer_mentorship_first_receipt_v1", {
      p_request_id: args.requestId, p_buyer_id: args.buyerId, p_context: context, p_proof: proof,
    });
    if (result.error || result.data?.reservationId !== proof.reservationId || typeof result.data?.recorded !== "boolean") throw Error("invalid reply");
    assertAgreementId(result.data.purchaseId); assertAgreementId(result.data.ledgerId);
    return { recorded: result.data.recorded as boolean, reservationId: proof.reservationId,
      purchaseId: result.data.purchaseId as string, ledgerId: result.data.ledgerId as string };
  } catch { throw Error("Buyer installment receipt accounting requires review"); }
}

type Reservation=NonNullable<Awaited<ReturnType<typeof import("./mentorshipInstallmentReservation").readBuyerMentorshipBootstrapReservation>>>;
/** Resolve the existing original admission or first Checkout for financial
 * recovery. Never prepares, pays or records a receipt. */
export async function inspectBuyerMentorshipUncreditedCapture(args:{admin:SupabaseClient;reservation:Reservation;paymentIntentId:string;
  env:Record<string,string|undefined>;financialInspection:"refund"|"dispute"}) {
  const {admin,reservation:r,env,financialInspection}=args;
  assertBuyerFinancialInspectionReady(env,financialInspection);
  const admission=await admin.from("buyer_mentorship_payment_admissions_v1").select("reservation_id,invoice_id,payment_intent_id")
    .eq("reservation_id",r.id).eq("payment_intent_id",args.paymentIntentId).maybeSingle();
  financialCheck(!admission.error);
  if(admission.data) {
    financialCheck(admission.data.reservation_id===r.id && admission.data.payment_intent_id===args.paymentIntentId);
    const {inspectBuyerMentorshipAdmittedCapture}=await import("./mentorshipInstallmentReconciliation");
    const inspected=await inspectBuyerMentorshipAdmittedCapture({buyerId:r.buyerId,requestId:r.requestId,invoiceId:admission.data.invoice_id,env,financialInspection});
    return inspected.status==="captured"?{proof:inspected.proof,invoiceId:admission.data.invoice_id as string}:null;
  }
  return {proof:await inspectBuyerMentorshipFirstPayment({buyerId:r.buyerId,requestId:r.requestId,env,financialInspection}),invoiceId:null};
}

function financialCheck(v:unknown):asserts v {if(!v)throw Error("Buyer financial capture requires review");}
