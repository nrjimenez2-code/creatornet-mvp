import "server-only";
import Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {parseExactFutureCardQuote} from "./installments/paymentRetryStore";
import {PAY_NOW_CONSENT_VERSION} from "./installments/buyerRecoveryView";
import {verifyRenewalProviderHistory} from "./installments/renewal";
import {calculateInstallmentPlan} from "./installmentPlan";
import {readBuyerMentorshipAdmittedPayment,inspectBuyerMentorshipAdmittedCapture} from "./mentorshipInstallmentReconciliation";
import {readBuyerMentorshipActivationDependencies} from "./mentorshipInstallmentActivationRuntime";
import {inspectBuyerMentorshipActivationSubscription} from "./mentorshipInstallmentActivation";
import type {ExactPaymentContext} from "./installments/paymentContext";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer continuation requires review");}
type Basis={paymentMethodId:string;remainingPayments:unknown;
  prior:ReadonlyArray<{paymentNumber:number;paymentIntentId:string}>;
  firstProof:{reservationId:string;paymentMethodId:string;customerId:string;subscriptionId:string;
    termsFingerprint:string;context:ExactPaymentContext;paidAt:number}};

/** Shared read-only provider proof for either previously authorized same-card
 * continuation or separately consented replacement-card continuation. No money
 * or subscription mutation. Each caller rechecks its own SQL authority. */
export async function verifyBuyerMentorshipContinuationProvider(
  args:Parameters<typeof inspectBuyerMentorshipAdmittedCapture>[0],
  original:Awaited<ReturnType<typeof readBuyerMentorshipAdmittedPayment>>,basis:Basis,
) {
  const {r,a,paymentIntentId,defaultPaymentMethodId,admin,config,context,contract}=original;
    // Reuse exact amount/calendar parsing; SQL binds this schedule to the
    // separately accepted immutable quote and the unclaimed remaining periods.
    const schedule=parseExactFutureCardQuote({future_card_option:true,future_card_periods:basis.remainingPayments,confirmed_at:null},a,PAY_NOW_CONSENT_VERSION);
    check(schedule.remainingPayments && schedule.remainingPayments[0].dueAt>Date.now()/1000);
    const captured=await inspectBuyerMentorshipAdmittedCapture(args);
    check(captured.status==="captured" && captured.proof.paymentIntentId===paymentIntentId &&
      captured.proof.paymentMethodId===basis.paymentMethodId && captured.proof.invoiceId===a.invoiceId);
    const first=basis.firstProof;
    check(first?.reservationId===r.id && first.paymentMethodId===defaultPaymentMethodId && first.customerId===a.customerId &&
      first.subscriptionId===a.subscriptionId && first.termsFingerprint===r.fingerprint && isDeepStrictEqual(first.context,context));
    const deps=await readBuyerMentorshipActivationDependencies(admin,r.id,first);
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const sub=async()=>{
      const subscription=await stripe.subscriptions.retrieve(a.subscriptionId);
      const state=inspectBuyerMentorshipActivationSubscription({reservation:r,context,dependencies:deps,paidAt:first.paidAt,
        paymentMethodId:defaultPaymentMethodId,subscription,nowSeconds:Math.floor(Date.now()/1000),allowActivated:true});
      check(state.activated && state.itemId===a.subscriptionItemId && state.cancelAt===a.cancelAt && subscription.status==="active");
    };
    await sub();
    const plan=calculateInstallmentPlan(r.terms.amountCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule);
    await verifyRenewalProviderHistory(stripe,{paymentMethodId:basis.paymentMethodId,defaultPaymentMethodId,
      customerId:a.customerId,destinationId:a.destinationId,paymentNumber:a.paymentNumber+1},basis.prior,plan.payments,contract.expectedLiveMode);
    const card=await stripe.paymentMethods.retrieve(basis.paymentMethodId);
    check(card.id===basis.paymentMethodId && card.object==="payment_method" && card.type==="card" && card.customer===a.customerId &&
      card.livemode===contract.expectedLiveMode && card.billing_details.address?.country==="US");
  return sub;
}
