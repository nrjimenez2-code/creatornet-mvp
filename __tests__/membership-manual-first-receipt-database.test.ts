/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { installServerPaymentJournal } from "../test-support/server-payment-journal-postgres";
import { installMonthlyManualJournal } from "../test-support/monthly-manual-journal-postgres";
import { membershipFixture } from "../test-support/membership-fixtures";
import { buildMembershipSubscription } from "@/lib/membershipCheckout";
import { buildMembershipManualContract } from "@/lib/membershipManualContract";
import { serverPaymentCreateRequest } from "@/lib/serverPaymentConfirmation";

declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const sql = (file: string) => readFileSync(file, "utf8");
function definition(source: string, name: string) {
  const start = source.indexOf(`create function public.${name}(`);
  if (start < 0) throw Error(`Missing original ${name}`);
  const end = source.indexOf("$$;", start);
  if (end < 0) throw Error(`Incomplete original ${name}`);
  return source.slice(start, end + 3);
}
async function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await db.query(`insert into public.${table}(${columns.join(",")}) values(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row));
}
const scalar = async (name: string, args: unknown[]) => copy((await db.query<{ value: unknown }>(
  `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) value`, args)).rows[0].value);

beforeAll(async () => {
  db = createLocalPostgres(); await installServerPaymentJournal(db); await installMonthlyManualJournal(db);
  await db.exec(`alter table public.monthly_mentorship_operations_v1 add column agreement_revision bigint;
    alter table public.monthly_mentorship_receipts_v1 add column ledger_id uuid,
      add column period_start bigint,add column period_end bigint,add column provider_proof jsonb;
    alter table public.monthly_mentorship_receipts_v1 add constraint receipt_ledger_unique unique(ledger_id);
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
      add column kind text,add column status text,add column subscription_id text,add column session_id text,
      add column first_access_at timestamptz,add column paid_at timestamptz;
    alter table public.profiles add column total_earnings_cents bigint default 0;`);
  const hosted = sql("supabase/proposals/078-monthly-mentorship-receipts.sql");
  await db.exec(definition(hosted, "monthly_mentorship_boundary_v1"));
  await db.exec(definition(hosted, "record_monthly_mentorship_receipt_v1"));
  await db.exec(sql("supabase/migrations/20260925064000_monthly_manual_first_receipt.sql"));
});
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function fixture() {
  const f = membershipFixture(), a = copy(f.a);
  a.stripe_customer_id = null; a.stripe_subscription_id = null; a.stripe_checkout_session_id = null;
  Object.assign(a, { billing_review_at: null, initial_abandon_requested_at: null,
    initial_abandoned_at: null, payoff_hold_at: null });
  const context = { version: "exact-payment-context-v1" as const, mode: a.terms.paymentContext.mode,
    platformAccountId: a.terms.paymentContext.stripeAccountId,
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
  await insert("purchases", { id: a.purchase_id, buyer_id: a.buyer_id, product_id: a.product_id,
    post_id: a.post_id, monthly_mentorship_id: a.id, kind: "monthly_mentorship_v1", status: "pending" });
  const requests = { customer: { method: "POST", path: "/v1/customers", params: {} },
    product: { method: "POST", path: "/v1/products", params: {} },
    subscription: { method: "POST", path: "/v1/subscriptions",
      params: buildMembershipSubscription(a, f.customer.id, f.product.id) },
    hold: { method: "POST", path: `/v1/subscriptions/${f.subscription.id}`,
      params: { pause_collection: { behavior: "keep_as_draft" } } } };
  for (const kind of ["customer", "product", "subscription", "hold"] as const)
    await insert("monthly_mentorship_operations_v1", { agreement_id: a.id, kind,
      scope_key: "initial", request: requests[kind], status: "complete", agreement_revision: a.revision,
      provider_id: kind === "customer" ? f.customer.id : kind === "product" ? f.product.id : f.subscription.id });
  const selection = await scalar("select_monthly_manual_payment_v1",
    [a.id, a.buyer_id, a.terms.paymentContext, "first", null]) as any;
  await scalar("register_monthly_manual_source_v1", [selection.id, a.buyer_id, context]);
  const contract = buildMembershipManualContract({ selection, agreement: a,
    contextEvidence: evidence, now: Math.floor(Date.now() / 1000), customer: f.customer,
    firstPreparation: { customerId: f.customer.id, productId: f.product.id,
      subscriptionId: f.subscription.id, subscription: f.subscription } });
  const request = serverPaymentCreateRequest(contract, evidence);
  const dispatch = Math.floor(Date.now() / 1000) - 5, paidAt = dispatch + 2;
  await insert("server_payment_intent_operations_v1", { attempt_id: selection.id,
    contract, request, first_dispatch_at: new Date(dispatch * 1000).toISOString(),
    payment_intent_id: "pi_monthly", provider_request_id: "req_monthly",
    bound_at: new Date((dispatch + 1) * 1000).toISOString() });
  const operationId = "40000000-0000-4000-8000-000000000002";
  await insert("server_payment_confirmations_v1", { operation_id: operationId,
    attempt_id: selection.id, phase: 1, payment_intent_id: "pi_monthly",
    basis: { kind: "token" }, request: {},
    dispatch_before: new Date((dispatch + 30) * 1000).toISOString(),
    latest_observation: { status: "succeeded", paymentIntentId: "pi_monthly",
      chargeId: "ch_monthly", paymentMethodId: "pm_monthly" } });
  const fees = a.terms.firstMonthFees;
  const ledgerId = "40000000-0000-4000-8000-000000000003";
  await insert("payment_fee_ledger", { id: ledgerId, purchase_id: a.purchase_id,
    creator_id: a.creator_id, stripe_payment_intent_id: "pi_monthly",
    stripe_charge_id: "ch_monthly", stripe_balance_transaction_id: "txn_monthly",
    actual_stripe_fee_cents: 320, gross_amount_cents: a.monthly_price_cents,
    platform_fee_cents: fees.platformFeeCents, processing_fee_cents: fees.processingFeeCents,
    total_creator_deduction_cents: fees.totalCreatorDeductionCents,
    creator_net_cents: fees.creatorNetCents, fee_schedule_version: fees.feeScheduleVersion,
    currency: "usd", status: "paid" });
  const proof = { version: "monthly-mentorship-payment-proof-v1", paymentContext: a.terms.paymentContext,
    customerId: f.customer.id, subscriptionId: f.subscription.id, checkoutSessionId: null,
    destinationId: a.terms.destinationId, paymentIntentId: "pi_monthly", chargeId: "ch_monthly",
    invoiceId: null, capturedAmountCents: a.monthly_price_cents,
    applicationFeeAmountCents: fees.totalCreatorDeductionCents, paymentStatus: "succeeded",
    paymentMethodId: "pm_monthly", paidAt, balanceTransactionId: "txn_monthly",
    transferId: "tr_monthly", actualStripeFeeCents: 320, buyerCountry: "US",
    manualPayment: { attemptId: selection.id, confirmationOperationId: operationId } };
  const record = (nextProof: unknown = proof, actor = a.buyer_id) => scalar("record_monthly_manual_first_receipt_v1",
    [a.id, actor, context, selection.id, ledgerId, nextProof]);
  return { a, selection, ledgerId, proof, record };
}

test("original captured manual first payment binds, credits and replays once with no Checkout Session", async () => {
  const f = await fixture();
  await db.exec("set local role service_role");
  expect(await f.record()).toBe(true);
  expect(await f.record()).toBe(false);
  await db.exec("reset role");
  const agreement = (await db.query<any>("select * from monthly_mentorship_agreements_v1 where id=$1", [f.a.id])).rows[0];
  const purchase = (await db.query<any>("select * from purchases where id=$1", [f.a.purchase_id])).rows[0];
  const receipt = (await db.query<any>("select * from monthly_mentorship_receipts_v1 where agreement_id=$1", [f.a.id])).rows;
  const creator = (await db.query<any>("select total_earnings_cents from profiles where id=$1", [f.a.creator_id])).rows[0];
  expect(agreement).toMatchObject({ stripe_customer_id: "cus_fixture",
    stripe_subscription_id: "sub_fixture", stripe_checkout_session_id: null, covered_months: 1 });
  expect(purchase).toMatchObject({ subscription_id: "sub_fixture", session_id: null, status: "active" });
  expect(receipt).toHaveLength(1);
  expect(creator.total_earnings_cents).toBe(f.a.terms.firstMonthFees.creatorNetCents);
});

test.each(["foreign owner", "different captured charge", "refunded ledger"] as const)(
  "rejects %s without binding or credit", async fault => {
    const f = await fixture();
    if (fault === "refunded ledger") await db.query(
      "update payment_fee_ledger set status='refunded',refunded_amount_cents=100 where id=$1", [f.ledgerId]);
    await db.exec("savepoint rejected_receipt;set local role service_role");
    await expect(f.record(fault === "different captured charge" ?
      { ...f.proof, chargeId: "ch_other" } : f.proof,
    fault === "foreign owner" ? f.a.creator_id : f.a.buyer_id)).rejects.toThrow();
    await db.exec("rollback to savepoint rejected_receipt;reset role");
    const agreement = (await db.query<any>("select stripe_customer_id,stripe_subscription_id,covered_months from monthly_mentorship_agreements_v1 where id=$1", [f.a.id])).rows[0];
    expect(agreement).toEqual({ stripe_customer_id: null, stripe_subscription_id: null, covered_months: 0 });
    expect((await db.query("select * from monthly_mentorship_receipts_v1")).rows).toHaveLength(0);
  });

test("client roles cannot invoke the accounting adapter", async () => {
  const f = await fixture();
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`savepoint denied;set local role ${role}`);
    await expect(f.record()).rejects.toThrow("permission denied");
    await db.exec("rollback to savepoint denied");
  }
});
