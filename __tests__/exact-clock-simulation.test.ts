/** @jest-environment ./test-support/pglite-environment.cjs */
// NEW two-clock local-model integration. No Stripe SDK, network, real account,
// existing agreement, database migration, global clock override or payment.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { installmentMonthBoundary } from "../lib/installments/checkoutPreparation";
import type { ExactPaymentContext } from "../lib/installments/paymentContext";
import { createExactClockEvidenceReader, type ExactClockObservation } from "../test-support/exact-clock-simulation/clockEvidence";
import { createExactClockSimulation, type SimulatedAdmission } from "../test-support/exact-clock-simulation/simulation";

declare const createLocalPostgres: () => PGlite;
jest.mock("@electric-sql/pglite", () => ({ PGlite: jest.fn(function(options: unknown) {
  if (!options || typeof options !== "object" || Reflect.ownKeys(options).length !== 0) throw Error("memory only");
  return createLocalPostgres();
}) }));
jest.setTimeout(60000);

const anchor = Date.UTC(2100, 0, 31, 12, 0, 0) / 1000;
const firstFees = { enabled: true, basisPoints: 290, fixedCents: 30, version: "CNQA-local-first" };
const renewalFees = { enabled: true, basisPoints: 360, fixedCents: 30, version: "CNQA-local-renewal" };
const kind = "simulation-only-new-temporal-model";
type Simulation = Awaited<ReturnType<typeof createExactClockSimulation>>;
const open: Simulation[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(s => s.close())); });

function source(overrides: { simulationId?: string; customerId?: string; projectRef?: string; wallNow?: () => number } = {}) {
  const context: ExactPaymentContext = { version: "exact-payment-context-v1", mode: "test",
    platformAccountId: "acct_CNQALOCALPlatform", supabaseProjectRef: overrides.projectRef ?? "aaaaaaaaaaaaaaaaaaaa",
    siteOrigin: "https://cnqa-local-clock.vercel.app" };
  const binding = { version: "exact-clock-binding-v1", simulationId: overrides.simulationId ?? randomUUID(),
    clockId: "clock_CNQALOCAL1", customerId: overrides.customerId ?? "cus_CNQALOCAL1", subscriptionId: "sub_CNQALOCAL1" };
  const clock = { id: binding.clockId, livemode: false, status: "ready", frozen_time: anchor };
  const customer = { id: binding.customerId, livemode: false, test_clock: binding.clockId };
  const subscription = { id: binding.subscriptionId, livemode: false, customer: binding.customerId, test_clock: binding.clockId };
  const reader = createExactClockEvidenceReader({ context,
    contextEvidence: { approvedContext: context, vercelEnvironment: "preview", stripeSecretKeyMode: "test",
      stripePublishableKeyMode: "test", observedPlatformAccountId: context.platformAccountId,
      observedSupabaseProjectRef: context.supabaseProjectRef, configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
      configuredSiteOrigin: context.siteOrigin }, binding,
    provider: { observePlatformAccount: async () => ({ id: context.platformAccountId }),
      retrieveClock: async () => clock, retrieveCustomer: async () => customer, retrieveSubscription: async () => subscription },
    wallNowMilliseconds: overrides.wallNow,
  });
  return { binding, clock, reader, async observe(seconds = clock.frozen_time) {
    clock.frozen_time = seconds; return reader.observe();
  } };
}
async function fixture() {
  const f = source();
  const s = await createExactClockSimulation({ firstObservation: await f.observe(), totalCents: 199900,
    paymentCount: 3, firstFeeSchedule: firstFees, renewalFeeSchedule: renewalFees });
  open.push(s);
  return { ...f, s };
}
const revision = async (s: Simulation) => (await s.snapshot()).revision;
function receipt(s: Simulation, a: SimulatedAdmission, suffix = String(a.installmentNumber)) {
  const p = s.plan.payments[a.installmentNumber - 1];
  return { invoiceId: `in_CNQALOCAL${suffix}`, paymentIntentId: `pi_CNQALOCAL${suffix}`, chargeId: `ch_CNQALOCAL${suffix}`,
    grossCents: p.amountCents, deductionCents: p.fees.totalCreatorDeductionCents,
    rawCaptureSeconds: Math.floor(Date.now() / 1000) };
}

test("future months use logical billing dates but original wall capture times; exactly three credits and no fourth", async () => {
  const unchangedDate = Date;
  const unchangedNow = Date.now;
  const f = await fixture();
  const raw: number[] = [];
  for (const n of [1, 2, 3]) {
    const o = await f.observe(installmentMonthBoundary(anchor, n - 1));
    const beforeWall = Date.now();
    const a = await f.s.admit(o, n, await revision(f.s));
    expect(a.dispatchWallTimeMilliseconds).toBeGreaterThanOrEqual(beforeWall);
    expect(a.dispatchWallTimeMilliseconds).toBeLessThanOrEqual(Date.now());
    expect(a.billingTimeSeconds).toBeGreaterThan(a.dispatchWallTimeMilliseconds / 1000);
    const r = receipt(f.s, a);
    raw.push(r.rawCaptureSeconds);
    if (n === 2) {
      await f.s.markOutcomeUnknown(a);
      await expect(f.s.admit(await f.observe(), n, await revision(f.s))).rejects.toThrow();
    }
    expect(await f.s.recordReceipt(a, r)).toEqual({ kind, credited: true, duplicate: false });
    expect(await f.s.recordReceipt(a, r)).toEqual({ kind, credited: false, duplicate: true });
  }
  const result = await f.s.snapshot();
  expect(result).toMatchObject({ kind, paidCount: 3, complete: true, grossCents: 199900, deductionCents: 30808 });
  expect(f.s.plan.payments.map(p => p.amountCents)).toEqual([66633, 66633, 66634]);
  expect(result.admissions.map(a => a.rawCaptureSeconds)).toEqual(raw);
  await expect(f.s.admit(await f.observe(result.fixedEndBillingSeconds), 4, result.revision)).rejects.toThrow();
  expect(await f.s.snapshot()).toEqual(result);
  expect(Date).toBe(unchangedDate);
  expect(Date.now).toBe(unchangedNow);
});

test("concurrent admission contenders and receipt replay serialize to one local credit", async () => {
  const f = await fixture();
  const observations = [await f.observe(), await f.observe()];
  const results = await Promise.allSettled(observations.map(o => f.s.admit(o, 1, 0)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const success = results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<SimulatedAdmission>;
  const a = success.value;
  const r = receipt(f.s, a);
  const credits = await Promise.all([f.s.recordReceipt(a, r), f.s.recordReceipt(a, r)]);
  expect(credits.filter(c => c.credited)).toHaveLength(1);
  expect((await f.s.snapshot()).paidCount).toBe(1);
});

test("clock period is start-inclusive/end-exclusive and an unpaid period cannot be skipped", async () => {
  const f = await fixture();
  const end = installmentMonthBoundary(anchor, 1);
  await expect(f.s.admit(await f.observe(end), 1, 0)).rejects.toThrow();
  await expect(f.s.admit(await f.observe(end), 2, 0)).rejects.toThrow();
  await expect(f.s.admit(await f.observe(anchor - 1), 1, 0)).rejects.toThrow();
  const a = await f.s.admit(await f.observe(anchor), 1, 0);
  await f.s.markOutcomeUnknown(a);
  await expect(f.s.admit(await f.observe(end), 2, await revision(f.s))).rejects.toThrow();
  expect((await f.s.snapshot()).admissions).toMatchObject([{ outcome: "unknown" }]);
});

test("holds and stop block later admissions without blocking original-admission reconciliation", async () => {
  const f = await fixture();
  await f.s.setHold(true);
  await expect(f.s.admit(await f.observe(), 1, await revision(f.s))).rejects.toThrow();
  await f.s.setHold(false);
  const a = await f.s.admit(await f.observe(), 1, await revision(f.s));
  await f.s.markOutcomeUnknown(a);
  await f.s.stop();
  await f.s.setHold(true);
  expect((await f.s.recordReceipt(a, receipt(f.s, a))).credited).toBe(true);
  await f.s.setHold(false);
  await expect(f.s.admit(await f.observe(installmentMonthBoundary(anchor, 1)), 2, await revision(f.s))).rejects.toThrow();
  expect(await f.s.snapshot()).toMatchObject({ stopped: true, paidCount: 1, complete: false });
});

test("copied, wrong binding/context, expired, future-wall observations and stale revisions cannot admit", async () => {
  const f = await fixture();
  const good = await f.observe();
  const others: ExactClockObservation[] = [
    { ...good },
    await source().observe(),
    await source({ simulationId: f.binding.simulationId, customerId: "cus_CNQALOCALOther" }).observe(),
    await source({ simulationId: f.binding.simulationId, projectRef: "bbbbbbbbbbbbbbbbbbbb" }).observe(),
    await source({ simulationId: f.binding.simulationId, wallNow: () => Date.now() - 31000 }).observe(),
    await source({ simulationId: f.binding.simulationId, wallNow: () => Date.now() + 31000 }).observe(),
  ];
  for (const o of others) await expect(f.s.admit(o, 1, 0)).rejects.toThrow();
  await expect(f.s.admit(good, 1, 99)).rejects.toThrow();
  expect(await f.s.snapshot()).toMatchObject({ paidCount: 0, revision: 0, admissions: [] });
  const a = await f.s.admit(good, 1, 0);
  await f.s.recordReceipt(a, receipt(f.s, a));
  await expect(f.s.admit(good, 2, await revision(f.s))).rejects.toThrow();
});

test("billing rewind and an older in-flight wall observation cannot authorize the next period", async () => {
  const f = await fixture();
  const old = await source({ simulationId: f.binding.simulationId, wallNow: () => Date.now() - 5000 })
    .observe(installmentMonthBoundary(anchor, 1));
  const a = await f.s.admit(await f.observe(anchor + 1), 1, 0);
  await f.s.recordReceipt(a, receipt(f.s, a));
  await expect(f.s.admit(await f.observe(anchor), 2, await revision(f.s))).rejects.toThrow();
  await expect(f.s.admit(old, 2, await revision(f.s))).rejects.toThrow();
  expect((await f.s.snapshot()).paidCount).toBe(1);
});

test("invalid or conflicting receipts never credit or replace raw capture evidence", async () => {
  const f = await fixture();
  const a = await f.s.admit(await f.observe(), 1, 0);
  const r = receipt(f.s, a);
  const getter = jest.fn(() => { throw Error("synthetic-secret-should-not-leak"); });
  const withGetter = Object.defineProperty({ ...r }, "invoiceId", { enumerable: true, get: getter });
  await expect(f.s.recordReceipt(a, withGetter)).rejects.toThrow("Local clock simulation stopped");
  expect(getter).not.toHaveBeenCalled();
  await expect(f.s.recordReceipt(a, { ...r, extra: "not-receipt-evidence" } as typeof r)).rejects.toThrow();
  const bad = [
    { ...r, rawCaptureSeconds: a.billingTimeSeconds },
    { ...r, rawCaptureSeconds: Math.floor(a.dispatchWallTimeMilliseconds / 1000) - 2 },
    { ...r, rawCaptureSeconds: r.rawCaptureSeconds + 60 },
    { ...r, rawCaptureSeconds: 1.5 },
    { ...r, grossCents: r.grossCents + 1 },
    { ...r, deductionCents: r.deductionCents + 1 },
    { ...r, invoiceId: "in_NotALocalFixture" },
  ];
  for (const invalid of bad) await expect(f.s.recordReceipt(a, invalid)).rejects.toThrow();
  await expect(f.s.recordReceipt({ ...a }, r)).rejects.toThrow();
  expect((await f.s.snapshot()).paidCount).toBe(0);
  await f.s.recordReceipt(a, r);
  await expect(f.s.recordReceipt(a, { ...r, chargeId: "ch_CNQALOCALConflict" })).rejects.toThrow();
  expect((await f.s.snapshot()).admissions[0].rawCaptureSeconds).toBe(r.rawCaptureSeconds);
  expect((await f.s.snapshot()).paidCount).toBe(1);
});

test("a previously credited invoice cannot be reused on a later admission", async () => {
  const f = await fixture();
  const first = await f.s.admit(await f.observe(), 1, 0);
  await f.s.recordReceipt(first, receipt(f.s, first));
  const next = await f.s.admit(await f.observe(installmentMonthBoundary(anchor, 1)), 2, await revision(f.s));
  const r = receipt(f.s, next);
  for (const field of ["invoiceId", "paymentIntentId", "chargeId"] as const) {
    await expect(f.s.recordReceipt(next, { ...r, [field]: receipt(f.s, first)[field] })).rejects.toThrow();
  }
  expect((await f.s.snapshot()).paidCount).toBe(1);
});

test("creation refuses existing-looking hosted identities and operations are revoked on close", async () => {
  const bad = source({ customerId: "cus_NotALocalFixture" });
  await expect(createExactClockSimulation({ firstObservation: await bad.observe(), totalCents: 199900,
    paymentCount: 3, firstFeeSchedule: firstFees, renewalFeeSchedule: renewalFees })).rejects.toThrow();
  const f = await fixture();
  const a = await f.s.admit(await f.observe(), 1, 0);
  await f.s.close();
  await expect(f.s.snapshot()).rejects.toThrow();
  await expect(f.s.recordReceipt(a, receipt(f.s, a))).rejects.toThrow();
});
