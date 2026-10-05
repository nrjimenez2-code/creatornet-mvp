import type Stripe from "stripe";
import { buyerBootstrapFixture } from "../test-support/buyer-mentorship-bootstrap-fixture";
import { buyerMentorshipFirstPaymentRequest } from "@/lib/mentorshipInstallmentCheckout";
import { inspectBuyerMentorshipFirstCapture, inspectBuyerMentorshipFirstPayment } from "@/lib/mentorshipInstallmentReceipt";
import { installmentMonthBoundary } from "@/lib/installments/checkoutPreparation";
import { mentorshipInstallmentQuote } from "@/lib/mentorshipInstallmentQuote";
import { fixedServiceEndAt } from "@/lib/fixedServiceTerms";

function capture(serviceMonths = 10) {
  const f = buyerBootstrapFixture();
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
test("verifies the original paid first installment and preserves independent service duration", () => {
  const args = capture(), before = JSON.stringify(args), proof = inspectBuyerMentorshipFirstCapture(args);
  expect(proof.amountCents).toBe(3333); expect(proof.fees.totalCreatorDeductionCents).toBe(527);
  expect(proof.fees.creatorNetCents).toBe(2806); expect(proof.actualStripeFeeCents).toBe(127);
  expect(proof.paymentNumber).toBe(1); expect(proof.transferId).toBe("tr_owned");
  expect(proof.serviceEndsAt).toBe(installmentMonthBoundary(args.data.charge.created, 10));
  expect(proof.nextPaymentAt).toBe(installmentMonthBoundary(args.data.charge.created, 1));
  expect(proof).not.toHaveProperty("access_granted"); expect(proof).not.toHaveProperty("url");
  expect(JSON.stringify(args)).toBe(before);
});
test.each(["unpaid redirect", "missing consent", "foreign session", "foreign intent", "foreign charge", "foreign customer", "foreign card",
  "wrong amount", "wrong fee", "wrong destination", "uncaptured", "missing balance", "foreign balance", "bad net", "missing transfer",
  "refunded", "disputed", "card not saved", "changed request", "changed context", "missing hold", "wrong product"])("rejects %s before any receipt proof", issue => {
  const a = capture(), d = a.data;
  if (issue === "unpaid redirect") d.session.payment_status = "unpaid";
  if (issue === "missing consent") d.session.consent = null;
  if (issue === "foreign session") d.session.id = "cs_test_other";
  if (issue === "foreign intent") d.paymentIntent.id = "pi_other";
  if (issue === "foreign charge") d.charge.id = "ch_other";
  if (issue === "foreign customer") d.paymentIntent.customer = "cus_other";
  if (issue === "foreign card") d.charge.payment_method = "pm_other";
  if (issue === "wrong amount") d.paymentIntent.amount_received = 10001;
  if (issue === "wrong fee") d.charge.application_fee_amount = 400;
  if (issue === "wrong destination") d.paymentIntent.transfer_data!.destination = "acct_other";
  if (issue === "uncaptured") d.charge.captured = false;
  if (issue === "missing balance") d.charge.balance_transaction = null;
  if (issue === "foreign balance") d.balance.source = "ch_other";
  if (issue === "bad net") d.balance.net++;
  if (issue === "missing transfer") d.charge.transfer = undefined;
  if (issue === "refunded") d.charge.amount_refunded = 1;
  if (issue === "disputed") d.charge.disputed = true;
  if (issue === "card not saved") d.paymentMethod.customer = null;
  if (issue === "changed request") a.originalRequest.params.expires_at++;
  if (issue === "changed context") a.contextEvidence.observedPlatformAccountId = "acct_other";
  if (issue === "missing hold") d.subscription.pause_collection = null;
  if (issue === "wrong product") d.subscription.items.data[0].price.product = "prod_other";
  expect(() => inspectBuyerMentorshipFirstCapture(a)).toThrow();
});
test.each(["session", "charge", "card"])("non-US or unknown %s address cannot produce US eligibility evidence", field => {
  for (const country of ["CA", null, ""]) {
    const a = capture();
    const address = field === "session" ? a.data.session.customer_details!.address! :
      field === "charge" ? a.data.charge.billing_details.address! : a.data.paymentMethod.billing_details.address!;
    address.country = country;
    expect(() => inspectBuyerMentorshipFirstCapture(a)).toThrow();
  }
});
test("a later read preserves the captured date and original next-payment date", () => {
  const a = capture(), first = inspectBuyerMentorshipFirstCapture(a); a.nowSeconds += 2 * 86400;
  expect(inspectBuyerMentorshipFirstCapture(a)).toEqual(first);
});
test("service can exceed the installment engine's 24-payment limit", () => {
  const a = capture(36), proof = inspectBuyerMentorshipFirstCapture(a);
  expect(proof.serviceEndsAt).toBe(fixedServiceEndAt(a.data.charge.created, 36));
  expect(a.reservation.terms.paymentCount).toBe(3);
});
test("read-only inspection gate defaults off", async () => {
  const a = capture();
  await expect(inspectBuyerMentorshipFirstPayment({ buyerId: a.reservation.buyerId, requestId: a.reservation.requestId, env: {} }))
    .rejects.toThrow("requires review");
});

test("read-only refund inspection preserves original capture proof while clean credit rejects it",()=>{
  const a=capture(),original=inspectBuyerMentorshipFirstCapture(a);
  a.data.charge.amount_refunded=1000;
  expect(()=>inspectBuyerMentorshipFirstCapture(a)).toThrow();
  expect(inspectBuyerMentorshipFirstCapture({...a,financialInspection:"refund"})).toEqual(original);
  a.data.charge.amount_refunded=3333;a.data.charge.refunded=true;
  expect(inspectBuyerMentorshipFirstCapture({...a,financialInspection:"refund"})).toEqual(original);
  a.data.charge.disputed=true;
  expect(()=>inspectBuyerMentorshipFirstCapture({...a,financialInspection:"refund"})).toThrow();
});

test("read-only dispute inspection retains original capture while ordinary credit rejects dispute",()=>{
  const a=capture(),original=inspectBuyerMentorshipFirstCapture(a);a.data.charge.disputed=true;
  expect(()=>inspectBuyerMentorshipFirstCapture(a)).toThrow();
  expect(inspectBuyerMentorshipFirstCapture({...a,financialInspection:"dispute"})).toEqual(original);
  a.data.charge.amount_refunded=1000;
  expect(()=>inspectBuyerMentorshipFirstCapture({...a,financialInspection:"dispute"})).toThrow();
});
