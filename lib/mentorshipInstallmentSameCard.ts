import "server-only";
import {isDeepStrictEqual} from "node:util";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {readBuyerMentorshipAdmittedPayment} from "./mentorshipInstallmentReconciliation";
import {verifyBuyerMentorshipContinuationProvider} from "./mentorshipInstallmentContinuationProvider";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer same-card continuation requires review");}

/** Receipt-backed release of this original payment's own recovery hold only.
 * It neither extends card consent nor issues any provider write. */
export async function resumeBuyerMentorshipSameCard(args:{buyerId:string;requestId:string;invoiceId:string;env?:Record<string,string|undefined>}) {
  const env=args.env??process.env;
  check(["SAME_CARD_SCHEMA_READY","SAME_CARD_RECOVERY_READY","INVOICE_CARD_SCHEMA_READY"]
    .every(k=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`]==="true"));
  const original=await readBuyerMentorshipAdmittedPayment(args);
  const {r,a,context,admin,runtime,paymentMethodId,defaultPaymentMethodId,cardAuthorizationId}=original;
  const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_invoice_id:a.invoiceId};
  const release=async(basis:unknown)=>{
    validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
    const saved=await admin.rpc("release_buyer_mentorship_same_card_v1",{...scope,p_basis:basis});
    check(!saved.error && saved.data?.status==="collection_resumed" && saved.data.reservationId===r.id && saved.data.invoiceId===a.invoiceId);
    return "collection_resumed" as const;
  };
  const previous=await admin.from("buyer_mentorship_same_card_releases_v1").select("reservation_id,payment_number,verified_basis")
    .eq("reservation_id",r.id).eq("payment_number",a.paymentNumber).maybeSingle();
  check(!previous.error);
  if(previous.data) {
    check(previous.data.reservation_id===r.id && previous.data.payment_number===a.paymentNumber &&
      previous.data.verified_basis?.invoiceId===a.invoiceId);
    // SQL allows acknowledgment of only the exact completed transition. A new
    // hold, revision or debit/financial stop rejects this read-only replay.
    return release(previous.data.verified_basis);
  }
  const read=async()=>{
    const result=await admin.rpc("read_buyer_mentorship_same_card_context_v1",scope);
    check(!result.error && result.data?.reservationId===r.id && ["held","not_held","complete"].includes(result.data.status));
    if(result.data.status==="held")check(result.data.invoiceId===a.invoiceId && result.data.afterPaymentNumber===a.paymentNumber &&
      result.data.paymentMethodId===paymentMethodId && result.data.originalDefaultPaymentMethodId===defaultPaymentMethodId &&
      result.data.cardAuthorizationId===cardAuthorizationId && Array.isArray(result.data.prior));
    return result.data;
  };
  const basis=await read();
  if(basis.status==="not_held")return "not_requested" as const;
  if(basis.status==="complete")return "complete" as const;
  check(env.CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RELEASE_READY==="true");
  const verifySubscription=await verifyBuyerMentorshipContinuationProvider(args,original,basis);
  await verifySubscription();
  validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
  check(isDeepStrictEqual(await read(),basis));
  return release(basis);
}
