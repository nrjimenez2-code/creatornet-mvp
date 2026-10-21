/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { installServerPaymentJournal } from "../test-support/server-payment-journal-postgres";
import { installMonthlyManualJournal } from "../test-support/monthly-manual-journal-postgres";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";
import { buildMembershipManualContract } from "@/lib/membershipManualContract";
import { serverPaymentCreateRequest } from "@/lib/serverPaymentConfirmation";

declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
async function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await db.query(`insert into public.${table}(${columns.join(",")}) values(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row));
}
const scalar = async (name: string, args: unknown[]) => copy((await db.query<{ value: unknown }>(
  `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) value`, args)).rows[0].value);

beforeAll(async () => {
  db = createLocalPostgres(); await installServerPaymentJournal(db); await installMonthlyManualJournal(db);
  await db.exec(`alter table public.monthly_mentorship_agreements_v1 add column billing_next_attempt_at timestamptz;
    alter table public.payment_fee_ledger add column id uuid primary key default gen_random_uuid(),
      add column creator_id uuid,add column stripe_checkout_session_id text,add column stripe_invoice_id text,
      add column stripe_charge_id text,add column stripe_balance_transaction_id text,
      add column actual_stripe_fee_cents bigint,add column gross_amount_cents bigint,
      add column platform_fee_cents bigint,add column processing_fee_cents bigint,
      add column total_creator_deduction_cents bigint,add column creator_net_cents bigint,
      add column fee_schedule_version text,add column currency text,add column status text,
      add column refunded_amount_cents bigint default 0,add column earnings_reversed_cents bigint default 0,
      add column earnings_credited_at timestamptz,add column dispute_status text,
      add column updated_at timestamptz;
    alter table public.purchases add column id uuid primary key,add column monthly_mentorship_id uuid,
      add column status text,add column subscription_id text;
    alter table public.profiles add column total_earnings_cents bigint default 0;
    create table public.monthly_mentorship_exit_requests_v1(
      agreement_id uuid,buyer_id uuid,kind text,accepted_snapshot jsonb,unique(agreement_id,kind));
    create function public.record_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,uuid,jsonb)
      returns boolean language sql as $$select false$$;`);
  await db.exec(readFileSync("supabase/migrations/20260925231000_monthly_manual_payoff_receipt.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260925234000_monthly_manual_payoff_terminal_release.sql", "utf8"));
});
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function fixture(mode: "captured" | "unregistered" | "registered_no_intent" |
  "unbound" | "bound_terminal" = "captured") {
  const f = membershipPayoffFixture(false), a = copy(f.a), payoff = copy(f.p);
  payoff.status = "accepted"; payoff.checkout_request = null;
  payoff.checkout_dispatched_at = null; payoff.stripe_checkout_session_id = null;
  Object.assign(a, { billing_review_at: null, initial_abandon_requested_at: null,
    initial_abandoned_at: null, payoff_hold_at: new Date().toISOString() });
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
  await db.query("insert into exact_installment_context_pin_v2 values(true,$1)", [context]);
  await db.query("insert into profiles(id,stripe_account_id,stripe_onboarding_complete) values($1,null,false),($2,$3,true)",
    [a.buyer_id, a.creator_id, a.terms.destinationId]);
  await insert("monthly_mentorship_agreements_v1", a);
  await insert("purchases", { id: a.purchase_id, buyer_id: a.buyer_id,
    product_id: a.product_id, post_id: a.post_id, monthly_mentorship_id: a.id,
    status: "active", subscription_id: a.stripe_subscription_id });
  await insert("monthly_mentorship_payoffs_v1", { ...payoff,
    amount_cents: payoff.terms.amountCents, remaining_months: payoff.terms.remainingMonths,
    first_unpaid_month: payoff.terms.firstUnpaidMonth,
    period_start: payoff.terms.periodStart, period_end: payoff.terms.periodEnd });
  const selection = await scalar("select_monthly_manual_payment_v1",
    [a.id, a.buyer_id, a.terms.paymentContext, "payoff", payoff.id]) as any;
  if (mode !== "unregistered")
    await scalar("register_monthly_manual_source_v1", [selection.id, a.buyer_id, context]);
  const contract = buildMembershipManualContract({ selection, agreement: a, payoff,
    contextEvidence: evidence, now: Math.floor(Date.now() / 1000), customer: f.customer });
  const request = serverPaymentCreateRequest(contract, evidence);
  const dispatch = Math.floor(Date.now() / 1000) - 4, paidAt = dispatch + 2;
  if (mode === "captured" || mode === "bound_terminal" || mode === "unbound")
    await insert("server_payment_intent_operations_v1", { attempt_id: selection.id,
      contract, request, first_dispatch_at: new Date(dispatch * 1000).toISOString(),
      payment_intent_id: mode === "unbound" ? null : "pi_manualpayoff",
      provider_request_id: mode === "unbound" ? null : "req_manualpayoff",
      bound_at: mode === "unbound" ? null : new Date((dispatch + 1) * 1000).toISOString() });
  const operationId = "40000000-0000-4000-8000-000000000012";
  if (mode === "captured") await insert("server_payment_confirmations_v1", { operation_id: operationId,
    attempt_id: selection.id, phase: 1, payment_intent_id: "pi_manualpayoff",
    basis: { kind: "token" }, request: {},
    dispatch_before: new Date((dispatch + 30) * 1000).toISOString(),
    latest_observation: { status: "succeeded", paymentIntentId: "pi_manualpayoff",
      chargeId: "ch_manualpayoff", paymentMethodId: "pm_manualpayoff" } });
  const fees = payoff.terms.fees, ledgerId = "40000000-0000-4000-8000-000000000013";
  if (mode === "captured") await insert("payment_fee_ledger", { id: ledgerId, purchase_id: a.purchase_id,
    creator_id: a.creator_id, stripe_payment_intent_id: "pi_manualpayoff",
    stripe_charge_id: "ch_manualpayoff", stripe_balance_transaction_id: "txn_manualpayoff",
    actual_stripe_fee_cents: 610, gross_amount_cents: payoff.terms.amountCents,
    platform_fee_cents: fees.platformFeeCents, processing_fee_cents: fees.processingFeeCents,
    total_creator_deduction_cents: fees.totalCreatorDeductionCents,
    creator_net_cents: fees.creatorNetCents, fee_schedule_version: fees.feeScheduleVersion,
    currency: "usd", status: "paid" });
  if (mode === "registered_no_intent" || mode === "unbound" || mode === "bound_terminal")
    await insert("server_payment_stops_v1", { attempt_id: selection.id });
  const terminalProof = { version: "server-payment-intent-terminal-v1",
    paymentIntentId: "pi_manualpayoff", status: "canceled", amountReceived: 0,
    amountCapturable: 0, canceledAt: dispatch + 2, observedAt: dispatch + 3,
    chargeIds: [] };
  if (mode === "bound_terminal") await insert("server_payment_intent_terminal_v1", {
    attempt_id: selection.id, proof: terminalProof });
  const proof = { version: "monthly-mentorship-payoff-proof-v1",
    paymentContext: a.terms.paymentContext, payoffId: payoff.id,
    payoffFingerprint: payoff.fingerprint, customerId: a.stripe_customer_id,
    subscriptionId: a.stripe_subscription_id, checkoutSessionId: null,
    destinationId: a.terms.destinationId, paymentIntentId: "pi_manualpayoff",
    chargeId: "ch_manualpayoff", capturedAmountCents: payoff.terms.amountCents,
    applicationFeeAmountCents: fees.totalCreatorDeductionCents,
    paymentStatus: "succeeded", paymentMethodId: "pm_manualpayoff", paidAt,
    periodStart: payoff.terms.periodStart, periodEnd: payoff.terms.periodEnd,
    balanceTransactionId: "txn_manualpayoff", transferId: "tr_manualpayoff",
    actualStripeFeeCents: 610, buyerCountry: "US",
    manualPayment: { attemptId: selection.id, confirmationOperationId: operationId } };
  const record = (nextProof: unknown = proof, actor = a.buyer_id) =>
    scalar("record_monthly_manual_payoff_receipt_v1",
      [payoff.id, actor, context, selection.id, ledgerId, nextProof]);
  const releaseProof = { version: "monthly-manual-payoff-terminal-v1",
    paymentContext: a.terms.paymentContext, payoffId: payoff.id, selectionId: selection.id,
    neverDispatched: mode !== "bound_terminal", paymentIntentId: mode === "bound_terminal" ? "pi_manualpayoff" : null,
    terminalProof: mode === "bound_terminal" ? terminalProof : null };
  const release = (nextProof: unknown = releaseProof, actor = a.buyer_id) =>
    scalar("release_monthly_manual_payoff_v1",
      [payoff.id, actor, context, selection.id, nextProof]);
  return { a, payoff, selection, ledgerId, proof, record, releaseProof, release };
}

test("one captured manual payoff credits once, settles the minimum and requests a renewal stop", async () => {
  const f = await fixture();
  await db.exec("set local role service_role");
  expect(await f.record()).toBe(true);
  expect(await f.record()).toBe(false);
  await db.exec("reset role");
  const agreement = (await db.query<any>("select * from monthly_mentorship_agreements_v1 where id=$1", [f.a.id])).rows[0];
  const payoff = (await db.query<any>("select * from monthly_mentorship_payoffs_v1 where id=$1", [f.payoff.id])).rows[0];
  const creator = (await db.query<any>("select total_earnings_cents from profiles where id=$1", [f.a.creator_id])).rows[0];
  expect(agreement.covered_months).toBe(f.a.minimum_months);
  expect(agreement.payoff_hold_at).toBeNull();
  expect(payoff.status).toBe("captured");
  expect(payoff.stripe_checkout_session_id).toBeNull();
  expect(creator.total_earnings_cents).toBe(f.payoff.terms.fees.creatorNetCents);
  expect((await db.query("select * from monthly_mentorship_exit_requests_v1 where agreement_id=$1", [f.a.id])).rows).toHaveLength(1);
});

test.each(["foreign owner", "foreign country", "different charge", "refunded ledger"] as const)(
  "rejects %s without payoff credit", async fault => {
    const f = await fixture();
    if (fault === "refunded ledger") await db.query(
      "update payment_fee_ledger set status='refunded',refunded_amount_cents=100 where id=$1", [f.ledgerId]);
    const proof = { ...f.proof,
      ...(fault === "foreign country" ? { buyerCountry: "CA" } : {}),
      ...(fault === "different charge" ? { chargeId: "ch_other" } : {}) };
    await db.exec("savepoint rejected_payoff;set local role service_role");
    await expect(f.record(proof, fault === "foreign owner" ? f.a.creator_id : f.a.buyer_id)).rejects.toThrow();
    await db.exec("rollback to savepoint rejected_payoff;reset role");
    expect((await db.query<any>("select status from monthly_mentorship_payoffs_v1 where id=$1", [f.payoff.id])).rows[0].status).toBe("accepted");
    expect((await db.query<any>("select total_earnings_cents from profiles where id=$1", [f.a.creator_id])).rows[0].total_earnings_cents).toBe(0);
  });

test("client roles cannot invoke payoff accounting", async () => {
  const f = await fixture();
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`savepoint denied;set local role ${role}`);
    await expect(f.record()).rejects.toThrow("permission denied");
    await db.exec("rollback to savepoint denied");
  }
});

test.each(["unregistered", "registered_no_intent", "bound_terminal"] as const)(
  "%s original payoff releases its hold only from verified zero-money terminal state", async mode => {
    const f = await fixture(mode);
    await db.exec("set local role service_role");
    expect(await f.release()).toBe(true);
    expect(await f.release()).toBe(false);
    await db.exec("reset role");
    const agreement = (await db.query<any>(
      "select payoff_hold_at,covered_months from monthly_mentorship_agreements_v1 where id=$1", [f.a.id])).rows[0];
    const payoff = (await db.query<any>(
      "select status,ledger_id,abandonment_proof from monthly_mentorship_payoffs_v1 where id=$1", [f.payoff.id])).rows[0];
    expect(agreement).toMatchObject({ payoff_hold_at: null, covered_months: 1 });
    expect(payoff).toMatchObject({ status: "abandoned", ledger_id: null,
      abandonment_proof: f.releaseProof });
    expect((await db.query("select * from payment_fee_ledger")).rows).toHaveLength(0);
  });

test.each(["unbound", "captured"] as const)(
  "%s original cannot release the payoff hold", async mode => {
    const f = await fixture(mode);
    await db.exec("savepoint denied_release;set local role service_role");
    await expect(f.release()).rejects.toThrow("terminal evidence is incomplete");
    await db.exec("rollback to savepoint denied_release;reset role");
    const agreement = (await db.query<any>(
      "select payoff_hold_at from monthly_mentorship_agreements_v1 where id=$1", [f.a.id])).rows[0];
    expect(agreement.payoff_hold_at).not.toBeNull();
  });

test("foreign release proof cannot unlock an unpaid payoff", async () => {
  const f = await fixture("bound_terminal");
  await db.exec("savepoint denied_release;set local role service_role");
  await expect(f.release({ ...f.releaseProof, terminalProof: null })).rejects.toThrow();
  await db.exec("rollback to savepoint denied_release;reset role");
  expect((await db.query<any>("select status from monthly_mentorship_payoffs_v1 where id=$1", [f.payoff.id])).rows[0].status)
    .toBe("accepted");
});
