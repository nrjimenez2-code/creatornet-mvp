/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotExactTerms, type ExactAgreementTerms } from "../lib/installments/agreementStore";

// Real SQL execution in an in-memory PostgreSQL engine. Minimal prerequisite
// tables model only the columns touched by migration 040; this is not a full
// Supabase migration-chain or concurrent multi-connection acceptance test.
const ids = {
  buyer: "11111111-1111-4111-8111-111111111111", creator: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
  booking: "55555555-5555-4555-8555-555555555555", bp: "66666666-6666-4666-8666-666666666666",
  plan: "77777777-7777-4777-8777-777777777777", token: "88888888-8888-4888-8888-888888888888",
  other: "99999999-9999-4999-8999-999999999999",
};
const terms: ExactAgreementTerms = snapshotExactTerms({ version: "exact-cents-held-v1", currency: "usd",
  bookingPaymentId: ids.bp, bookingId: ids.booking, productId: ids.product, postId: ids.post,
  buyerId: ids.buyer, creatorId: ids.creator, destinationId: "acct_fixture", title: "Synthetic mentorship",
  previewOrigin: "https://creatornet-test.vercel.app", totalCents: 199900, paymentCount: 3,
  firstPaymentFeeSchedule: { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-card" },
  renewalFeeSchedule: { enabled: true, basisPoints: 360, fixedCents: 30, version: "synthetic-billing" },
});
let db: PGlite;
declare const createLocalPostgres: () => PGlite;
jest.setTimeout(60000);

async function create(value: unknown = terms, actor = ids.creator, plan = ids.plan) {
  const r = await db.query<{ id: string }>("select (public.create_exact_installment_agreement($1,$2,$3,$4::jsonb)).*",
    [plan, ids.bp, actor, JSON.stringify(value)]);
  return r.rows[0];
}
async function claim(step = "customer", token = ids.token, hash = "a".repeat(64)) {
  return (await db.query<{ result: { status: string; resultId?: string } }>(
    "select public.claim_exact_installment_operation($1,$2,$3,$4) as result", [ids.plan, step, hash, token])).rows[0].result;
}
async function complete(step = "customer", result = "cus_fixture", token = ids.token) {
  return db.query("select public.complete_exact_installment_operation($1,$2,$3,$4)", [ids.plan, step, token, result]);
}
async function bind() {
  return db.query("select public.bind_exact_installment_checkout($1,$2,$3,$4)", [ids.plan, "cus_fixture", "sub_fixture", "cs_test_fixture"]);
}
async function prepared() {
  await create();
  for (const [step, result] of [["customer", "cus_fixture"], ["product", "prod_fixture"],
    ["subscription", "sub_fixture"], ["hold", "sub_fixture"], ["checkout", "cs_test_fixture"]]) {
    await claim(step); await complete(step, result);
  }
  await bind();
}
async function receipt(pi = "pi_fixture", gross = 66633, fee = 9958, session = "cs_test_fixture") {
  return (await db.query<{ recorded: boolean }>(
    "select public.record_exact_installment_first_receipt($1,$2,$3,$4,$5,'2100-01-01T00:00:00Z') as recorded",
    [ids.plan, session, pi, gross, fee])).rows[0].recorded;
}

beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.profiles(id uuid primary key, stripe_account_id text, stripe_onboarding_complete boolean);
    create table public.bookings(id uuid primary key, creator_id uuid, buyer_id uuid, post_id uuid, status text);
    create table public.booking_payments(id uuid primary key, booking_id uuid, buyer_id uuid, product_id uuid,
      plan_type text, status text, currency text, installment_months integer, amount_total_cents bigint,
      stripe_checkout_session_id text, stripe_subscription_id text, link_url text);
  `);
  await db.exec(readFileSync(join(process.cwd(), "supabase/schema/040-exact-installment-agreements.sql"), "utf8"));
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  // Only this in-memory engine. No host, credentials, connection string or
  // Supabase API is available to the test.
  await db.exec("truncate public.exact_installment_receipts, public.exact_installment_operations, public.exact_installment_agreements, public.booking_payments, public.bookings, public.profiles;");
  await db.query("insert into public.profiles values($1,'acct_fixture',true)", [ids.creator]);
  await db.query("insert into public.bookings values($1,$2,$3,$4,'pending')", [ids.booking, ids.creator, ids.buyer, ids.post]);
  await db.query("insert into public.booking_payments(id,booking_id,buyer_id,product_id,plan_type,status,currency,installment_months,amount_total_cents) values($1,$2,$3,$4,'installment','pending','usd',3,199900)",
    [ids.bp, ids.booking, ids.buyer, ids.product]);
});

test("migration creates protected tables and immutable agreement replay", async () => {
  expect((await create()).id).toBe(ids.plan);
  expect((await create({ ...terms }, ids.creator, ids.other)).id).toBe(ids.plan);
  expect((await db.query("select * from public.exact_installment_agreements")).rows).toHaveLength(1);
});
test.each(["buyerId", "creatorId", "productId", "postId", "bookingId", "bookingPaymentId"] as const)
  ("rejects different %s before creating an agreement", async (key) => {
    await expect(create({ ...terms, [key]: ids.other })).rejects.toThrow();
    expect((await db.query("select * from public.exact_installment_agreements")).rows).toHaveLength(0);
  });
test.each([
  { paymentCount: 4 }, { totalCents: 199901 }, { currency: "eur" }, { version: "exact-percent-v1" },
  { destinationId: "acct_other" }, { firstPaymentFeeSchedule: null },
  { firstPaymentFeeSchedule: { ...terms.firstPaymentFeeSchedule, enabled: null } },
  { renewalFeeSchedule: { ...terms.renewalFeeSchedule, fixedCents: 900000 } },
  { title: "" }, { previewOrigin: "https://www.creatornet.net" }, { paymentCount: "3" }, { totalCents: "199900" },
  { firstPaymentFeeSchedule: { ...terms.firstPaymentFeeSchedule, version: 1 } },
])("rejects altered or invalid price/version/fee terms %#", async (change) => {
  await expect(create({ ...terms, ...change })).rejects.toThrow();
});
test("creator ownership is checked against the locked booking", async () => {
  await expect(create(terms, ids.buyer)).rejects.toThrow("creator ownership");
});
test("cannot replace saved terms or convert a legacy link", async () => {
  await db.exec("update public.booking_payments set stripe_checkout_session_id='cs_legacy'");
  await expect(create()).rejects.toThrow("existing payment link");
  await db.exec("update public.booking_payments set stripe_checkout_session_id=null");
  await create();
  await expect(create({ ...terms, title: "Changed offer" })).rejects.toThrow("terms differ");
});
test("busy claims, stale token fencing and completed result reuse", async () => {
  await create();
  expect(await claim()).toEqual({ status: "new" });
  expect(await claim("customer", ids.other)).toEqual({ status: "busy" });
  await db.exec("update public.exact_installment_operations set lease_until=now()-interval '1 second'");
  expect(await claim("customer", ids.other)).toEqual({ status: "new" });
  await expect(complete()).rejects.toThrow("claim lost");
  await complete("customer", "cus_fixture", ids.other);
  await db.exec("update public.exact_installment_operations set first_started_at=now()-interval '2 days'");
  expect(await claim()).toEqual({ status: "complete", resultId: "cus_fixture" });
});
test("ambiguous old operations stop instead of minting another Stripe object", async () => {
  await create(); await claim();
  await db.exec("update public.exact_installment_operations set first_started_at=now()-interval '21 hours', lease_until=now()-interval '1 minute'");
  expect(await claim()).toEqual({ status: "review_required" });
  expect((await db.query("select status from public.exact_installment_agreements")).rows).toEqual([{ status: "review_required" }]);
  await expect(complete()).rejects.toThrow("not preparing");
});
test("operation parameters cannot change on retry", async () => {
  await create(); await claim();
  await expect(claim("customer", ids.other, "b".repeat(64))).rejects.toThrow("parameters changed");
});
test("cannot bind checkout without all held-bootstrap operation results", async () => {
  await create();
  await expect(bind()).rejects.toThrow("bootstrap operations incomplete");
});
test("first receipt is recorded once and does not pretend to activate or fulfill", async () => {
  await prepared();
  expect(await receipt()).toBe(true);
  expect(await receipt()).toBe(false);
  expect((await db.query("select status from public.exact_installment_agreements")).rows).toEqual([{ status: "awaiting_first" }]);
  expect((await db.query("select status from public.bookings")).rows).toEqual([{ status: "pending" }]);
  expect((await db.query("select * from public.exact_installment_receipts")).rows).toHaveLength(1);
});
test("conflicting first payments or fee/amount/session mismatches cannot overwrite evidence", async () => {
  await prepared(); await receipt();
  await expect(receipt("pi_other")).rejects.toThrow("conflicting first receipt");
  await expect(receipt("pi_fixture", 66634)).rejects.toThrow("does not match");
  await expect(receipt("pi_fixture", 66633, 10425)).rejects.toThrow("does not match");
  await expect(receipt("pi_fixture", 66633, 9958, "cs_other")).rejects.toThrow("session mismatch");
});
test.each(["anon", "authenticated"])("%s cannot read or mutate private agreement records", async (role) => {
  await create();
  await db.exec(`set role ${role}`);
  try {
    await expect(db.query("select * from public.exact_installment_agreements")).rejects.toThrow("permission denied");
    await expect(claim()).rejects.toThrow("permission denied");
    await expect(create()).rejects.toThrow("permission denied");
  } finally { await db.exec("reset role"); }
});
test("service role must use the narrow RPCs, not direct financial-state updates", async () => {
  await db.exec("set role service_role");
  try {
    await create();
    await expect(db.exec("update public.exact_installment_agreements set terms='{}'")).rejects.toThrow("permission denied");
    expect(await claim()).toEqual({ status: "new" });
  } finally { await db.exec("reset role"); }
});
