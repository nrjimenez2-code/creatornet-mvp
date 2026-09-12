import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import type { MembershipPaymentContext } from "./membershipAgreement";
import { membershipMonthBoundary } from "./membershipAgreement";
import { membershipCheck as check, membershipStripeId as sid, membershipMetadata, assertMembershipHeld, type MembershipRecord } from "./membershipCheckout";
import { runMembershipOperation } from "./membershipOperation";
import { monthlyCardForService, monthlyInvoiceCard, monthlyCaptureAuthority } from "./membershipCards";
import { assertMembershipActivated, assertMembershipInvoice, inspectMembershipRenewalCapture, membershipActivationParams,
  membershipInvoiceConfiguration, membershipInvoicePayParams, membershipRenewalPeriod, readMembershipFirstProof, type MembershipFirstProof } from "./membershipRenewal";
import { recordPaymentFeeLedger } from "./paymentFeeLedger";
import { reconcileKnownPaymentDispute } from "./paymentDisputes";
import { assertMembershipBootstrapInvoice, reconcileMembershipActivation } from "./membershipActivationRecovery";
import { applyPaymentRefundState, reconcileKnownPaymentRefund, recordPaymentRefundState } from "./paymentRefunds";

export type MembershipBillingDependencies = { admin: SupabaseClient; stripe: Stripe; context: MembershipPaymentContext;
  env: Record<string, string | undefined>; checked: <T>(promise: Promise<Stripe.Response<T>>) => Promise<Stripe.Response<T>>;
  observeContext: () => Promise<MembershipPaymentContext>; load: (id: string, buyerId: string) => Promise<MembershipRecord>;
  productId: (a: MembershipRecord) => Promise<string> };
export function createMembershipBillingRuntime(d: MembershipBillingDependencies) {
  const { admin, stripe, context, env, checked, observeContext, load, productId } = d;
  const newCollectionReady = () => check(["CREATOR_MONTHLY_MENTORSHIPS_COLLECTION_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_RENEWALS_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY", "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_READY", "CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_READY", "CREATOR_MONTHLY_MENTORSHIPS_ACTIVATION_RECOVERY_SCHEMA_READY"]
    .every(key => env[key] === "true"), "Monthly renewal collection is not enabled");
  const reconciliationReady = () => check(env.CREATOR_MONTHLY_MENTORSHIPS_COLLECTION_SCHEMA_READY === "true" &&
    env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY === "true", "Monthly renewal reconciliation is not enabled");
  async function first(a: MembershipRecord) {
    const row = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", a.id).eq("month_number", 1).maybeSingle();
    check(!row.error && row.data); return readMembershipFirstProof(a, row.data.provider_proof);
  }
  async function knownOperation(a: MembershipRecord, kind: "activate" | "collect", scope: string) {
    const row = await admin.from("monthly_mentorship_operations_v1").select("id,status,provider_id,request,scope_key")
      .eq("agreement_id", a.id).eq("kind", kind).eq("scope_key", scope).maybeSingle();
    check(!row.error); return row.data;
  }
  async function card(a: MembershipRecord, proof: MembershipFirstProof, original = proof) {
    const customer = await checked(stripe.customers.retrieve(a.stripe_customer_id!));
    const pm = await checked(stripe.paymentMethods.retrieve(proof.paymentMethodId));
    check(!customer.deleted && customer.id === a.stripe_customer_id && customer.livemode === (context.mode === "live") &&
      customer.balance === 0 && customer.default_source == null && customer.test_clock == null && !customer.delinquent &&
      (customer.invoice_settings.default_payment_method == null || customer.invoice_settings.default_payment_method === original.paymentMethodId) &&
      isDeepStrictEqual(customer.metadata, membershipMetadata(a, "customer")) && pm.object === "payment_method" && pm.id === proof.paymentMethodId &&
      pm.type === "card" && pm.customer === a.stripe_customer_id && pm.livemode === (context.mode === "live"));
  }
  async function activate(id: string, buyerId: string) {
    newCollectionReady(); const a = await load(id, buyerId); await observeContext();
    check(!a.financial_hold_at && !a.debit_revoked_at && !a.renewal_stopped_at, "Stopped monthly service cannot be activated");
    const proof = await first(a), product = await productId(a), prior = await knownOperation(a, "activate", "initial");
    const inspectActivationInputs = async () => {
      check(Math.floor(Date.now() / 1000) < membershipMonthBoundary(proof.paidAt, 1), "Late monthly activation requires recovery");
      await card(a, proof);
      const sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!));
      if (sub.metadata.creatornet_membership_activation) {
        await reconcileMembershipActivation(admin, env, a, product, proof, sub); return true;
      }
      assertMembershipHeld(sub, a, a.stripe_customer_id!, product, true, true);
      const invoices = await checked(stripe.invoices.list({ subscription: a.stripe_subscription_id!, limit: 100 }));
      check(invoices.has_more === false && invoices.data.length <= 8, "Unexpected invoice count before monthly activation");
      for (const inv of invoices.data) {
        check(assertMembershipBootstrapInvoice(inv, a, product) !== "activation_zero", "Activation invoice lacks original activation evidence");
        const links = await checked(stripe.invoicePayments.list({ invoice: inv.id, limit: 100 }));
        check(links.has_more === false && links.data.length === 0, "Bootstrap invoice has unexpected payment evidence");
      }
      return false;
    };
    if (prior?.status !== "complete") {
      const sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!));
      if (sub.metadata.creatornet_membership_activation) {
        await reconcileMembershipActivation(admin, env, a, product, proof, sub);
        return { status: "activated_held" as const, membershipId: a.id, subscriptionId: sub.id };
      }
      if (Math.floor(Date.now() / 1000) >= membershipMonthBoundary(proof.paidAt, 1)) {
        const reviewed = await admin.rpc("review_monthly_mentorship_late_activation_v1", {
          p_id: a.id, p_buyer_id: a.buyer_id, p_context: context,
        });
        check(!reviewed.error && reviewed.data === true, "Late monthly activation review needs retry");
        return { status: "stopped" as const, membershipId: a.id,
          reason: "late_activation_review_required" as const, billingBlocked: true, balanceWaived: false };
      }
      await inspectActivationInputs();
    }
    const request = { method: "POST" as const, path: `/v1/subscriptions/${a.stripe_subscription_id}`,
      params: membershipActivationParams(a, proof) as Record<string, unknown> };
    const sub = await runMembershipOperation({ admin, agreementId: a.id, actorId: a.buyer_id, revision: a.revision,
      kind: "activate", scope: "initial", context, request, env, observeContext,
      create: async (saved, opts) => {
        const current = await load(a.id, a.buyer_id);
        check(current.revision === a.revision && !current.billing_review_at && !current.financial_hold_at &&
          !current.debit_revoked_at && !current.renewal_stopped_at, "Activation was stopped or changed before dispatch");
        if (await inspectActivationInputs()) return checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!));
        await observeContext();
        const still = await admin.rpc("claim_monthly_mentorship_operation_v1", { p_agreement_id: a.id, p_actor_id: a.buyer_id,
          p_kind: "activate", p_scope: "initial", p_revision: a.revision, p_context: context, p_request: saved });
        check(!still.error && still.data?.status === "dispatched" && "creatornet-membership:" + still.data.id === opts.idempotencyKey,
          "Activation was stopped or changed before dispatch");
        return checked(stripe.subscriptions.update(a.stripe_subscription_id!, saved.params as Stripe.SubscriptionUpdateParams, opts));
      },
      retrieve: providerId => checked(stripe.subscriptions.retrieve(providerId)), validate: value => { assertMembershipActivated(value, a, product, proof); } });
    return { status: "activated_held" as const, membershipId: a.id, subscriptionId: sub.id };
  }
  async function payments(invoiceId: string) {
    const links = await checked(stripe.invoicePayments.list({ invoice: invoiceId, limit: 100 }));
    check(links.has_more === false && links.data.length === 1, "Monthly invoice payment linkage requires review");
    return links.data[0];
  }
  async function recordCapture(a: MembershipRecord, proof: MembershipFirstProof, month: number, product: string, inv: Stripe.Response<Stripe.Invoice>) {
    assertMembershipInvoice(inv, a, proof, month, product, "paid");
    const prior = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", a.id).eq("month_number", month).maybeSingle();
    check(!prior.error);
    if (prior.data) { check(prior.data.provider_proof?.invoiceId === inv.id); return { status: "already_recorded" as const, membershipId: a.id, month }; }
    const link = await payments(inv.id), pi = await checked(stripe.paymentIntents.retrieve(sid(link.payment.payment_intent, "pi")));
    const charge = await checked(stripe.charges.retrieve(sid(pi.latest_charge, "ch")));
    const balance = await checked(stripe.balanceTransactions.retrieve(sid(charge.balance_transaction, "txn")));
    const authority = await monthlyCaptureAuthority(d, a, proof, month, inv.id, pi.id, sid(pi.payment_method, "pm"), charge.created);
    const evidence = inspectMembershipRenewalCapture(a, authority.proof, month, inv, link, pi, charge, balance, inv.lastResponse.requestId);
    await observeContext();
    const ledgerId = await recordPaymentFeeLedger(admin, { breakdown: a.terms.recurringMonthFees, currency: "usd", creatorId: a.creator_id,
      purchaseId: a.purchase_id, invoiceId: inv.id, paymentIntentId: pi.id, stripeFee: evidence.stripeFee }, true);
    check(ledgerId);
    if (charge.amount_refunded > 0) {
      const state = await recordPaymentRefundState(admin, { paymentIntentId: pi.id, chargeId: charge.id,
        chargeAmountCents: charge.amount, refundedAmountCents: charge.amount_refunded });
      await applyPaymentRefundState(admin, state);
    }
    await reconcileKnownPaymentRefund(admin, pi.id);
    await reconcileKnownPaymentDispute(admin, pi.id);
    if (charge.disputed) {
      const row = await admin.from("payment_fee_ledger").select("dispute_status").eq("id", ledgerId).maybeSingle();
      check(!row.error && ["won", "warning_closed"].includes(row.data?.dispute_status), "Monthly dispute needs reconciliation before credit");
    }
    const saved = await admin.rpc("record_monthly_mentorship_receipt_v1", { p_id: a.id, p_ledger_id: ledgerId, p_month: month,
      p_start: evidence.period.start, p_end: evidence.period.end, p_proof: { ...evidence.providerProof, ...authority.extension } });
    check(!saved.error && typeof saved.data === "boolean", "Monthly renewal receipt needs retry or review");
    return { status: "recorded" as const, membershipId: a.id, month };
  }
  async function reconcileInvoice(id: string, buyerId: string, invoiceId: string) {
    reconciliationReady(); sid(invoiceId, "in"); const a = await load(id, buyerId); await observeContext();
    const row = await admin.from("monthly_mentorship_operations_v1").select("scope_key,request,provider_id,status")
      .eq("agreement_id", a.id).eq("kind", "collect").eq("request->>path", `/v1/invoices/${invoiceId}/pay`).maybeSingle();
    check(!row.error && row.data && /^[1-9][0-9]{0,8}$/.test(row.data.scope_key), "Monthly invoice has no owned collection admission");
    const month = Number(row.data.scope_key), original = await first(a), product = await productId(a);
    const proof = monthlyInvoiceCard(d, original, row.data.request, invoiceId);
    const inv = await checked(stripe.invoices.retrieve(invoiceId));
    if (inv.status !== "paid") return { status: "payment_pending" as const, membershipId: id, month };
    return recordCapture(a, proof, month, product, inv);
  }
  async function collectNext(id: string, buyerId: string) {
    newCollectionReady(); const a = await load(id, buyerId); await observeContext();
    if (a.covered_months < 1 || !a.auto_renew && a.covered_months >= a.minimum_months) return { status: "nothing_due" as const, membershipId: id };
    const p = membershipRenewalPeriod(a), prior = await knownOperation(a, "collect", String(p.month));
    if (prior) {
      check(typeof prior.request?.path === "string" && /^\/v1\/invoices\/in_[A-Za-z0-9]+\/pay$/.test(prior.request.path));
      const invoiceId = prior.request.path.split("/")[3];
      const observed = await reconcileInvoice(id, buyerId, invoiceId);
      if (observed.status !== "payment_pending") return observed;
      check(prior.status === "dispatched", "Monthly payment needs buyer recovery or review");
    }
    if (a.financial_hold_at || a.debit_revoked_at || a.renewal_stopped_at) return { status: "stopped" as const, membershipId: id };
    const now = Math.floor(Date.now() / 1000);
    if (now < p.start) return { status: "nothing_due" as const, membershipId: id };
    check(now < p.end, "Elapsed unpaid monthly service needs recovery, not automatic catch-up charges");
    const original = await first(a), product = await productId(a);
    const proof = prior ? monthlyInvoiceCard(d, original, prior.request, prior.request.path.split("/")[3]) : await monthlyCardForService(d, a, original, p.month);
    const activation = await knownOperation(a, "activate", "initial");
    check(activation?.status === "complete", "Monthly renewal activation is incomplete");
    const sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!));
    const itemId = assertMembershipActivated(sub, a, product, original); await card(a, proof, original);
    let invoiceId: string;
    if (prior) invoiceId = prior.request.path.split("/")[3];
    else {
      const list = await checked(stripe.invoices.list({ subscription: a.stripe_subscription_id!, created: { gte: p.providerStart - 60, lte: now }, limit: 100 }));
      check(list.has_more === false, "Monthly invoice discovery needs bounded review");
      const matches = list.data.filter(inv => inv.billing_reason === "subscription_cycle" && inv.lines?.data?.some(line =>
        line.parent?.subscription_item_details?.subscription === a.stripe_subscription_id && line.period.start === p.providerStart && line.period.end === p.providerEnd));
      if (!matches.length) return { status: "awaiting_invoice" as const, membershipId: id };
      check(matches.length === 1, "More than one invoice claims the monthly service period");
      assertMembershipInvoice(matches[0], a, proof, p.month, product, "held", itemId); invoiceId = sid(matches[0].id, "in");
    }
    const request = { method: "POST" as const, path: `/v1/invoices/${invoiceId}/pay`, params: membershipInvoicePayParams(proof) as Record<string, unknown> };
    const operationArgs = { admin, agreementId: a.id, actorId: a.creator_id, revision: a.revision, kind: "collect" as const,
      scope: String(p.month), context, request, env, observeContext };
    const paid = await runMembershipOperation({ ...operationArgs,
      retrieve: providerId => checked(stripe.invoices.retrieve(providerId)),
      validate: inv => { check(inv.id === invoiceId); assertMembershipInvoice(inv, a, proof, p.month, product, "paid", itemId); },
      create: async (saved, options) => {
        let inv = await checked(stripe.invoices.retrieve(invoiceId));
        if (inv.status === "paid") { assertMembershipInvoice(inv, a, proof, p.month, product, "paid", itemId); return inv; }
        assertMembershipInvoice(inv, a, proof, p.month, product, "held", itemId);
        const key = options.idempotencyKey;
        if (inv.status === "draft") {
          const line = inv.lines.data[0];
          if (line.period.start !== p.start || line.period.end !== p.end) {
            // Only the displayed/recognized service period is changed. Price,
            // quantity, subscription cadence and amount are not rewritten.
            await checked(stripe.invoices.updateLineItem(invoiceId, line.id, { period: { start: p.start, end: p.end } },
              { ...options, idempotencyKey: `${key}:period` }));
          }
          await checked(stripe.invoices.update(invoiceId, membershipInvoiceConfiguration(a, proof, p.month), { ...options, idempotencyKey: `${key}:configure` }));
          inv = await checked(stripe.invoices.retrieve(invoiceId)); assertMembershipInvoice(inv, a, proof, p.month, product, "configured", itemId);
          assertMembershipActivated(await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!)), a, product, original);
          inv = await checked(stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: false }, { ...options, idempotencyKey: `${key}:finalize` }));
        }
        assertMembershipInvoice(inv, a, proof, p.month, product, "configured", itemId);
        const link = await payments(invoiceId), pi = await checked(stripe.paymentIntents.retrieve(sid(link.payment.payment_intent, "pi")));
        check(link.invoice === invoiceId && link.livemode === (context.mode === "live") && link.is_default && link.currency === "usd" &&
          link.amount_requested === a.monthly_price_cents && link.amount_paid == null && link.status === "open" && link.payment.type === "payment_intent" &&
          pi.customer === a.stripe_customer_id && pi.currency === "usd" && pi.livemode === (context.mode === "live") && pi.amount === a.monthly_price_cents &&
          pi.application_fee_amount === a.terms.recurringMonthFees.totalCreatorDeductionCents && pi.transfer_data?.destination === a.terms.destinationId &&
          pi.transfer_data.amount == null && isDeepStrictEqual(pi.payment_method_types, ["card"]));
        if (inv.attempt_count !== 0 || pi.amount_received !== 0 || pi.latest_charge != null || !["requires_payment_method", "requires_confirmation"].includes(pi.status)) {
          const held = await admin.rpc("review_monthly_mentorship_collection_v1", { p_id: a.id, p_month: p.month, p_context: context });
          check(!held.error); throw Error("Monthly payment needs explicit recovery, not another automatic attempt");
        }
        await observeContext(); assertMembershipActivated(await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!)), a, product, original);
        // Recheck the exact same durable claim immediately before the debit.
        // A stop/revision change during invoice preparation prevents payment.
        const still = await admin.rpc("claim_monthly_mentorship_operation_v1", { p_agreement_id: a.id, p_actor_id: a.creator_id,
          p_kind: "collect", p_scope: String(p.month), p_revision: a.revision, p_context: context, p_request: saved });
        check(!still.error && still.data?.status === "dispatched" && `creatornet-membership:${still.data.id}` === key,
          "Monthly collection was stopped or changed before debit");
        return checked(stripe.invoices.pay(invoiceId, saved.params as Stripe.InvoicePayParams, options));
      } });
    return recordCapture(a, proof, p.month, product, paid);
  }
  return { activate, collectNext, reconcileInvoice };
}
