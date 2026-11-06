import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import type {BuyerHeldInvoiceAuthorization} from "./installments/heldInvoice";
import {calculateInstallmentPlan} from "./installmentPlan";
function check(v:unknown):asserts v {if(!v)throw Error("Original buyer invoice card requires review");}

/** Read immutable claim-time card authority. Historical receipts remain readable
 * when new future-card actions are disabled; no latest-card lookup can replace
 * the card frozen on an existing invoice. */
export async function readBuyerMentorshipInvoiceCard(args:{admin:SupabaseClient;authorization:BuyerHeldInvoiceAuthorization;
  originalPaymentMethodId:string;env:Record<string,string|undefined>}) {
  const {admin,authorization:a,originalPaymentMethodId:original,env}=args;
  check(/^pm_[A-Za-z0-9]+$/.test(original));
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_INVOICE_CARD_SCHEMA_READY!=="true")
    return {paymentMethodId:original,defaultPaymentMethodId:original,cardAuthorizationId:null};
  const saved=await admin.from("buyer_mentorship_invoice_cards_v1").select("*")
    .eq("reservation_id",a.buyerReservationId).eq("payment_number",a.paymentNumber).maybeSingle();
  check(!saved.error && saved.data);const card=saved.data;
  check(card.reservation_id===a.buyerReservationId && card.payment_number===a.paymentNumber && card.invoice_id===a.invoiceId &&
    card.original_default_payment_method_id===original && /^pm_[A-Za-z0-9]+$/.test(card.payment_method_id));
  if(card.authorization_quote_id===null)check(card.payment_method_id===original);
  else {
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_SCHEMA_READY==="true");assertAgreementId(card.authorization_quote_id);
    const result=await admin.from("buyer_mentorship_future_card_authorizations_v1").select("*").eq("quote_id",card.authorization_quote_id).maybeSingle();
    check(!result.error && result.data);const f=result.data,basis=f.verified_basis;
    check(f.quote_id===card.authorization_quote_id && f.reservation_id===a.buyerReservationId &&
      Number.isSafeInteger(f.after_payment_number) && f.after_payment_number>=2 && f.after_payment_number<a.paymentNumber &&
      f.payment_method_id===card.payment_method_id && f.original_default_payment_method_id===original &&
      basis?.reservationId===f.reservation_id && basis.quoteId===f.quote_id && basis.afterPaymentNumber===f.after_payment_number &&
      basis.paymentMethodId===f.payment_method_id && basis.originalDefaultPaymentMethodId===original &&
      Array.isArray(f.remaining_periods) && isDeepStrictEqual(basis.remainingPayments,f.remaining_periods));
    const payment=calculateInstallmentPlan(a.totalCents,a.paymentCount,a.feeSchedule).payments[a.paymentNumber-1];
    const matches=f.remaining_periods.filter((p:{paymentNumber?:unknown})=>p.paymentNumber===a.paymentNumber);
    check(matches.length===1 && isDeepStrictEqual(matches[0],{paymentNumber:a.paymentNumber,amountCents:payment.amountCents,dueAt:a.periodStart,periodEnd:a.periodEnd}));
  }
  return {paymentMethodId:card.payment_method_id as string,defaultPaymentMethodId:original,cardAuthorizationId:card.authorization_quote_id as string|null};
}
