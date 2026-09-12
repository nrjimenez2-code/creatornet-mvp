/** NEW isolated clock-evidence assertions only. All provider ports/data are
 * synthetic. No SDK/network, database, credentials or existing suites run. */
import { assertFreshExactClockObservation, createExactClockEvidenceReader,
  EXACT_CLOCK_OBSERVATION_MAX_AGE_MS, type ExactClockBinding } from "../test-support/exact-clock-simulation/clockEvidence";
import type { ExactPaymentContext, ExactPaymentContextEvidence } from "../lib/installments/paymentContext";

const wallTime = 1_788_897_600_000;
const billingTime = 1_791_489_600;
const failure = "Exact clock observation unavailable";

function fixture(mode: "test" | "live" = "test") {
  const context: ExactPaymentContext = { version: "exact-payment-context-v1", mode,
    platformAccountId: "acct_syntheticPlatform", supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa",
    siteOrigin: mode === "test" ? "https://synthetic-clock.vercel.app" : "https://synthetic-live.example" };
  const contextEvidence: ExactPaymentContextEvidence = { approvedContext: { ...context },
    vercelEnvironment: mode === "test" ? "preview" : "production", stripeSecretKeyMode: mode,
    stripePublishableKeyMode: mode, observedPlatformAccountId: context.platformAccountId,
    observedSupabaseProjectRef: context.supabaseProjectRef,
    configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin };
  const binding: ExactClockBinding = { version: "exact-clock-binding-v1",
    simulationId: "11111111-1111-4111-8111-111111111111", clockId: "clock_synthetic",
    customerId: "cus_synthetic", subscriptionId: "sub_synthetic" };
  const account = { id: context.platformAccountId };
  const clock = { id: binding.clockId, livemode: false, status: "ready", frozen_time: billingTime };
  const customer = { id: binding.customerId, livemode: false, test_clock: binding.clockId };
  const subscription = { id: binding.subscriptionId, livemode: false, customer: binding.customerId, test_clock: binding.clockId };
  const calls: string[] = [];
  const provider = {
    observePlatformAccount: jest.fn(async () => { calls.push("account"); return account as unknown; }),
    retrieveClock: jest.fn(async (id: string) => { void id; calls.push("clock"); return clock as unknown; }),
    retrieveCustomer: jest.fn(async (id: string) => { void id; calls.push("customer"); return customer as unknown; }),
    retrieveSubscription: jest.fn(async (id: string) => { void id; calls.push("subscription"); return subscription as unknown; }),
  };
  const wallNowMilliseconds = jest.fn(() => wallTime);
  const args = { context, contextEvidence, binding, provider, wallNowMilliseconds };
  return { args, context, contextEvidence, binding, account, clock, customer, subscription, provider, wallNowMilliseconds, calls };
}

test("separates billing from wall time and exposes only immutable compact read evidence", async () => {
  const f = fixture();
  Object.assign(f.customer, { email: "synthetic-private-marker", metadata: { secret: "synthetic-private-marker" } });
  Object.assign(f.subscription, { latest_invoice: { hosted_invoice_url: "https://synthetic.invalid/private" } });
  const beforeDateNow = Date.now;
  const beforeDate = Date;
  const reader = createExactClockEvidenceReader(f.args);
  const observation = await reader.observe();
  expect(observation).toEqual({ version: "exact-clock-observation-v1", context: f.context, simulationId: f.binding.simulationId,
    platformAccountId: f.context.platformAccountId, clockId: f.binding.clockId, customerId: f.binding.customerId,
    subscriptionId: f.binding.subscriptionId, billingTimeSeconds: billingTime,
    startedWallTimeMilliseconds: wallTime, observedWallTimeMilliseconds: wallTime });
  expect(Object.isFrozen(reader)).toBe(true);
  expect(Object.isFrozen(observation)).toBe(true);
  expect(Object.isFrozen(observation.context)).toBe(true);
  expect(observation.context).not.toBe(f.context);
  expect(f.calls).toEqual(["account", "clock", "customer", "subscription", "subscription", "customer", "clock", "account"]);
  expect(f.provider.retrieveClock.mock.calls).toEqual([[f.binding.clockId], [f.binding.clockId]]);
  expect(f.provider.retrieveCustomer.mock.calls).toEqual([[f.binding.customerId], [f.binding.customerId]]);
  expect(f.provider.retrieveSubscription.mock.calls).toEqual([[f.binding.subscriptionId], [f.binding.subscriptionId]]);
  expect(JSON.stringify(observation)).not.toMatch(/private|email|metadata|url|secret/);
  expect(Date.now).toBe(beforeDateNow);
  expect(Date).toBe(beforeDate);
  assertFreshExactClockObservation(observation, wallTime);
});

test("accepts fresh expanded clock/customer references but does not return provider objects", async () => {
  const f = fixture();
  f.provider.retrieveCustomer.mockResolvedValue({ ...f.customer, test_clock: { id: f.binding.clockId } });
  f.provider.retrieveSubscription.mockResolvedValue({ ...f.subscription,
    test_clock: { id: f.binding.clockId }, customer: { id: f.binding.customerId } });
  await expect(createExactClockEvidenceReader(f.args).observe()).resolves.toMatchObject({ billingTimeSeconds: billingTime });
});

test("pins context, binding and provider method references before asynchronous observation", async () => {
  const f = fixture();
  const reader = createExactClockEvidenceReader(f.args);
  Object.assign(f.binding, { customerId: "cus_changed", clockId: "clock_changed" });
  Object.assign(f.context, { platformAccountId: "acct_changed" });
  const replacement = jest.fn<Promise<unknown>, [string]>(async () => { throw new Error("synthetic-private-marker"); });
  f.provider.retrieveCustomer = replacement;
  const observation = await reader.observe();
  expect(observation.customerId).toBe("cus_synthetic");
  expect(observation.clockId).toBe("clock_synthetic");
  expect(observation.platformAccountId).toBe("acct_syntheticPlatform");
  expect(replacement).not.toHaveBeenCalled();
});

test("a valid live payment context is still forbidden before any provider read", () => {
  const f = fixture("live");
  expect(() => createExactClockEvidenceReader(f.args)).toThrow(failure);
  expect(f.calls).toEqual([]);
});

test("context evidence must independently match approved pins", () => {
  const f = fixture();
  const args = { ...f.args, contextEvidence: { ...f.contextEvidence, observedPlatformAccountId: "acct_other" } };
  expect(() => createExactClockEvidenceReader(args)).toThrow(failure);
  expect(f.calls).toEqual([]);
});

test.each([
  { version: "other" }, { simulationId: "11111111-1111-1111-8111-111111111111" },
  { simulationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, { clockId: "clock_" },
  { customerId: "sub_wrongType" }, { subscriptionId: "sub_private?secret=value" },
  { requestMetadata: { clockId: "clock_synthetic" } },
])("rejects malformed or metadata-augmented binding %j without provider reads", change => {
  const f = fixture();
  expect(() => createExactClockEvidenceReader({ ...f.args, binding: { ...f.binding, ...change } })).toThrow(failure);
  expect(f.calls).toEqual([]);
});

type PortName = "observePlatformAccount" | "retrieveClock" | "retrieveCustomer" | "retrieveSubscription";
const badEvidence: ReadonlyArray<readonly [string, PortName, Record<string, unknown>]> = [
  ["wrong platform account", "observePlatformAccount", { id: "acct_other" }],
  ["wrong clock", "retrieveClock", { id: "clock_other" }],
  ["live clock", "retrieveClock", { livemode: true }],
  ["ambiguous clock mode", "retrieveClock", { livemode: "false" }],
  ["advancing clock", "retrieveClock", { status: "advancing" }],
  ["failed clock", "retrieveClock", { status: "internal_failure" }],
  ["zero billing time", "retrieveClock", { frozen_time: 0 }],
  ["fractional billing time", "retrieveClock", { frozen_time: billingTime + 0.5 }],
  ["unsafe billing time", "retrieveClock", { frozen_time: Number.MAX_SAFE_INTEGER + 1 }],
  ["missing billing time", "retrieveClock", { frozen_time: null }],
  ["wrong customer", "retrieveCustomer", { id: "cus_other" }],
  ["live customer", "retrieveCustomer", { livemode: true }],
  ["unclocked customer", "retrieveCustomer", { test_clock: null }],
  ["other customer clock", "retrieveCustomer", { test_clock: "clock_other" }],
  ["wrong subscription", "retrieveSubscription", { id: "sub_other" }],
  ["live subscription", "retrieveSubscription", { livemode: true }],
  ["other subscription customer", "retrieveSubscription", { customer: "cus_other" }],
  ["other subscription clock", "retrieveSubscription", { test_clock: "clock_other" }],
];

test.each(badEvidence)("rejects initial %s evidence", async (_reason, method, change) => {
  const f = fixture();
  const current = { observePlatformAccount: f.account, retrieveClock: f.clock,
    retrieveCustomer: f.customer, retrieveSubscription: f.subscription }[method];
  f.provider[method].mockResolvedValueOnce({ ...current, ...change });
  await expect(createExactClockEvidenceReader(f.args).observe()).rejects.toThrow(failure);
});

test.each([
  ["platform changes", "observePlatformAccount", { id: "acct_other" }],
  ["clock advances", "retrieveClock", { frozen_time: billingTime + 1 }],
  ["clock rewinds", "retrieveClock", { frozen_time: billingTime - 1 }],
  ["clock becomes advancing", "retrieveClock", { status: "advancing" }],
  ["customer moves clocks", "retrieveCustomer", { test_clock: "clock_other" }],
  ["subscription moves customer", "retrieveSubscription", { customer: "cus_other" }],
] satisfies Array<[string, PortName, Record<string, unknown>]>) (
  "cross-read rejects %s before issuing any observation", async (_reason, method, change) => {
    const f = fixture();
    const current = { observePlatformAccount: f.account, retrieveClock: f.clock,
      retrieveCustomer: f.customer, retrieveSubscription: f.subscription }[method];
    f.provider[method].mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, ...change });
    await expect(createExactClockEvidenceReader(f.args).observe()).rejects.toThrow(failure);
  });

test.each(["observePlatformAccount", "retrieveClock", "retrieveCustomer", "retrieveSubscription"] as const)(
  "%s failure never leaks raw provider diagnostics", async method => {
    const f = fixture();
    f.provider[method].mockRejectedValueOnce(new Error("synthetic-private-marker"));
    await expect(createExactClockEvidenceReader(f.args).observe()).rejects.toThrow(new Error(failure));
  });

test("provider accessors and inherited fields are not read as evidence", async () => {
  const f = fixture();
  const read = jest.fn(() => { throw new Error("synthetic-private-marker"); });
  const payload = { ...f.clock };
  Object.defineProperty(payload, "frozen_time", { enumerable: true, get: read });
  f.provider.retrieveClock.mockResolvedValueOnce(payload);
  await expect(createExactClockEvidenceReader(f.args).observe()).rejects.toThrow(failure);
  expect(read).not.toHaveBeenCalled();
  f.provider.retrieveClock.mockResolvedValueOnce(Object.create(f.clock));
  await expect(createExactClockEvidenceReader(f.args).observe()).rejects.toThrow(failure);
});

test.each([0, NaN, Infinity, wallTime + 0.1])("invalid starting wall time %p fails before reads", async started => {
  const f = fixture();
  f.wallNowMilliseconds.mockReturnValue(started);
  await expect(createExactClockEvidenceReader(f.args).observe()).rejects.toThrow(failure);
  expect(f.calls).toEqual([]);
});

test.each([wallTime - 1, wallTime + 30_001, NaN, wallTime + 0.5])(
  "rejects stale, reversed or malformed final wall observation %p", async ended => {
    const f = fixture();
    f.wallNowMilliseconds.mockReturnValueOnce(wallTime).mockReturnValueOnce(ended);
    await expect(createExactClockEvidenceReader(f.args).observe()).rejects.toThrow(failure);
  });

test("freshness starts before all reads, lasts at most 30 seconds, and never follows billing time", async () => {
  const f = fixture();
  f.wallNowMilliseconds.mockReturnValueOnce(wallTime).mockReturnValueOnce(wallTime + 20_000);
  const observation = await createExactClockEvidenceReader(f.args).observe();
  assertFreshExactClockObservation(observation, wallTime + EXACT_CLOCK_OBSERVATION_MAX_AGE_MS);
  for (const now of [wallTime + 19_999, wallTime + 30_001, billingTime * 1000, NaN, -1]) {
    expect(() => assertFreshExactClockObservation(observation, now)).toThrow(failure);
  }
});

test("copied, serialized and forged observations cannot become trusted provider evidence", async () => {
  const f = fixture(), observation = await createExactClockEvidenceReader(f.args).observe();
  for (const value of [{ ...observation }, JSON.parse(JSON.stringify(observation)), null,
    { version: "exact-clock-observation-v1", billingTimeSeconds: billingTime }]) {
    expect(() => assertFreshExactClockObservation(value, wallTime)).toThrow(failure);
  }
});

test("observation does not claim persistent monotonic sequence or authorize a payment", async () => {
  const f = fixture(), reader = createExactClockEvidenceReader(f.args);
  const first = await reader.observe();
  f.clock.frozen_time = billingTime - 1;
  const second = await reader.observe();
  // Atomic future-store state must reject regression across observations; this
  // stateless read adapter checks coherence within each sandwich only.
  expect(second.billingTimeSeconds).toBeLessThan(first.billingTimeSeconds);
  expect(Object.keys(reader)).toEqual(["observe"]);
  expect(first).not.toHaveProperty("admitted");
  expect(first).not.toHaveProperty("sequence");
});
