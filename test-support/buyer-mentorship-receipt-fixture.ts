import type Stripe from "stripe";
import { buyerBootstrapFixture } from "./buyer-mentorship-bootstrap-fixture";
import { buyerMentorshipFirstPaymentRequest } from "../lib/mentorshipInstallmentCheckout";
import { mentorshipInstallmentQuote } from "../lib/mentorshipInstallmentQuote";
import {buyerMentorshipServerPaymentContract} from "../lib/mentorshipInstallmentCheckout";
import {serverPaymentCreateRequest} from "../lib/serverPaymentConfirmation";
export function buyerFirstCaptureFixture(serviceMonths = 10, anchorSeconds?: number) {
  const f = buyerBootstrapFixture(anchorSeconds);
  const t = f.reservation.terms;
  Object.assign(f.reservation, mentorshipInstallmentQuote({ buyerId: f.reservation.buyerId, postId: f.reservation.postId,
    paymentCount: t.paymentCount, firstPaymentFees: t.firstPaymentFeeSchedule, renewalFees: t.renewalFeeSchedule,
    product: { id: t.productId, creator_id: t.creatorId, title: t.title, description: t.description, type: "mentorship",
      amount_cents: t.amountCents, currency: t.currency, fixed_service_months: serviceMonths, installment_options: [t.paymentCount] } }));
  f.customer.metadata.terms_fingerprint = f.reservation.fingerprint;
  f.subscription.metadata.terms_fingerprint = f.reservation.fingerprint;
  const request = buyerMentorshipFirstPaymentRequest(f.reservation, f.context, f.dependencies);
  const session = { object: "checkout.session", id: "cs_test_owned", livemode: false, mode: "payment", status: "complete", payment_status: "paid",
    customer: f.customer.id, payment_intent: "pi_owned", currency: "usd", amount_total: 3333, amount_subtotal: 3333,
    automatic_tax: { enabled: false }, total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 },
    expires_at: request.params.expires_at, created: f.dependencies.anchorSeconds + 10,
    consent: { terms_of_service: "accepted" }, billing_address_collection: "required", metadata: request.params.metadata,
    customer_details: { address: { country: "US" } } } as unknown as Stripe.Checkout.Session;
  const paymentIntent = { object: "payment_intent", id: "pi_owned", livemode: false, customer: f.customer.id, latest_charge: "ch_owned",
    status: "succeeded", currency: "usd", amount: 3333, amount_received: 3333, amount_capturable: 0, capture_method: "automatic_async",
    setup_future_usage: "off_session", payment_method_types: ["card"], payment_method: "pm_owned", application_fee_amount: 527,
    transfer_data: { destination: f.reservation.destinationId }, metadata: request.params.metadata } as unknown as Stripe.PaymentIntent;
  const charge = { object: "charge", id: "ch_owned", livemode: false, customer: f.customer.id, payment_intent: "pi_owned",
    paid: true, captured: true, status: "succeeded", currency: "usd", amount: 3333, amount_captured: 3333, application_fee_amount: 527,
    payment_method_details: { type: "card" }, payment_method: "pm_owned", amount_refunded: 0, refunded: false, disputed: false,
    created: f.nowSeconds - 10, balance_transaction: "txn_owned", transfer: "tr_owned", billing_details: { address: { country: "US" } } } as unknown as Stripe.Charge;
  const balance = { object: "balance_transaction", id: "txn_owned", source: "ch_owned", type: "charge", currency: "usd", amount: 3333,
    fee: 127, net: 3206 } as unknown as Stripe.BalanceTransaction;
  const paymentMethod = { object: "payment_method", id: "pm_owned", livemode: false, type: "card", card: {}, customer: f.customer.id,
    billing_details: { address: { country: "US" } } } as unknown as Stripe.PaymentMethod;
  return { ...f, originalRequest: request, sessionId: session.id, firstDispatchAt: new Date((f.dependencies.anchorSeconds + 10) * 1000).toISOString(),
    data: { session, paymentIntent, charge, balance, paymentMethod, customer: f.customer, subscription: f.subscription } };
}

export function buyerManualFirstCaptureFixture(serviceMonths=10,anchorSeconds?:number){
  const f=buyerFirstCaptureFixture(serviceMonths,anchorSeconds),c=buyerMentorshipServerPaymentContract(f.reservation,f.context,f.dependencies);
  const request=serverPaymentCreateRequest(c,f.contextEvidence);
  const {session:unused,...data}=f.data;void unused;
  data.paymentIntent={...data.paymentIntent,...request.params,created:Math.floor(Date.parse(f.firstDispatchAt)/1000),
    confirmation_method:"manual",on_behalf_of:null,shipping:null,transfer_group:null,last_payment_error:null,next_action:null} as Stripe.PaymentIntent;
  return {...f,data,manual:{contract:c,paymentIntentId:data.paymentIntent.id,confirmationOperationId:f.reservation.requestId}};
}
