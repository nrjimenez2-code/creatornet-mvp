import "server-only";
import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertMembershipId, type MembershipPaymentContext } from "./membershipAgreement";
import { membershipCheck as check, membershipStripeId as sid } from "./membershipCheckout";
import { membershipRenewalRecoveryReady, type MembershipRenewalRecoveryResult } from "./membershipRenewalRecovery";
import { MONTHLY_CARD_SETUP_CONSENT_TEXT, MONTHLY_CARD_SETUP_CONSENT_VERSION } from "./membershipCardSetupConsent";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
import { consumedMonthlyRetry } from "./membershipCards";
type Snapshot = { membershipId: string; operationId: string; invoiceId: string; paymentIntentId: string; customerId: string;
  subscriptionId: string; originalPaymentMethodId: string; monthlyPriceCents: number; periodStart: number; periodEnd: number;
  revision: number; fingerprint: string; paymentContext: MembershipPaymentContext };
export type MonthlyCardSetup = { id: string; operation_id: string; agreement_id: string; buyer_id: string; snapshot: Snapshot;
  consent_version: string; consent_text: string; created_at: number; expires_at: number; request: Stripe.Checkout.SessionCreateParams;
  dispatch_started_at: string | null; session_id: string | null; setup_intent_id: string | null; payment_method_id: string | null;
  verified_at: string | null; closed_at: string | null };
type Recovery = { readRenewalRecovery(id: string, buyer: string, invoice: string): Promise<MembershipRenewalRecoveryResult> };
export function membershipCardSetupReady(env: Record<string, string | undefined> = process.env) {
  return membershipRenewalRecoveryReady(env) && ["CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_READY"].every(key => env[key] === "true");
}
export function monthlyCardSetupMetadata(r: MonthlyCardSetup) {
  return { creatornet_membership_card_setup: "monthly-card-setup-v1", membership_id: r.agreement_id, setup_request_id: r.id,
    collection_operation_id: r.operation_id, invoice_id: r.snapshot.invoiceId, buyer_id: r.buyer_id, membership_fingerprint: r.snapshot.fingerprint };
}
export function monthlyCardSetupParams(r: MonthlyCardSetup): Stripe.Checkout.SessionCreateParams {
  const url = r.snapshot.paymentContext.siteOrigin + "/memberships/renewal-recovery?membership_id=" + r.agreement_id, metadata = monthlyCardSetupMetadata(r);
  return { mode: "setup", ui_mode: "hosted", customer: r.snapshot.customerId, client_reference_id: r.id, payment_method_types: ["card"],
    expires_at: r.expires_at, success_url: url, cancel_url: url, metadata, setup_intent_data: { metadata },
    custom_text: { submit: { message: MONTHLY_CARD_SETUP_CONSENT_TEXT } } };
}
function readSetup(value: unknown, id: string, buyer: string, context: MembershipPaymentContext): MonthlyCardSetup {
  check(value && typeof value === "object" && !Array.isArray(value)); const r = value as MonthlyCardSetup, b = r.snapshot;
  [r.id, r.operation_id, r.agreement_id, r.buyer_id].forEach(assertMembershipId);
  check(r.agreement_id === id && r.buyer_id === buyer && b?.membershipId === id && b.operationId === r.operation_id &&
    isDeepStrictEqual(b.paymentContext, context) && r.consent_version === MONTHLY_CARD_SETUP_CONSENT_VERSION &&
    r.consent_text === MONTHLY_CARD_SETUP_CONSENT_TEXT && Number.isSafeInteger(r.created_at) && r.created_at > 0 &&
    Number.isSafeInteger(r.expires_at) && r.expires_at > r.created_at && r.expires_at <= r.created_at + 3600 &&
    Number.isSafeInteger(b.revision) && b.revision >= 0 && Number.isSafeInteger(b.monthlyPriceCents) && b.monthlyPriceCents >= 50 &&
    Number.isSafeInteger(b.periodStart) && Number.isSafeInteger(b.periodEnd) && b.periodEnd > b.periodStart && r.expires_at <= b.periodEnd &&
    /^[a-f0-9]{64}$/.test(b.fingerprint) && isDeepStrictEqual(r.request, monthlyCardSetupParams(r)), "Saved monthly setup differs");
  sid(b.invoiceId, "in"); sid(b.paymentIntentId, "pi"); sid(b.customerId, "cus"); sid(b.subscriptionId, "sub"); sid(b.originalPaymentMethodId, "pm");
  check((r.verified_at == null) === (r.payment_method_id == null) && (r.verified_at == null) === (r.setup_intent_id == null));
  if (r.session_id) sid(r.session_id, "cs");
  if (r.payment_method_id) sid(r.payment_method_id, "pm");
  if (r.setup_intent_id) sid(r.setup_intent_id, "seti");
  return r;
}
/** Setup is not payment. All provider writes in this module are setup-only
 * Checkout creation. No raw card data, client secret or default mutation. */
export function createMembershipCardSetup(d: MembershipBillingDependencies, recovery: Recovery) {
  const { admin, stripe, context, env, checked, observeContext, load } = d;
  const gate = () => check(membershipCardSetupReady(env), "Monthly card setup is not enabled");
  async function action(kind: string, id: string, buyer: string, setup: string, operation: string | null = null,
    consent: string | null = null, proof: unknown = null) {
    await observeContext();
    const q = await admin.rpc("monthly_card_setup_v1", { p_action: kind, p_id: setup, p_operation: operation, p_buyer: buyer,
      p_context: context, p_consent: consent, p_accepted: kind === "reserve", p_proof: proof });
    check(!q.error && q.data, "Monthly card setup state needs retry or review"); return readSetup(q.data, id, buyer, context);
  }
  async function currentRenewalRecovery(id: string, buyer: string) {
    gate(); const a = await load(id, buyer); await observeContext();
    const q = await admin.from("monthly_mentorship_operations_v1").select("id,request").eq("agreement_id", a.id).eq("kind", "collect")
      .eq("scope_key", String(a.covered_months + 1)).maybeSingle();
    check(!q.error); if (!q.data) return { membershipId: id, renewal: null, setup: null };
    check(/^\/v1\/invoices\/in_[A-Za-z0-9]+\/pay$/.test(q.data.request?.path));
    const renewal = await recovery.readRenewalRecovery(id, buyer, q.data.request.path.split("/")[3]);
    const row = await admin.from("monthly_mentorship_card_setups_v1").select("*").eq("operation_id", q.data.id).eq("buyer_id", buyer).is("closed_at", null).maybeSingle();
    check(!row.error); const s = row.data ? readSetup(row.data, id, buyer, context) : null;
    const retry = await consumedMonthlyRetry(d, a, q.data.id);
    return { membershipId: id, renewal, setup: s && (s.expires_at > Math.floor(Date.now() / 1000) || retry) ?
      { id: s.id, status: retry ? "retry_requested" as const : s.verified_at ? "card_saved_payment_not_attempted" as const : "setup_pending" as const } : null };
  }
  async function fresh(id: string, buyer: string, setup: string) {
    gate(); assertMembershipId(setup); await load(id, buyer);
    const q = await admin.from("monthly_mentorship_card_setups_v1").select("*").eq("id", setup).eq("agreement_id", id).eq("buyer_id", buyer).maybeSingle();
    check(!q.error && q.data, "Owned monthly card setup is unavailable"); const r = readSetup(q.data, id, buyer, context);
    const observed = await recovery.readRenewalRecovery(id, buyer, r.snapshot.invoiceId);
    check(observed.outcome === "payment_method_required", "Monthly setup requires a verified unpaid card decline");
    return action("read", id, buyer, setup);
  }
  function inspectSession(s: Stripe.Response<Stripe.Checkout.Session>, r: MonthlyCardSetup) {
    const params = monthlyCardSetupParams(r), now = Math.floor(Date.now() / 1000);
    sid(s.id, "cs");
    check(s.object === "checkout.session" && s.livemode === (context.mode === "live") && (context.mode === "test" ? s.id.startsWith("cs_test_") : !s.id.startsWith("cs_test_")) &&
      s.mode === "setup" && s.ui_mode === "hosted" && sid(s.customer, "cus") === r.snapshot.customerId && s.client_reference_id === r.id &&
      isDeepStrictEqual(s.metadata, params.metadata) && s.payment_intent === null && s.subscription === null && s.invoice === null &&
      s.payment_status === "no_payment_required" && (s.amount_total == null || s.amount_total === 0) &&
      (s.amount_subtotal == null || s.amount_subtotal === 0) && s.payment_method_types.length === 1 && s.payment_method_types[0] === "card" &&
      s.expires_at === r.expires_at && Number.isSafeInteger(s.created) && s.created >= r.created_at && s.created <= now &&
      Number.isFinite(Date.parse(r.dispatch_started_at || "")) && s.created >= Math.floor(Date.parse(r.dispatch_started_at!) / 1000) &&
      ["open", "complete"].includes(s.status || "") && s.success_url === params.success_url && s.cancel_url === params.cancel_url &&
      s.custom_text?.submit?.message === MONTHLY_CARD_SETUP_CONSENT_TEXT && (!r.session_id || s.id === r.session_id), "Monthly setup Checkout differs");
    return { version: "monthly-card-setup-proof-v1", paymentContext: context, session: { id: s.id, customerId: r.snapshot.customerId,
      mode: s.mode, uiMode: s.ui_mode, status: s.status, paymentStatus: s.payment_status, clientReferenceId: s.client_reference_id,
      metadata: s.metadata, expiresAt: s.expires_at, createdAt: s.created, amountCents: 0, paymentIntentId: null,
      subscriptionId: null, invoiceId: null, setupIntentId: s.setup_intent == null ? null : sid(s.setup_intent, "seti"), requestId: s.lastResponse.requestId } };
  }
  async function prepareRenewalCardSetup(id: string, buyer: string, consentVersion: string, accepted: boolean) {
    gate(); check(accepted === true && consentVersion === MONTHLY_CARD_SETUP_CONSENT_VERSION, "Explicit current card setup consent is required");
    check(env.CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_PUBLISH_READY === "true", "Monthly card setup handoff is not enabled");
    const current = await currentRenewalRecovery(id, buyer);
    check(current.renewal?.outcome === "payment_method_required", "Monthly setup requires a verified unpaid card decline");
    const op = await admin.from("monthly_mentorship_operations_v1").select("id").eq("agreement_id", id).eq("kind", "collect")
      .eq("request->>path", "/v1/invoices/" + current.renewal.invoiceId + "/pay").maybeSingle();
    check(!op.error && op.data); assertMembershipId(op.data.id);
    let r = await action("reserve", id, buyer, randomUUID(), op.data.id, consentVersion), session: Stripe.Response<Stripe.Checkout.Session>;
    if (r.session_id) session = await checked(stripe.checkout.sessions.retrieve(r.session_id));
    else {
      const list = await checked(stripe.checkout.sessions.list({ customer: r.snapshot.customerId, created: { gte: r.created_at }, limit: 100 }));
      check(!list.has_more, "Monthly setup discovery needs bounded review");
      const matches = list.data.filter(s => s.metadata?.setup_request_id === r.id);
      check(matches.length <= 1, "Ambiguous original monthly setup");
      if (matches.length) {
        check(r.dispatch_started_at, "Discovered monthly setup has no original dispatch");
        session = await checked(stripe.checkout.sessions.retrieve(matches[0].id)); check(session.id === matches[0].id);
      }
      else {
        check(r.expires_at - Math.floor(Date.now() / 1000) >= 1860, "Monthly setup creation window expired; keep the original request");
        await fresh(id, buyer, r.id);
        r = await action("claim", id, buyer, r.id);
        session = await checked(stripe.checkout.sessions.create(r.request,
          { idempotencyKey: "creatornet-monthly-card-setup:" + r.id, maxNetworkRetries: 0 }));
      }
    }
    const proof = inspectSession(session, r); await fresh(id, buyer, r.id);
    r = await action("bind", id, buyer, r.id, null, null, proof);
    if (session.status === "complete") return { membershipId: id, setupId: r.id, status: r.verified_at ? "card_saved_payment_not_attempted" as const : "setup_pending" as const };
    check(session.url, "Monthly card setup URL is unavailable"); const url = new URL(session.url);
    check(url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.username && !url.password && !url.port &&
      url.pathname.startsWith("/c/") && url.pathname.includes(session.id), "Invalid monthly setup destination");
    await fresh(id, buyer, r.id);
    return { membershipId: id, setupId: r.id, status: "setup_pending" as const, url: session.url };
  }
  async function verifyRenewalCardSetup(id: string, buyer: string, setup: string) {
    let r = await fresh(id, buyer, setup); check(r.session_id, "Monthly setup is not bound");
    const session = await checked(stripe.checkout.sessions.retrieve(r.session_id)), sessionProof = inspectSession(session, r);
    if (session.status !== "complete") return { membershipId: id, setupId: r.id, status: "setup_pending" as const };
    const intent = await checked(stripe.setupIntents.retrieve(sid(session.setup_intent, "seti")));
    check(intent.object === "setup_intent" && intent.id === sid(session.setup_intent, "seti") && intent.livemode === (context.mode === "live") && sid(intent.customer, "cus") === r.snapshot.customerId &&
      intent.status === "succeeded" && intent.usage === "off_session" && intent.on_behalf_of === null &&
      Number.isSafeInteger(intent.created) && intent.created >= r.created_at && intent.created <= Math.floor(Date.now() / 1000) &&
      intent.payment_method_types.length === 1 && intent.payment_method_types[0] === "card" && isDeepStrictEqual(intent.metadata, monthlyCardSetupMetadata(r)),
    "Monthly SetupIntent differs");
    const card = await checked(stripe.paymentMethods.retrieve(sid(intent.payment_method, "pm")));
    check(card.object === "payment_method" && card.id === sid(intent.payment_method, "pm") && card.livemode === (context.mode === "live") && card.type === "card" &&
      sid(card.customer, "cus") === r.snapshot.customerId, "Saved monthly card ownership differs");
    const proof = { ...sessionProof, setupIntentId: intent.id, paymentMethodId: card.id, setupStatus: intent.status, usage: intent.usage,
      setupCustomerId: r.snapshot.customerId, cardCustomerId: r.snapshot.customerId, cardType: card.type, setupMetadata: intent.metadata,
      setupRequestId: intent.lastResponse.requestId, cardRequestId: card.lastResponse.requestId };
    r = await fresh(id, buyer, r.id); r = await action("verify", id, buyer, r.id, null, null, proof);
    check(r.setup_intent_id === intent.id && r.payment_method_id === card.id && r.verified_at);
    return { membershipId: id, setupId: r.id, status: "card_saved_payment_not_attempted" as const };
  }
  return { currentRenewalRecovery, prepareRenewalCardSetup, verifyRenewalCardSetup };
}
