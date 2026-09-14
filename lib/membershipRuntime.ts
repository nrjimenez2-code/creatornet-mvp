import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { runMembershipOperation, type MembershipOperationKind, type MembershipProviderRequest } from "./membershipOperation";
import { buildMembershipAgreement, MEMBERSHIP_PAYMENT_PROOF_VERSION, membershipMonthBoundary, type MembershipOffer, type MembershipPaymentContext } from "./membershipAgreement";
import { membershipServerClients, membershipCheckoutReady } from "./membershipServer";
import { assertMembershipCustomer, assertMembershipHeld, assertMembershipSession, buildMembershipCheckout,
  buildMembershipSubscription, membershipBootstrapTimes, membershipCheck as check, membershipMetadata,
  membershipStripeId as sid, readMembershipRecord, type MembershipRecord } from "./membershipCheckout";
import { recordPaymentFeeLedger, type StripeFeeDetails } from "./paymentFeeLedger";
import { applyPaymentRefundState, reconcileKnownPaymentRefund, recordPaymentRefundState } from "./paymentRefunds";
import { resolvePostForProduct, INVALID_POST } from "./checkoutGuards";
import { createMembershipBillingRuntime } from "./membershipBillingRuntime";
import { createMembershipExitRuntime } from "./membershipExit";
import { createMembershipPayoffRuntime } from "./membershipPayoffRuntime";
import { createMembershipLifecycleRuntime } from "./membershipLifecycle";
import { createMembershipPaymentEventRuntime } from "./membershipPaymentEvents";
import { createMembershipCheckoutRecovery } from "./membershipCheckoutRecovery";
import { createMembershipInitialAbandonment } from "./membershipInitialAbandonment";
import { createMembershipRenewalRecovery } from "./membershipRenewalRecovery";
import { createMembershipCardSetup } from "./membershipCardSetup";
import { createMembershipRetry } from "./membershipRetry";
import { createMembershipBankVerification } from "./membershipBankVerification";
import { reconcileKnownPaymentDispute } from "./paymentDisputes";

type FirstCapture = {
  session: Stripe.Checkout.Session; paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge; balance: Stripe.BalanceTransaction;
};
export function inspectMembershipFirstCapture(a: MembershipRecord, data: FirstCapture) {
  const { session: s, paymentIntent: pi, charge: c, balance: b } = data;
  assertMembershipSession(s, a, true);
  const live = a.terms.paymentContext.mode === "live", fees = a.terms.firstMonthFees;
  const expected = buildMembershipCheckout(a, a.stripe_customer_id!, a.stripe_subscription_id!);
  check(pi.object === "payment_intent" && pi.id === sid(s.payment_intent, "pi") && pi.livemode === live && pi.status === "succeeded" &&
    pi.customer === a.stripe_customer_id && pi.currency === "usd" && pi.amount === a.monthly_price_cents && pi.amount_received === pi.amount &&
    pi.amount_capturable === 0 && ["automatic", "automatic_async"].includes(pi.capture_method) && pi.setup_future_usage === "off_session" &&
    pi.application_fee_amount === fees.totalCreatorDeductionCents && pi.transfer_data?.destination === a.terms.destinationId &&
    pi.transfer_data.amount == null && isDeepStrictEqual(pi.metadata, expected.payment_intent_data!.metadata));
  const method = sid(pi.payment_method, "pm");
  check(c.object === "charge" && c.id === sid(pi.latest_charge, "ch") && c.payment_intent === pi.id && c.livemode === live &&
    c.customer === a.stripe_customer_id && c.status === "succeeded" && c.paid === true && c.captured === true && c.currency === "usd" &&
    c.amount === a.monthly_price_cents && c.amount_captured === c.amount && c.application_fee_amount === fees.totalCreatorDeductionCents &&
    c.payment_method === method && c.payment_method_details?.type === "card" && Number.isSafeInteger(c.created) &&
    c.created >= Math.floor(Date.parse(a.accepted_at) / 1000) && c.created <= Math.floor(Date.now() / 1000) &&
    Number.isSafeInteger(c.amount_refunded) && c.amount_refunded >= 0 && c.amount_refunded <= c.amount && typeof c.disputed === "boolean");
  check(b.object === "balance_transaction" && b.id === sid(c.balance_transaction, "txn") && b.source === c.id && b.type === "charge" &&
    b.currency === "usd" && b.amount === c.amount && Number.isSafeInteger(b.fee) && b.fee >= 0 && b.fee <= c.amount && b.net === b.amount - b.fee);
  const stripeFee: StripeFeeDetails = { chargeId: c.id, balanceTransactionId: b.id,
    actualStripeFeeCents: b.fee, applicationFeeAmountCents: c.application_fee_amount };
  return { stripeFee, anchor: c.created, proof: { version: MEMBERSHIP_PAYMENT_PROOF_VERSION, paymentContext: a.terms.paymentContext,
    customerId: a.stripe_customer_id, subscriptionId: a.stripe_subscription_id, checkoutSessionId: s.id,
    destinationId: a.terms.destinationId, paymentIntentId: pi.id, chargeId: c.id, invoiceId: null,
    capturedAmountCents: c.amount, applicationFeeAmountCents: c.application_fee_amount, paymentStatus: "succeeded",
    paymentMethodId: method, paidAt: c.created } };
}

/** The default path uses the existing ledger/refund/dispute reconciliation,
 * never a new money balance. Test injection is private to the runtime factory. */
async function writeFirstLedger(admin: SupabaseClient, a: MembershipRecord, data: FirstCapture) {
  const inspected = inspectMembershipFirstCapture(a, data), c = data.charge;
  const ledgerId = await recordPaymentFeeLedger(admin, { breakdown: a.terms.firstMonthFees, currency: "usd", creatorId: a.creator_id,
    purchaseId: a.purchase_id, checkoutSessionId: data.session.id, paymentIntentId: data.paymentIntent.id, stripeFee: inspected.stripeFee }, true);
  if (c.amount_refunded > 0) {
    const state = await recordPaymentRefundState(admin, { paymentIntentId: data.paymentIntent.id, chargeId: c.id,
      chargeAmountCents: c.amount, refundedAmountCents: c.amount_refunded });
    await applyPaymentRefundState(admin, state);
  }
  await reconcileKnownPaymentRefund(admin, data.paymentIntent.id);
  await reconcileKnownPaymentDispute(admin, data.paymentIntent.id);
  if (c.disputed) {
    const result = await admin.from("payment_fee_ledger").select("dispute_status").eq("id", ledgerId!).maybeSingle();
    check(!result.error && ["won", "warning_closed"].includes(result.data?.dispute_status), "Monthly dispute requires reconciliation before credit");
  }
  check(ledgerId); return ledgerId;
}

export type MembershipRuntimeDependencies = { admin: SupabaseClient; stripe: Stripe; context: MembershipPaymentContext;
  writeFirstLedger?: typeof writeFirstLedger };
export function createMembershipRuntime(env: Record<string, string | undefined> = process.env, injected?: MembershipRuntimeDependencies) {
  const { admin, stripe, context } = injected || membershipServerClients(env), started = Date.now();
  let observedAt = 0;
  const fresh = () => check(Date.now() - started < 45000, "Monthly operation needs a bounded retry");
  async function checked<T>(promise: Promise<Stripe.Response<T>>): Promise<Stripe.Response<T>> {
    fresh(); const result = await promise; fresh();
    check(result.lastResponse?.apiVersion === context.apiVersion && /^req_[A-Za-z0-9]+$/.test(result.lastResponse.requestId) &&
      (result.lastResponse.stripeAccount == null || result.lastResponse.stripeAccount === context.stripeAccountId), "Monthly provider response context differs");
    return result;
  }
  async function observeContext() {
    fresh();
    if (Date.now() - observedAt < 1000) return context;
    const account = await checked(stripe.accounts.retrieve());
    const balance = await checked(stripe.balance.retrieve());
    check(account.object === "account" && account.id === context.stripeAccountId && balance.object === "balance" &&
      balance.livemode === (context.mode === "live"), "Monthly provider account or mode differs");
    observedAt = Date.now(); return context;
  }
  async function load(id: string, buyerId: string) {
    const result = await admin.from("monthly_mentorship_agreements_v1").select("*").eq("id", id).eq("buyer_id", buyerId).maybeSingle();
    check(!result.error && result.data, "Owned membership not found");
    const a = readMembershipRecord(result.data);
    check(a.id === id && a.buyer_id === buyerId && isDeepStrictEqual(a.terms.paymentContext, context), "Monthly agreement context differs");
    return a;
  }
  async function productId(a: MembershipRecord) {
    const result = await admin.from("monthly_mentorship_operations_v1").select("provider_id").eq("agreement_id", a.id)
      .eq("kind", "product").eq("scope_key", "initial").eq("status", "complete").maybeSingle();
    check(!result.error); return sid(result.data?.provider_id, "prod");
  }
  async function operation<T extends { id: string; lastResponse?: { requestId?: string } }>(a: MembershipRecord, kind: MembershipOperationKind,
    path: string, params: object, create: (params: MembershipProviderRequest, options: { idempotencyKey: string; maxNetworkRetries: 0 }) => Promise<T>,
    retrieve: (id: string) => Promise<T>, validate: (object: T) => void) {
    return runMembershipOperation({ admin, agreementId: a.id, actorId: a.buyer_id, revision: a.revision, kind, scope: "initial", context,
      request: { method: "POST", path, params: params as Record<string, unknown> }, env, observeContext, create, retrieve, validate });
  }
  async function summary(a: MembershipRecord) {
    const result = await admin.rpc("read_monthly_mentorship_entitlement_v1", { p_purchase_id: a.purchase_id, p_buyer_id: a.buyer_id });
    check(!result.error && result.data && typeof result.data.allowed === "boolean");
    return { membershipId: a.id, title: a.terms.title, firstPaymentRecorded: a.covered_months > 0, accessGranted: result.data.allowed,
      paidThrough: a.anchor_at && a.covered_months > 0 ? new Date(membershipMonthBoundary(a.anchor_at, a.covered_months) * 1000).toISOString() : null };
  }
  const billing = createMembershipBillingRuntime({ admin, stripe, context, env, checked, observeContext, load, productId });
  const exit = createMembershipExitRuntime({ admin, stripe, context, env, checked, observeContext, load, productId });
  const payoff = createMembershipPayoffRuntime({ admin, stripe, context, env, checked, observeContext, load, productId });
  const api = {
    context, activate: billing.activate, collectNext: billing.collectNext, reconcileInvoice: billing.reconcileInvoice,
    quoteExit: exit.quoteExit, requestExit: exit.requestExit, reconcileExitStop: exit.reconcileExitStop,
    quotePayoff: payoff.quotePayoff, acceptAndPreparePayoff: payoff.acceptAndPreparePayoff,
    confirmPayoff: payoff.confirmPayoff, abandonPayoff: payoff.abandonPayoff,
    async quote(buyerId: string, product: string, post: string | null) {
      check(membershipCheckoutReady(env), "Monthly checkout is not enabled");
      await observeContext();
      const found = await admin.from("products").select("id,creator_id,title,description,type,price_cents,amount_cents,currency,membership_terms")
        .eq("id", product).maybeSingle();
      check(!found.error && found.data, "Monthly offer not found"); const offer = found.data as MembershipOffer;
      const postId = await resolvePostForProduct(admin, post, offer.id, offer.creator_id);
      check(postId && postId !== INVALID_POST, "Select the post that sells this monthly offer");
      const creator = await admin.from("profiles").select("stripe_account_id").eq("id", offer.creator_id).maybeSingle();
      const { isCreatorSellReady } = await import("./creatorStripeConnect");
      check(!creator.error && creator.data?.stripe_account_id && await isCreatorSellReady(offer.creator_id), "Creator is not accepting payments");
      return buildMembershipAgreement({ offer, buyerId, postId, destinationId: creator.data.stripe_account_id, context, env });
    },
    async acceptAndPrepare(buyerId: string, product: string, post: string, consent: { accepted: boolean; version: string; fingerprint: string }) {
      check(membershipCheckoutReady(env), "Monthly checkout is not enabled");
      const quote = await this.quote(buyerId, product, post);
      check(consent.accepted === true && consent.version === quote.agreement.version && consent.fingerprint === quote.fingerprint,
        "Review and accept the current monthly agreement");
      const saved = await admin.rpc("reserve_monthly_mentorship_v1", { p_buyer_id: buyerId, p_product_id: product, p_post_id: post,
        p_terms: quote.agreement, p_fingerprint: quote.fingerprint, p_accepted: true });
      check(!saved.error && typeof saved.data === "string", "Monthly acceptance could not be recorded");
      return this.prepare(saved.data, buyerId);
    },
    async prepare(id: string, buyerId: string) {
      check(membershipCheckoutReady(env), "Monthly checkout is not enabled");
      const a = await load(id, buyerId); await observeContext();
      const success = `${context.siteOrigin}/memberships/complete?membership_id=${a.id}`;
      if (a.covered_months > 0) return { membershipId: id, url: success };
      check(!a.billing_review_at && !a.financial_hold_at && !a.debit_revoked_at && !a.renewal_stopped_at, "Membership payment needs support review");
      if (a.stripe_checkout_session_id) {
        const session = await checked(stripe.checkout.sessions.retrieve(a.stripe_checkout_session_id));
        assertMembershipSession(session, a, null);
        if (session.status === "complete") return { membershipId: id, url: success };
        check(session.status === "open" && session.payment_status === "unpaid", "Monthly checkout expired and needs recovery");
        assertMembershipHeld(await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!)), a, a.stripe_customer_id!, await productId(a), true);
        check(session.url && new URL(session.url).origin === "https://checkout.stripe.com");
        if (process.env.DISCOVER_V4_ENABLED === "true" && a.post_id) {
          const { recordDiscoverEvent } = await import("./discoverServer");
          await recordDiscoverEvent({actor: `user:${a.buyer_id}`, userId: a.buyer_id, postId: a.post_id, kind: "checkout_start", entityKey: session.id});
        }
        return { membershipId: id, url: session.url };
      }
      check(Math.floor(Date.now() / 1000) < membershipBootstrapTimes(a).expiresAt - 31 * 60, "Monthly checkout acceptance needs recovery");
      const customer = await operation(a, "customer", "/v1/customers", { metadata: membershipMetadata(a, "customer") },
        (r, opts) => checked(stripe.customers.create(r.params as Stripe.CustomerCreateParams, opts)),
        id => checked(stripe.customers.retrieve(id)), c => assertMembershipCustomer(c, a, true));
      const product = await operation(a, "product", "/v1/products", { name: a.terms.title.slice(0, 200), metadata: membershipMetadata(a, "product") },
        (r, opts) => { check(typeof r.params.name === "string"); return checked(stripe.products.create({ ...r.params, name: r.params.name }, opts)); }, id => checked(stripe.products.retrieve(id)), p => {
          check(p.object === "product" && p.active && p.livemode === (context.mode === "live") && p.name === a.terms.title.slice(0, 200) &&
            p.default_price === null && isDeepStrictEqual(p.metadata, membershipMetadata(a, "product"))); });
      const sub = await operation(a, "subscription", "/v1/subscriptions", buildMembershipSubscription(a, customer.id, product.id),
        (r, opts) => { check(typeof r.params.customer === "string"); return checked(stripe.subscriptions.create({ ...r.params, customer: r.params.customer }, opts)); }, id => checked(stripe.subscriptions.retrieve(id)),
        s => assertMembershipHeld(s, a, customer.id, product.id, null));
      await operation(a, "hold", `/v1/subscriptions/${sub.id}`, { pause_collection: { behavior: "keep_as_draft" } },
        (r, opts) => checked(stripe.subscriptions.update(sub.id, r.params as Stripe.SubscriptionUpdateParams, opts)), id => checked(stripe.subscriptions.retrieve(id)),
        s => { check(s.id === sub.id); assertMembershipHeld(s, a, customer.id, product.id, true); });
      assertMembershipHeld(await checked(stripe.subscriptions.retrieve(sub.id)), a, customer.id, product.id, true);
      assertMembershipCustomer(await checked(stripe.customers.retrieve(customer.id)), a, true);
      const bound = { ...a, stripe_customer_id: customer.id, stripe_subscription_id: sub.id };
      const session = await operation(a, "checkout", "/v1/checkout/sessions", buildMembershipCheckout(bound, customer.id, sub.id),
        (r, opts) => checked(stripe.checkout.sessions.create(r.params as Stripe.Checkout.SessionCreateParams, opts)),
        id => checked(stripe.checkout.sessions.retrieve(id)), s => assertMembershipSession(s, bound, false));
      const linked = await admin.rpc("bind_monthly_mentorship_provider_v1", { p_id: a.id, p_customer_id: customer.id,
        p_subscription_id: sub.id, p_session_id: session.id });
      check(!linked.error && typeof linked.data === "boolean", "Monthly payment link could not be published safely");
      check(session.url && new URL(session.url).origin === "https://checkout.stripe.com");
      if (process.env.DISCOVER_V4_ENABLED === "true" && a.post_id) {
        const { recordDiscoverEvent } = await import("./discoverServer");
        await recordDiscoverEvent({actor: `user:${a.buyer_id}`, userId: a.buyer_id, postId: a.post_id, kind: "checkout_start", entityKey: session.id});
      }
      return { membershipId: id, url: session.url };
    },
    async confirmFirst(id: string, buyerId: string) {
      check(env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY === "true" && env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY === "true",
        "Monthly payment reconciliation is not enabled");
      const a = await load(id, buyerId); await observeContext();
      if (a.covered_months > 0) return summary(a); // Never rerun an already recorded earnings/access transition.
      check(a.stripe_checkout_session_id && a.stripe_subscription_id && a.stripe_customer_id, "Monthly checkout is not bound");
      const session = await checked(stripe.checkout.sessions.retrieve(a.stripe_checkout_session_id));
      assertMembershipSession(session, a, null);
      if (session.status !== "complete" || session.payment_status !== "paid") return summary(a);
      const paymentIntent = await checked(stripe.paymentIntents.retrieve(sid(session.payment_intent, "pi")));
      const charge = await checked(stripe.charges.retrieve(sid(paymentIntent.latest_charge, "ch")));
      const balance = await checked(stripe.balanceTransactions.retrieve(sid(charge.balance_transaction, "txn")));
      const data = { session, paymentIntent, charge, balance }, inspected = inspectMembershipFirstCapture(a, data);
      await observeContext();
      const ledgerId = await (injected?.writeFirstLedger || writeFirstLedger)(admin, a, data);
      const recorded = await admin.rpc("record_monthly_mentorship_receipt_v1", { p_id: a.id, p_ledger_id: ledgerId, p_month: 1,
        p_start: inspected.anchor, p_end: membershipMonthBoundary(inspected.anchor, 1), p_proof: inspected.proof });
      check(!recorded.error && typeof recorded.data === "boolean", "Monthly receipt requires retry or review");
      return summary(await load(id, buyerId));
    },
  };
  const lifecycle = createMembershipLifecycleRuntime({ admin, stripe, context, env, checked, observeContext, load, productId }, api);
  const paymentEvents = createMembershipPaymentEventRuntime({ admin, stripe, context, env, checked, observeContext, load, productId }, api);
  const recovery = createMembershipCheckoutRecovery({ admin, stripe, context, env, checked, observeContext, load, productId }, api);
  const initialAbandonment = createMembershipInitialAbandonment({ admin, stripe, context, env, checked, observeContext, load, productId }, recovery);
  const renewalRecovery = createMembershipRenewalRecovery({ admin, stripe, context, env, checked, observeContext, load, productId }, api);
  const cardSetup = createMembershipCardSetup({ admin, stripe, context, env, checked, observeContext, load, productId }, renewalRecovery);
  const retry = createMembershipRetry({ admin, stripe, context, env, checked, observeContext, load, productId }, { ...renewalRecovery, ...cardSetup });
  const bank = createMembershipBankVerification({ admin, stripe, context, env, checked, observeContext, load, productId }, renewalRecovery);
  return { ...api, ...recovery, ...initialAbandonment, ...renewalRecovery, ...cardSetup, ...retry, ...bank, reconcileLifecycle: lifecycle.reconcileLifecycle, reconcilePaymentEvent: paymentEvents.reconcilePaymentEvent };
}
