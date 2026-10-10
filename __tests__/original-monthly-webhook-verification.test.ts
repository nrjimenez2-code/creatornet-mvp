/** Real HTTP handler and Stripe signature verification; effects are synthetic.
 * These tests do not send Stripe events or access hosted payment/database data. */
import Stripe from "stripe";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const verifier = new Stripe("sk_test_synthetic_no_network");
const platformSecret = "synthetic-platform-signature", connectSecret = "synthetic-connect-signature";
const claim = jest.fn(), complete = jest.fn(), release = jest.fn(), retrieve = jest.fn(), exact = jest.fn(), monthly = jest.fn();
let db = createMockClient(() => undefined);
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => ({ webhooks: verifier.webhooks, accounts: { retrieve } }) }));
jest.mock("@/lib/stripeEvents", () => ({ claimStripeEvent: (...a: unknown[]) => claim(...a), completeStripeEvent: (...a: unknown[]) => complete(...a), releaseStripeEvent: (...a: unknown[]) => release(...a) }));
jest.mock("@/lib/installments/routeHandoff", () => ({ handoffExactInstallmentWebhook: (...a: unknown[]) => exact(...a) }));
jest.mock("@/lib/membershipWebhook", () => ({ handoffMonthlyMentorshipWebhook: (...a: unknown[]) => monthly(...a) }));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("@/lib/updatePostMetrics", () => ({ updatePostMetrics: jest.fn() }));
const previous = { ...process.env };
const origin = "https://creatornet-verifyfixture-nrjimenez2-codes-projects.vercel.app";
beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks();
  process.env = { ...previous, VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview",
    VERCEL_PROJECT_ID: "prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA", VERCEL_URL: origin.slice(8), VERCEL_DEPLOYMENT_ID: "dpl_verificationfixture",
    CREATOR_ORIGINAL_MONTHLY_COMPLETION_PROFILE: "original-monthly-completion-v1", CREATOR_ORIGINAL_MONTHLY_WEBHOOK_VERIFY_ONLY: "true",
    CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED: "true", CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED: "false",
    CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT: "false", STRIPE_SECRET_KEY: "sk_test_synthetic_no_network",
    STRIPE_WEBHOOK_SECRET: platformSecret, STRIPE_CONNECT_WEBHOOK_SECRET: connectSecret,
    NEXT_PUBLIC_SUPABASE_URL: "https://nwqfofezfzljhxolkycz.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic" };
  db = createMockClient(() => ({ data: null, error: null }));
  claim.mockRejectedValue(Error("Observation must not claim"));
  retrieve.mockRejectedValue(Error("Observation must not call Stripe"));
  jest.spyOn(console, "log").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(globalThis, "fetch").mockRejectedValue(Error("No network in fixture tests"));
});
afterEach(() => { jest.restoreAllMocks(); process.env = { ...previous }; });
const platform = (type = "customer.created") => ({ id: "evt_observation", object: "event", type,
  api_version: "2025-10-29.clover", livemode: false,
  data: { object: { id: "cus_fixture", object: "customer", email: "private-fixture@example.invalid", metadata: { private: "never-retain-this" } } } });
const connected = () => ({ ...platform("account.updated"), account: "acct_fixture",
  data: { object: { id: "acct_fixture", object: "account", charges_enabled: true, payouts_enabled: true } } });
async function deliver(event: unknown, secret = platformSecret, url = origin + "/api/stripe/webhook", alias = false) {
  const payload = JSON.stringify(event), signature = verifier.webhooks.generateTestHeaderString({ payload, secret });
  const route = alias ? await import("../app/api/webhook/route") : await import("../app/api/stripe/webhook/route");
  return route.POST(new Request(url, { method: "POST", body: payload, headers: { "stripe-signature": signature } }) as never);
}
function noEffects() {
  for (const port of [claim, complete, release, retrieve, exact, monthly, globalThis.fetch]) expect(port).not.toHaveBeenCalled();
  expect(db.ops).toEqual([]);
}

test.each(["customer.created", "payment_intent.succeeded", "invoice.payment_failed", "charge.refunded"])("signed %s is observed before every shared claim or payment path", async type => {
  const response = await deliver(platform(type));
  expect(response.status).toBe(200); noEffects();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  const body = await response.json();
  expect(body).toEqual({ ok: true, version: "original-monthly-signed-observation-v1", deploymentId: "dpl_verificationfixture",
    eventId: "evt_observation", eventType: type, source: "platform", livemode: false, apiVersion: "2025-10-29.clover",
    processing: "verification-only", databaseClaimed: false });
  expect(console.info).toHaveBeenCalledTimes(1);
  const retained = JSON.stringify([body, jest.mocked(console.info).mock.calls]);
  for (const privateValue of [platformSecret, connectSecret, "cus_fixture", "private-fixture@example.invalid", "never-retain-this"])
    expect(retained).not.toContain(privateValue);
});

test("connected account observation does not retrieve capabilities or update profiles", async () => {
  const response = await deliver(connected(), connectSecret);
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ source: "connect", databaseClaimed: false }); noEffects();
});

test("the backward-compatible URL uses the same no-claim observation", async () => {
  expect((await deliver(platform("charge.refunded"), platformSecret, origin + "/api/webhook", true)).status).toBe(200); noEffects();
});

test("repeated signed delivery never enters completed-duplicate refund repair", async () => {
  claim.mockResolvedValue({ status: "duplicate" });
  expect((await deliver(platform("charge.refunded"))).status).toBe(200);
  expect((await deliver(platform("charge.refunded"))).status).toBe(200);
  expect(console.info).toHaveBeenCalledTimes(2); noEffects();
});

test("wrong signature cannot produce a verification receipt", async () => {
  expect((await deliver(platform(), "untrusted-secret")).status).toBe(400);
  expect(console.info).not.toHaveBeenCalled(); noEffects();
});

test.each(["", "false", "TRUE", "unexpected"])("malformed observation selection %s fails closed", async value => {
  process.env.CREATOR_ORIGINAL_MONTHLY_WEBHOOK_VERIFY_ONLY = value;
  expect((await deliver(platform())).status).toBe(503); noEffects();
});

test.each([
  ["VERCEL_ENV", "production"], ["VERCEL_TARGET_ENV", "mentorship-sandbox"], ["VERCEL_PROJECT_ID", "prj_other"],
  ["CREATOR_ORIGINAL_MONTHLY_COMPLETION_PROFILE", "other"], ["CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED", "false"],
  ["CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED", "true"], ["CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT", "true"],
  ["NEXT_PUBLIC_SUPABASE_URL", "https://other.supabase.co"], ["VERCEL_URL", "www.creatornet.net"],
  ["VERCEL_DEPLOYMENT_ID", "not-a-deployment"],
])("observation refuses drift in %s", async (name, value) => {
  process.env[name] = value;
  expect((await deliver(platform())).status).toBe(503); noEffects();
});

test("observation refuses an alternate host and never retains a query credential", async () => {
  expect((await deliver(platform(), platformSecret, "https://other.invalid/api/stripe/webhook")).status).toBe(503); noEffects();
  const response = await deliver(platform(), platformSecret, origin + "/api/stripe/webhook?x-vercel-protection-bypass=synthetic-private-query");
  expect(response.status).toBe(200);
  expect(JSON.stringify([await response.json(), jest.mocked(console.info).mock.calls])).not.toContain("synthetic-private-query"); noEffects();
});

test.each([
  [() => ({ ...platform(), livemode: true }), platformSecret],
  [() => ({ ...platform(), livemode: undefined }), platformSecret],
  [() => ({ ...platform(), account: "acct_fixture" }), platformSecret],
  [() => platform(), connectSecret], [() => connected(), platformSecret],
  [() => ({ ...connected(), account: "acct_other" }), connectSecret],
] as const)("existing signature source and mode rules remain in force %#", async (event, secret) => {
  expect((await deliver(event(), secret)).status).toBe(400);
  expect(console.info).not.toHaveBeenCalled(); noEffects();
});

test("ambiguous signing secrets fail before observation", async () => {
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = platformSecret;
  expect((await deliver(platform())).status).toBe(500); noEffects();
});

test.each([{ ...platform(), id: "private-fixture@example.invalid" }, { ...platform(), type: "untrusted payload\n" }])("malformed event envelope is not retained", async event => {
  expect((await deliver(event)).status).toBe(400); expect(console.info).not.toHaveBeenCalled(); noEffects();
});

test("omitting observation keeps ordinary completion claim semantics", async () => {
  delete process.env.CREATOR_ORIGINAL_MONTHLY_WEBHOOK_VERIFY_ONLY;
  claim.mockResolvedValue({ status: "duplicate" });
  const response = await deliver(platform());
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, duplicate: true });
  expect(claim).toHaveBeenCalledWith("stripe:evt_observation", "customer.created");
  expect(console.info).not.toHaveBeenCalled();
});
