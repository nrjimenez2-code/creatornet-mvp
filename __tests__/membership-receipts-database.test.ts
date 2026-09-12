/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { bootstrapRequests as recoveryBootstrapRequests } from "../test-support/membership-checkout-recovery-fixtures";
import { BOOTSTRAP_STAGES as recoveryBootstrapStages } from "@/lib/membershipCheckoutRecovery";
import { buildMembershipPayoffTerms, membershipPayoffFingerprint, buildMembershipPayoffCheckout, readMembershipPayoff, type MembershipPayoffRecord } from "@/lib/membershipPayoff";
import type { MembershipExitQuote } from "@/lib/membershipExit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installStagingStructuralBaseline } from "../test-support/staging-catalog-postgres";
import { buildMembershipAgreement, membershipMonthBoundary, MEMBERSHIP_PAYMENT_PROOF_VERSION } from "@/lib/membershipAgreement";
import { readMembershipRecord } from "@/lib/membershipCheckout";
import { membershipActivationParams, membershipInvoicePayParams, membershipRenewalPeriod } from "@/lib/membershipRenewal";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const buyer = "14000000-0000-4000-8000-000000000001", creator = "14000000-0000-4000-8000-000000000002";
const context = { stripeAccountId: "acct_fixture", mode: "test" as const, apiVersion: "2025-10-29.clover",
  siteOrigin: "https://membership.example.invalid", supabaseProjectRef: "nwqfofezfzljhxolkycz" };
const sql = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
beforeAll(async () => {
  db = createLocalPostgres(); await installStagingStructuralBaseline(db);
  await db.exec(sql("supabase/schema/020-product-checkout-idempotency.sql"));
  // Only unrelated fixed-agreement trigger targets are stubs. The actual
  // captured product/purchase/profile/ledger schema and SQL 075/077/078 run.
  // This is not acceptance of the complete 040-078 deployment chain.
  await db.exec("create table public.exact_installment_agreements(id uuid primary key,terms jsonb); create table public.exact_installment_context_reservations_v2(id uuid primary key,terms jsonb)");
  for (const file of ["075-monthly-mentorship-offers.sql", "077-versioned-purchase-consent.sql", "078-monthly-mentorship-receipts.sql", "079-monthly-mentorship-operation-journal.sql"])
    await db.exec(sql("supabase/proposals/" + file));
  // Execute the existing baseline refund allocator, not a replacement invented
  // for monthly tests. Later whole-candidate compatibility remains separate.
  const original = sql("supabase/schema/019-creator-processing-fees.sql");
  const start = original.indexOf("create or replace function public.apply_payment_fee_ledger_refund(");
  if (start < 0) throw Error("Existing ledger refund function missing");
  const end = original.indexOf("$$;", start);
  if (end < 0) throw Error("Existing ledger refund function terminator missing");
  await db.exec(original.slice(start, end + 3));
  await db.query("insert into auth.users(id) values($1),($2)", [buyer, creator]);
  await db.query("insert into public.profiles(id,username,stripe_account_id) values($1,'membership_buyer',null),($2,'membership_creator','acct_creator')", [buyer, creator]);
}, 30000);
afterAll(async () => { await db?.close(); });
async function createMembership(minimumMonths = 3, autoRenew = true, withBinding = true) {
  const productId = randomUUID(), postId = randomUUID();
  const offer = { id: productId, creator_id: creator, type: "mentorship", title: "Monthly support", description: "Daily mentor questions",
    amount_cents: 10000, price_cents: 10000, currency: "usd", membership_terms: { version: "monthly-mentorship-v1", minimumMonths, autoRenew } };
  await db.query(`insert into public.products(id,creator_id,title,description,type,price_cents,amount_cents,currency,plan_months,membership_terms)
    values($1,$2,$3,$4,'mentorship',10000,10000,'usd',1,$5::jsonb)`, [productId, creator, offer.title, offer.description, JSON.stringify(offer.membership_terms)]);
  await db.query("insert into public.posts(id,creator_id,product_id,title) values($1,$2,$3,'Monthly post')", [postId, creator, productId]);
  const quote = buildMembershipAgreement({ offer, buyerId: buyer, postId, destinationId: "acct_creator", context, env: {} });
  const reserve = (terms = quote.agreement, accepted = true) => db.query<{ id: string }>(
    "select public.reserve_monthly_mentorship_v1($1,$2,$3,$4::jsonb,$5,$6) id", [buyer, productId, postId, JSON.stringify(terms), quote.fingerprint, accepted]);
  const id = (await reserve()).rows[0].id;
  const purchase = (await db.query<{ purchase_id: string }>("select purchase_id from public.monthly_mentorship_agreements_v1 where id=$1", [id])).rows[0].purchase_id;
  const suffix = id.replaceAll("-", "");
  const customer = "cus_" + suffix, subscription = "sub_" + suffix, session = "cs_test_" + suffix;
  const bind = () => db.query("select public.bind_monthly_mentorship_provider_v1($1,$2,$3,$4)", [id, customer, subscription, session]);
  if (withBinding) await bind();
  return { id, purchase, quote, reserve, bind, customer, subscription, session };
}
type Membership = Awaited<ReturnType<typeof createMembership>>;
async function ledger(m: Membership, number = 1) {
  const suffix = randomUUID().replaceAll("-", ""), pi = "pi_" + suffix, charge = "ch_" + suffix;
  const invoice = number > 1 ? "in_" + suffix : null;
  const fee = number === 1 ? m.quote.agreement.firstMonthFees : m.quote.agreement.recurringMonthFees;
  const id = (await db.query<{ id: string }>(`insert into public.payment_fee_ledger(creator_id,purchase_id,stripe_payment_intent_id,
    stripe_charge_id,stripe_checkout_session_id,stripe_invoice_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,
    total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version,status)
    values($1,$2,$3,$4,$5,$6,10000,$7,$8,$9,$10,'usd',$11,'paid') returning id`,
  [creator, m.purchase, pi, charge, number === 1 ? m.session : null, invoice, fee.platformFeeCents, fee.processingFeeCents,
    fee.totalCreatorDeductionCents, fee.creatorNetCents, fee.feeScheduleVersion])).rows[0].id;
  const proof = { version: MEMBERSHIP_PAYMENT_PROOF_VERSION, paymentContext: context, customerId: m.customer, subscriptionId: m.subscription,
    destinationId: "acct_creator",
    checkoutSessionId: m.session, paymentIntentId: pi, chargeId: charge, invoiceId: invoice, capturedAmountCents: 10000,
    applicationFeeAmountCents: fee.totalCreatorDeductionCents, paymentStatus: "succeeded" };
  return { id, proof };
}
const record = (m: Membership, l: Awaited<ReturnType<typeof ledger>>, number: number, anchor: number, proof: unknown = l.proof) =>
  db.query<{ result: boolean }>("select public.record_monthly_mentorship_receipt_v1($1,$2,$3,$4,$5,$6::jsonb) result", [m.id, l.id, number,
    membershipMonthBoundary(anchor, number - 1), membershipMonthBoundary(anchor, number), JSON.stringify(proof)]);
const access = async (m: Membership, actor = buyer) => (await db.query<{ value: { allowed: boolean; maxAgeSeconds: number } }>(
  "select public.read_monthly_mentorship_entitlement_v1($1,$2) value", [m.purchase, actor])).rows[0].value;
const balance = async () => Number((await db.query<{ value: string }>("select total_earnings_cents value from public.profiles where id=$1", [creator])).rows[0].value);

test("steps 1/4: reservation is idempotent, immutable, private and unpaid", async () => {
  const m = await createMembership(); expect((await m.reserve()).rows[0].id).toBe(m.id);
  expect((await access(m)).allowed).toBe(false);
  await expect(m.reserve(m.quote.agreement, false)).rejects.toThrow("Explicit current");
  await expect(m.reserve({ ...m.quote.agreement, monthlyPriceCents: 50 })).rejects.toThrow("current offer");
  const acl = await db.query<{ role: string; can_write: boolean; can_read: boolean }>(`select r role,
    has_table_privilege(r,'public.monthly_mentorship_agreements_v1','UPDATE') can_write,
    has_table_privilege(r,'public.monthly_mentorship_agreements_v1','SELECT') can_read from unnest(array['anon','authenticated','service_role']) r`);
  expect(acl.rows).toEqual([{ role: "anon", can_write: false, can_read: false }, { role: "authenticated", can_write: false, can_read: false },
    { role: "service_role", can_write: false, can_read: true }]);
});
test("step 1: provider binding cannot silently change on retry", async () => {
  const m = await createMembership(); await m.bind();
  await expect(db.query("select public.bind_monthly_mentorship_provider_v1($1,'cus_other',$2,$3)", [m.id, m.subscription, m.session]))
    .rejects.toThrow("binding differs");
});
test("steps 1/8: a captured receipt credits the existing ledger exactly once and grants only owned current service", async () => {
  const m = await createMembership(), l = await ledger(m), anchor = Math.floor(Date.now() / 1000), before = await balance();
  expect((await record(m, l, 1, anchor)).rows[0].result).toBe(true);
  expect((await record(m, l, 1, anchor)).rows[0].result).toBe(false);
  expect(await balance()).toBe(before + 8800); expect(await access(m)).toMatchObject({ allowed: true, maxAgeSeconds: 3600 });
  expect((await access(m, creator)).allowed).toBe(false);
  const p = (await db.query<{ access_granted: boolean; paid_count: number }>("select access_granted,paid_count from public.purchases where id=$1", [m.purchase])).rows[0];
  expect(p).toEqual({ access_granted: false, paid_count: 0 });
});
test.each(["access_granted=true", "paid_count=1", "earnings_credited_at=now()", "monthly_mentorship_id=null"])(
  "steps 1/5/8: legacy mutation %s cannot grant permanent access or double-credit a membership", async mutation => {
    const m = await createMembership(); await expect(db.query(`update public.purchases set ${mutation} where id=$1`, [m.purchase])).rejects.toThrow();
  });
test("steps 1/8: missing and future periods cannot be skipped to grant service", async () => {
  const m = await createMembership(), l = await ledger(m, 2), now = Math.floor(Date.now() / 1000);
  await expect(record(m, l, 2, now)).rejects.toThrow("next agreed");
  const first = await ledger(m); await expect(record(m, first, 1, now + 86400)).rejects.toThrow("service period differs");
  expect((await access(m)).allowed).toBe(false);
});
test("steps 1/8: a paid elapsed month is not permanent access and the next captured month restores only its own period", async () => {
  const m = await createMembership(), date = new Date(), anchor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) / 1000;
  await record(m, await ledger(m), 1, anchor); expect((await access(m)).allowed).toBe(false);
  await record(m, await ledger(m, 2), 2, anchor); expect((await access(m)).allowed).toBe(true);
});
test("step 1: nonrenewing membership cannot admit a month beyond its agreed term", async () => {
  const m = await createMembership(1, false), date = new Date(), anchor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) / 1000;
  await record(m, await ledger(m), 1, anchor);
  await expect(record(m, await ledger(m, 2), 2, anchor)).rejects.toThrow("next agreed");
});
test.each([{ paymentStatus: "processing" }, { capturedAmountCents: 50 }, { applicationFeeAmountCents: 1 }, { destinationId: "acct_other" },
  { customerId: "cus_other" }, { paymentContext: { ...context, mode: "live" } }])("step 8: rejects mismatched receipt evidence %p", async change => {
  const m = await createMembership(), l = await ledger(m), before = await balance();
  await expect(record(m, l, 1, Math.floor(Date.now() / 1000), { ...l.proof, ...change })).rejects.toThrow("evidence differs");
  expect(await balance()).toBe(before); expect((await access(m)).allowed).toBe(false);
});
test("steps 7/8: the existing refund allocator reverses a credited monthly ledger; replay cannot revive access", async () => {
  const m = await createMembership(), l = await ledger(m), anchor = Math.floor(Date.now() / 1000), before = await balance();
  await record(m, l, 1, anchor);
  await db.query("select public.apply_payment_fee_ledger_refund($1,10000)", [l.id]);
  expect(await balance()).toBe(before); expect((await access(m)).allowed).toBe(false);
  expect((await record(m, l, 1, anchor)).rows[0].result).toBe(false); expect((await access(m)).allowed).toBe(false);
});
test("steps 7/8: refund-before-credit credits only the unreversed net and never reopens a fully refunded period", async () => {
  const m = await createMembership(), l = await ledger(m), before = await balance();
  await db.query("select public.apply_payment_fee_ledger_refund($1,10000)", [l.id]);
  await record(m, l, 1, Math.floor(Date.now() / 1000));
  expect(await balance()).toBe(before); expect((await access(m)).allowed).toBe(false);
});
test("steps 1/8: an active dispute blocks paid-period access", async () => {
  const m = await createMembership(), l = await ledger(m);
  await record(m, l, 1, Math.floor(Date.now() / 1000));
  await db.query("update public.payment_fee_ledger set dispute_status='needs_response' where id=$1", [l.id]);
  expect((await access(m)).allowed).toBe(false);
});

const claim = async (m: Membership, kind = "customer", path = "/v1/customers", params: unknown = {}) =>
  (await db.query<{ value: { id: string; status: string; provider_id: string | null } }>(
    "select public.claim_monthly_mentorship_operation_v1($1,$2,$3,'initial',0,$4::jsonb,$5::jsonb) value",
    [m.id, buyer, kind, JSON.stringify(context), JSON.stringify({ method: "POST", path, params })])).rows[0].value;
test("steps 1/8: the operation journal gives identical retries one identity and refuses changed parameters", async () => {
  const m = await createMembership(3, true, false), first = await claim(m);
  expect(await claim(m)).toEqual(first);
  await expect(claim(m, "customer", "/v1/customers", { changed: true })).rejects.toThrow("retry parameters differ");
  await expect(claim(m, "customer", "/v1/refunds")).rejects.toThrow("provider path differs");
});
test("step 8: lost results outside the safe retry window become reconciliation-only", async () => {
  const m = await createMembership(3, true, false), op = await claim(m);
  await db.query("update public.monthly_mentorship_operations_v1 set dispatched_at=clock_timestamp()-interval '21 hours' where id=$1", [op.id]);
  expect((await claim(m)).status).toBe("review_required"); expect((await claim(m)).status).toBe("review_required");
});
test("steps 1/8: a saved provider result remains retrieval-only after the retry window", async () => {
  const m = await createMembership(3, true, false), op = await claim(m);
  await db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,'req_fixture')", [op.id, JSON.stringify(context), m.customer]);
  await db.query("update public.monthly_mentorship_operations_v1 set dispatched_at=clock_timestamp()-interval '21 hours' where id=$1", [op.id]);
  expect(await claim(m)).toMatchObject({ id: op.id, status: "complete", provider_id: m.customer });
});
test("step 1: prerequisites and stops fence new provider dispatch", async () => {
  const m = await createMembership(3, true, false);
  await expect(claim(m, "product", "/v1/products")).rejects.toThrow("Prior monthly operation");
  await db.query("update public.monthly_mentorship_agreements_v1 set debit_revoked_at=now() where id=$1", [m.id]);
  await expect(claim(m)).rejects.toThrow("fresh eligible");
});
test("step 8: finishing an already dispatched result after a stop records the fact without restarting access", async () => {
  const m = await createMembership(3, true, false), op = await claim(m);
  await db.query("update public.monthly_mentorship_agreements_v1 set debit_revoked_at=now() where id=$1", [m.id]);
  await db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,'req_fixture')", [op.id, JSON.stringify(context), m.customer]);
  expect((await access(m)).allowed).toBe(false);
  await expect(claim(m, "product", "/v1/products")).rejects.toThrow("fresh eligible");
});
test("step 8: completion refuses a different provider object kind and context", async () => {
  const m = await createMembership(3, true, false), op = await claim(m);
  await expect(db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,'sub_wrong','req_fixture')", [op.id, JSON.stringify(context)]))
    .rejects.toThrow("object kind differs");
  await expect(db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,'req_fixture')", [op.id, JSON.stringify({ ...context, mode: "live" }), m.customer]))
    .rejects.toThrow("context differs");
});

describe("SQL 080 provider publication, after the existing 078/079 receipt and journal cases", () => {
  beforeAll(async () => { await db.exec(sql("supabase/proposals/080-monthly-mentorship-provider-publication.sql")); });
  async function completedBootstrap(m: Membership, omit = "") {
    for (const [kind, path, provider] of [["customer", "/v1/customers", m.customer], ["product", "/v1/products", "prod_" + m.id.replaceAll("-", "")],
      ["subscription", "/v1/subscriptions", m.subscription], ["hold", "/v1/subscriptions/" + m.subscription, m.subscription],
      ["checkout", "/v1/checkout/sessions", m.session]]) {
      if (kind === omit) break;
      const op = await claim(m, kind, path);
      await db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,'req_fixture')", [op.id, JSON.stringify(context), provider]);
    }
  }
  test("step 8: binding without completed owned provider operations is rejected", async () => {
    const m = await createMembership(3, true, false); await expect(m.bind()).rejects.toThrow("completed owned operations");
    expect((await access(m)).allowed).toBe(false);
  });
  test("step 8: incomplete checkout operation cannot publish a payment identity", async () => {
    const m = await createMembership(3, true, false); await completedBootstrap(m, "checkout");
    await expect(m.bind()).rejects.toThrow("completed owned operations");
  });
  test("steps 1/8: all owned completed operations permit one immutable publication, not access", async () => {
    const m = await createMembership(3, true, false); await completedBootstrap(m); await m.bind(); await m.bind();
    expect((await access(m)).allowed).toBe(false);
  });
  test("step 8: completed journal evidence does not authorize a different customer", async () => {
    const m = await createMembership(3, true, false); await completedBootstrap(m);
    await expect(db.query("select public.bind_monthly_mentorship_provider_v1($1,'cus_other',$2,$3)", [m.id, m.subscription, m.session]))
      .rejects.toThrow("completed owned operations");
  });
  describe("SQL 081 captured-card activation and collection admission", () => {
    beforeAll(async () => { await db.exec(sql("supabase/proposals/081-monthly-mentorship-collection-admission.sql")); });
    async function readyRenewal(activate = true, anchorOverride?: number) {
      const m = await createMembership(3, true, false); await completedBootstrap(m); await m.bind();
      const first = await ledger(m), date = new Date(), anchor = anchorOverride ?? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1, 12) / 1000;
      const proof = { ...first.proof, paymentMethodId: "pm_fixture", paidAt: anchor };
      await record(m, first, 1, anchor, proof);
      const row = (await db.query<{ value: unknown }>("select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [m.id])).rows[0].value;
      // Supabase's HTTP JSON parse yields application-realm plain objects.
      const a = readMembershipRecord(JSON.parse(JSON.stringify(row)));
      const operation = async (kind: string, scope: string, path: string, params: unknown, actor = buyer) =>
        (await db.query<{ value: { id: string } }>("select public.claim_monthly_mentorship_operation_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) value",
          [m.id, actor, kind, scope, a.revision, JSON.stringify(context), JSON.stringify({ method: "POST", path, params })])).rows[0].value;
      if (activate) {
        const op = await operation("activate", "initial", "/v1/subscriptions/" + m.subscription, membershipActivationParams(a, proof));
        await db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,'req_fixture')", [op.id, JSON.stringify(context), m.subscription]);
      }
      const renew = await ledger(m, 2), period = membershipRenewalPeriod(a, 2);
      const admit = (params: unknown = membershipInvoicePayParams(proof)) => operation("collect", "2", "/v1/invoices/" + renew.proof.invoiceId + "/pay", params, creator);
      const renewProof = { ...renew.proof, paymentMethodId: "pm_fixture", collectionRequestId: "req_observed",
        providerPeriodStart: period.providerStart, providerPeriodEnd: period.providerEnd };
      return { m, a, proof, anchor, renew, admit, operation, renewProof };
    }
    test("steps 1/4: activation cannot use an uncaptured card or remove the hold", async () => {
      const x = await readyRenewal(false), params = membershipActivationParams(x.a, x.proof);
      await expect(x.operation("activate", "initial", "/v1/subscriptions/" + x.m.subscription,
        { ...params, default_payment_method: "pm_other" })).rejects.toThrow("owned held schedule");
      await expect(x.operation("activate", "initial", "/v1/subscriptions/" + x.m.subscription,
        { ...params, pause_collection: "" })).rejects.toThrow("owned held schedule");
    });
    test.each([{ payment_method: "pm_other" }, { forgive: true }, { paid_out_of_band: true }, { off_session: false }])(
      "steps 1/8: altered collection request %p cannot be admitted", async change => {
        const x = await readyRenewal(); await expect(x.admit({ ...membershipInvoicePayParams(x.proof), ...change }))
          .rejects.toThrow("captured-card authority");
      });
    test("steps 1/8: a renewal receipt cannot adopt an invoice without the owned collection request", async () => {
      const x = await readyRenewal(), before = await balance();
      await expect(record(x.m, x.renew, 2, x.anchor, x.renewProof)).rejects.toThrow("owned collection admission");
      expect(await balance()).toBe(before);
    });
    test("steps 1/7/8: admitted captured renewal credits the existing balance once and finishes its operation", async () => {
      const x = await readyRenewal(), op = await x.admit(), before = await balance();
      expect((await record(x.m, x.renew, 2, x.anchor, x.renewProof)).rows[0].result).toBe(true);
      expect((await record(x.m, x.renew, 2, x.anchor, x.renewProof)).rows[0].result).toBe(false);
      expect(await balance()).toBe(before + 8800);
      const saved = (await db.query<{ status: string; provider_id: string }>("select status,provider_id from public.monthly_mentorship_operations_v1 where id=$1", [op.id])).rows[0];
      expect(saved).toEqual({ status: "complete", provider_id: x.renew.proof.invoiceId }); expect((await access(x.m)).allowed).toBe(true);
    });
    test("step 8: late captured observation finishes a review operation without granting any retry authority", async () => {
      const x = await readyRenewal(), op = await x.admit();
      await db.query("update public.monthly_mentorship_operations_v1 set status='review_required',dispatched_at=now()-interval '21 hours' where id=$1", [op.id]);
      await record(x.m, x.renew, 2, x.anchor, x.renewProof);
      expect((await db.query<{ status: string }>("select status from public.monthly_mentorship_operations_v1 where id=$1", [op.id])).rows[0].status).toBe("complete");
    });
    test("step 8: provider period and card identity cannot change when recording the renewal", async () => {
      const x = await readyRenewal(); await x.admit();
      await expect(record(x.m, x.renew, 2, x.anchor, { ...x.renewProof, providerPeriodEnd: x.renewProof.providerPeriodEnd + 1 }))
        .rejects.toThrow("owned collection admission");
      await expect(record(x.m, x.renew, 2, x.anchor, { ...x.renewProof, paymentMethodId: "pm_other" }))
        .rejects.toThrow("owned collection admission");
    });
    test("step 8: a verified failure is durable review-only and never marks a receipt paid", async () => {
      const x = await readyRenewal(), op = await x.admit();
      await db.query("select public.review_monthly_mentorship_collection_v1($1,2,$2::jsonb)", [x.m.id, JSON.stringify(context)]);
      expect((await db.query<{ status: string; review_reason: string }>("select status,review_reason from public.monthly_mentorship_operations_v1 where id=$1", [op.id])).rows[0])
        .toEqual({ status: "review_required", review_reason: "payment_requires_review" });
      expect((await db.query<{ count: number }>("select count(*)::integer count from public.monthly_mentorship_receipts_v1 where agreement_id=$1 and month_number=2", [x.m.id])).rows[0].count).toBe(0);
    });
    describe("SQL 082 bounded worker leases", () => {
      beforeAll(async () => { await db.exec(sql("supabase/proposals/082-monthly-mentorship-worker-leases.sql")); });
      beforeEach(async () => {
        // Isolate this lease test's work selection from earlier completed
        // receipt fixtures, without changing their contracts or ledger state.
        await db.exec("update public.monthly_mentorship_agreements_v1 set billing_next_attempt_at='infinity',billing_work_token=null,billing_lease_until=null");
      });
      type Work = { id: string; buyer_id: string; creator_id: string; lease_token: string; needs_activation: boolean };
      const lease = async (ctx = context, limit = 6) => (await db.query<{ value: Work[] }>(
        "select public.lease_monthly_mentorship_work_v1($1::jsonb,$2) value", [JSON.stringify(ctx), limit])).rows[0].value;
      const finish = async (item: Work, status = "awaiting_invoice", token = item.lease_token) =>
        (await db.query<{ value: boolean }>("select public.finish_monthly_mentorship_work_v1($1,$2,$3::jsonb,$4) value",
          [item.id, token, JSON.stringify(context), status])).rows[0].value;
      test("step 10: an active lease excludes a second selection and retains owned identities", async () => {
        const x = await readyRenewal(), rows = await lease(); expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: x.m.id, buyer_id: buyer, creator_id: creator, needs_activation: false });
        expect(await lease()).toEqual([]);
      });
      test("step 10: completion requires the matching token and applies a retry delay", async () => {
        await readyRenewal(); const [item] = await lease(); expect(await finish(item, "awaiting_invoice", randomUUID())).toBe(false);
        expect(await finish(item)).toBe(true); expect(await lease()).toEqual([]);
        const saved = (await db.query<{ billing_work_token: string | null; billing_worker_status: string }>(
          "select billing_work_token,billing_worker_status from public.monthly_mentorship_agreements_v1 where id=$1", [item.id])).rows[0];
        expect(saved).toEqual({ billing_work_token: null, billing_worker_status: "awaiting_invoice" });
      });
      test("step 10: expired lease receives a new token; the old worker cannot overwrite its result", async () => {
        await readyRenewal(); const [old] = await lease();
        await db.query("update public.monthly_mentorship_agreements_v1 set billing_lease_until=now()-interval '1 second',billing_next_attempt_at=now()-interval '1 second' where id=$1", [old.id]);
        const [fresh] = await lease(); expect(fresh.lease_token).not.toBe(old.lease_token);
        expect(await finish(old)).toBe(false); expect(await finish(fresh)).toBe(true);
      });
      test("step 1: future agreed renewal is not leased merely because a provider invoice could exist", async () => {
        await readyRenewal(true, Math.floor(Date.now() / 1000)); expect(await lease()).toEqual([]);
      });
      test("step 1: first paid month awaiting activation is a distinct work item", async () => {
        const x = await readyRenewal(false); expect(await lease()).toEqual([expect.objectContaining({ id: x.m.id, needs_activation: true })]);
      });
      test("steps 8/10: stopped service, different context and an excessive batch cannot authorize worker selection", async () => {
        const x = await readyRenewal(); expect(await lease({ ...context, stripeAccountId: "acct_other" })).toEqual([]);
        await expect(lease(context, 7)).rejects.toThrow("request differs");
        await db.query("update public.monthly_mentorship_agreements_v1 set debit_revoked_at=now() where id=$1", [x.m.id]);
        expect(await lease()).toEqual([]);
      });
      describe("SQL 083 cancellation and separate debit revocation", () => {
        beforeAll(async () => { await db.exec(sql("supabase/proposals/083-monthly-mentorship-exit-requests.sql")); });
        type ExitQuote = { version: string; revision: number; coveredMonths: number; remainingMonths: number; payoffAmountCents: number | null;
          paidThrough: number | null; minimumEnd: number | null; reviewReasons: string[]; renewalStopped: boolean; debitsRevoked: boolean };
        type ExitRequest = { id: string; status: string; accepted_snapshot: ExitQuote; provider_started_at: string | null };
        async function paidMembership(minimumMonths = 3, anchor = Math.floor(Date.now() / 1000)) {
          const m = await createMembership(minimumMonths, true, false); await completedBootstrap(m); await m.bind();
          const first = await ledger(m); await record(m, first, 1, anchor, { ...first.proof, paymentMethodId: "pm_fixture", paidAt: anchor });
          return { m, first, anchor };
        }
        const quoteExit = async (m: Membership, actor = buyer, ctx = context) => (await db.query<{ value: ExitQuote }>(
          "select public.read_monthly_mentorship_exit_quote_v1($1,$2,$3::jsonb) value", [m.id, actor, JSON.stringify(ctx)])).rows[0].value;
        const exitRequest = async (m: Membership, kind: string, q: unknown = null, accepted = true, actor = buyer) =>
          (await db.query<{ value: ExitRequest }>("select public.request_monthly_mentorship_exit_v1($1,$2,$3::jsonb,$4,$5::jsonb,$6) value",
            [m.id, actor, JSON.stringify(context), kind, q === null ? null : JSON.stringify(q), accepted])).rows[0].value;
        const claimStop = async (e: ExitRequest) => (await db.query<{ value: ExitRequest }>(
          "select public.claim_monthly_mentorship_exit_stop_v1($1,$2,$3::jsonb) value", [e.id, buyer, JSON.stringify(context)])).rows[0].value;
        const stopProof = (m: Membership) => ({ version: "monthly-exit-stop-proof-v1", paymentContext: context,
          subscriptionId: m.subscription, customerId: m.customer, status: "canceled", requestId: "req_stop" });
        const recordStop = async (e: ExitRequest, proof: unknown) => (await db.query<{ value: boolean }>(
          "select public.record_monthly_mentorship_exit_stop_v1($1,$2,$3::jsonb,$4::jsonb) value",
          [e.id, buyer, JSON.stringify(context), JSON.stringify(proof)])).rows[0].value;
        test("step 2: a three-month minimum after one paid month quotes exactly the two unpaid months", async () => {
          const x = await paidMembership(), q = await quoteExit(x.m);
          expect(q).toMatchObject({ coveredMonths: 1, remainingMonths: 2, payoffAmountCents: 20000, reviewReasons: [] });
          expect(q.paidThrough).toBe(membershipMonthBoundary(x.anchor, 1)); expect(q.minimumEnd).toBe(membershipMonthBoundary(x.anchor, 3));
        });
        test("step 2: unpaid minimum cannot use ordinary cancellation or imply a payoff charge", async () => {
          const x = await paidMembership(), q = await quoteExit(x.m), before = await balance();
          await expect(exitRequest(x.m, "stop_renewal", q)).rejects.toThrow("separate confirmed payoff");
          expect((await quoteExit(x.m)).renewalStopped).toBe(false); expect(await balance()).toBe(before);
        });
        test("step 2: no-extra-minimum cancellation retains existing paid access and never adds credit", async () => {
          const x = await paidMembership(1), q = await quoteExit(x.m), before = await balance();
          const e = await exitRequest(x.m, "stop_renewal", q); expect(e.status).toBe("requested");
          expect(await exitRequest(x.m, "stop_renewal", q)).toEqual(e);
          expect((await quoteExit(x.m)).renewalStopped).toBe(true); expect((await access(x.m)).allowed).toBe(true);
          expect(await balance()).toBe(before);
        });
        test("step 4: stale or edited quote cannot cancel a membership", async () => {
          const x = await paidMembership(1), q = await quoteExit(x.m);
          await expect(exitRequest(x.m, "stop_renewal", { ...q, payoffAmountCents: 1 })).rejects.toThrow("quote changed");
          await db.query("update public.monthly_mentorship_agreements_v1 set revision=revision+1 where id=$1", [x.m.id]);
          await expect(exitRequest(x.m, "stop_renewal", q)).rejects.toThrow("quote changed");
        });
        test("step 2: debit revocation stops future admission without waiving the unpaid minimum or access", async () => {
          const x = await paidMembership(), before = await balance(), e = await exitRequest(x.m, "revoke_debits");
          expect(e.accepted_snapshot.payoffAmountCents).toBe(20000);
          expect(await quoteExit(x.m)).toMatchObject({ payoffAmountCents: 20000, debitsRevoked: true, renewalStopped: false });
          expect((await access(x.m)).allowed).toBe(true); expect(await balance()).toBe(before);
        });
        test("step 4: revocation cannot smuggle in a payoff quote or omit confirmation", async () => {
          const x = await paidMembership();
          await expect(exitRequest(x.m, "revoke_debits", await quoteExit(x.m))).rejects.toThrow("not payoff acceptance");
          await expect(exitRequest(x.m, "revoke_debits", null, false)).rejects.toThrow("Explicit owned");
        });
        test("step 8: pending collection suppresses an exact payoff quote but cannot prevent debit revocation", async () => {
          const x = await readyRenewal(); await x.admit();
          const q = await quoteExit(x.m); expect(q.payoffAmountCents).toBeNull(); expect(q.reviewReasons).toContain("collection_in_flight_or_review");
          await exitRequest(x.m, "revoke_debits");
          await expect(x.admit()).rejects.toThrow("fresh eligible"); expect((await quoteExit(x.m)).debitsRevoked).toBe(true);
        });
        test("steps 2/7: a refunded receipt needs balance review rather than recreating debt", async () => {
          const x = await paidMembership(1); await db.query("select public.apply_payment_fee_ledger_refund($1,10000)", [x.first.id]);
          const q = await quoteExit(x.m); expect(q.payoffAmountCents).toBeNull(); expect(q.reviewReasons).toContain("refund_or_payment_review");
          await exitRequest(x.m, "revoke_debits"); expect((await access(x.m)).allowed).toBe(false);
        });
        test("step 8: captured ledger not yet admitted as a receipt cannot cause double payoff", async () => {
          const x = await paidMembership(); await ledger(x.m, 2);
          const q = await quoteExit(x.m); expect(q.payoffAmountCents).toBeNull(); expect(q.reviewReasons).toContain("unreconciled_payment");
        });
        test("step 2: an elapsed unpaid minimum requires support review, not silent catch-up billing", async () => {
          const now = new Date(), anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4, 1) / 1000;
          const x = await paidMembership(3, anchor), q = await quoteExit(x.m);
          expect(q.payoffAmountCents).toBeNull(); expect(q.reviewReasons).toContain("elapsed_unpaid_minimum");
        });
        test("step 8: uncertain provider cancellation keeps one identity and becomes review-only after the retry window", async () => {
          const x = await paidMembership(), e = await exitRequest(x.m, "revoke_debits"), first = await claimStop(e);
          expect(first.status).toBe("dispatching"); expect(await claimStop(e)).toEqual(first);
          await db.query("update public.monthly_mentorship_exit_requests_v1 set provider_started_at=now()-interval '21 hours' where id=$1", [e.id]);
          expect((await claimStop(e)).status).toBe("review_required");
          expect(await recordStop(e, stopProof(x.m))).toBe(true); expect(await recordStop(e, stopProof(x.m))).toBe(false);
          expect((await claimStop(e)).status).toBe("provider_stopped"); expect((await access(x.m)).allowed).toBe(true);
        });
        test("step 8: a different provider subscription or context cannot be recorded as the completed stop", async () => {
          const x = await paidMembership(), e = await exitRequest(x.m, "revoke_debits");
          await expect(recordStop(e, { ...stopProof(x.m), subscriptionId: "sub_other" })).rejects.toThrow("proof differs");
          await expect(recordStop(e, { ...stopProof(x.m), paymentContext: { ...context, mode: "live" } })).rejects.toThrow("proof differs");
        });
        test("step 5: another buyer or provider account cannot read or request the exit", async () => {
          const x = await paidMembership();
          await expect(quoteExit(x.m, creator)).rejects.toThrow("ownership differs");
          await expect(quoteExit(x.m, buyer, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("ownership differs");
          await expect(exitRequest(x.m, "revoke_debits", null, true, creator)).rejects.toThrow("Explicit owned");
        });
        test("step 5: browser roles cannot directly mutate exits or execute the private stop RPC", async () => {
          const rows = await db.query<{ role: string; can_write: boolean; can_execute: boolean }>(`select r role,
            has_table_privilege(r,'public.monthly_mentorship_exit_requests_v1','UPDATE') can_write,
            has_function_privilege(r,'public.request_monthly_mentorship_exit_v1(uuid,uuid,jsonb,text,jsonb,boolean)','EXECUTE') can_execute
            from unnest(array['anon','authenticated','service_role']) r`);
          expect(rows.rows).toEqual([{ role: "anon", can_write: false, can_execute: false },
            { role: "authenticated", can_write: false, can_execute: false }, { role: "service_role", can_write: false, can_execute: true }]);
        });
        describe("SQL 084 separately confirmed minimum payoff", () => {
          beforeAll(async () => { await db.exec(sql("supabase/proposals/084-monthly-mentorship-payoff.sql")); });
          async function payoffFixture(reserveNow = true, anchor = Math.floor(Date.now() / 1000)) {
            const x = await paidMembership(3, anchor);
            const a = readMembershipRecord(JSON.parse(JSON.stringify((await db.query<{ value: unknown }>(
              "select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [x.m.id])).rows[0].value)));
            const q = JSON.parse(JSON.stringify(await quoteExit(x.m))) as MembershipExitQuote;
            const terms = buildMembershipPayoffTerms(a, q), fingerprint = membershipPayoffFingerprint(terms);
            const reserve = async (value = terms, fp = fingerprint, accepted = true) => (await db.query<{ value: MembershipPayoffRecord }>(
              "select public.reserve_monthly_mentorship_payoff_v1($1,$2,$3::jsonb,$4::jsonb,$5,$6) value",
              [a.id, buyer, JSON.stringify(context), JSON.stringify(value), fp, accepted])).rows[0].value;
            let pf = reserveNow ? await reserve() : null;
            const admit = async () => {
              if (!pf) pf = await reserve();
              const request = buildMembershipPayoffCheckout(a, readMembershipPayoff(JSON.parse(JSON.stringify(pf)), a));
              return (await db.query<{ value: MembershipPayoffRecord }>("select public.claim_monthly_mentorship_payoff_checkout_v1($1,$2,$3::jsonb,$4::jsonb) value",
                [pf.id, buyer, JSON.stringify(context), JSON.stringify(request)])).rows[0].value;
            };
            const session = "cs_payoff" + a.id.replaceAll("-", "");
            const publish = async () => { const p = await admit(); await db.query(
              "select public.bind_monthly_mentorship_payoff_checkout_v1($1,$2,$3::jsonb,$4,'req_payoff')", [p.id, buyer, JSON.stringify(context), session]); return p; };
            return { ...x, a, terms, fingerprint, reserve, admit, publish, session, getPayoff: () => pf! };
          }
          type PayoffFixture = Awaited<ReturnType<typeof payoffFixture>>;
          async function payoffLedger(x: PayoffFixture) {
            const pf = x.getPayoff(), suffix = randomUUID().replaceAll("-", ""), pi = "pi_" + suffix, charge = "ch_" + suffix, f = x.terms.fees;
            const id = (await db.query<{ id: string }>(`insert into public.payment_fee_ledger(creator_id,purchase_id,stripe_payment_intent_id,
              stripe_charge_id,stripe_checkout_session_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,
              creator_net_cents,currency,fee_schedule_version,status) values($1,$2,$3,$4,$5,20000,$6,$7,$8,$9,'usd',$10,'paid') returning id`,
              [creator, x.m.purchase, pi, charge, x.session, f.platformFeeCents, f.processingFeeCents, f.totalCreatorDeductionCents, f.creatorNetCents, f.feeScheduleVersion])).rows[0].id;
            const proof = { version: "monthly-mentorship-payoff-proof-v1", paymentContext: context, payoffId: pf.id, payoffFingerprint: pf.fingerprint,
              customerId: x.m.customer, subscriptionId: x.m.subscription, checkoutSessionId: x.session, destinationId: "acct_creator",
              paymentIntentId: pi, chargeId: charge, capturedAmountCents: 20000, applicationFeeAmountCents: f.totalCreatorDeductionCents,
              paymentStatus: "succeeded", paymentMethodId: "pm_payoff", paidAt: Math.floor(Date.now() / 1000),
              periodStart: x.terms.periodStart, periodEnd: x.terms.periodEnd };
            const recordPayoff = async (value: unknown = proof) => (await db.query<{ value: boolean }>(
              "select public.record_monthly_mentorship_payoff_v1($1,$2,$3::jsonb,$4,$5::jsonb) value",
              [pf.id, buyer, JSON.stringify(context), id, JSON.stringify(value)])).rows[0].value;
            return { id, proof, recordPayoff };
          }
          const abandon = async (x: PayoffFixture, proof: unknown = { paymentContext: context, neverDispatched: true }) =>
            (await db.query<{ value: boolean }>("select public.abandon_monthly_mentorship_payoff_v1($1,$2,$3::jsonb,$4::jsonb) value",
              [x.getPayoff().id, buyer, JSON.stringify(context), JSON.stringify(proof)])).rows[0].value;
          test("steps 2/4: one exact accepted payoff freezes collection without creating money or future access", async () => {
            const x = await payoffFixture(), pf = x.getPayoff(), before = await balance();
            expect(pf.terms.amountCents).toBe(20000); expect((await x.reserve()).id).toBe(pf.id);
            expect((await quoteExit(x.m)).coveredMonths).toBe(1); expect((await access(x.m)).allowed).toBe(true); expect(await balance()).toBe(before);
            expect(await lease()).toEqual([]);
            await expect(x.reserve(x.terms, x.fingerprint, false)).rejects.toThrow("Explicit owned");
          });
          test("step 4: a stale quote after new ledger money cannot freeze an incorrect payoff", async () => {
            const x = await payoffFixture(false); await ledger(x.m, 2);
            await expect(x.reserve()).rejects.toThrow("fresh settled");
          });
          test("steps 2/4: acceptance cannot alter the balance, coverage or creator fee schedule", async () => {
            const x = await payoffFixture(false);
            await expect(x.reserve({ ...x.terms, amountCents: 50 })).rejects.toThrow("exact unpaid minimum");
            await expect(x.reserve({ ...x.terms, periodEnd: x.terms.periodEnd + 1 })).rejects.toThrow("exact unpaid minimum");
            await expect(x.reserve({ ...x.terms, fees: { ...x.terms.fees, processingFeeFixedCents: 99 } })).rejects.toThrow("fee schedule");
          });
          test("step 8: a fresh-revision operation still cannot dispatch while payoff collection is held", async () => {
            const x = await payoffFixture();
            await expect(db.query("select public.claim_monthly_mentorship_operation_v1($1,$2,'activate','initial',$3,$4::jsonb,$5::jsonb)",
              [x.a.id, buyer, x.a.revision + 1, JSON.stringify(context), JSON.stringify({ method: "POST", path: "/v1/subscriptions/" + x.m.subscription,
                params: membershipActivationParams(x.a, { ...x.first.proof, paymentMethodId: "pm_fixture", paidAt: x.anchor }) })])).rejects.toThrow("fresh eligible");
          });
          test("steps 2/8: the same admitted checkout keeps its identity and refuses changed parameters", async () => {
            const x = await payoffFixture(), p = await x.admit(); expect((await x.admit()).id).toBe(p.id);
            await expect(db.query("select public.claim_monthly_mentorship_payoff_checkout_v1($1,$2,$3::jsonb,$4::jsonb)",
              [p.id, buyer, JSON.stringify(context), JSON.stringify({ ...p.checkout_request, customer: "cus_other" })])).rejects.toThrow("retry parameters");
          });
          test("step 8: an unknown checkout result outside the window is reconciliation-only and cannot be abandoned blindly", async () => {
            const x = await payoffFixture(), p = await x.admit();
            await db.query("update public.monthly_mentorship_payoffs_v1 set checkout_dispatched_at=now()-interval '21 hours' where id=$1", [p.id]);
            expect((await x.admit()).status).toBe("review_required");
            await expect(abandon(x)).rejects.toThrow("expired and proven uncaptured");
          });
          test("steps 2/7: one captured payoff credits once and covers the remaining minimum without duplicate monthly receipts", async () => {
            const date = new Date(), anchor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) / 1000;
            const x = await payoffFixture(true, anchor); await x.publish(); const l = await payoffLedger(x), before = await balance();
            expect((await access(x.m)).allowed).toBe(false);
            expect(await l.recordPayoff()).toBe(true); expect(await l.recordPayoff()).toBe(false); expect(await balance()).toBe(before + x.terms.fees.creatorNetCents);
            expect(await quoteExit(x.m)).toMatchObject({ coveredMonths: 3, remainingMonths: 0, payoffAmountCents: 0, reviewReasons: [], renewalStopped: true });
            expect((await quoteExit(x.m)).paidThrough).toBe(x.terms.periodEnd); expect((await access(x.m)).allowed).toBe(true);
            expect((await db.query<{ count: number }>("select count(*)::integer count from public.monthly_mentorship_receipts_v1 where agreement_id=$1", [x.a.id])).rows[0].count).toBe(1);
            expect((await exitRequest(x.m, "stop_renewal")).status).toBe("requested");
          });
          test("steps 2/7: an already refunded payoff credits no new net money and grants no refunded future service", async () => {
            const date = new Date(), anchor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) / 1000;
            const x = await payoffFixture(true, anchor); await x.publish(); const l = await payoffLedger(x), before = await balance();
            await db.query("select public.apply_payment_fee_ledger_refund($1,20000)", [l.id]);
            expect(await l.recordPayoff()).toBe(true); expect(await balance()).toBe(before); expect((await access(x.m)).allowed).toBe(false);
            expect((await quoteExit(x.m)).payoffAmountCents).toBeNull();
          });
          test("step 7: the existing refund allocator reverses the single payoff ledger and replay does not revive access", async () => {
            const date = new Date(), anchor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) / 1000;
            const x = await payoffFixture(true, anchor); await x.publish(); const l = await payoffLedger(x), before = await balance();
            await l.recordPayoff(); await db.query("select public.apply_payment_fee_ledger_refund($1,20000)", [l.id]);
            expect(await l.recordPayoff()).toBe(false); expect(await balance()).toBe(before); expect((await access(x.m)).allowed).toBe(false);
          });
          test("step 8: mismatched capture amount or provider ownership cannot credit the payoff", async () => {
            const x = await payoffFixture(); await x.publish(); const l = await payoffLedger(x), before = await balance();
            await expect(l.recordPayoff({ ...l.proof, capturedAmountCents: 10000 })).rejects.toThrow("evidence differs");
            await expect(l.recordPayoff({ ...l.proof, customerId: "cus_other" })).rejects.toThrow("evidence differs");
            expect(await balance()).toBe(before);
          });
          test("step 2: undispatched abandonment releases only the payoff hold and requires a fresh quote for another payoff", async () => {
            const x = await payoffFixture(); await exitRequest(x.m, "revoke_debits");
            expect(await abandon(x)).toBe(true); expect(await abandon(x)).toBe(false);
            expect(await quoteExit(x.m)).toMatchObject({ coveredMonths: 1, payoffAmountCents: 20000, debitsRevoked: true });
            await expect(x.reserve()).rejects.toThrow("fresh settled");
          });
          test("step 8: expiry without proof that the PaymentIntent is canceled cannot release the hold", async () => {
            const x = await payoffFixture(); await x.publish();
            const proof = { paymentContext: context, checkoutSessionId: x.session, sessionStatus: "expired", paymentStatus: "unpaid",
              requestId: "req_abandon", paymentIntentId: "pi_payoff", paymentIntentStatus: "processing", amountReceived: 0 };
            await expect(abandon(x, proof)).rejects.toThrow("expired and proven uncaptured");
            expect(await abandon(x, { ...proof, paymentIntentStatus: "canceled" })).toBe(true);
          });
          test("step 8: captured payoff cannot be abandoned to restore automatic billing", async () => {
            const x = await payoffFixture(); await x.publish(); const l = await payoffLedger(x); await l.recordPayoff();
            await expect(abandon(x)).rejects.toThrow("Recorded payoff money");
          });
          describe("SQL 085 durable lifecycle and billing-only review", () => {
            beforeAll(async () => { await db.exec(sql("supabase/proposals/085-monthly-mentorship-lifecycle.sql")); });
            const eventId = () => "evt_" + randomUUID().replaceAll("-", "");
            const lifecycleProof = (m: Membership, status = "active") => ({ version: "monthly-lifecycle-proof-v1", paymentContext: context,
              customerId: m.customer, subscriptionId: m.subscription, objectType: "subscription", objectId: m.subscription,
              status, requestId: "req_lifecycle", pauseBehavior: "keep_as_draft", resumesAt: null });
            const observe = async (m: Membership, outcome = "observed", proof: unknown = lifecycleProof(m), event = eventId(), type = "customer.subscription.updated") =>
              (await db.query<{ value: { outcome: string; event_id: string } }>("select public.record_monthly_mentorship_lifecycle_v1($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb) value",
                [m.id, buyer, JSON.stringify(context), event, type, outcome, JSON.stringify(proof)])).rows[0].value;
            const containmentRequest = (m: Membership) => ({ method: "POST", path: "/v1/subscriptions/" + m.subscription,
              params: { pause_collection: { behavior: "keep_as_draft" }, proration_behavior: "none" } });
            const contain = async (m: Membership, event: string, request: unknown = containmentRequest(m)) =>
              (await db.query<{ value: { id: string; status: string; request: unknown } }>(
                "select public.claim_monthly_mentorship_containment_v1($1,$2,$3::jsonb,$4,'subscription',$5,$6::jsonb) value",
                [m.id, buyer, JSON.stringify(context), event, m.subscription, JSON.stringify(request)])).rows[0].value;
            const completeContainment = async (id: string, proof: unknown) => (await db.query<{ value: boolean }>(
              "select public.complete_monthly_mentorship_containment_v1($1,$2,$3::jsonb,$4::jsonb) value",
              [id, buyer, JSON.stringify(context), JSON.stringify(proof)])).rows[0].value;
            test("steps 1/2/8: provider cancellation preserves paid access, balance and unpaid minimum", async () => {
              const x = await paidMembership(), before = await balance();
              await observe(x.m, "provider_stopped", lifecycleProof(x.m, "canceled"));
              expect(await quoteExit(x.m)).toMatchObject({ renewalStopped: true, debitsRevoked: false, payoffAmountCents: 20000, coveredMonths: 1 });
              expect((await access(x.m)).allowed).toBe(true); expect(await balance()).toBe(before);
              expect((await db.query("select * from public.monthly_mentorship_exit_requests_v1 where agreement_id=$1", [x.m.id])).rows).toHaveLength(0);
            });
            test("step 8: fresh cancellation completes an existing accepted stop without new buyer consent", async () => {
              const x = await paidMembership(1), e = await exitRequest(x.m, "stop_renewal", await quoteExit(x.m));
              await observe(x.m, "provider_stopped", lifecycleProof(x.m, "canceled"));
              expect((await claimStop(e)).status).toBe("provider_stopped");
            });
            test("step 8: duplicate observations and later healthy snapshots cannot restart stopped billing", async () => {
              const x = await paidMembership(), event = eventId();
              await observe(x.m, "provider_stopped", lifecycleProof(x.m, "canceled"), event); const q = await quoteExit(x.m);
              await observe(x.m, "provider_stopped", lifecycleProof(x.m, "canceled"), event);
              await observe(x.m, "observed", lifecycleProof(x.m)); expect(await quoteExit(x.m)).toEqual(q);
              expect((await db.query("select * from public.monthly_mentorship_lifecycle_v1 where event_id=$1", [event])).rows).toHaveLength(1);
            });
            test("step 8: billing review blocks fresh automatic operation and payoff but does not remove paid access", async () => {
              const x = await paidMembership(), before = await balance(); await observe(x.m, "review_required");
              const q = await quoteExit(x.m); expect(q.reviewReasons).toContain("billing_review"); expect(q.payoffAmountCents).toBeNull();
              await expect(db.query("select public.claim_monthly_mentorship_operation_v1($1,$2,'activate','initial',$3,$4::jsonb,$5::jsonb)",
                [x.m.id, buyer, q.revision, JSON.stringify(context), JSON.stringify({ method: "POST", path: "/v1/subscriptions/" + x.m.subscription, params: {} })]))
                .rejects.toThrow("fresh eligible");
              expect((await access(x.m)).allowed).toBe(true); expect(await balance()).toBe(before);
            });
            test("step 8: lifecycle ownership and event identity are immutable", async () => {
              const x = await paidMembership(), y = await paidMembership(), event = eventId();
              await observe(x.m, "observed", lifecycleProof(x.m), event);
              await expect(observe(y.m, "observed", lifecycleProof(y.m), event)).rejects.toThrow("identity changed");
              await expect(observe(x.m, "observed", { ...lifecycleProof(x.m), customerId: "cus_other" })).rejects.toThrow("ownership");
              await expect(observe(x.m, "provider_stopped", lifecycleProof(x.m))).rejects.toThrow("actual canceled");
            });
            test("step 8: billing-review rows cannot be leased even if a scheduler retry is forced due", async () => {
              const x = await paidMembership();
              await db.query("update public.monthly_mentorship_agreements_v1 set billing_next_attempt_at='-infinity',billing_lease_until=null where id=$1", [x.m.id]);
              const leaseHere = async () => (await db.query<{ value: { id: string }[] }>(
                "select public.lease_monthly_mentorship_work_v1($1::jsonb,6) value", [JSON.stringify(context)])).rows[0].value;
              expect((await leaseHere()).some(r => r.id === x.m.id)).toBe(true);
              await observe(x.m, "review_required");
              await db.query("update public.monthly_mentorship_agreements_v1 set billing_next_attempt_at='-infinity',billing_lease_until=null where id=$1", [x.m.id]);
              expect((await leaseHere()).some(r => r.id === x.m.id)).toBe(false);
            });
            test("step 8: a billing-only hold does not discard a legitimate delayed first capture", async () => {
              const m = await createMembership(3, true, false); await completedBootstrap(m); await m.bind();
              await observe(m, "review_required"); const l = await ledger(m), anchor = Math.floor(Date.now() / 1000), before = await balance();
              expect(await record(m, l, 1, anchor, { ...l.proof, paymentMethodId: "pm_fixture", paidAt: anchor })).toMatchObject({ rows: [{ result: true }] });
              expect((await access(m)).allowed).toBe(true); expect(await balance()).toBeGreaterThan(before);
              expect((await quoteExit(m)).reviewReasons).toContain("billing_review");
            });
            test("step 8: hold-only containment requires prior durable billing review", async () => {
              const x = await paidMembership(), event = eventId(); await observe(x.m, "observed", lifecycleProof(x.m), event);
              await expect(contain(x.m, event)).rejects.toThrow("lacks durable review");
              await observe(x.m, "review_required", lifecycleProof(x.m), event);
              const o = await contain(x.m, event); expect(o.status).toBe("dispatched"); expect(await contain(x.m, event)).toEqual(o);
              await expect(contain(x.m, event, { ...containmentRequest(x.m), params: { pause_collection: "" } })).rejects.toThrow("only disable collection");
            });
            test("step 8: old unknown containment requires review but fresh actual hold can finish without dispatch", async () => {
              const x = await paidMembership(), event = eventId(); await observe(x.m, "review_required", lifecycleProof(x.m), event);
              const o = await contain(x.m, event);
              await db.query("update public.monthly_mentorship_containment_v1 set dispatched_at=now()-interval '21 hours' where id=$1", [o.id]);
              expect((await contain(x.m, event)).status).toBe("review_required");
              await expect(completeContainment(o.id, { ...lifecycleProof(x.m), pauseBehavior: null })).rejects.toThrow("fresh stopped-collection");
              expect(await completeContainment(o.id, lifecycleProof(x.m))).toBe(true); expect(await completeContainment(o.id, lifecycleProof(x.m))).toBe(false);
              expect((await quoteExit(x.m)).reviewReasons).toContain("billing_review"); expect((await access(x.m)).allowed).toBe(true);
            });
            test("step 8: expired payoff observation never releases its collection hold", async () => {
              const x = await payoffFixture(); await x.publish();
              const p = { ...lifecycleProof(x.m), objectType: "checkout.session", objectId: x.session, status: "expired", paymentStatus: "unpaid" };
              await observe(x.m, "checkout_attention", p, eventId(), "checkout.session.expired");
              const row = (await db.query<{ hold: unknown }>("select payoff_hold_at hold from public.monthly_mentorship_agreements_v1 where id=$1", [x.m.id])).rows[0];
              expect(row.hold).not.toBeNull(); expect((await quoteExit(x.m)).reviewReasons).not.toContain("billing_review");
            });
            test("step 8: invoice containment cannot target another invoice or enable automatic advancement", async () => {
              const x = await paidMembership(), event = eventId(), invoice = "in_lifecycle";
              await observe(x.m, "review_required", { ...lifecycleProof(x.m), objectType: "invoice", objectId: invoice, status: "draft", autoAdvance: true },
                event, "invoice.created");
              const request = { method: "POST", path: "/v1/invoices/" + invoice, params: { auto_advance: false } };
              const claim = (target: string, r: unknown) => db.query(
                "select public.claim_monthly_mentorship_containment_v1($1,$2,$3::jsonb,$4,'invoice',$5,$6::jsonb)",
                [x.m.id, buyer, JSON.stringify(context), event, target, JSON.stringify(r)]);
              await expect(claim("in_other", request)).rejects.toThrow("target differs");
              await expect(claim(invoice, { ...request, params: { auto_advance: true } })).rejects.toThrow("only disable collection");
              await expect(claim(invoice, request)).resolves.toBeDefined();
            });
            describe("SQL 086 receipt-backed payment events", () => {
              beforeAll(async () => { await db.exec(sql("supabase/proposals/086-monthly-mentorship-payment-events.sql")); });
              const paymentProof = (m: Membership, p: { paymentIntentId: string; chargeId: string; capturedAmountCents: number }) => ({
                version: "monthly-payment-event-proof-v1", paymentContext: context, customerId: m.customer, subscriptionId: m.subscription,
                objectType: "payment_intent", objectId: p.paymentIntentId, paymentIntentId: p.paymentIntentId, status: "succeeded",
                paymentStatus: "succeeded", requestId: "req_event", paymentRequestId: "req_payment", amountCents: p.capturedAmountCents,
                amountReceivedCents: p.capturedAmountCents, chargeId: p.chargeId, path: "first", checkoutSessionId: m.session, invoiceId: null,
                payoffId: null, reason: "captured_receipt_confirmed" });
              const paymentEvent = async (m: Membership, proof: unknown, outcome = "reconciled", event = eventId(), type = "payment_intent.succeeded") =>
                (await db.query<{ value: { outcome: string } }>(
                  "select public.record_monthly_mentorship_payment_event_v1($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb) value",
                  [m.id, buyer, JSON.stringify(context), event, type, outcome, JSON.stringify(proof)])).rows[0].value;
              test("step 8: first-payment event replay cannot credit another month or another ledger", async () => {
                const x = await paidMembership(), proof = paymentProof(x.m, x.first.proof), event = eventId(), before = await balance();
                expect((await paymentEvent(x.m, proof, "reconciled", event)).outcome).toBe("reconciled");
                await paymentEvent(x.m, proof, "reconciled", event); expect(await balance()).toBe(before);
                expect((await quoteExit(x.m)).coveredMonths).toBe(1);
              });
              test("step 8: a paid event with no captured receipt cannot grant access", async () => {
                const m = await createMembership(3, true, false); await completedBootstrap(m); await m.bind(); const l = await ledger(m), before = await balance();
                await expect(paymentEvent(m, paymentProof(m, l.proof))).rejects.toThrow("matching captured receipt");
                expect((await access(m)).allowed).toBe(false); expect(await balance()).toBe(before);
              });
              test.each(["paymentIntentId", "chargeId", "amount"])("step 8: mismatched payment-event %s cannot adopt a receipt", async field => {
                const x = await paidMembership(), proof = paymentProof(x.m, x.first.proof);
                if (field === "paymentIntentId") { proof.paymentIntentId = "pi_other"; proof.objectId = "pi_other"; }
                if (field === "chargeId") proof.chargeId = "ch_other";
                if (field === "amount") { proof.amountCents++; proof.amountReceivedCents++; }
                await expect(paymentEvent(x.m, proof)).rejects.toThrow("matching captured receipt");
              });
              test("step 8: renewal observations require the exact admitted invoice and captured monthly receipt", async () => {
                const x = await readyRenewal(); await x.admit(); await record(x.m, x.renew, 2, x.anchor, x.renewProof);
                const proof = { ...paymentProof(x.m, x.renew.proof), path: "renewal", month: 2, checkoutSessionId: null, invoiceId: x.renew.proof.invoiceId };
                const before = await balance(); await paymentEvent(x.m, proof); expect(await balance()).toBe(before);
                await expect(paymentEvent(x.m, { ...proof, invoiceId: "in_other" })).rejects.toThrow("collection admission");
              });
              test("step 8: payoff observations use the one payoff receipt, not fabricated monthly payments", async () => {
                const x = await payoffFixture(); await x.publish(); const l = await payoffLedger(x); await l.recordPayoff();
                const proof = { ...paymentProof(x.m, l.proof), path: "payoff", payoffId: x.getPayoff().id, checkoutSessionId: x.session };
                const before = await balance(); await paymentEvent(x.m, proof); expect(await balance()).toBe(before);
                expect((await quoteExit(x.m)).coveredMonths).toBe(3);
              });
              test("step 8: refunded receipt replay is observation only and cannot restore paid access", async () => {
                const x = await paidMembership(); await db.query("select public.apply_payment_fee_ledger_refund($1,10000)", [x.first.id]);
                const before = await balance(); await paymentEvent(x.m, paymentProof(x.m, x.first.proof));
                expect(await balance()).toBe(before); expect((await access(x.m)).allowed).toBe(false);
              });
              test("step 8: unpaid payoff attention does not release its hold or claim payment", async () => {
                const x = await payoffFixture(); await x.publish();
                const proof = { ...paymentProof(x.m, { paymentIntentId: "pi_payoffpending", chargeId: "ch_unused", capturedAmountCents: 20000 }),
                  path: "payoff", payoffId: x.getPayoff().id, checkoutSessionId: x.session, status: "canceled", paymentStatus: "canceled",
                  amountReceivedCents: 0, chargeId: null };
                await paymentEvent(x.m, proof, "checkout_attention", eventId(), "payment_intent.canceled");
                expect((await db.query<{ hold: unknown }>("select payoff_hold_at hold from public.monthly_mentorship_agreements_v1 where id=$1", [x.m.id])).rows[0].hold).not.toBeNull();
                expect((await quoteExit(x.m)).coveredMonths).toBe(1);
              });
              test("step 8: unresolved owned payment puts billing into review without inventing a purchase link", async () => {
                const x = await paidMembership(), proof = { ...paymentProof(x.m, x.first.proof), path: "unresolved", checkoutSessionId: null };
                await paymentEvent(x.m, proof, "review_required"); expect((await quoteExit(x.m)).reviewReasons).toContain("billing_review");
                expect((await access(x.m)).allowed).toBe(true);
                await expect(paymentEvent(x.m, { ...proof, checkoutSessionId: x.m.session }, "review_required")).rejects.toThrow("invent a payment link");
              });
              test("step 8: the original charge event can differ from the now-captured charge, but its event identity cannot change", async () => {
                const x = await paidMembership(), event = eventId(), proof = { ...paymentProof(x.m, x.first.proof), objectType: "charge", objectId: "ch_oldfailed", status: "failed" };
                await paymentEvent(x.m, proof, "reconciled", event, "charge.failed");
                await expect(paymentEvent(x.m, { ...proof, objectId: "ch_other" }, "reconciled", event, "charge.failed")).rejects.toThrow("identity changed");
              });
              describe("SQL 087 owned management and bounded exit recovery", () => {
                beforeAll(async () => { await db.exec(sql("supabase/proposals/087-monthly-mentorship-management.sql")); });
                beforeEach(async () => {
                  // Isolate due work from previously tested financial scenarios without changing their receipts or consent.
                  await db.exec("update public.monthly_mentorship_exit_requests_v1 set provider_next_attempt_at='infinity',provider_work_token=null,provider_lease_until=null");
                });
                type ExitJob = { membership_id: string; buyer_id: string; request_id: string; lease_token: string };
                type Managed = { id: string; acceptedAt: string; counterpartyId: string; firstPaymentRecorded: boolean;
                  quote: ExitQuote; access: { allowed: boolean }; exitStatus: { billingBlocked: boolean; providerStopped: boolean };
                  payoff: { id: string; status: string } | null };
                type ManagedPage = { view: string; items: Managed[]; nextCursor: { id: string; acceptedAt: string } | null };
                const exitLease = async (limit = 6, ctx = context) => (await db.query<{ value: ExitJob[] }>(
                  "select public.lease_monthly_mentorship_exit_work_v1($1::jsonb,$2) value", [JSON.stringify(ctx), limit])).rows[0].value;
                const finishExit = async (job: ExitJob, status: string, token = job.lease_token, ctx = context) =>
                  (await db.query<{ value: boolean }>("select public.finish_monthly_mentorship_exit_work_v1($1,$2,$3::jsonb,$4) value",
                    [job.request_id, token, JSON.stringify(ctx), status])).rows[0].value;
                const management = async (actor = buyer, view = "buyer", cursor: ManagedPage["nextCursor"] = null, limit = 12, ctx = context) =>
                  (await db.query<{ value: ManagedPage }>("select public.read_monthly_mentorship_management_v1($1,$2,$3::jsonb,$4,$5,$6) value",
                    [actor, view, JSON.stringify(ctx), cursor?.acceptedAt ?? null, cursor?.id ?? null, limit])).rows[0].value;
                const exitStatus = async (m: Membership, actor = buyer, ctx = context) => (await db.query<{ value: {
                  membershipId: string; billingBlocked: boolean; providerStopped: boolean; requests: { id: string; attempts: number; workerStatus: string | null }[] } }>(
                  "select public.read_monthly_mentorship_exit_status_v1($1,$2,$3::jsonb) value", [m.id, actor, JSON.stringify(ctx)])).rows[0].value;
                test("step 8: two kinds of stop on one agreement cannot be leased by overlapping worker batches", async () => {
                  const x = await paidMembership(1); await exitRequest(x.m, "stop_renewal", await quoteExit(x.m)); await exitRequest(x.m, "revoke_debits");
                  const jobs = await exitLease(); expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ membership_id: x.m.id, buyer_id: buyer });
                  expect(await exitLease()).toEqual([]); expect(await finishExit(jobs[0], "provider_review_required")).toBe(true);
                  const second = await exitLease(); expect(second).toHaveLength(1); expect(second[0].request_id).not.toBe(jobs[0].request_id);
                });
                test("steps 8/10: each lease is bounded to six owned requests and does not cross payment context", async () => {
                  for (let i = 0; i < 7; i++) { const x = await paidMembership(); await exitRequest(x.m, "revoke_debits"); }
                  expect(await exitLease(6, { ...context, stripeAccountId: "acct_other" })).toEqual([]);
                  const first = await exitLease(); expect(first).toHaveLength(6); expect(new Set(first.map(j => j.membership_id)).size).toBe(6);
                  expect(await exitLease()).toHaveLength(1); expect(await exitLease()).toEqual([]);
                  await expect(exitLease(7)).rejects.toThrow("worker request differs");
                });
                test("step 8: expired leases receive a new token and stale completion cannot overwrite the new worker", async () => {
                  const x = await paidMembership(); await exitRequest(x.m, "revoke_debits"); const [first] = await exitLease();
                  await db.query("update public.monthly_mentorship_exit_requests_v1 set provider_next_attempt_at=now()-interval '1 minute',provider_lease_until=now()-interval '1 minute' where id=$1", [first.request_id]);
                  const [second] = await exitLease(); expect(second.lease_token).not.toBe(first.lease_token);
                  expect(await finishExit(first, "retry_required")).toBe(false); expect(await finishExit(second, "retry_required")).toBe(true);
                  expect((await exitStatus(x.m)).requests[0]).toMatchObject({ attempts: 2, workerStatus: "retry_required" });
                  expect(await exitLease()).toEqual([]);
                });
                test("steps 2/4/8: recovery cannot reset consent, the original dispatch age, the agreement or money", async () => {
                  const x = await paidMembership(), e = await exitRequest(x.m, "revoke_debits"); await claimStop(e);
                  await db.query("update public.monthly_mentorship_exit_requests_v1 set provider_started_at=now()-interval '21 hours' where id=$1", [e.id]);
                  const saved = async () => (await db.query<{ value: unknown }>(
                    "select jsonb_build_object('consent',e.accepted_snapshot,'started',e.provider_started_at,'requested',e.requested_at,'agreement',to_jsonb(a)) value from public.monthly_mentorship_exit_requests_v1 e join public.monthly_mentorship_agreements_v1 a on a.id=e.agreement_id where e.id=$1", [e.id])).rows[0].value;
                  const before = await saved(), moneyBefore = await balance(), [job] = await exitLease();
                  expect((await claimStop(e)).status).toBe("review_required"); await finishExit(job, "provider_review_required");
                  expect(await saved()).toEqual(before); expect(await balance()).toBe(moneyBefore); expect((await access(x.m)).allowed).toBe(true);
                  expect((await quoteExit(x.m)).payoffAmountCents).toBe(20000);
                });
                test("step 8: a worker cannot manufacture provider-stop proof or complete under a different context", async () => {
                  const x = await paidMembership(); await exitRequest(x.m, "revoke_debits"); const [job] = await exitLease();
                  await expect(finishExit(job, "provider_stopped")).rejects.toThrow("not recorded");
                  await expect(finishExit(job, "provider_review_required", job.lease_token, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("context differs");
                  expect((await exitStatus(x.m)).providerStopped).toBe(false);
                });
                test("step 8: later durable provider proof wins over an older worker's pending result", async () => {
                  const x = await paidMembership(), e = await exitRequest(x.m, "revoke_debits"), [job] = await exitLease();
                  await recordStop(e, stopProof(x.m)); expect(await finishExit(job, "provider_review_required")).toBe(true);
                  expect(await exitStatus(x.m)).toMatchObject({ providerStopped: true, requests: [{ workerStatus: "provider_stopped" }] });
                  expect(await exitLease()).toEqual([]); expect((await access(x.m)).allowed).toBe(true);
                });
                test("step 8: an accepted payoff's saved stop is recoverable without another consent or ledger", async () => {
                  const x = await payoffFixture(); await x.publish(); const l = await payoffLedger(x); await l.recordPayoff();
                  const before = await balance(), [job] = await exitLease(); expect(job.membership_id).toBe(x.m.id);
                  const row = (await db.query<{ value: ExitRequest }>("select to_jsonb(e) value from public.monthly_mentorship_exit_requests_v1 e where id=$1", [job.request_id])).rows[0].value;
                  await recordStop(row, stopProof(x.m)); await finishExit(job, "provider_stopped");
                  expect(await balance()).toBe(before); expect((await quoteExit(x.m)).coveredMonths).toBe(3);
                  expect((await access(x.m)).allowed).toBe(true);
                });
                test("step 5: stop status is owned and never exposes consent snapshots or provider proof", async () => {
                  const x = await paidMembership(), e = await exitRequest(x.m, "revoke_debits"); await recordStop(e, stopProof(x.m));
                  const state = await exitStatus(x.m); expect(state).toMatchObject({ membershipId: x.m.id, billingBlocked: true, providerStopped: true });
                  const serialized = JSON.stringify(state);
                  for (const privateValue of ["accepted_snapshot", "provider_proof", x.m.subscription, x.m.customer, "req_stop"]) expect(serialized).not.toContain(privateValue);
                  await expect(exitStatus(x.m, creator)).rejects.toThrow("owner differs");
                  await expect(exitStatus(x.m, buyer, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("owner differs");
                });
                test("step 5: management exposes only the actor's buyer or creator side", async () => {
                  const x = await paidMembership();
                  const mine = await management(), customers = await management(creator, "creator");
                  expect(mine.items.find(item => item.id === x.m.id)).toMatchObject({ counterpartyId: creator, firstPaymentRecorded: true, access: { allowed: true } });
                  expect(customers.items.find(item => item.id === x.m.id)).toMatchObject({ counterpartyId: buyer });
                  expect((await management(creator, "buyer")).items).toEqual([]); expect((await management(buyer, "creator")).items).toEqual([]);
                  expect((await management(buyer, "buyer", null, 12, { ...context, stripeAccountId: "acct_other" })).items).toEqual([]);
                });
                test("step 5: a pending first purchase remains findable without receiving paid access", async () => {
                  const m = await createMembership(3, true, false), page = await management();
                  expect(page.items.find(item => item.id === m.id)).toMatchObject({ firstPaymentRecorded: false, access: { allowed: false } });
                  const text = JSON.stringify(page.items.find(item => item.id === m.id));
                  for (const field of ["terms", "stripe_customer_id", "stripe_subscription_id", "provider_proof", "accepted_snapshot"]) expect(text).not.toContain('"' + field + '"');
                });
                test("step 5: management includes the saved payoff reference and retains paid access after stop", async () => {
                  const x = await payoffFixture(); await x.publish(); const l = await payoffLedger(x); await l.recordPayoff();
                  const [job] = await exitLease(), row = (await db.query<{ value: ExitRequest }>("select to_jsonb(e) value from public.monthly_mentorship_exit_requests_v1 e where id=$1", [job.request_id])).rows[0].value;
                  await recordStop(row, stopProof(x.m));
                  expect((await management()).items.find(item => item.id === x.m.id)).toMatchObject({ payoff: { id: x.getPayoff().id, status: "captured" },
                    access: { allowed: true }, quote: { payoffAmountCents: 0 }, exitStatus: { billingBlocked: true, providerStopped: true } });
                });
                test("step 5: bounded keyset pages neither duplicate nor omit agreements at the cursor boundary", async () => {
                  for (let i = 0; i < 13; i++) await createMembership(1, true, false);
                  const first = await management(); expect(first.items).toHaveLength(12); expect(first.nextCursor?.id).toBe(first.items[11].id);
                  const second = await management(buyer, "buyer", first.nextCursor);
                  const expected = (await db.query<{ id: string }>("select id from public.monthly_mentorship_agreements_v1 where buyer_id=$1 and terms->'paymentContext'=$2::jsonb order by accepted_at desc,id desc limit 24",
                    [buyer, JSON.stringify(context)])).rows.map(row => row.id);
                  const actual = [...first.items, ...second.items].map(item => item.id);
                  expect(actual).toEqual(expected); expect(new Set(actual).size).toBe(actual.length);
                  expect(first.nextCursor?.acceptedAt).toBe(first.items[11].acceptedAt);
                });
                test("step 5: invalid role, unpaired cursor and oversized management pages are refused", async () => {
                  await expect(management(buyer, "admin")).rejects.toThrow("request differs");
                  await expect(management(buyer, "buyer", null, 13)).rejects.toThrow("request differs");
                  await expect(db.query("select public.read_monthly_mentorship_management_v1($1,'buyer',$2::jsonb,now(),null,12)", [buyer, JSON.stringify(context)])).rejects.toThrow("request differs");
                });
                describe("SQL 088 original checkout recovery", () => {
                  beforeAll(async () => { await db.exec(sql("supabase/proposals/088-monthly-mentorship-checkout-recovery.sql")); });
                  type BootstrapRow = { id: string; status: string; provider_id: string | null; dispatched_at: string };
                  async function recoveryFixture(target: "customer" | "product" | "subscription" | "hold" | "checkout" = "checkout", allComplete = false) {
                    const m = await createMembership(3, true, false);
                    const a = readMembershipRecord(JSON.parse(JSON.stringify((await db.query<{ value: unknown }>(
                      "select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [m.id])).rows[0].value)));
                    const ids = { customer: m.customer, product: "prod_" + randomUUID().replaceAll("-", ""), subscription: m.subscription, hold: m.subscription, checkout: m.session };
                    const requests = recoveryBootstrapRequests(a, ids);
                    let targetRow!: BootstrapRow;
                    for (const kind of recoveryBootstrapStages) {
                      const row = (await db.query<{ value: BootstrapRow }>(
                        "select public.claim_monthly_mentorship_operation_v1($1,$2,$3,'initial',$4,$5::jsonb,$6::jsonb) value",
                        [m.id, buyer, kind, a.revision, JSON.stringify(context), JSON.stringify(requests[kind])])).rows[0].value;
                      if (kind === target) targetRow = row;
                      if (kind === target && !allComplete) break;
                      await db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,'req_original')",
                        [row.id, JSON.stringify(context), ids[kind]]);
                    }
                    const proof = { version: "monthly-bootstrap-recovery-proof-v1", paymentContext: context, operationId: targetRow.id, kind: target,
                      objectType: target === "checkout" ? "checkout.session" : target === "hold" ? "subscription" : target,
                      objectId: ids[target], requestId: "req_recovery", metadata: requests[target === "hold" ? "subscription" : target].params.metadata,
                      customerId: target === "customer" ? null : ids.customer, productId: ["subscription", "hold", "checkout"].includes(target) ? ids.product : null,
                      subscriptionId: ["subscription", "hold", "checkout"].includes(target) ? ids.subscription : null, held: target === "hold" };
                    const recover = async (value: unknown = proof, actor = buyer, ctx = context, request: unknown = requests[target]) =>
                      (await db.query<{ value: boolean }>("select public.reconcile_monthly_mentorship_bootstrap_v1($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) value",
                        [targetRow.id, actor, JSON.stringify(ctx), JSON.stringify(request), JSON.stringify(value)])).rows[0].value;
                    const publish = async (actor = buyer, ctx = context) => (await db.query<{ value: boolean }>(
                      "select public.publish_monthly_mentorship_recovery_v1($1,$2,$3::jsonb) value", [m.id, actor, JSON.stringify(ctx)])).rows[0].value;
                    return { m, a, ids, requests, targetRow, proof, recover, publish };
                  }
                  test.each(recoveryBootstrapStages)("steps 4/8: late positive %s recovery preserves original identity, age and consent", async kind => {
                    const x = await recoveryFixture(kind);
                    await db.query("update public.monthly_mentorship_operations_v1 set dispatched_at=now()-interval '21 hours',status='review_required' where id=$1", [x.targetRow.id]);
                    const before = (await db.query<{ value: { dispatched: string; agreement: unknown } }>(
                      "select jsonb_build_object('dispatched',o.dispatched_at,'agreement',to_jsonb(a)) value from public.monthly_mentorship_operations_v1 o join public.monthly_mentorship_agreements_v1 a on a.id=o.agreement_id where o.id=$1", [x.targetRow.id])).rows[0].value;
                    const moneyBefore = await balance(); expect(await x.recover()).toBe(true); expect(await x.recover()).toBe(false);
                    const after = (await db.query<{ value: { dispatched: string; agreement: unknown; proof: unknown; status: string; providerId: string } }>(
                      "select jsonb_build_object('dispatched',o.dispatched_at,'agreement',to_jsonb(a),'proof',o.recovery_proof,'status',o.status,'providerId',o.provider_id) value from public.monthly_mentorship_operations_v1 o join public.monthly_mentorship_agreements_v1 a on a.id=o.agreement_id where o.id=$1", [x.targetRow.id])).rows[0].value;
                    expect(after.dispatched).toBe(before.dispatched); expect(after.agreement).toEqual(before.agreement);
                    expect(after).toMatchObject({ status: "complete", providerId: x.ids[kind], proof: x.proof });
                    expect(await balance()).toBe(moneyBefore); expect((await access(x.m)).allowed).toBe(false);
                  });
                  test("step 8: positive recovery does not relax the old unknown-result retry fence", async () => {
                    const x = await recoveryFixture("customer");
                    await db.query("update public.monthly_mentorship_operations_v1 set dispatched_at=now()-interval '21 hours' where id=$1", [x.targetRow.id]);
                    await expect(db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,'req_old')",
                      [x.targetRow.id, JSON.stringify(context), x.ids.customer])).rejects.toThrow("requires reconciliation");
                    const op = (await db.query<{ value: BootstrapRow }>("select public.claim_monthly_mentorship_operation_v1($1,$2,'customer','initial',0,$3::jsonb,$4::jsonb) value",
                      [x.m.id, buyer, JSON.stringify(context), JSON.stringify(x.requests.customer)])).rows[0].value;
                    expect(op.status).toBe("review_required"); expect(op.provider_id).toBeNull();
                  });
                  test("step 5: recovery and publication remain owned and context-pinned", async () => {
                    const x = await recoveryFixture();
                    await expect(x.recover(x.proof, creator)).rejects.toThrow("owner differs");
                    await expect(x.recover(x.proof, buyer, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("owner differs");
                    await expect(x.publish(creator)).rejects.toThrow("owner differs");
                    await expect(x.publish(buyer, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("owner differs");
                  });
                  test.each(["fingerprint", "metadata", "object", "customer", "subscription", "request"])("step 8: changed recovery %s cannot manufacture a completed payment link", async field => {
                    const x = await recoveryFixture(), proof = JSON.parse(JSON.stringify(x.proof));
                    if (field === "fingerprint") proof.metadata.creatornet_membership_fingerprint = "wrong";
                    if (field === "metadata") proof.metadata.buyer_id = creator;
                    if (field === "object") proof.objectType = "customer";
                    if (field === "customer") proof.customerId = "cus_other";
                    if (field === "subscription") proof.subscriptionId = "sub_other";
                    await expect(x.recover(proof, buyer, context, field === "request" ? { ...x.requests.checkout, params: { amount: 1 } } : x.requests.checkout)).rejects.toThrow();
                    expect((await access(x.m)).allowed).toBe(false);
                  });
                  test("step 8: a recovered result cannot later be rebound to a different provider object", async () => {
                    const x = await recoveryFixture("customer"); await x.recover();
                    await expect(x.recover({ ...x.proof, objectId: "cus_other" })).rejects.toThrow("result changed");
                  });
                  test("step 8: publication cannot skip an unknown checkout result", async () => {
                    const x = await recoveryFixture(); await expect(x.publish()).rejects.toThrow("original completed operations");
                    expect((await access(x.m)).allowed).toBe(false);
                  });
                  test("steps 2/7/8: a stop racing original publication cannot lose captured-money recovery or restart billing", async () => {
                    const x = await recoveryFixture("checkout", true), moneyBefore = await balance();
                    await exitRequest(x.m, "revoke_debits"); expect(await x.publish()).toBe(true); expect(await x.publish()).toBe(false);
                    expect((await quoteExit(x.m)).debitsRevoked).toBe(true); expect(await balance()).toBe(moneyBefore); expect((await access(x.m)).allowed).toBe(false);
                    const first = await ledger(x.m), anchor = Math.floor(Date.now() / 1000);
                    expect((await record(x.m, first, 1, anchor, { ...first.proof, paymentMethodId: "pm_fixture", paidAt: anchor })).rows[0].result).toBe(true);
                    expect((await quoteExit(x.m)).debitsRevoked).toBe(true); expect((await access(x.m)).allowed).toBe(true);
                  });
                  describe("SQL 089 unpaid original checkout close-out", () => {
                    beforeAll(async () => { await db.exec(sql("supabase/proposals/089-monthly-mentorship-initial-abandonment.sql")); });
                    const requestClose = (m: Membership, confirmed = true, actor = buyer, ctx = context) => db.query(
                      "select public.request_monthly_initial_abandonment_v1($1,$2,$3::jsonb,$4)", [m.id, actor, JSON.stringify(ctx), confirmed]);
                    const finishClose = async (m: Membership, proof: unknown = { version: "monthly-initial-abandonment-proof-v1", paymentContext: context, membershipId: m.id, neverPayable: true }) =>
                      (await db.query<{ value: boolean }>("select public.complete_monthly_initial_abandonment_v1($1,$2,$3::jsonb,$4::jsonb) value",
                        [m.id, buyer, JSON.stringify(context), JSON.stringify(proof)])).rows[0].value;
                    async function nativeClose() {
                      const x = await recoveryFixture("checkout", true); await requestClose(x.m);
                      const resource = (kind: string, status: string): Record<string, unknown> => ({
                        version: "monthly-initial-resource-proof-v1", paymentContext: context, requestId: "req_initial",
                        customerId: x.ids.customer, subscriptionId: x.ids.subscription, status,
                        ...(kind === "expire_checkout" ? { objectId: x.ids.checkout, objectType: "checkout.session", metadata: x.requests.checkout.params.metadata,
                          amountCents: 10000, paymentStatus: "unpaid" } : kind === "cancel_subscription" ? {
                          objectId: x.ids.subscription, objectType: "subscription", metadata: x.requests.subscription.params.metadata } : {
                          objectId: "in_" + x.m.id.replaceAll("-", ""), objectType: "invoice", currency: "usd", amountPaidCents: 0,
                          autoAdvance: false, hostedInvoiceUrlNull: true }),
                      });
                      const claim = async (kind: string, proof: unknown) => (await db.query<{ value: { id: string; request: unknown; provider_started_at: string | null } }>(
                        "select public.claim_monthly_initial_closure_v1($1,$2,$3::jsonb,$4,$5::jsonb) value",
                        [x.m.id, buyer, JSON.stringify(context), kind, JSON.stringify(proof)])).rows[0].value;
                      const complete = async (id: string, proof: unknown) => (await db.query<{ value: boolean }>(
                        "select public.complete_monthly_initial_closure_v1($1,$2,$3::jsonb,$4::jsonb) value",
                        [id, buyer, JSON.stringify(context), JSON.stringify(proof)])).rows[0].value;
                      const proof: Record<string, unknown> = { version: "monthly-initial-abandonment-proof-v1", paymentContext: context, membershipId: x.m.id,
                        neverPayable: false, customerId: x.ids.customer, subscriptionId: x.ids.subscription, checkoutSessionId: x.ids.checkout,
                        listsComplete: true, pendingInvoiceItemCount: 0, readRequestIds: Array(6).fill("req_initial"), paymentIntents: [], charges: [],
                        invoices: [], subscriptions: [{ id: x.ids.subscription, status: "canceled" }], checkouts: [{ id: x.ids.checkout, status: "expired", paymentStatus: "unpaid" }] };
                      const roots = async () => {
                        for (const [kind, status] of [["expire_checkout", "expired"], ["cancel_subscription", "canceled"]]) {
                          const p = resource(kind, status), op = await claim(kind, p); await complete(op.id, p);
                        }
                      };
                      return { ...x, resource, claim, complete, proof, roots };
                    }
                    test("steps 4/5: only a proven unpaid close-out releases the current-offer slot while preserving its consent and purchase", async () => {
                      const m = await createMembership(3, true, false), money = await balance();
                      const before = (await db.query<{ value: unknown }>("select jsonb_build_object('terms',terms,'fingerprint',fingerprint,'acceptedAt',accepted_at,'purchase',purchase_id) value from public.monthly_mentorship_agreements_v1 where id=$1", [m.id])).rows[0].value;
                      await requestClose(m); expect((await m.reserve()).rows[0].id).toBe(m.id);
                      expect(await finishClose(m)).toBe(true); expect(await finishClose(m)).toBe(false);
                      await expect(m.reserve(m.quote.agreement, false)).rejects.toThrow("Explicit current");
                      const next = (await m.reserve()).rows[0].id; expect(next).not.toBe(m.id); expect((await m.reserve()).rows[0].id).toBe(next);
                      const after = (await db.query<{ value: unknown }>("select jsonb_build_object('terms',terms,'fingerprint',fingerprint,'acceptedAt',accepted_at,'purchase',purchase_id) value from public.monthly_mentorship_agreements_v1 where id=$1", [m.id])).rows[0].value;
                      expect(after).toEqual(before); expect(await balance()).toBe(money); expect((await access(m)).allowed).toBe(false);
                      expect((await db.query<{ status: string }>("select status from public.purchases where id=$1", [m.purchase])).rows[0].status).toBe("canceled");
                    });
                    test("steps 3/8: ordinary canceled purchases keep buyer/post and buyer/product uniqueness", async () => {
                      const product = randomUUID(), post = randomUUID(), otherPost = randomUUID();
                      await db.query("insert into public.products(id,creator_id,title,type,price_cents,amount_cents,currency,plan_months) values($1,$2,'Legacy offer','mentorship',10000,10000,'usd',1)", [product, creator]);
                      for (const id of [post, otherPost]) await db.query("insert into public.posts(id,creator_id,product_id,title) values($1,$2,$3,'Legacy post')", [id, creator, product]);
                      const insert = (id: string) => db.query("insert into public.purchases(id,buyer_id,creator_id,product_id,post_id,currency,status,kind,access_granted) values($1,$2,$3,$4,$5,'usd','canceled','one_time',false)",
                        [randomUUID(), buyer, creator, product, id]);
                      await insert(post); await expect(insert(post)).rejects.toThrow("purchases_");
                      await expect(insert(otherPost)).rejects.toThrow("purchases_unique_buyer_product");
                      const m = await createMembership(3, true, false);
                      await expect(db.query("update public.purchases set status='canceled' where id=$1", [m.purchase])).rejects.toThrow("proven unpaid");
                    });
                    test("steps 4/5/8: a freshly accepted replacement records only its own payment and paid access", async () => {
                      const m = await createMembership(3, true, false); await requestClose(m); await finishClose(m);
                      const id = (await m.reserve()).rows[0].id, suffix = id.replaceAll("-", "");
                      const purchase = (await db.query<{ purchase_id: string }>("select purchase_id from public.monthly_mentorship_agreements_v1 where id=$1", [id])).rows[0].purchase_id;
                      const next: Membership = { ...m, id, purchase, customer: "cus_" + suffix, subscription: "sub_" + suffix, session: "cs_test_" + suffix };
                      await completedBootstrap(next);
                      await db.query("select public.bind_monthly_mentorship_provider_v1($1,$2,$3,$4)", [next.id, next.customer, next.subscription, next.session]);
                      const first = await ledger(next), anchor = Math.floor(Date.now() / 1000);
                      expect((await record(next, first, 1, anchor, { ...first.proof, paymentMethodId: "pm_fixture", paidAt: anchor })).rows[0].result).toBe(true);
                      expect((await access(m)).allowed).toBe(false); expect((await access(next)).allowed).toBe(true);
                    });
                    test("step 8: closed monthly history cannot be changed back into an active purchase", async () => {
                      const m = await createMembership(3, true, false); await requestClose(m); await finishClose(m);
                      await expect(db.query("update public.purchases set status='pending' where id=$1", [m.purchase])).rejects.toThrow("proven unpaid");
                    });
                    test("steps 4/5: an abandoned offer cannot silently accept stale replacement terms", async () => {
                      const m = await createMembership(3, true, false); await requestClose(m); await finishClose(m);
                      await db.query("update public.products set title='Changed current terms' where id=$1", [m.quote.agreement.productId]);
                      await expect(m.reserve()).rejects.toThrow("current offer");
                    });
                    test("steps 4/5: false intent, foreign actor and another payment context are refused", async () => {
                      const m = await createMembership(3, true, false);
                      await expect(requestClose(m, false)).rejects.toThrow("owned");
                      await expect(requestClose(m, true, creator)).rejects.toThrow("owned");
                      await expect(requestClose(m, true, buyer, { ...context, mode: "live" as "test" })).rejects.toThrow("owned");
                      await expect(finishClose(m)).rejects.toThrow("intent");
                    });
                    test.each(["ledger", "paid_access", "financial_hold"])("step 8: %s cannot be erased by closing the initial checkout", async state => {
                      const m = await createMembership(3, true, false);
                      if (state === "ledger" || state === "paid_access") {
                        await completedBootstrap(m); await m.bind(); const first = await ledger(m);
                        if (state === "paid_access") { const anchor = Math.floor(Date.now() / 1000);
                          await record(m, first, 1, anchor, { ...first.proof, paymentMethodId: "pm_fixture", paidAt: anchor }); }
                      } else await db.query("update public.monthly_mentorship_agreements_v1 set financial_hold_at=now() where id=$1", [m.id]);
                      const money = await balance(); await expect(requestClose(m)).rejects.toThrow("unpaid"); expect(await balance()).toBe(money);
                    });
                    test("step 8: native work cannot be mislabeled never-payable and incomplete roots cannot release the reservation", async () => {
                      const x = await nativeClose();
                      await expect(finishClose(x.m)).rejects.toThrow("never started");
                      await expect(finishClose(x.m, x.proof)).rejects.toThrow("incomplete");
                      expect((await x.m.reserve()).rows[0].id).toBe(x.m.id);
                    });
                    test("steps 1/8: exact stop identity and original timestamps survive a retry older than the payment-creation retry fence", async () => {
                      const x = await nativeClose(), p = x.resource("cancel_subscription", "trialing"), first = await x.claim("cancel_subscription", p);
                      expect(first.request).toEqual({ method: "DELETE", path: "/v1/subscriptions/" + x.ids.subscription, params: { invoice_now: false, prorate: false } });
                      await db.query("update public.monthly_mentorship_initial_closures_v1 set provider_started_at=now()-interval '30 hours' where id=$1", [first.id]);
                      const before = (await db.query<{ value: string }>("select provider_started_at::text value from public.monthly_mentorship_initial_closures_v1 where id=$1", [first.id])).rows[0].value;
                      expect((await x.claim("cancel_subscription", p)).id).toBe(first.id);
                      expect((await db.query<{ value: string }>("select provider_started_at::text value from public.monthly_mentorship_initial_closures_v1 where id=$1", [first.id])).rows[0].value).toBe(before);
                      await expect(x.complete(first.id, p)).rejects.toThrow("terminal");
                      expect(await x.complete(first.id, x.resource("cancel_subscription", "canceled"))).toBe(true);
                      expect(await x.complete(first.id, x.resource("cancel_subscription", "canceled"))).toBe(false);
                    });
                    test.each(["customer", "fingerprint", "request", "resource"])("step 8: changed %s cannot authorize a guessed subscription stop", async fault => {
                      const x = await nativeClose(), p = x.resource("cancel_subscription", "trialing");
                      if (fault === "customer") p.customerId = "cus_other";
                      if (fault === "fingerprint") p.metadata = { ...(p.metadata as object), creatornet_membership_fingerprint: "wrong" };
                      if (fault === "request") p.requestId = "";
                      if (fault === "resource") p.objectId = "sub_other";
                      await expect(x.claim("cancel_subscription", p)).rejects.toThrow("resource");
                    });
                    test("step 8: a nonpayable subscription draft is held without finalizing or deleting the invoice", async () => {
                      const x = await nativeClose(); await x.roots(); const p = x.resource("hold_invoice", "draft");
                      const op = await x.claim("hold_invoice", p);
                      expect(op.request).toEqual({ method: "POST", path: "/v1/invoices/" + p.objectId, params: { auto_advance: false } });
                      expect(op.provider_started_at).toBeNull(); await x.complete(op.id, p);
                      x.proof.invoices = [{ id: p.objectId, status: "draft", amountPaidCents: 0, autoAdvance: false, hostedInvoiceUrlNull: true }];
                      expect(await finishClose(x.m, x.proof)).toBe(true);
                    });
                    test.each(["customer", "reads", "pending_intent", "captured_charge", "payable_draft", "pending_items", "active_subscription", "open_checkout", "pagination"])(
                      "step 8: incomplete final %s evidence cannot close an unpaid original", async fault => {
                        const x = await nativeClose(); await x.roots();
                        if (fault === "customer") x.proof.customerId = "cus_other";
                        if (fault === "reads") x.proof.readRequestIds = [];
                        if (fault === "pending_intent") x.proof.paymentIntents = [{ id: "pi_pending", status: "processing", amountReceivedCents: 0, amountCapturableCents: 0 }];
                        if (fault === "captured_charge") x.proof.charges = [{ id: "ch_paid", paid: true, amountCapturedCents: 10000 }];
                        if (fault === "payable_draft") x.proof.invoices = [{ id: "in_pending", status: "draft", amountPaidCents: 0, autoAdvance: true, hostedInvoiceUrlNull: true }];
                        if (fault === "pending_items") x.proof.pendingInvoiceItemCount = 1;
                        if (fault === "active_subscription") x.proof.subscriptions = [{ id: x.ids.subscription, status: "active" }];
                        if (fault === "open_checkout") x.proof.checkouts = [{ id: x.ids.checkout, status: "open", paymentStatus: "unpaid" }];
                        if (fault === "pagination") x.proof.listsComplete = false;
                        await expect(finishClose(x.m, x.proof)).rejects.toThrow(); expect((await x.m.reserve()).rows[0].id).toBe(x.m.id);
                      });
                    test("steps 5/8: owned account history marks the closed attempt without inventing paid access or a payoff", async () => {
                      const m = await createMembership(3, true, false); await requestClose(m); await finishClose(m);
                      const page = (await db.query<{ value: { items: { id: string; initialAbandoned: boolean; firstPaymentRecorded: boolean; access: { allowed: boolean }; payoff: unknown }[] } }>(
                        "select public.read_monthly_mentorship_management_v1($1,'buyer',$2::jsonb,null,null,12) value", [buyer, JSON.stringify(context)])).rows[0].value;
                      expect(page.items.find(i => i.id === m.id)).toMatchObject({ initialAbandoned: true, firstPaymentRecorded: false, access: { allowed: false }, payoff: null });
                    });
                    test("step 8: unexpected late money stays in the ledger rather than reopening a closed attempt", async () => {
                      const x = await nativeClose(); await x.publish(); await x.roots(); expect(await finishClose(x.m, x.proof)).toBe(true);
                      const l = await ledger(x.m), anchor = Math.floor(Date.now() / 1000), money = await balance();
                      await expect(record(x.m, l, 1, anchor, { ...l.proof, paymentMethodId: "pm_fixture", paidAt: anchor })).rejects.toThrow();
                      expect(await balance()).toBe(money); expect((await access(x.m)).allowed).toBe(false);
                      expect((await db.query("select id from public.payment_fee_ledger where id=$1", [l.id])).rows).toHaveLength(1);
                    });
                    describe("SQL 090 original activation observation", () => {
                      beforeAll(async () => { await db.exec(sql("supabase/proposals/090-monthly-mentorship-activation-recovery.sql")); });
                      async function activationRecoveryFixture(days = 3) {
                        const m = await createMembership(3, true, false), anchor = Math.floor(Date.now() / 1000) - days * 86400;
                        // Synthetic accepted/captured chronology precedes original provider admission.
                        await db.query("update public.monthly_mentorship_agreements_v1 set accepted_at=to_timestamp($2) where id=$1", [m.id, anchor - 60]);
                        await completedBootstrap(m); await m.bind();
                        const first = await ledger(m); await record(m, first, 1, anchor, { ...first.proof, paymentMethodId: "pm_fixture", paidAt: anchor });
                        const a = readMembershipRecord(JSON.parse(JSON.stringify((await db.query<{ value: unknown }>(
                          "select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [m.id])).rows[0].value)));
                        const params = membershipActivationParams(a, { paymentMethodId: "pm_fixture", paidAt: anchor, paymentIntentId: first.proof.paymentIntentId });
                        const request = { method: "POST", path: "/v1/subscriptions/" + m.subscription, params };
                        const revision = (await db.query<{ revision: number }>("select revision from public.monthly_mentorship_agreements_v1 where id=$1", [m.id])).rows[0].revision;
                        const op = (await db.query<{ value: { id: string } }>("select public.claim_monthly_mentorship_operation_v1($1,$2,'activate','initial',$3,$4::jsonb,$5::jsonb) value",
                          [m.id, buyer, revision, JSON.stringify(context), JSON.stringify(request)])).rows[0].value;
                        const proof = { version: "monthly-activation-recovery-proof-v1", paymentContext: context, requestId: "req_activation",
                          objectId: m.subscription, objectType: "subscription", status: "trialing", customerId: m.customer,
                          subscriptionId: m.subscription, metadata: params.metadata, trialEnd: params.trial_end, billingCycleAnchor: params.trial_end,
                          cancelAt: null, paymentMethodId: "pm_fixture", pauseBehavior: "keep_as_draft", resumesAt: null };
                        const recover = async (value: unknown = proof, actor = buyer, ctx = context, operation = op.id) => (await db.query<{ value: boolean }>(
                          "select public.reconcile_monthly_mentorship_activation_v1($1,$2,$3::jsonb,$4::jsonb) value",
                          [operation, actor, JSON.stringify(ctx), JSON.stringify(value)])).rows[0].value;
                        return { m, anchor, op, request, proof, recover };
                      }
                      test("steps 1/8: old positive activation observation keeps the original operation, age, consent and earnings", async () => {
                        const x = await activationRecoveryFixture(), money = await balance();
                        await db.query("update public.monthly_mentorship_operations_v1 set dispatched_at=now()-interval '21 hours',status='review_required' where id=$1", [x.op.id]);
                        const snapshot = async () => (await db.query<{ value: unknown }>("select jsonb_build_object('agreement',to_jsonb(a),'request',o.request,'dispatchedAt',o.dispatched_at,'operationId',o.id) value from public.monthly_mentorship_operations_v1 o join public.monthly_mentorship_agreements_v1 a on a.id=o.agreement_id where o.id=$1", [x.op.id])).rows[0].value;
                        const before = await snapshot();
                        expect(await x.recover()).toBe(true); expect(await x.recover()).toBe(false); expect(await snapshot()).toEqual(before);
                        expect(await balance()).toBe(money); expect((await access(x.m)).allowed).toBe(true);
                        const saved = (await db.query<{ value: { status: string; providerId: string; proof: unknown } }>(
                          "select jsonb_build_object('status',status,'providerId',provider_id,'proof',recovery_proof) value from public.monthly_mentorship_operations_v1 where id=$1", [x.op.id])).rows[0].value;
                        expect(saved).toEqual({ status: "complete", providerId: x.m.subscription, proof: x.proof });
                      });
                      test("steps 2/8: observing activation does not clear a racing debit stop or billing review", async () => {
                        const x = await activationRecoveryFixture(); await exitRequest(x.m, "revoke_debits");
                        await db.query("update public.monthly_mentorship_agreements_v1 set billing_review_at=now(),billing_review_reason='evt_existingreview' where id=$1", [x.m.id]);
                        const snapshot = async () => (await db.query<{ value: unknown }>("select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [x.m.id])).rows[0].value;
                        const before = await snapshot(); expect(await x.recover()).toBe(true); expect(await snapshot()).toEqual(before);
                        expect((await quoteExit(x.m)).debitsRevoked).toBe(true);
                      });
                      test.each(["customer", "subscription", "metadata", "trial", "anchor", "cancel", "card", "hold", "resume", "status", "request_id"])(
                        "step 8: changed activation %s cannot be treated as the original applied request", async field => {
                          const x = await activationRecoveryFixture(), proof = JSON.parse(JSON.stringify(x.proof));
                          if (field === "customer") proof.customerId = "cus_other";
                          if (field === "subscription") proof.objectId = "sub_other";
                          if (field === "metadata") proof.metadata.creatornet_membership_fingerprint = "wrong";
                          if (field === "trial") proof.trialEnd++;
                          if (field === "anchor") proof.billingCycleAnchor++;
                          if (field === "cancel") proof.cancelAt = proof.trialEnd;
                          if (field === "card") proof.paymentMethodId = "pm_other";
                          if (field === "hold") proof.pauseBehavior = null;
                          if (field === "resume") proof.resumesAt = proof.trialEnd;
                          if (field === "status") proof.status = "canceled";
                          if (field === "request_id") proof.requestId = "";
                          await expect(x.recover(proof)).rejects.toThrow("original held schedule");
                          expect((await db.query<{ status: string }>("select status from public.monthly_mentorship_operations_v1 where id=$1", [x.op.id])).rows[0].status).toBe("dispatched");
                        });
                      test("steps 5/8: activation recovery is owned and cannot invent an unknown original operation", async () => {
                        const x = await activationRecoveryFixture();
                        await expect(x.recover(x.proof, creator)).rejects.toThrow("owner");
                        await expect(x.recover(x.proof, buyer, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("owner");
                        await expect(x.recover(x.proof, buyer, context, randomUUID())).rejects.toThrow("owner");
                        const prior = (await db.query<{ id: string }>("select id from public.monthly_mentorship_operations_v1 where agreement_id=$1 and kind='subscription'", [x.m.id])).rows[0].id;
                        await expect(x.recover(x.proof, buyer, context, prior)).rejects.toThrow("original held schedule");
                      });
                      test("step 10: activation recovery is a private observation RPC, not a client mutation", async () => {
                        const rows = (await db.query<{ role: string; execute: boolean; mutate: boolean }>(
                          "select r role,has_function_privilege(r,'public.reconcile_monthly_mentorship_activation_v1(uuid,uuid,jsonb,jsonb)','EXECUTE') execute,has_table_privilege(r,'public.monthly_mentorship_operations_v1','UPDATE') mutate from unnest(array['anon','authenticated','service_role']) r")).rows;
                        expect(rows).toEqual([{ role: "anon", execute: false, mutate: false }, { role: "authenticated", execute: false, mutate: false }, { role: "service_role", execute: true, mutate: false }]);
                      });
                      describe("SQL 091 original renewal recovery observations", () => {
                        beforeAll(async () => { await db.exec(sql("supabase/proposals/091-monthly-mentorship-renewal-recovery.sql")); });
                        async function renewalRecoveryFixture() {
                          const x = await activationRecoveryFixture(32); await x.recover();
                          const a = readMembershipRecord(JSON.parse(JSON.stringify((await db.query<{ value: unknown }>(
                            "select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [x.m.id])).rows[0].value)));
                          const invoiceId = "in_recovery" + randomUUID().replaceAll("-", ""), pi = "pi_recovery" + randomUUID().replaceAll("-", "");
                          const request = { method: "POST", path: "/v1/invoices/" + invoiceId + "/pay",
                            params: { payment_method: "pm_fixture", off_session: true, forgive: false, paid_out_of_band: false } };
                          const op = (await db.query<{ value: { id: string } }>(
                            "select public.claim_monthly_mentorship_operation_v1($1,$2,'collect','2',$3,$4::jsonb,$5::jsonb) value",
                            [a.id, creator, a.revision, JSON.stringify(context), JSON.stringify(request)])).rows[0].value;
                          const proof = { version: "monthly-renewal-recovery-proof-v1", paymentContext: context, operationId: op.id,
                            customerId: a.stripe_customer_id, subscriptionId: a.stripe_subscription_id, invoiceId, paymentIntentId: pi,
                            originalPaymentMethodId: "pm_fixture", month: 2, periodStart: membershipMonthBoundary(x.anchor, 1),
                            periodEnd: membershipMonthBoundary(x.anchor, 2), invoiceStatus: "open", paymentStatus: "requires_payment_method",
                            amountDueCents: a.monthly_price_cents, amountPaidCents: 0, amountReceivedCents: 0, amountCapturableCents: 0,
                            attemptCount: 1, observedAt: Math.floor(Date.now() / 1000), invoiceRequestId: "req_invoice", paymentRequestId: "req_payment" };
                          const observe = async (outcome = "payment_method_required", value: unknown = proof, actor = buyer, ctx = context, revision = a.revision) =>
                            (await db.query<{ value: Record<string, unknown> }>(
                              "select public.record_monthly_mentorship_renewal_recovery_v1($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb) value",
                              [a.id, actor, op.id, JSON.stringify(ctx), revision, outcome, JSON.stringify(value)])).rows[0].value;
                          return { ...x, a, invoiceId, pi, collection: op, recoveryProof: proof, observe };
                        }
                        test("steps 1/8: a decline preserves original operation age, terms, service and money", async () => {
                          const x = await renewalRecoveryFixture(), money = await balance();
                          await db.query("update public.monthly_mentorship_operations_v1 set dispatched_at=now()-interval '21 hours' where id=$1", [x.collection.id]);
                          const original = (await db.query<{ value: unknown }>("select to_jsonb(o) value from public.monthly_mentorship_operations_v1 o where id=$1", [x.collection.id])).rows[0].value as Record<string, unknown>;
                          const result = await x.observe(); expect(result.outcome).toBe("payment_method_required");
                          const after = (await db.query<{ value: unknown }>("select to_jsonb(o) value from public.monthly_mentorship_operations_v1 o where id=$1", [x.collection.id])).rows[0].value as Record<string, unknown>;
                          expect(after.status).toBe("review_required"); expect(after.dispatched_at).toEqual(original.dispatched_at); expect(after.request).toEqual(original.request);
                          const a = (await db.query<{ value: unknown }>("select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [x.a.id])).rows[0].value;
                          expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(x.a))); expect(await balance()).toBe(money);
                        });
                        test("step 8: original observation and payment identity survive repeat reads", async () => {
                          const x = await renewalRecoveryFixture(), first = await x.observe();
                          const next = await x.observe("payment_pending", { ...x.recoveryProof, paymentStatus: "processing", paymentRequestId: "req_later" });
                          expect(next.first_observation).toEqual(first.first_observation);
                          expect(next.latest_observation).toMatchObject({ paymentRequestId: "req_later", paymentStatus: "processing" });
                          await expect(x.observe("payment_pending", { ...x.recoveryProof, paymentStatus: "processing", paymentIntentId: "pi_other" })).rejects.toThrow("binding cannot change");
                        });
                        test.each(["invoiceId", "customerId", "subscriptionId", "operationId", "originalPaymentMethodId", "month", "periodEnd", "amountDueCents", "amountCapturableCents", "invoiceRequestId", "observedAt"])(
                          "step 8: contradictory renewal recovery proof %s is rejected", async field => {
                            const x = await renewalRecoveryFixture(), proof = { ...x.recoveryProof } as Record<string, unknown>;
                            proof[field] = typeof proof[field] === "number" ? Number(proof[field]) + (field === "observedAt" ? 600 : 1) : "other";
                            await expect(x.observe("payment_method_required", proof)).rejects.toThrow("provider proof");
                          });
                        test("step 7: claimed success cannot invent a ledger receipt", async () => {
                          const x = await renewalRecoveryFixture();
                          await expect(x.observe("paid_accounted", { ...x.recoveryProof, invoiceStatus: "paid", paymentStatus: "succeeded",
                            amountPaidCents: x.a.monthly_price_cents, amountReceivedCents: x.a.monthly_price_cents })).rejects.toThrow("ledger receipt");
                        });
                        test("step 8: captured money awaiting its receipt blocks an unpaid observation", async () => {
                          const x = await renewalRecoveryFixture(), l = await ledger(x.m, 2);
                          await db.query("update public.payment_fee_ledger set stripe_invoice_id=$2,stripe_payment_intent_id=$3 where id=$1", [l.id, x.invoiceId, x.pi]);
                          await expect(x.observe()).rejects.toThrow("unpaid recovery state changed");
                        });
                        test("steps 2/8: stops remain set; only a review observation is allowed", async () => {
                          const x = await renewalRecoveryFixture();
                          await db.query("update public.monthly_mentorship_agreements_v1 set debit_revoked_at=now() where id=$1", [x.a.id]);
                          await expect(x.observe()).rejects.toThrow("requires review"); expect((await x.observe("review_required")).outcome).toBe("review_required");
                          expect((await db.query<{ stopped: boolean }>("select debit_revoked_at is not null stopped from public.monthly_mentorship_agreements_v1 where id=$1", [x.a.id])).rows[0].stopped).toBe(true);
                        });
                        test("steps 5/8: ownership, context and a changed revision cannot be adopted", async () => {
                          const x = await renewalRecoveryFixture();
                          await expect(x.observe("payment_method_required", x.recoveryProof, creator)).rejects.toThrow("owner");
                          await expect(x.observe("payment_method_required", x.recoveryProof, buyer, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("owner");
                          await expect(x.observe("payment_method_required", x.recoveryProof, buyer, context, x.a.revision + 1)).rejects.toThrow("state changed");
                        });
                        test("step 8: existing once-only receipt can settle recovery across a revision change", async () => {
                          const x = await renewalRecoveryFixture(); await x.observe();
                          const l = await ledger(x.m, 2);
                          await db.query("update public.payment_fee_ledger set stripe_invoice_id=$2,stripe_payment_intent_id=$3 where id=$1", [l.id, x.invoiceId, x.pi]);
                          const proof = { ...l.proof, invoiceId: x.invoiceId, paymentIntentId: x.pi, paymentMethodId: "pm_fixture",
                            paidAt: Math.floor(Date.now() / 1000), collectionRequestId: "req_collected",
                            providerPeriodStart: membershipMonthBoundary(x.anchor, 1),
                            providerPeriodEnd: membershipMonthBoundary(membershipMonthBoundary(x.anchor, 1), 1) };
                          await record(x.m, l, 2, x.anchor, proof); const money = await balance();
                          const paid = { ...x.recoveryProof, invoiceStatus: "paid", paymentStatus: "succeeded",
                            amountPaidCents: x.a.monthly_price_cents, amountReceivedCents: x.a.monthly_price_cents };
                          expect((await x.observe("paid_accounted", paid)).outcome).toBe("paid_accounted");
                          expect((await x.observe("paid_accounted", paid)).outcome).toBe("paid_accounted"); expect(await balance()).toBe(money);
                          await expect(x.observe()).rejects.toThrow("unpaid recovery state changed");
                        });
                        test("step 10: only the private observation RPC is writable by the service role", async () => {
                          const rows = (await db.query<{ role: string; execute: boolean; mutate: boolean }>(
                            "select r role,has_function_privilege(r,'public.record_monthly_mentorship_renewal_recovery_v1(uuid,uuid,uuid,jsonb,bigint,text,jsonb)','EXECUTE') execute,has_table_privilege(r,'public.monthly_mentorship_renewal_recoveries_v1','UPDATE') mutate from unnest(array['anon','authenticated','service_role']) r")).rows;
                          expect(rows).toEqual([{ role: "anon", execute: false, mutate: false }, { role: "authenticated", execute: false, mutate: false }, { role: "service_role", execute: true, mutate: false }]);
                        });
                        describe("SQL 092 buyer-consented monthly card setup", () => {
                          beforeAll(async () => { await db.exec(sql("supabase/proposals/092-monthly-mentorship-card-setup.sql")); });
                          async function monthlySetupFixture() {
                            const x = await renewalRecoveryFixture(); await x.observe(); const id = randomUUID();
                            const { MONTHLY_CARD_SETUP_CONSENT_VERSION: version, MONTHLY_CARD_SETUP_CONSENT_TEXT: text } = await import("@/lib/membershipCardSetupConsent");
                            const call = async (action: string, proof: unknown = null, actor = buyer, ctx = context, accepted = action === "reserve", consent: string | null = action === "reserve" ? version : null, request = id) =>
                              JSON.parse(JSON.stringify((await db.query<{ value: Record<string, unknown> }>(
                                "select public.monthly_card_setup_v1($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb) value",
                                [action, request, action === "reserve" ? x.collection.id : null, actor, JSON.stringify(ctx), consent, accepted, proof == null ? null : JSON.stringify(proof)])).rows[0].value));
                            const reserved = await call("reserve");
                            const claim = async () => {
                              const r = await call("claim");
                              return { version: "monthly-card-setup-proof-v1", paymentContext: context, session: {
                                id: "cs_test_" + id.replaceAll("-", ""), customerId: x.a.stripe_customer_id, mode: "setup", uiMode: "hosted",
                                paymentStatus: "no_payment_required", status: "open", clientReferenceId: id, metadata: reserved.request.metadata,
                                expiresAt: reserved.expires_at, createdAt: Math.max(reserved.created_at, Math.floor(Date.parse(r.dispatch_started_at) / 1000)),
                                amountCents: 0, paymentIntentId: null, subscriptionId: null, invoiceId: null, requestId: "req_session" } };
                            };
                            const savedProof = async () => {
                              const p = await claim(); await call("bind", p);
                              return { ...p, session: { ...p.session, status: "complete", setupIntentId: "seti_" + id.replaceAll("-", "") }, setupIntentId: "seti_" + id.replaceAll("-", ""),
                                paymentMethodId: "pm_" + id.replaceAll("-", ""), setupStatus: "succeeded", usage: "off_session",
                                setupCustomerId: x.a.stripe_customer_id, cardCustomerId: x.a.stripe_customer_id, cardType: "card",
                                setupMetadata: reserved.request.metadata, setupRequestId: "req_setup", cardRequestId: "req_card" };
                            };
                            return { ...x, id, reserved, call, claim, savedProof, version, text };
                          }
                          test("steps 4/5: exact consent and setup-only parameters are durable and replay the original request", async () => {
                            const x = await monthlySetupFixture(), { monthlyCardSetupParams } = await import("@/lib/membershipCardSetup");
                            expect(x.reserved.consent_version).toBe(x.version); expect(x.reserved.consent_text).toBe(x.text);
                            expect(x.reserved.request).toEqual(monthlyCardSetupParams(x.reserved));
                            const replay = await x.call("reserve", null, buyer, context, true, x.version, randomUUID());
                            expect(replay.id).toBe(x.id); expect(replay.request).toEqual(x.reserved.request); expect(replay.created_at).toBe(x.reserved.created_at);
                          });
                          test("step 4: missing, false and stale setup consent cannot reuse an accepted setup", async () => {
                            const x = await monthlySetupFixture();
                            await expect(x.call("reserve", null, buyer, context, false)).rejects.toThrow("consent");
                            await expect(x.call("reserve", null, buyer, context, true, "old")).rejects.toThrow("consent");
                            await expect(x.call("reserve", null, buyer, context, true, null)).rejects.toThrow("consent");
                          });
                          test("step 5: session binding and verified card do not change money, service or original defaults", async () => {
                            const x = await monthlySetupFixture(), before = await balance(), proof = await x.savedProof();
                            const done = await x.call("verify", proof), replay = await x.call("verify", proof);
                            expect(done.payment_method_id).toBe(proof.paymentMethodId); expect(done.setup_intent_id).toBe(proof.setupIntentId);
                            expect(replay.verified_at).toBe(done.verified_at); expect(await balance()).toBe(before);
                            const a = (await db.query<{ value: unknown }>("select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [x.a.id])).rows[0].value;
                            expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(x.a)));
                            expect((await db.query<{ card: string }>("select request->'params'->>'payment_method' card from public.monthly_mentorship_operations_v1 where id=$1", [x.collection.id])).rows[0].card).toBe("pm_fixture");
                          });
                          test.each(["mode", "status", "metadata", "customerId", "paymentIntentId", "expiresAt", "requestId"])(
                            "step 8: contradictory setup session proof %s cannot bind", async field => {
                              const x = await monthlySetupFixture(), proof = await x.claim();
                              (proof.session as Record<string, unknown>)[field] = field === "status" ? null : field === "expiresAt" ? proof.session.expiresAt + 1 : "other";
                              await expect(x.call("bind", proof)).rejects.toThrow("session proof");
                            });
                          test.each(["usage", "cardCustomerId", "setupCustomerId", "setupMetadata", "cardType", "setupRequestId"])(
                            "step 8: contradictory saved-card proof %s cannot verify", async field => {
                              const x = await monthlySetupFixture(), proof = await x.savedProof();
                              (proof as Record<string, unknown>)[field] = "other"; await expect(x.call("verify", proof)).rejects.toThrow("saved-card proof");
                            });
                          test("steps 2/8: pending money and stops cannot become setup authority", async () => {
                            const x = await monthlySetupFixture();
                            await x.observe("payment_pending", { ...x.recoveryProof, paymentStatus: "processing" });
                            await expect(x.call("claim")).rejects.toThrow("eligible unpaid attempt");
                            await x.observe();
                            await db.query("update public.monthly_mentorship_agreements_v1 set debit_revoked_at=now() where id=$1", [x.a.id]);
                            await expect(x.call("claim")).rejects.toThrow("eligible unpaid attempt");
                          });
                          test("step 8: unrelated billing review is not cleared or adopted for card setup", async () => {
                            const x = await monthlySetupFixture();
                            await db.query("update public.monthly_mentorship_agreements_v1 set billing_review_at=now(),billing_review_reason='evt_unrelated' where id=$1", [x.a.id]);
                            await expect(x.call("claim")).rejects.toThrow("Unrelated monthly billing review");
                          });
                          test("step 8: a saved card cannot be silently replaced in the original setup", async () => {
                            const x = await monthlySetupFixture(), proof = await x.savedProof(); await x.call("verify", proof);
                            await expect(x.call("verify", { ...proof, paymentMethodId: "pm_other" })).rejects.toThrow("cannot be replaced");
                          });
                          test("step 8: a different valid SetupIntent cannot replace the one bound to completed Checkout", async () => {
                            const x = await monthlySetupFixture(), proof = await x.savedProof();
                            await expect(x.call("verify", { ...proof, setupIntentId: "seti_other" })).rejects.toThrow("saved-card proof");
                          });
                          test("step 8: the test Checkout prefix is literal, not a wildcard pattern", async () => {
                            const x = await monthlySetupFixture(), proof = await x.claim();
                            proof.session.id = "cs_testXforeign";
                            await expect(x.call("bind", proof)).rejects.toThrow("session proof");
                          });
                          test("step 8: an expired setup requires new consent and preserves its closed history", async () => {
                            const x = await monthlySetupFixture();
                            // Synthetic elapsed setup lifetime; no provider clock or hosted action.
                            await db.query("update public.monthly_mentorship_card_setups_v1 set created_at=created_at-7200,expires_at=expires_at-7200,request=jsonb_set(request,'{expires_at}',to_jsonb(expires_at-7200)) where id=$1", [x.id]);
                            await expect(x.call("read")).rejects.toThrow("expired");
                            const old = (await db.query<{ request: unknown }>("select request from public.monthly_mentorship_card_setups_v1 where id=$1", [x.id])).rows[0].request;
                            const next = await x.call("reserve", null, buyer, context, true, x.version, randomUUID());
                            expect(next.id).not.toBe(x.id);
                            const history = (await db.query<{ closed: boolean; request: unknown }>("select closed_at is not null closed,request from public.monthly_mentorship_card_setups_v1 where id=$1", [x.id])).rows[0];
                            expect(history.closed).toBe(true); expect(history.request).toEqual(old);
                            await expect(x.call("read")).rejects.toThrow("expired");
                          });
                          test("step 5: setup read and continuation remain buyer/context owned", async () => {
                            const x = await monthlySetupFixture();
                            await expect(x.call("read", null, creator)).rejects.toThrow("owner");
                            await expect(x.call("read", null, buyer, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("owner");
                          });
                          test("step 10: public clients cannot reserve, bind or rewrite setup history", async () => {
                            const rows = (await db.query<{ role: string; execute: boolean; mutate: boolean }>(
                              "select r role,has_function_privilege(r,'public.monthly_card_setup_v1(text,uuid,uuid,uuid,jsonb,text,boolean,jsonb)','EXECUTE') execute,has_table_privilege(r,'public.monthly_mentorship_card_setups_v1','UPDATE') mutate from unnest(array['anon','authenticated','service_role']) r")).rows;
                            expect(rows).toEqual([{ role: "anon", execute: false, mutate: false }, { role: "authenticated", execute: false, mutate: false }, { role: "service_role", execute: true, mutate: false }]);
                          });

                          describe("SQL 093 immutable original-invoice buyer retry", () => {
                            beforeAll(async () => { await db.exec(sql("supabase/proposals/093-monthly-mentorship-buyer-retry.sql")); });
                            async function monthlyRetryFixture(verified = true) {
                              const x = await monthlySetupFixture(), saved = verified ? await x.savedProof() : null;
                              if (saved) await x.call("verify", saved);
                              const id = randomUUID();
                              const consent = await import("@/lib/membershipRetryConsent");
                              const retry = async (action: string, options: { accepted?: boolean; consent?: string | null; future?: boolean;
                                futureConsent?: string | null; actor?: string; context?: unknown; id?: string } = {}) => {
                                const future = options.future ?? false;
                                return JSON.parse(JSON.stringify((await db.query<{ value: Record<string, unknown> }>(
                                  "select public.monthly_retry_v1($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) value",
                                  [action, options.id ?? id, action === "review" ? x.id : null, options.actor ?? buyer,
                                    JSON.stringify(options.context ?? context), options.accepted ?? action === "confirm",
                                    options.consent === undefined ? action === "confirm" ? consent.MONTHLY_RETRY_CONSENT_VERSION : null : options.consent,
                                    future, options.futureConsent === undefined ? future && action === "confirm" ? consent.MONTHLY_FUTURE_CARD_CONSENT_VERSION : null : options.futureConsent]
                                )).rows[0].value));
                              };
                              const quote = await retry("review");
                              const capture = async (fields: Record<string, unknown> = {}) => {
                                const l = await ledger(x.m, 2);
                                await db.query("update public.payment_fee_ledger set stripe_invoice_id=$2,stripe_payment_intent_id=$3 where id=$1", [l.id, x.invoiceId, x.pi]);
                                const proof = { ...l.proof, invoiceId: x.invoiceId, paymentIntentId: x.pi, paymentMethodId: saved!.paymentMethodId,
                                  paidAt: Math.floor(Date.now() / 1000), collectionRequestId: "req_retry",
                                  providerPeriodStart: membershipMonthBoundary(x.anchor, 1),
                                  providerPeriodEnd: membershipMonthBoundary(membershipMonthBoundary(x.anchor, 1), 1),
                                  retryQuoteId: id, nextPaymentMethodId: "pm_fixture", ...fields };
                                return { l, proof, record: () => record(x.m, l, 2, x.anchor, proof) };
                              };
                              return { ...x, retryId: id, quote, retry, capture, saved, consent };
                            }
                            test("steps 1/4/5: exact original price, dates and two consent texts are quoted without changing money or service", async () => {
                              const x = await monthlyRetryFixture(), before = await balance(), replay = await x.retry("review", { id: randomUUID() });
                              expect(replay.id).toBe(x.retryId); expect(replay.quote).toEqual(x.quote.quote);
                              expect(x.quote.quote).toMatchObject({ amountCents: x.a.monthly_price_cents, month: 2,
                                periodStart: x.recoveryProof.periodStart, periodEnd: x.recoveryProof.periodEnd,
                                consentText: x.consent.MONTHLY_RETRY_CONSENT_TEXT, futureConsentText: x.consent.MONTHLY_FUTURE_CARD_CONSENT_TEXT });
                              expect(x.quote.confirmed_at).toBeNull(); expect(x.quote.request).toEqual({
                                payment_method: x.saved!.paymentMethodId, off_session: false, forgive: false, paid_out_of_band: false });
                              expect(await balance()).toBe(before);
                            });
                            test("step 4: an unverified setup cannot create payment retry authority", async () => {
                              await expect(monthlyRetryFixture(false)).rejects.toThrow("verified setup");
                            });
                            test.each([
                              { accepted: false }, { consent: null }, { consent: "old" },
                              { future: true, futureConsent: null }, { future: true, futureConsent: "old" },
                              { future: false, futureConsent: "monthly-future-card-consent-v1" },
                            ])("step 4: missing or contradictory consent %p is rejected", async options => {
                              const x = await monthlyRetryFixture(); await expect(x.retry("confirm", options)).rejects.toThrow("choices");
                              expect((await x.retry("read")).confirmed_at).toBeNull();
                            });
                            test("steps 4/8: confirmation preserves its original choice and exactly one dispatch is admitted", async () => {
                              const x = await monthlyRetryFixture(), before = await balance();
                              const old = (await db.query<{ value: unknown }>("select to_jsonb(o) value from public.monthly_mentorship_operations_v1 o where id=$1", [x.collection.id])).rows[0].value;
                              const accepted = await x.retry("confirm", { future: true }), replay = await x.retry("confirm", { future: true });
                              expect(replay.confirmed_at).toBe(accepted.confirmed_at);
                              await expect(x.retry("confirm")).rejects.toThrow("cannot change");
                              const first = await x.retry("consume"), second = await x.retry("consume");
                              expect(first.dispatch).toBe(true); expect(second.dispatch).toBe(false);
                              expect(second.retry.dispatch_consumed_at).toBe(first.retry.dispatch_consumed_at);
                              expect((await db.query<{ value: unknown }>("select to_jsonb(o) value from public.monthly_mentorship_operations_v1 o where id=$1", [x.collection.id])).rows[0].value).toEqual(old);
                              expect(await balance()).toBe(before);
                              await expect(x.retry("consume", { accepted: true })).rejects.toThrow("manufacture consent");
                              await expect(x.retry("review", { id: randomUUID() })).rejects.toThrow("eligible unpaid attempt");
                            });
                            test("step 8: confirmation alone cannot become capture or a second accepted quote", async () => {
                              const x = await monthlyRetryFixture(); await x.retry("confirm");
                              await expect(x.retry("review", { id: randomUUID() })).rejects.toThrow("already accepted");
                              const c = await x.capture(); await expect(c.record()).rejects.toThrow("exact retry admission");
                            });
                            test.each(["stop", "revision", "expired", "pending_money"])("steps 2/8: %s after confirmation prevents dispatch", async fault => {
                              const x = await monthlyRetryFixture(); await x.retry("confirm");
                              if (fault === "stop") await db.query("update public.monthly_mentorship_agreements_v1 set debit_revoked_at=now() where id=$1", [x.a.id]);
                              if (fault === "revision") await db.query("update public.monthly_mentorship_agreements_v1 set revision=revision+1 where id=$1", [x.a.id]);
                              if (fault === "expired") await db.query("update public.monthly_mentorship_retry_quotes_v1 set created_at=created_at-700,expires_at=expires_at-700 where id=$1", [x.retryId]);
                              if (fault === "pending_money") { const l = await ledger(x.m, 2); await db.query("update public.payment_fee_ledger set stripe_invoice_id=$2,stripe_payment_intent_id=$3 where id=$1", [l.id, x.invoiceId, x.pi]); }
                              await expect(x.retry("consume")).rejects.toThrow(); expect((await x.retry("read")).dispatch_consumed_at).toBeNull();
                            });
                            test.each([false, true])("steps 4/7/8: successful capture credits once and changes the next card only for accepted future choice %s", async future => {
                              const x = await monthlyRetryFixture(); await x.retry("confirm", { future }); await x.retry("consume");
                              const next = future ? x.saved!.paymentMethodId : "pm_fixture", c = await x.capture({ nextPaymentMethodId: next });
                              await c.record(); const amount = await balance(); await c.record(); expect(await balance()).toBe(amount);
                              expect((await db.query<{ card: string }>("select public.monthly_card_for_service_v1($1,3) card", [x.a.id])).rows[0].card).toBe(next);
                              expect((await db.query<{ value: string }>("select request->'params'->>'default_payment_method' value from public.monthly_mentorship_operations_v1 where agreement_id=$1 and kind='activate'", [x.a.id])).rows[0].value).toBe("pm_fixture");
                            });
                            test("step 8: original-card success racing the retry cannot switch the next monthly card", async () => {
                              const x = await monthlyRetryFixture(); await x.retry("confirm", { future: true }); await x.retry("consume");
                              const c = await x.capture({ paymentMethodId: "pm_fixture", retryQuoteId: null, nextPaymentMethodId: "pm_fixture" }); await c.record();
                              expect((await db.query<{ card: string }>("select public.monthly_card_for_service_v1($1,3) card", [x.a.id])).rows[0].card).toBe("pm_fixture");
                            });
                            test.each(["wrong_card", "early_capture", "future_without_consent", "wrong_retry"])("step 8: %s cannot manufacture a replacement receipt", async fault => {
                              const x = await monthlyRetryFixture(); await x.retry("confirm"); await x.retry("consume");
                              const fields = fault === "wrong_card" ? { paymentMethodId: "pm_other" } : fault === "early_capture" ? { paidAt: 1 } :
                                fault === "future_without_consent" ? { nextPaymentMethodId: x.saved!.paymentMethodId } : { retryQuoteId: randomUUID() };
                              const c = await x.capture(fields); await expect(c.record()).rejects.toThrow();
                            });
                            test("step 8: even original-card capture cannot substitute a new payment identity after recovery binding", async () => {
                              const x = await monthlyRetryFixture(); await x.retry("confirm"); await x.retry("consume");
                              const c = await x.capture({ paymentMethodId: "pm_fixture", retryQuoteId: null, paymentIntentId: "pi_other" });
                              await db.query("update public.payment_fee_ledger set stripe_payment_intent_id='pi_other' where id=$1", [c.l.id]);
                              await expect(c.record()).rejects.toThrow("original recovery payment");
                            });
                            test.each(["related", "unrelated", "financial_hold", "stopped"])("steps 2/7/8: paid recovery handles %s review without clearing unrelated stops", async kind => {
                              const x = await monthlyRetryFixture(); await x.retry("confirm"); await x.retry("consume");
                              const event = "evt_retry" + x.retryId.replaceAll("-", "");
                              await db.query("insert into public.monthly_mentorship_lifecycle_v1(event_id,agreement_id,event_type,object_id,first_observation,latest_observation,outcome) values($1,$2,'invoice.payment_failed',$3,'{}','{}','review_required')", [event, x.a.id, x.invoiceId]);
                              await db.query("update public.monthly_mentorship_agreements_v1 set billing_review_at=now(),billing_review_reason=$2,revision=revision+1 where id=$1", [x.a.id, event]);
                              if (kind === "unrelated") await db.query("insert into public.monthly_mentorship_lifecycle_v1(event_id,agreement_id,event_type,object_id,first_observation,latest_observation,outcome) values($1,$2,'invoice.payment_failed','in_other','{}','{}','review_required')", [event + "other", x.a.id]);
                              if (kind === "financial_hold") await db.query("update public.monthly_mentorship_agreements_v1 set financial_hold_at=now() where id=$1", [x.a.id]);
                              if (kind === "stopped") await db.query("update public.monthly_mentorship_agreements_v1 set debit_revoked_at=now(),renewal_stopped_at=now() where id=$1", [x.a.id]);
                              const c = await x.capture(); await c.record();
                              const a = (await db.query<{ review: boolean; stopped: boolean; debit: boolean; next: string }>("select billing_review_at is not null review,renewal_stopped_at is not null stopped,debit_revoked_at is not null debit,billing_next_attempt_at::text next from public.monthly_mentorship_agreements_v1 where id=$1", [x.a.id])).rows[0];
                              expect(a.review).toBe(kind === "unrelated" || kind === "financial_hold");
                              expect((await db.query<{ resolved: boolean }>("select payment_recovery_resolved_at is not null resolved from public.monthly_mentorship_lifecycle_v1 where event_id=$1", [event])).rows[0].resolved).toBe(!a.review);
                              if (kind === "stopped") { expect(a.stopped).toBe(true); expect(a.debit).toBe(true); expect(a.next).toBe("infinity"); }
                            });
                            test("step 5: retry reads, confirmation and consumption remain buyer/context owned", async () => {
                              const x = await monthlyRetryFixture();
                              await expect(x.retry("read", { actor: creator })).rejects.toThrow("owner");
                              await expect(x.retry("confirm", { context: { ...context, stripeAccountId: "acct_other" } })).rejects.toThrow("owner");
                              await expect(x.retry("consume", { actor: creator })).rejects.toThrow("owner");
                            });
                            test("step 10: only the private action RPC is executable by service, with no direct quote mutation", async () => {
                              const rows = (await db.query<{ role: string; execute: boolean; mutate: boolean; direct_card: boolean }>(
                                "select r role,has_function_privilege(r,'public.monthly_retry_v1(text,uuid,uuid,uuid,jsonb,boolean,text,boolean,text)','EXECUTE') execute,has_table_privilege(r,'public.monthly_mentorship_retry_quotes_v1','UPDATE') mutate,has_function_privilege(r,'public.monthly_card_for_service_v1(uuid,integer)','EXECUTE') direct_card from unnest(array['anon','authenticated','service_role']) r")).rows;
                              expect(rows).toEqual([{ role: "anon", execute: false, mutate: false, direct_card: false },
                                { role: "authenticated", execute: false, mutate: false, direct_card: false }, { role: "service_role", execute: true, mutate: false, direct_card: false }]);
                            });

                            describe("SQL 094 original monthly bank context", () => {
                              beforeAll(async () => { await db.exec(sql("supabase/proposals/094-monthly-mentorship-bank-verification.sql")); });
                              describe("SQL 099/100 refund coordination and late manual review", () => {
                                const administrator = "14000000-0000-4000-8000-000000000003";
                                beforeAll(async () => {
                                  await db.exec(sql("supabase/schema/021-admin-refund-operations.sql"));
                                  await db.exec(sql("supabase/proposals/099-monthly-admin-refund-coordination.sql"));
                                  await db.exec(sql("supabase/proposals/100-monthly-late-activation-review.sql"));
                                  await db.query("insert into auth.users(id) values($1)", [administrator]);
                                  await db.query("insert into public.profiles(id,username,role) values($1,'refund_admin','admin')", [administrator]);
                                });
                                async function refundFor(m: Membership) {
                                  const source = (await db.query<{ id: string; stripe_charge_id: string }>(
                                    "select l.id,l.stripe_charge_id from public.payment_fee_ledger l join public.monthly_mentorship_receipts_v1 r on r.ledger_id=l.id where r.agreement_id=$1 and r.month_number=1", [m.id])).rows[0];
                                  const id = randomUUID(), token = randomUUID();
                                  await db.query("select public.create_refund_operation($1,$2,1000,'creator_discretionary','creator',null,$3,$4,$5,'fee_fixture',0,0,null)",
                                    [id, source.id, 'monthly-refund:' + id, administrator, source.stripe_charge_id]);
                                  await db.query("select public.claim_refund_operation($1,$2,300)", [id, token]);
                                  const admit = async (t = token) => (await db.query<{ value: string }>(
                                    "select public.admit_monthly_mentorship_admin_refund_v1($1,$2) value", [id, t])).rows[0].value;
                                  return { id, token, admit };
                                }
                                const state = async (m: Membership) => (await db.query<{ value: Record<string, unknown> }>(
                                  "select to_jsonb(a) value from public.monthly_mentorship_agreements_v1 a where id=$1", [m.id])).rows[0].value;
                                const stable = async (m: Membership) => {
                                  const a = await state(m); return { terms: a.terms, anchor: a.anchor_at, covered: a.covered_months,
                                    minimum: a.minimum_months, stopped: a.renewal_stopped_at, revoked: a.debit_revoked_at, money: await balance(), access: await access(m) };
                                };
                                test("refund first blocks fresh collection under the existing agreement lock", async () => {
                                  const x = await activationRecoveryFixture(32); await x.recover();
                                  const refund = await refundFor(x.m), before = await stable(x.m);
                                  expect(await refund.admit()).toBe("held");
                                  const a = await state(x.m);
                                  await expect(db.query("select public.claim_monthly_mentorship_operation_v1($1,$2,'collect','2',$3,$4::jsonb,$5::jsonb)",
                                    [x.m.id, creator, a.revision, JSON.stringify(context), JSON.stringify({ method: "POST", path: "/v1/invoices/in_next/pay",
                                      params: { payment_method: "pm_fixture", off_session: true, forgive: false, paid_out_of_band: false } })])).rejects.toThrow("fresh eligible");
                                  expect(await stable(x.m)).toEqual(before);
                                  expect(await refund.admit()).toBe("held");
                                });
                                test("collection first blocks refund until the actual receipt is recorded, even after operation completion", async () => {
                                  const x = await renewalRecoveryFixture(), refund = await refundFor(x.m);
                                  await db.query("update public.monthly_mentorship_agreements_v1 set billing_review_at=now(),billing_review_reason='evt_existing_payment_review' where id=$1", [x.m.id]);
                                  expect(await refund.admit()).toBe("reconciliation_required");
                                  expect((await state(x.m)).billing_review_reason).toBe('admin_refund:' + refund.id + ';prior:evt_existing_payment_review');
                                  await db.query("select public.complete_monthly_mentorship_operation_v1($1,$2::jsonb,$3,'req_collection')", [x.collection.id, JSON.stringify(context), x.invoiceId]);
                                  expect(await refund.admit()).toBe("reconciliation_required");
                                  const l = await ledger(x.m, 2), period = membershipRenewalPeriod(x.a, 2);
                                  await db.query("update public.payment_fee_ledger set stripe_invoice_id=$2 where id=$1", [l.id, x.invoiceId]);
                                  await record(x.m, l, 2, x.anchor, { ...l.proof, invoiceId: x.invoiceId, paymentMethodId: "pm_fixture",
                                    collectionRequestId: "req_collection", providerPeriodStart: period.providerStart, providerPeriodEnd: period.providerEnd });
                                  expect(await refund.admit()).toBe("held");
                                  expect((await state(x.m)).billing_review_at).toBeTruthy();
                                  expect((await state(x.m)).billing_review_reason).toBe('admin_refund:' + refund.id + ';prior:evt_existing_payment_review');
                                });
                                test("expired collection admission is unresolved, not proof of failed payment", async () => {
                                  const x = await renewalRecoveryFixture(), refund = await refundFor(x.m);
                                  await db.query("update public.monthly_mentorship_operations_v1 set dispatched_at=now()-interval '3 days',status='review_required' where id=$1", [x.collection.id]);
                                  expect(await refund.admit()).toBe("reconciliation_required");
                                });
                                test("refund hold preserves currently paid access and rejects a foreign processing token", async () => {
                                  const x = await paidMembership(), refund = await refundFor(x.m), before = await stable(x.m);
                                  await expect(refund.admit(randomUUID())).rejects.toThrow("claim or administrator");
                                  expect((await state(x.m)).billing_review_at).toBeNull();
                                  expect(await refund.admit()).toBe("held"); expect(before.access.allowed).toBe(true);
                                  expect(await stable(x.m)).toEqual(before);
                                });
                                test("never-applied late activation becomes a replay-safe review hold without changing obligations", async () => {
                                  const x = await activationRecoveryFixture(40), before = await stable(x.m);
                                  const review = async (actor = buyer) => db.query("select public.review_monthly_mentorship_late_activation_v1($1,$2,$3::jsonb)", [x.m.id, actor, JSON.stringify(context)]);
                                  await expect(review(creator)).rejects.toThrow("identity or state");
                                  await review(); const first = await state(x.m); await review();
                                  expect((await state(x.m)).billing_review_at).toEqual(first.billing_review_at);
                                  expect((await state(x.m)).revision).toEqual(first.revision);
                                  expect(first.billing_review_reason).toBe("late_activation_unapplied");
                                  expect(await stable(x.m)).toEqual(before);
                                });
                                test("already-applied activation cannot be mislabeled as never-applied manual review", async () => {
                                  const x = await activationRecoveryFixture(40); await x.recover();
                                  await expect(db.query("select public.review_monthly_mentorship_late_activation_v1($1,$2,$3::jsonb)", [x.m.id, buyer, JSON.stringify(context)]))
                                    .rejects.toThrow("identity or state");
                                });
                                test("both coordination RPCs remain service-only", async () => {
                                  for (const signature of ["public.admit_monthly_mentorship_admin_refund_v1(uuid,uuid)", "public.review_monthly_mentorship_late_activation_v1(uuid,uuid,jsonb)"]) {
                                    const rows = (await db.query<{ role: string; allowed: boolean }>("select r role,has_function_privilege(r,$1,'EXECUTE') allowed from unnest(array['anon','authenticated','service_role']) r", [signature])).rows;
                                    expect(rows).toEqual([{ role: "anon", allowed: false }, { role: "authenticated", allowed: false }, { role: "service_role", allowed: true }]);
                                  }
                                });
                              });
                              async function bankFixture(replacement = false) {
                                const replacementData = replacement ? await monthlyRetryFixture() : null;
                                const x = replacementData ?? await renewalRecoveryFixture();
                                if (replacementData) { await replacementData.retry("confirm"); await replacementData.retry("consume"); }
                                await x.observe("action_required", { ...x.recoveryProof, paymentStatus: "requires_action" });
                                const bank = async (actor = buyer, ctx = context, invoice = x.invoiceId) =>
                                  JSON.parse(JSON.stringify((await db.query<{ value: Record<string, unknown> }>(
                                    "select public.read_monthly_mentorship_bank_context_v1($1,$2,$3,$4::jsonb) value",
                                    [x.a.id, actor, invoice, JSON.stringify(ctx)])).rows[0].value));
                                return { ...x, bank, bankPaymentMethodId: replacementData?.saved?.paymentMethodId ?? "pm_fixture",
                                  bankRetryQuoteId: replacementData?.retryId ?? null };
                              }
                              test.each([false, true])("steps 1/4/5/8: original bank context replacement=%s preserves payment identity and money", async replacement => {
                                const x = await bankFixture(replacement), before = await balance(), b = await x.bank();
                                expect(b).toMatchObject({ version: "monthly-bank-context-v1", membershipId: x.a.id, buyerId: buyer,
                                  operationId: x.collection.id, invoiceId: x.invoiceId, paymentIntentId: x.pi, originalPaymentMethodId: "pm_fixture",
                                  month: 2, amountCents: x.a.monthly_price_cents, periodStart: x.recoveryProof.periodStart, periodEnd: x.recoveryProof.periodEnd });
                                expect(b.paymentMethodId).toBe(x.bankPaymentMethodId);
                                expect(b.retryQuoteId).toBe(x.bankRetryQuoteId); expect(await balance()).toBe(before);
                                expect(await x.bank()).toEqual(b); expect(JSON.stringify(b)).not.toContain("secret");
                              });
                              test("step 4: a saved card or unconsumed retry cannot replace original bank authority", async () => {
                                const x = await monthlyRetryFixture(); await x.retry("confirm", { future: true });
                                await x.observe("action_required", { ...x.recoveryProof, paymentStatus: "requires_action" });
                                const b = (await db.query<{ value: { paymentMethodId: string; retryQuoteId: string | null } }>(
                                  "select public.read_monthly_mentorship_bank_context_v1($1,$2,$3,$4::jsonb) value", [x.a.id, buyer, x.invoiceId, JSON.stringify(context)])).rows[0].value;
                                expect(b.paymentMethodId).toBe("pm_fixture"); expect(b.retryQuoteId).toBeNull();
                              });
                              test.each(["debit_revoked_at", "renewal_stopped_at", "financial_hold_at", "payoff_hold_at"])(
                                "step 2: %s blocks bank capability release", async column => {
                                  const x = await bankFixture();
                                  await db.query("update public.monthly_mentorship_agreements_v1 set " + column + "=now() where id=$1", [x.a.id]);
                                  await expect(x.bank()).rejects.toThrow("fresh eligible");
                                });
                              test.each(["stale", "future", "payment_identity", "status", "amount"])("step 8: %s observation cannot release bank capability", async fault => {
                                const x = await bankFixture();
                                const key = fault === "stale" || fault === "future" ? "observedAt" : fault === "payment_identity" ? "paymentIntentId" :
                                  fault === "status" ? "paymentStatus" : "amountReceivedCents";
                                const value = fault === "stale" ? Math.floor(Date.now() / 1000) - 61 : fault === "future" ? Math.floor(Date.now() / 1000) + 61 :
                                  fault === "payment_identity" ? "pi_other" : fault === "status" ? "processing" : 1;
                                await db.query("update public.monthly_mentorship_renewal_recoveries_v1 set latest_observation=jsonb_set(latest_observation,array[$2],$3::jsonb) where operation_id=$1",
                                  [x.collection.id, key, JSON.stringify(value)]);
                                await expect(x.bank()).rejects.toThrow("fresh eligible");
                              });
                              test("step 8: already-captured money blocks authentication even before its monthly receipt", async () => {
                                const x = await bankFixture(), l = await ledger(x.m, 2);
                                await db.query("update public.payment_fee_ledger set stripe_invoice_id=$2,stripe_payment_intent_id=$3 where id=$1", [l.id, x.invoiceId, x.pi]);
                                await expect(x.bank()).rejects.toThrow("fresh eligible");
                              });
                              test.each(["refund", "dispute"])("step 7: prior %s prevents another bank capability", async fault => {
                                const x = await bankFixture();
                                if (fault === "refund") await db.query("update public.payment_fee_ledger set status='refunded',refunded_amount_cents=gross_amount_cents,earnings_reversed_cents=creator_net_cents,platform_fee_refund_attribution_cents=platform_fee_cents,processing_fee_refund_attribution_cents=processing_fee_cents,refund_allocation_rounding_cents=0 where id=(select ledger_id from public.monthly_mentorship_receipts_v1 where agreement_id=$1 and month_number=1)", [x.a.id]);
                                else await db.query("update public.payment_fee_ledger set dispute_status='needs_response' where id=(select ledger_id from public.monthly_mentorship_receipts_v1 where agreement_id=$1 and month_number=1)", [x.a.id]);
                                await expect(x.bank()).rejects.toThrow("fresh eligible");
                              });
                              test.each(["related", "unrelated"])("step 8: %s billing review is handled without clearing any review", async kind => {
                                const x = await bankFixture(), event = "evt_bank" + randomUUID().replaceAll("-", "");
                                await db.query("insert into public.monthly_mentorship_lifecycle_v1(event_id,agreement_id,event_type,object_id,first_observation,latest_observation,outcome) values($1,$2,'invoice.payment_action_required',$3,'{}','{}','review_required')",
                                  [event, x.a.id, kind === "related" ? x.invoiceId : "in_other"]);
                                await db.query("update public.monthly_mentorship_agreements_v1 set billing_review_at=now(),billing_review_reason=$2,revision=revision+1 where id=$1", [x.a.id, event]);
                                if (kind === "related") expect((await x.bank()).invoiceId).toBe(x.invoiceId);
                                else await expect(x.bank()).rejects.toThrow("Unrelated monthly billing review");
                                expect((await db.query<{ review: boolean }>("select billing_review_at is not null review from public.monthly_mentorship_agreements_v1 where id=$1", [x.a.id])).rows[0].review).toBe(true);
                              });
                              test("step 8: old original operation age is preserved, not reused for another pay call", async () => {
                                const x = await bankFixture();
                                await db.query("update public.monthly_mentorship_operations_v1 set dispatched_at=now()-interval '21 hours' where id=$1", [x.collection.id]);
                                const before = (await db.query<{ value: unknown }>("select to_jsonb(o) value from public.monthly_mentorship_operations_v1 o where id=$1", [x.collection.id])).rows[0].value;
                                const b = await x.bank(); expect(b.admittedAt).toBeLessThan(Math.floor(Date.now() / 1000) - 20 * 3600);
                                expect((await db.query<{ value: unknown }>("select to_jsonb(o) value from public.monthly_mentorship_operations_v1 o where id=$1", [x.collection.id])).rows[0].value).toEqual(before);
                              });
                              test("step 5: invoice, owner and payment context must all match", async () => {
                                const x = await bankFixture();
                                await expect(x.bank(creator)).rejects.toThrow("owner");
                                await expect(x.bank(buyer, { ...context, stripeAccountId: "acct_other" })).rejects.toThrow("owner");
                                await expect(x.bank(buyer, context, "in_other")).rejects.toThrow("fresh eligible");
                              });
                              test("step 10: bank context remains private to the service RPC", async () => {
                                const rows = (await db.query<{ role: string; execute: boolean }>(
                                  "select r role,has_function_privilege(r,'public.read_monthly_mentorship_bank_context_v1(uuid,uuid,text,jsonb)','EXECUTE') execute from unnest(array['anon','authenticated','service_role']) r")).rows;
                                expect(rows).toEqual([{ role: "anon", execute: false }, { role: "authenticated", execute: false }, { role: "service_role", execute: true }]);
                              });
                            });
                          });
                        });
                      });
                    });
                    test("step 10: only service RPCs can mutate initial close-out state", async () => {
                      for (const signature of ["request_monthly_initial_abandonment_v1(uuid,uuid,jsonb,boolean)", "claim_monthly_initial_closure_v1(uuid,uuid,jsonb,text,jsonb)",
                        "complete_monthly_initial_closure_v1(uuid,uuid,jsonb,jsonb)", "complete_monthly_initial_abandonment_v1(uuid,uuid,jsonb,jsonb)"]) {
                        const rows = (await db.query<{ role: string; execute: boolean; mutate: boolean }>(
                          "select r role,has_function_privilege(r,$1,'EXECUTE') execute,has_table_privilege(r,'public.monthly_mentorship_initial_closures_v1','UPDATE') mutate from unnest(array['anon','authenticated','service_role']) r",
                          ["public." + signature])).rows;
                        expect(rows).toEqual([{ role: "anon", execute: false, mutate: false }, { role: "authenticated", execute: false, mutate: false }, { role: "service_role", execute: true, mutate: false }]);
                      }
                    });
                  });
                  test("steps 5/10: only service code can reconcile or publish positive original-result evidence", async () => {
                    for (const signature of ["reconcile_monthly_mentorship_bootstrap_v1(uuid,uuid,jsonb,jsonb,jsonb)", "publish_monthly_mentorship_recovery_v1(uuid,uuid,jsonb)"]) {
                      const rows = (await db.query<{ role: string; execute: boolean; mutate: boolean }>(
                        "select r role,has_function_privilege(r,$1,'EXECUTE') execute,has_table_privilege(r,'public.monthly_mentorship_operations_v1','UPDATE') mutate from unnest(array['anon','authenticated','service_role']) r",
                        ["public." + signature])).rows;
                      expect(rows).toEqual([{ role: "anon", execute: false, mutate: false }, { role: "authenticated", execute: false, mutate: false }, { role: "service_role", execute: true, mutate: false }]);
                    }
                  });
                });
                test("steps 5/10: new management and recovery RPCs remain service-only with no direct table writes", async () => {
                  for (const signature of ["lease_monthly_mentorship_exit_work_v1(jsonb,integer)", "finish_monthly_mentorship_exit_work_v1(uuid,uuid,jsonb,text)",
                    "read_monthly_mentorship_exit_status_v1(uuid,uuid,jsonb)", "read_monthly_mentorship_management_v1(uuid,text,jsonb,timestamptz,uuid,integer)"]) {
                    const rows = await db.query<{ role: string; can_execute: boolean; can_write: boolean }>(
                      "select r role,has_function_privilege(r,$1,'EXECUTE') can_execute,has_table_privilege(r,'public.monthly_mentorship_exit_requests_v1','UPDATE') can_write from unnest(array['anon','authenticated','service_role']) r",
                      ["public." + signature]);
                    expect(rows.rows).toEqual([{ role: "anon", can_execute: false, can_write: false }, { role: "authenticated", can_execute: false, can_write: false },
                      { role: "service_role", can_execute: true, can_write: false }]);
                  }
                });
              });
              test("step 5: payment-event mutation is unavailable to browser roles or direct table writes", async () => {
                const rows = await db.query<{ role: string; can_write: boolean; can_execute: boolean }>(`select r role,
                  has_table_privilege(r,'public.monthly_mentorship_lifecycle_v1','UPDATE') can_write,
                  has_function_privilege(r,'public.record_monthly_mentorship_payment_event_v1(uuid,uuid,jsonb,text,text,text,jsonb)','EXECUTE') can_execute
                  from unnest(array['anon','authenticated','service_role']) r`);
                expect(rows.rows).toEqual([{ role: "anon", can_write: false, can_execute: false }, { role: "authenticated", can_write: false, can_execute: false },
                  { role: "service_role", can_write: false, can_execute: true }]);
              });
            });
            test("step 5: lifecycle and containment writes remain private to the service adapter", async () => {
              const rows = await db.query<{ role: string; can_write: boolean; can_execute: boolean }>(`select r role,
                has_table_privilege(r,'public.monthly_mentorship_lifecycle_v1','UPDATE') can_write,
                has_function_privilege(r,'public.record_monthly_mentorship_lifecycle_v1(uuid,uuid,jsonb,text,text,text,jsonb)','EXECUTE') can_execute
                from unnest(array['anon','authenticated','service_role']) r`);
              expect(rows.rows).toEqual([{ role: "anon", can_write: false, can_execute: false }, { role: "authenticated", can_write: false, can_execute: false },
                { role: "service_role", can_write: false, can_execute: true }]);
            });
          });
          test("step 5: payoff state and mutation RPCs remain private to the service role", async () => {
            const rows = await db.query<{ role: string; can_write: boolean; can_execute: boolean }>(`select r role,
              has_table_privilege(r,'public.monthly_mentorship_payoffs_v1','UPDATE') can_write,
              has_function_privilege(r,'public.reserve_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,jsonb,text,boolean)','EXECUTE') can_execute
              from unnest(array['anon','authenticated','service_role']) r`);
            expect(rows.rows).toEqual([{ role: "anon", can_write: false, can_execute: false }, { role: "authenticated", can_write: false, can_execute: false },
              { role: "service_role", can_write: false, can_execute: true }]);
          });
        });
      });
    });
  });
});
