/** @jest-environment node */
import type Stripe from "stripe";
import { buildMembershipManualContract } from "@/lib/membershipManualContract";
import { inspectMembershipManualFirstCapture } from "@/lib/membershipManualFirstCapture";
import { serverPaymentCreateRequest, SERVER_PAYMENT_PROTOCOL } from "@/lib/serverPaymentConfirmation";
import { membershipFixture } from "../test-support/membership-fixtures";

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function fixture() {
  const f = membershipFixture(), a = f.a, now = Math.floor(Date.now() / 1000);
  a.stripe_customer_id = null; a.stripe_subscription_id = null; a.stripe_checkout_session_id = null;
  const accepted = Math.floor(Date.parse(a.accepted_at) / 1000);
  const context = { version: "exact-payment-context-v1" as const,
    mode: a.terms.paymentContext.mode, platformAccountId: a.terms.paymentContext.stripeAccountId,
    supabaseProjectRef: a.terms.paymentContext.supabaseProjectRef,
    siteOrigin: a.terms.paymentContext.siteOrigin };
  const evidence = { approvedContext: context, vercelEnvironment: "preview",
    stripeSecretKeyMode: "test", stripePublishableKeyMode: "test",
    observedPlatformAccountId: context.platformAccountId,
    observedSupabaseProjectRef: context.supabaseProjectRef,
    configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: context.siteOrigin };
  const selection = { id: "40000000-0000-4000-8000-000000000001",
    agreement_id: a.id, buyer_id: a.buyer_id, kind: "first", payoff_id: null,
    protocol: SERVER_PAYMENT_PROTOCOL, context: a.terms.paymentContext,
    selected_at: new Date((now - 1) * 1000).toISOString(),
    source: { agreementId: a.id, purchaseId: a.purchase_id, buyerId: a.buyer_id,
      creatorId: a.creator_id, productId: a.product_id, postId: a.post_id,
      agreementFingerprint: a.fingerprint, sourceFingerprint: a.fingerprint,
      terms: a.terms, amountCents: a.monthly_price_cents,
      acceptedAt: accepted, expiresAt: accepted + 23 * 3600, revision: a.revision } };
  const contract = buildMembershipManualContract({ selection, agreement: a,
    contextEvidence: evidence, now, customer: f.customer,
    firstPreparation: { customerId: f.customer.id, productId: f.product.id,
      subscriptionId: f.subscription.id, subscription: f.subscription } });
  const request = serverPaymentCreateRequest(contract, evidence);
  const pi = { ...request.params, id: "pi_monthly", object: "payment_intent",
    livemode: false, created: now - 4, status: "succeeded", customer: f.customer.id,
    amount_received: a.monthly_price_cents, amount_capturable: 0,
    setup_future_usage: "off_session", automatic_payment_methods: { enabled: false },
    payment_method: "pm_monthly", latest_charge: "ch_monthly",
    on_behalf_of: null, shipping: null, transfer_group: null } as unknown as Stripe.PaymentIntent;
  const charge = { id: "ch_monthly", object: "charge", payment_intent: pi.id,
    customer: f.customer.id, livemode: false, paid: true, captured: true,
    status: "succeeded", currency: "usd", amount: a.monthly_price_cents,
    amount_captured: a.monthly_price_cents,
    application_fee_amount: a.terms.firstMonthFees.totalCreatorDeductionCents,
    payment_method: "pm_monthly", payment_method_details: { type: "card" },
    billing_details: { address: { country: "US" } },
    amount_refunded: 0, refunded: false, disputed: false, created: now - 2,
    balance_transaction: "txn_monthly", transfer: "tr_monthly" } as unknown as Stripe.Charge;
  const balance = { id: "txn_monthly", object: "balance_transaction",
    source: charge.id, type: "charge", currency: "usd", amount: a.monthly_price_cents,
    fee: 320, net: a.monthly_price_cents - 320 } as unknown as Stripe.BalanceTransaction;
  const paymentMethod = { id: "pm_monthly", object: "payment_method", livemode: false,
    customer: f.customer.id, type: "card", card: { country: "US" },
    billing_details: { address: { country: "US" } } } as unknown as Stripe.PaymentMethod;
  const args: Parameters<typeof inspectMembershipManualFirstCapture>[0] = {
    agreement: a, contract, contextEvidence: evidence, subscriptionId: f.subscription.id,
    binding: { paymentIntentId: pi.id, firstDispatchAt: now - 5 },
    confirmationOperationId: "40000000-0000-4000-8000-000000000002",
    nowSeconds: now, data: { paymentIntent: pi, charge, balance, paymentMethod } };
  return args;
}

test("a captured original after expiry and debit stop retains a null Checkout identity", () => {
  const args = fixture();
  args.agreement.debit_revoked_at = new Date().toISOString();
  args.nowSeconds = args.contract.expiresAt + 3600;
  const proof = inspectMembershipManualFirstCapture(args);
  expect(proof).toMatchObject({ checkoutSessionId: null, invoiceId: null,
    paymentIntentId: "pi_monthly", chargeId: "ch_monthly",
    buyerCountry: "US", manualPayment: {
      attemptId: args.contract.attemptId,
      confirmationOperationId: args.confirmationOperationId } });
});

test.each(["foreign billing", "refunded charge", "different customer", "different balance"] as const)(
  "rejects %s before a receipt can be written", fault => {
    const args = fixture(), data = copy(args.data);
    if (fault === "foreign billing") data.charge.billing_details.address!.country = "CA";
    if (fault === "refunded charge") data.charge.amount_refunded = 100;
    if (fault === "different customer") data.paymentMethod.customer = "cus_other";
    if (fault === "different balance") data.balance.amount = 1;
    expect(() => inspectMembershipManualFirstCapture({ ...args, data })).toThrow();
  });

test("a changed subscription source or uncaptured intent cannot produce first-payment proof", () => {
  const args = fixture();
  expect(() => inspectMembershipManualFirstCapture({ ...args, subscriptionId: "sub_other" })).toThrow();
  const data = copy(args.data); data.paymentIntent.status = "processing";
  expect(() => inspectMembershipManualFirstCapture({ ...args, data })).toThrow();
});
