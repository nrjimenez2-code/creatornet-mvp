import type Stripe from "stripe";
import { buildExactInstallmentCheckoutContract, buildFixedTotalCheckoutPayload, type ExactCheckoutContractInput } from "../lib/installments/checkoutContract";
import { FIXED_PURCHASE_CONSENT_TEXT, FIXED_PURCHASE_CONSENT_VERSION } from "../lib/installments/purchaseConsent";
import { HELD_INSTALLMENT_VERSION } from "../lib/installments/heldInvoice";
import { calculateInstallmentPlan } from "../lib/installmentPlan";

const input: ExactCheckoutContractInput = {
  planId: "plan_test", bookingPaymentId: "bp_test", bookingId: "bk_test", postId: "post_test",
  productId: "product_test", buyerId: "buyer_test", creatorId: "creator_test",
  destinationId: "acct_test", customerId: "cus_test", subscriptionId: "sub_test",
  totalCents: 199900, paymentCount: 3, title: "Synthetic mentorship",
  previewOrigin: "https://creatornet-test.vercel.app",
  firstPaymentFeeSchedule: { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-card" },
  renewalFeeSchedule: { enabled: true, basisPoints: 360, fixedCents: 30, version: "synthetic-billing" },
};

function subscription() {
  return {
    id: "sub_test", livemode: false, customer: "cus_test", status: "trialing",
    application_fee_percent: null, transfer_data: { destination: "acct_test", amount_percent: null },
    pause_collection: { behavior: "keep_as_draft", resumes_at: null },
    metadata: { installment_collection_version: HELD_INSTALLMENT_VERSION,
      installment_plan_id: "plan_test", booking_payment_id: "bp_test" },
    trial_end: 1791343202, cancel_at: 1796613602,
  } as unknown as Stripe.Subscription;
}

function submitMessage(params: Stripe.Checkout.SessionCreateParams) {
  // Stripe permits an empty string to clear custom text; require the object
  // form here instead of using a cast that would hide an invalid request.
  const submit = params.custom_text?.submit;
  if (!submit || typeof submit !== "object") throw new Error("Missing installment disclosure");
  return submit.message;
}

describe("proposed exact installment Checkout request (not an enabled route)", () => {
  test("first payment has an integer fee and saves the card for the disclosed schedule", () => {
    const params = buildExactInstallmentCheckoutContract(input, subscription());
    expect(params.mode).toBe("payment");
    expect(params.subscription_data).toBeUndefined();
    expect(params.customer).toBe("cus_test");
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.payment_intent_data).toMatchObject({
      application_fee_amount: 9958,
      setup_future_usage: "off_session", transfer_data: { destination: "acct_test" },
    });
    expect(params.payment_intent_data?.metadata).toMatchObject({
      plan_type: "installment", installment_number: "1", installment_total_cents: "199900",
      installment_subscription_id: "sub_test", installment_collection_version: HELD_INSTALLMENT_VERSION,
    });
    expect(params.consent_collection?.payment_method_reuse_agreement?.position).toBe("auto");
    expect(submitMessage(params)).toContain("$666.33 today, then $666.33, $666.34");
    expect(submitMessage(params)).toContain("3 payments total: $1999.00 USD");
    expect(submitMessage(params)).toContain("No automatic renewal");
    expect(submitMessage(params)).toContain("cancellation and refund terms");
    expect(params.allow_promotion_codes).toBe(false);
    expect(params.invoice_creation).toEqual({enabled:false});
    expect(params.adaptive_pricing).toEqual({enabled:false});
    expect(params.automatic_tax).toEqual({enabled:false});
    expect(params.success_url).toBe("https://creatornet-test.vercel.app/success?session_id={CHECKOUT_SESSION_ID}");
  });

  test("does not charge the first payment's processing schedule at a subscription rate", () => {
    const plan = calculateInstallmentPlan(199900, 3, input.renewalFeeSchedule, input.firstPaymentFeeSchedule);
    expect(plan.payments.map((payment) => payment.fees.processingFeeCents)).toEqual([1962, 2429, 2429]);
    expect(plan.payments.map((payment) => payment.fees.totalCreatorDeductionCents)).toEqual([9958, 10425, 10425]);
  });

  test.each([
    [99900, 3, "$333.00 today, then $333.00, $333.00"],
    [10000, 3, "$33.33 today, then $33.33, $33.34"],
    [500000, 5, "$1000.00 today, then $1000.00, $1000.00, $1000.00, $1000.00"],
    [600000, 6, "$1000.00 today, then $1000.00, $1000.00, $1000.00, $1000.00, $1000.00"],
  ])("discloses the whole %i/%i price before payment", (totalCents, paymentCount, wording) => {
    const params = buildExactInstallmentCheckoutContract({ ...input, totalCents, paymentCount }, subscription());
    expect(params.line_items?.[0].price_data?.product_data?.description).toContain(wording);
    expect(submitMessage(params)).toContain(wording);
  });

  test.each([
    "https://www.creatornet.net", "http://creatornet-test.vercel.app", "https://creatornet-test.vercel.app.evil.example",
    "https://user:secret@creatornet-test.vercel.app", "https://creatornet-test.vercel.app/injected",
  ])("rejects production or unsafe redirect origin %s", (previewOrigin) => {
    expect(() => buildExactInstallmentCheckoutContract({ ...input, previewOrigin }, subscription())).toThrow();
  });

  test.each([
    ["live", (sub: Stripe.Subscription) => { sub.livemode = true; }],
    ["not held", (sub) => { sub.pause_collection = null; }],
    ["resuming", (sub) => { sub.pause_collection!.resumes_at = 1791343202; }],
    ["already active", (sub) => { sub.status = "active"; }],
    ["wrong customer", (sub) => { sub.customer = "cus_other"; }],
    ["legacy", (sub) => { sub.metadata.installment_collection_version = "exact-percent-v1"; }],
    ["percent split", (sub) => { sub.application_fee_percent = 15.65; }],
    ["no fixed end", (sub) => { sub.cancel_at = null; }],
  ] satisfies Array<[string, (sub: Stripe.Subscription) => void]>)
  ("refuses to build a chargeable request when subscription is %s", (_name, mutate) => {
    const sub = subscription();
    mutate(sub);
    expect(() => buildExactInstallmentCheckoutContract(input, sub)).toThrow();
  });

  test("rejects amounts above Stripe's USD limit before exposing checkout", () => {
    expect(() => buildExactInstallmentCheckoutContract({ ...input, totalCents: 300000000 }, subscription()))
      .toThrow("USD amount limit");
  });

  test("a maximum-count supported USD schedule fits the product description", () => {
    const params = buildExactInstallmentCheckoutContract({ ...input, totalCents: 99999999 * 24, paymentCount: 24 }, subscription());
    expect(params.line_items?.[0].price_data?.product_data?.description!.length).toBeLessThanOrEqual(500);
  });
});

describe("prospective fixed-total purchase acceptance", () => {
  test("requires the linked merchant Terms checkbox without inventing acceptance", () => {
    const params = buildFixedTotalCheckoutPayload({ ...input, origin: input.previewOrigin }, {}, FIXED_PURCHASE_CONSENT_VERSION);
    expect(params.consent_collection).toEqual({ payment_method_reuse_agreement: { position: "auto" }, terms_of_service: "required" });
    expect(params.custom_text?.terms_of_service_acceptance).toBeUndefined();
    expect(submitMessage(params)).toContain(FIXED_PURCHASE_CONSENT_TEXT);
    expect(submitMessage(params)).toContain("full price");
    expect(submitMessage(params)).toContain("not a cancel-anytime membership");
    expect(submitMessage(params)).toContain("does not set the service duration");
    expect(params.payment_intent_data?.application_fee_amount).toBe(9958);
    expect(params).not.toHaveProperty("consent");
    expect(params.metadata).toEqual({});
  });
  test("old shared and v1 requests do not silently acquire the new checkbox or text", () => {
    const params = buildFixedTotalCheckoutPayload({ ...input, origin: input.previewOrigin }, {});
    expect(params.consent_collection?.terms_of_service).toBeUndefined();
    expect(submitMessage(params)).not.toContain(FIXED_PURCHASE_CONSENT_TEXT);
    const legacy = buildExactInstallmentCheckoutContract(
      Object.assign({}, input, { purchaseConsentVersion: FIXED_PURCHASE_CONSENT_VERSION }), subscription());
    expect(legacy.consent_collection?.terms_of_service).toBeUndefined();
  });
  test.each([2, 3, 10, 24])("complete %i-payment disclosure fits native text limits", paymentCount => {
    const params = buildFixedTotalCheckoutPayload({ ...input, paymentCount, totalCents: 99999999 * paymentCount,
      origin: input.previewOrigin }, {}, FIXED_PURCHASE_CONSENT_VERSION);
    expect(params.line_items?.[0].price_data?.product_data?.description!.length).toBeLessThanOrEqual(500);
    expect(submitMessage(params).length).toBeLessThanOrEqual(1200);
    expect(submitMessage(params)).toContain(paymentCount + " payments total:");
  });
});
