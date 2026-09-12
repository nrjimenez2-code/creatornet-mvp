process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_fake";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";
process.env.NEXT_PUBLIC_SITE_URL = "https://creatornet.example";

import { NextRequest } from "next/server";
import { createMockClient, type Op } from "./__mocks__/supabaseQueryMock";

type Profile = { id: string; stripe_account_id: string | null; stripe_onboarding_complete: boolean;
  onboarding_complete: boolean; charges_enabled: boolean; payouts_enabled: boolean };
type Attempt = { creator_id: string; email: string | null; idempotency_key: string; created_at: string; stripe_account_id: string | null };
let mockProfile: Profile | null, mockAttempt: Attempt | null;
let mockUser: { id: string; email: string } | null;
let failProfileWrite = false, failAttemptWrite = false, failReserve = false, failProfileInsert = false;
let claimState: "empty" | "processing" | "complete", claimToken: unknown;
const mockCreate = jest.fn(), mockRetrieve = jest.fn(), mockLinks = jest.fn();
let mockEvent: { id: string; type: string; livemode: boolean; account: string; data: { object: { id: string; charges_enabled: boolean; payouts_enabled: boolean } } };
const failure = { data: null, error: { code: "08006", message: "synthetic database failure" } };
const ok = (data: unknown = null) => ({ data, error: null });
const matches = (row: object, op: Op) => Object.entries(op.filters).every(([key, value]) => Reflect.get(row, key) === value);
const mockDb = createMockClient(op => {
  if (op.table === "profiles") {
    if (op.kind === "select") return ok(mockProfile && { ...mockProfile });
    if (op.kind === "insert") {
      if (failProfileInsert) return failure;
      if (mockProfile) return { data: null, error: { code: "23505" } };
      mockProfile = { id: "creator_1", stripe_account_id: null, stripe_onboarding_complete: false,
        onboarding_complete: false, charges_enabled: false, payouts_enabled: false };
      return ok();
    }
    if (op.kind === "update") {
      if (failProfileWrite) return failure;
      if (!mockProfile || !matches(mockProfile, op)) return ok([]);
      Object.assign(mockProfile, op.payload);
      return ok([{ id: mockProfile.id }]);
    }
  }
  if (op.table === "stripe_connect_account_creations") {
    if (op.kind === "insert") {
      if (failReserve) return failure;
      if (mockAttempt) return { data: null, error: { code: "23505" } };
      const p = op.payload as { creator_id: string; email: string | null };
      mockAttempt = { ...p, idempotency_key: "11111111-1111-4111-8111-111111111111",
        created_at: new Date(Date.now() - 1000).toISOString(), stripe_account_id: null };
      return ok();
    }
    if (op.kind === "select") return ok(mockAttempt && { ...mockAttempt });
    if (op.kind === "update") {
      if (failAttemptWrite) return failure;
      if (mockAttempt && matches(mockAttempt, op)) Object.assign(mockAttempt, op.payload);
      return ok();
    }
  }
  const p = op.payload as { p_claim_token?: unknown };
  if (op.table === "claim_stripe_event") {
    if (claimState === "complete") return ok("duplicate");
    if (claimState === "processing") return ok("busy");
    claimState = "processing"; claimToken = p.p_claim_token; return ok("new");
  }
  if (op.table === "complete_stripe_event") {
    if (claimState !== "processing" || claimToken !== p.p_claim_token) return ok(false);
    claimState = "complete"; return ok(true);
  }
  if (op.table === "release_stripe_event") {
    if (claimState === "processing" && claimToken === p.p_claim_token) claimState = "empty";
    return ok();
  }
  throw Error(`Unexpected database call: ${op.table}`);
});
jest.mock("@supabase/supabase-js", () => ({ createClient: () => mockDb }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => mockUser }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => ({ accounts: { create: mockCreate, retrieve: mockRetrieve },
  accountLinks: { create: mockLinks }, webhooks: { constructEvent: (_body: string, _signature: string, secret: string) => { if (secret !== "whsec_connect_fake") throw Error("wrong destination"); return mockEvent; } } }) }));
jest.mock("@/lib/installments/routeHandoff", () => ({ handoffExactInstallmentWebhook: async () => false }));
jest.mock("@/lib/membershipWebhook", () => ({ handoffMonthlyMentorshipWebhook: async () => false }));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("@/lib/updatePostMetrics", () => ({ updatePostMetrics: jest.fn() }));

import { POST as onboard } from "@/app/api/stripe/connect/onboard/route";
import { GET as connectReturn } from "@/app/api/stripe/connect/return/route";
import { GET as status } from "@/app/api/stripe/connect/status/route";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
const request = () => new NextRequest("https://creatornet.example/api/stripe/connect/onboard", { method: "POST" });
const delivery = () => new NextRequest("https://creatornet.example/api/stripe/webhook", {
  method: "POST", headers: { "stripe-signature": "synthetic" }, body: "{}" });

beforeEach(() => {
  jest.clearAllMocks(); mockDb.ops.length = 0;
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  mockUser = { id: "creator_1", email: "first@example.invalid" };
  mockProfile = { id: "creator_1", stripe_account_id: "acct_existing", stripe_onboarding_complete: true,
    onboarding_complete: true, charges_enabled: true, payouts_enabled: true };
  mockAttempt = null; failProfileWrite = false; failAttemptWrite = false; failReserve = false; failProfileInsert = false;
  claimState = "empty"; claimToken = null;
  mockEvent = { id: "evt_connect", type: "account.updated", livemode: false, account: "acct_existing", data: { object: {
    id: "acct_existing", charges_enabled: true, payouts_enabled: true } } };
  mockRetrieve.mockReset().mockResolvedValue({ id: "acct_existing", charges_enabled: false, payouts_enabled: true });
  mockCreate.mockReset().mockResolvedValue({ id: "acct_created" });
  mockLinks.mockReset().mockResolvedValue({ url: "https://connect.stripe.com/setup/synthetic" });
});
afterEach(() => jest.restoreAllMocks());

test("capability persistence failure releases the real event claim; retry persists restrictions before completion", async () => {
  failProfileWrite = true;
  expect((await webhook(delivery())).status).toBe(500);
  expect(claimState).toBe("empty");
  expect(mockDb.opsFor("complete_stripe_event")).toHaveLength(0);
  expect(mockDb.opsFor("release_stripe_event")).toHaveLength(1);
  failProfileWrite = false;
  expect((await webhook(delivery())).status).toBe(200);
  expect(claimState).toBe("complete");
  expect(mockProfile).toMatchObject({ charges_enabled: false, payouts_enabled: true, stripe_onboarding_complete: false, onboarding_complete: false });
  expect(mockRetrieve).toHaveBeenCalledTimes(2); // Ignores the older enabled event payload on replay.
  expect((await webhook(delivery())).status).toBe(200);
  expect(mockRetrieve).toHaveBeenCalledTimes(2);
});

test("provider retrieval failure leaves capability event retryable", async () => {
  mockRetrieve.mockRejectedValueOnce(Error("synthetic Stripe failure"));
  expect((await webhook(delivery())).status).toBe(500);
  expect(claimState).toBe("empty");
  expect(mockDb.opsFor("profiles")).toHaveLength(0);
});

test.each([[false, true], [true, false], [false, false], [true, true]])(
  "status rechecks stored true and persists current charges=%s payouts=%s", async (charges, payouts) => {
    mockRetrieve.mockResolvedValue({ id: "acct_existing", charges_enabled: charges, payouts_enabled: payouts });
    const response = await status(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ charges_enabled: charges, payouts_enabled: payouts, onboarding_complete: charges && payouts });
    expect(mockProfile).toMatchObject({ charges_enabled: charges, payouts_enabled: payouts,
      stripe_onboarding_complete: charges && payouts, onboarding_complete: charges && payouts });
  },
);

test.each(["database", "Stripe"])("status cannot return stale readiness after %s failure", async fault => {
  if (fault === "database") failProfileWrite = true;
  else mockRetrieve.mockRejectedValueOnce(Error("synthetic Stripe failure"));
  const response = await status(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ charges_enabled: false, payouts_enabled: false, onboarding_complete: false });
});

test("existing linked account bypasses creation/reservation and preserves capability flags", async () => {
  failReserve = true;
  expect((await onboard(request())).status).toBe(200);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDb.opsFor("stripe_connect_account_creations")).toHaveLength(0);
  expect(mockLinks).toHaveBeenCalledWith(expect.objectContaining({ account: "acct_existing" }));
  expect(mockProfile?.stripe_onboarding_complete).toBe(true);
});

test("concurrent first onboarding shares one provider creation and never overwrites the winning link", async () => {
  mockProfile = null;
  const providerObjects = new Map<string, string>();
  mockCreate.mockImplementation(async (_params: unknown, options: { idempotencyKey: string }) => {
    if (!providerObjects.has(options.idempotencyKey)) providerObjects.set(options.idempotencyKey, "acct_created");
    await Promise.resolve();
    return { id: providerObjects.get(options.idempotencyKey) };
  });
  const responses = await Promise.all([onboard(request()), onboard(request())]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(providerObjects.size).toBe(1);
  expect(mockCreate).toHaveBeenCalledTimes(2);
  expect(mockCreate.mock.calls[0]).toEqual(mockCreate.mock.calls[1]);
  expect(mockProfile).toMatchObject({ stripe_account_id: "acct_created" });
  expect(mockLinks.mock.calls.every(([params]) => params.account === "acct_created")).toBe(true);
});

test("provider creation followed by profile persistence failure recovers the recorded account even after 24 hours", async () => {
  mockProfile!.stripe_account_id = null; failProfileWrite = true;
  expect((await onboard(request())).status).toBe(500);
  expect(mockLinks).not.toHaveBeenCalled();
  expect(mockAttempt).toMatchObject({ stripe_account_id: "acct_created" });
  failProfileWrite = false;
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 48 * 60 * 60 * 1000);
  expect((await onboard(request())).status).toBe(200);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockProfile?.stripe_account_id).toBe("acct_created");
});

test("failure to record the provider result retries the identical key and frozen email", async () => {
  mockProfile!.stripe_account_id = null; failAttemptWrite = true;
  expect((await onboard(request())).status).toBe(500);
  expect(mockProfile?.stripe_account_id).toBeNull();
  mockUser!.email = "changed@example.invalid"; failAttemptWrite = false;
  expect((await onboard(request())).status).toBe(200);
  expect(mockCreate).toHaveBeenCalledTimes(2);
  expect(mockCreate.mock.calls[1]).toEqual(mockCreate.mock.calls[0]);
  expect(mockCreate.mock.calls[1][0].email).toBe("first@example.invalid");
});

test("an ambiguous provider result beyond the safe retry window cannot create another account", async () => {
  mockProfile!.stripe_account_id = null;
  mockCreate.mockRejectedValueOnce(Error("response lost"));
  expect((await onboard(request())).status).toBe(500);
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
  const response = await onboard(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "CONNECT_ACCOUNT_RECONCILIATION_REQUIRED" });
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockLinks).not.toHaveBeenCalled();
});

test.each(["reservation", "profile"])("%s storage failure precedes provider creation", async fault => {
  mockProfile = null;
  failReserve = fault === "reservation"; failProfileInsert = fault === "profile";
  expect((await onboard(request())).status).toBe(500);
  expect(mockCreate).not.toHaveBeenCalled(); expect(mockLinks).not.toHaveBeenCalled();
});

test("a link installed while creation is in flight remains authoritative", async () => {
  mockProfile!.stripe_account_id = null;
  mockCreate.mockImplementationOnce(async () => {
    mockProfile!.stripe_account_id = "acct_existing";
    return { id: "acct_created" };
  });
  expect((await onboard(request())).status).toBe(200);
  expect(mockProfile?.stripe_account_id).toBe("acct_existing");
  expect(mockProfile?.stripe_onboarding_complete).toBe(true);
  expect(mockLinks).toHaveBeenCalledWith(expect.objectContaining({ account: "acct_existing" }));
});

test("unauthenticated requests cannot reserve, create, or read another creator's account", async () => {
  mockUser = null;
  expect((await onboard(request())).status).toBe(401);
  expect((await status(request())).status).toBe(401);
  expect(mockDb.ops).toHaveLength(0); expect(mockCreate).not.toHaveBeenCalled(); expect(mockRetrieve).not.toHaveBeenCalled();
});


describe("Connect return synchronization", () => {
  test.each(["database", "binding changed", "unexpected account"])("never reports success after %s", async fault => {
    if (fault === "database") failProfileWrite = true;
    mockRetrieve.mockImplementationOnce(async () => {
      if (fault === "binding changed") mockProfile!.stripe_account_id = "acct_relinked";
      return { id: fault === "unexpected account" ? "acct_wrong" : "acct_existing", charges_enabled: true, payouts_enabled: true };
    });
    const response = await connectReturn(request());
    expect(response.headers.get("location")).toBe("https://creatornet.example/dashboard?connect=error");
    if (fault === "binding changed") expect(mockProfile?.stripe_account_id).toBe("acct_relinked");
    if (fault === "unexpected account") expect(mockDb.opsFor("profiles").filter(op => op.kind === "update")).toHaveLength(0);
  });
  test.each([[true, true, "success"], [false, true, "pending"], [true, false, "pending"]])(
    "only reports %s/%s after persisting capabilities", async (charges, payouts, expected) => {
      mockRetrieve.mockResolvedValue({ id: "acct_existing", charges_enabled: charges, payouts_enabled: payouts });
      const response = await connectReturn(request());
      expect(response.headers.get("location")).toBe("https://creatornet.example/dashboard?connect=" + expected);
      expect(mockProfile).toMatchObject({ charges_enabled: charges, payouts_enabled: payouts, onboarding_complete: charges && payouts });
    });
});
