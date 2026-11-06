/** Actual Stripe signature verifier, HTTP route and monthly handoff. Runtime
 * provider work and durable claims use synthetic ports; no hosted delivery claim. */
import Stripe from "stripe";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const verifier = new Stripe("sk_test_synthetic_no_network"), secret = "synthetic-mentorship-signature";
const claim = jest.fn(), complete = jest.fn(), release = jest.fn(), lifecycle = jest.fn(), payment = jest.fn();
const exactHandoff = jest.fn().mockResolvedValue(false);
let db = createMockClient(() => undefined);
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => ({ webhooks: verifier.webhooks }) }));
jest.mock("@/lib/stripeEvents", () => ({ claimStripeEvent: (...a: unknown[]) => claim(...a), completeStripeEvent: (...a: unknown[]) => complete(...a), releaseStripeEvent: (...a: unknown[]) => release(...a) }));
jest.mock("@/lib/installments/routeHandoff", () => ({ handoffExactInstallmentWebhook: (...a: unknown[]) => exactHandoff(...a) }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({ reconcileLifecycle: (...a: unknown[]) => lifecycle(...a), reconcilePaymentEvent: (...a: unknown[]) => payment(...a) }) }));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("@/lib/updatePostMetrics", () => ({ updatePostMetrics: jest.fn() }));
const previous = { ...process.env }, fixture = membershipFixture(true);
const gaps = ["charge.updated", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed",
  "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible"] as const;
beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks();
  process.env = { ...previous, ...membershipTestEnv, VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_test_synthetic_no_network",
    STRIPE_WEBHOOK_SECRET: secret, NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic" };
  db = createMockClient(op => ({ data: op.table === "monthly_mentorship_agreements_v1" ? [fixture.a] : null, error: null }));
  claim.mockResolvedValue({ status: "new", claimToken: "synthetic-token" }); complete.mockResolvedValue(undefined); release.mockResolvedValue(undefined);
  lifecycle.mockResolvedValue({ status: "observed" }); payment.mockResolvedValue({ status: "reconciled" });
  jest.spyOn(console, "log").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks()); afterAll(() => { process.env = previous; });
async function deliver(type: typeof gaps[number], signingSecret = secret, apiVersion: string = context.apiVersion) {
  const object = type === "charge.updated" ? fixture.charge : type.startsWith("customer.subscription.") ? fixture.subscription :
    { id: "in_synthetic", object: "invoice", customer: fixture.customer.id, parent: { subscription_details: { subscription: fixture.subscription.id } } };
  const event = { id: "evt_synthetic", type, object: "event", api_version: apiVersion, livemode: false, data: { object } };
  const payload = JSON.stringify(event), signature = verifier.webhooks.generateTestHeaderString({ payload, secret: signingSecret });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request("https://example.invalid/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature } }) as never);
}
test.each(gaps.flatMap(type => [[type, context.apiVersion] as const, [type, "2025-09-30.clover"] as const]))("signed %s (%s) is claimed, handed off and completed without legacy processing", async (type, apiVersion) => {
  expect((await deliver(type, secret, apiVersion)).status).toBe(200);
  const worker = type === "charge.updated" ? payment : lifecycle;
  expect(worker).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1);
  expect(claim.mock.invocationCallOrder[0]).toBeLessThan(worker.mock.invocationCallOrder[0]);
  expect(worker.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
  expect(exactHandoff).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  expect(db.ops.every(op => op.kind === "select")).toBe(true);
});
test.each(gaps)("failed %s reconciliation is retryable and never marked complete", async type => {
  lifecycle.mockRejectedValue(Error("synthetic provider unavailable")); payment.mockRejectedValue(Error("synthetic provider unavailable"));
  expect((await deliver(type)).status).toBe(500); expect(complete).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1); expect(exactHandoff).not.toHaveBeenCalled();
});
test("invalid signature never claims or reads monthly records", async () => {
  expect((await deliver("invoice.payment_failed", "wrong-secret")).status).toBe(400);
  expect(claim).not.toHaveBeenCalled(); expect(db.ops).toEqual([]);
});
test("already-complete duplicate never re-enters a payment adapter", async () => {
  claim.mockResolvedValue({ status: "duplicate" });
  expect((await deliver("invoice.payment_failed")).status).toBe(200);
  expect(lifecycle).not.toHaveBeenCalled(); expect(payment).not.toHaveBeenCalled();
});
