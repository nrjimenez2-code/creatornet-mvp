/** Real Stripe signing/verification and real route; all provider/database effects stay in memory. */
import Stripe from "stripe";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const verifier = new Stripe("sk_test_synthetic_no_network");
const platformSecret = "synthetic-platform-signature", connectSecret = "synthetic-connect-signature";
const claim = jest.fn(), complete = jest.fn(), release = jest.fn(), retrieve = jest.fn();
let db = createMockClient(() => undefined);
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => ({ webhooks: verifier.webhooks, accounts: { retrieve } }) }));
jest.mock("@/lib/stripeEvents", () => ({ claimStripeEvent: (...a: unknown[]) => claim(...a), completeStripeEvent: (...a: unknown[]) => complete(...a), releaseStripeEvent: (...a: unknown[]) => release(...a) }));
jest.mock("@/lib/installments/routeHandoff", () => ({ handoffExactInstallmentWebhook: async () => false }));
jest.mock("@/lib/membershipWebhook", () => ({ handoffMonthlyMentorshipWebhook: async () => false }));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("@/lib/updatePostMetrics", () => ({ updatePostMetrics: jest.fn() }));
const previousEnv = { ...process.env };
beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks();
  process.env = { ...previousEnv, VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_live_synthetic_no_network",
    STRIPE_WEBHOOK_SECRET: platformSecret, STRIPE_CONNECT_WEBHOOK_SECRET: connectSecret,
    NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic" };
  db = createMockClient(op => ({ data: op.kind === "insert" ? { id: "synthetic_booking" } : null, error: null }));
  claim.mockResolvedValue({ status: "new", claimToken: "synthetic-token" });
  complete.mockResolvedValue(undefined); release.mockResolvedValue(undefined);
  retrieve.mockResolvedValue({ id: "acct_synthetic", charges_enabled: false, payouts_enabled: true });
  jest.spyOn(console, "log").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => { process.env = previousEnv; });
const setup = (livemode: boolean | undefined = true) => ({ id: "evt_synthetic", type: "checkout.session.completed", livemode,
  data: { object: { id: "cs_synthetic", object: "checkout.session", mode: "setup", metadata: { buyer_id: "buyer_synthetic", creator_id: "creator_synthetic" } } } });
const accountEvent = (livemode = true) => ({ id: "evt_account", type: "account.updated", livemode, account: "acct_synthetic",
  data: { object: { id: "acct_synthetic", object: "account", charges_enabled: true, payouts_enabled: true } } });
async function deliver(event: unknown, secret = platformSecret) {
  const payload = JSON.stringify(event), signature = verifier.webhooks.generateTestHeaderString({ payload, secret });
  const { POST } = await import("../app/api/stripe/webhook/route");
  return POST(new Request("https://example.invalid/api/stripe/webhook", { method: "POST", body: payload,
    headers: { "stripe-signature": signature } }) as never);
}
function noEffects() { expect(claim).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(db.ops).toHaveLength(0); expect(retrieve).not.toHaveBeenCalled(); }
test("valid live platform setup retains exactly one legacy booking effect", async () => {
  expect((await deliver(setup())).status).toBe(200);
  expect(db.opsFor("bookings").filter(op => op.kind === "insert")).toHaveLength(1);
  expect(claim).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1);
});
test("valid test platform setup remains usable on Preview", async () => {
  process.env.VERCEL_ENV = "preview"; process.env.STRIPE_SECRET_KEY = "rk_test_synthetic_no_network";
  expect((await deliver(setup(false))).status).toBe(200);
  expect(db.opsFor("bookings").filter(op => op.kind === "insert")).toHaveLength(1);
});
test("signed platform TEST event cannot write production or claim its id", async () => {
  expect((await deliver(setup(false))).status).toBe(400); noEffects();
});
test("missing event mode is rejected", async () => {
  const event = { ...setup(), livemode: undefined };
  expect((await deliver(event)).status).toBe(400); noEffects();
});
test.each([platformSecret, connectSecret])("connected Checkout cannot enter legacy platform booking with %s", async secret => {
  expect((await deliver({ ...setup(), account: "acct_synthetic" }, secret)).status).toBe(400); noEffects();
});
test("Connect secret cannot authorize an unscoped Checkout", async () => {
  expect((await deliver(setup(), connectSecret)).status).toBe(400); noEffects();
});
test("wrong signature produces no effects", async () => {
  expect((await deliver(setup(), "untrusted-signing-secret")).status).toBe(400); noEffects();
});
test("valid connected capability event still fetches fresh restrictions and completes", async () => {
  expect((await deliver(accountEvent(), connectSecret)).status).toBe(200);
  expect(retrieve).toHaveBeenCalledWith("acct_synthetic");
  expect(db.opsFor("profiles").find(op => op.kind === "update")?.payload).toMatchObject({ charges_enabled: false, onboarding_complete: false });
  expect(complete).toHaveBeenCalledTimes(1);
});
test("production Connect test notification is acknowledged without a claim or state changes", async () => {
  const response = await deliver(accountEvent(false), connectSecret);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, ignored: "test-connect-event" }); noEffects();
});
test.each([undefined, "acct_other"])("Connect identity %s cannot update an unrelated account", async account => {
  expect((await deliver({ ...accountEvent(), account }, connectSecret)).status).toBe(400); noEffects();
});
test("platform secret cannot authorize connected capability updates", async () => {
  expect((await deliver(accountEvent())).status).toBe(400); noEffects();
});
test.each(["sk_test_synthetic", "unknown"])("production key configuration %s fails closed", async key => {
  process.env.STRIPE_SECRET_KEY = key; expect((await deliver(setup())).status).toBe(500); noEffects();
});
test("equal signing secrets are ambiguous and fail closed", async () => {
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = platformSecret; expect((await deliver(setup())).status).toBe(500); noEffects();
});
