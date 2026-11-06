/** @jest-environment node */
import type Stripe from "stripe";
import { buildMembershipManualContract } from "@/lib/membershipManualContract";
import { inspectMembershipManualPayoffCapture } from "@/lib/membershipManualPayoffCapture";
import { serverPaymentCreateRequest, SERVER_PAYMENT_PROTOCOL } from "@/lib/serverPaymentConfirmation";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function fixture() {
  const f = membershipPayoffFixture(false), a = f.a, p = f.p;
  p.status = "accepted"; p.checkout_request = null; p.checkout_dispatched_at = null;
  p.stripe_checkout_session_id = null;
  const now = Math.floor(Date.now() / 1000), accepted = Math.floor(Date.parse(p.accepted_at) / 1000);
  const exact = { version: "exact-payment-context-v1" as const,
    mode: a.terms.paymentContext.mode, platformAccountId: a.terms.paymentContext.stripeAccountId,
    supabaseProjectRef: a.terms.paymentContext.supabaseProjectRef,
    siteOrigin: a.terms.paymentContext.siteOrigin };
  const evidence = { approvedContext: exact, vercelEnvironment: "preview",
    stripeSecretKeyMode: "test", stripePublishableKeyMode: "test",
    observedPlatformAccountId: exact.platformAccountId,
    observedSupabaseProjectRef: exact.supabaseProjectRef,
    configuredSupabaseUrl: `https://${exact.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: exact.siteOrigin };
  const selection = { id: "40000000-0000-4000-8000-000000000011",
    agreement_id: a.id, buyer_id: a.buyer_id, kind: "payoff", payoff_id: p.id,
    protocol: SERVER_PAYMENT_PROTOCOL, context: a.terms.paymentContext,
    selected_at: new Date((now - 1) * 1000).toISOString(),
    source: { agreementId: a.id, purchaseId: a.purchase_id, buyerId: a.buyer_id,
      creatorId: a.creator_id, productId: a.product_id, postId: a.post_id,
      agreementFingerprint: a.fingerprint, sourceFingerprint: p.fingerprint,
      terms: p.terms, amountCents: p.terms.amountCents, acceptedAt: accepted,
      expiresAt: Math.min(accepted + 23 * 3600, p.terms.periodEnd), revision: a.revision } };
  const contract = buildMembershipManualContract({ selection, agreement: a, payoff: p,
    contextEvidence: evidence, now, customer: f.customer });
  const request = serverPaymentCreateRequest(contract, evidence);
  const paymentIntent = { ...request.params, id: "pi_manualpayoff", object: "payment_intent",
    livemode: false, created: now - 4, status: "succeeded", customer: f.customer.id,
    amount_received: p.terms.amountCents, amount_capturable: 0,
    setup_future_usage: null, automatic_payment_methods: { enabled: false },
    payment_method: "pm_manualpayoff", latest_charge: "ch_manualpayoff",
    on_behalf_of: null, shipping: null, transfer_group: null } as unknown as Stripe.PaymentIntent;
  const charge = { id: "ch_manualpayoff", object: "charge", payment_intent: paymentIntent.id,
    customer: f.customer.id, livemode: false, paid: true, captured: true,
    status: "succeeded", currency: "usd", amount: p.terms.amountCents,
    amount_captured: p.terms.amountCents,
    application_fee_amount: p.terms.fees.totalCreatorDeductionCents,
    payment_method: "pm_manualpayoff", payment_method_details: { type: "card" },
    billing_details: { address: { country: "US" } },
    amount_refunded: 0, refunded: false, disputed: false, created: now - 2,
    balance_transaction: "txn_manualpayoff", transfer: "tr_manualpayoff" } as unknown as Stripe.Charge;
  const balance = { id: "txn_manualpayoff", object: "balance_transaction",
    source: charge.id, type: "charge", currency: "usd", amount: p.terms.amountCents,
    fee: 610, net: p.terms.amountCents - 610 } as unknown as Stripe.BalanceTransaction;
  const paymentMethod = { id: "pm_manualpayoff", object: "payment_method", livemode: false,
    customer: f.customer.id, type: "card", card: { country: "US" },
    billing_details: { address: { country: "US" } } } as unknown as Stripe.PaymentMethod;
  const args: Parameters<typeof inspectMembershipManualPayoffCapture>[0] = {
    agreement: a, payoff: p, contract, contextEvidence: evidence,
    binding: { paymentIntentId: paymentIntent.id, firstDispatchAt: now - 5 },
    confirmationOperationId: "40000000-0000-4000-8000-000000000012",
    nowSeconds: now, data: { paymentIntent, charge, balance, paymentMethod } };
  return args;
}

test("original manual payoff capture has US provider evidence and no Checkout Session", () => {
  const args = fixture(), proof = inspectMembershipManualPayoffCapture(args);
  expect(proof).toMatchObject({ payoffId: args.payoff.id,
    checkoutSessionId: null, paymentIntentId: "pi_manualpayoff",
    capturedAmountCents: args.payoff.terms.amountCents, buyerCountry: "US",
    manualPayment: { attemptId: args.contract.attemptId,
      confirmationOperationId: args.confirmationOperationId } });
});

test.each(["foreign billing", "refunded charge", "different payoff", "uncaptured intent"] as const)(
  "rejects %s before payoff receipt admission", fault => {
    const args = fixture(), data = copy(args.data);
    if (fault === "foreign billing") data.charge.billing_details.address!.country = "CA";
    if (fault === "refunded charge") data.charge.amount_refunded = 100;
    if (fault === "different payoff") args.contract = { ...args.contract, termsFingerprint: "a".repeat(64) };
    if (fault === "uncaptured intent") data.paymentIntent.status = "processing";
    expect(() => inspectMembershipManualPayoffCapture({ ...args, data })).toThrow();
  });
