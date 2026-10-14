process.env.CREATOR_TIPPING_ENABLED = "true";
process.env.NEXT_PUBLIC_SITE_URL = "https://creatornet.net";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.CREATOR_PROCESSING_FEE_ENABLED = "false";

import { NextRequest } from "next/server";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";

const tipperId = "11111111-1111-4111-8111-111111111111";
const creatorId = "22222222-2222-4222-8222-222222222222";
const postId = "33333333-3333-4333-8333-333333333333";
const requestKey = "44444444-4444-4444-8444-444444444444";
const sessionCreate = jest.fn();
const sessionRetrieve = jest.fn();
const sessionExpire = jest.fn();
const accountRetrieve = jest.fn();
let db: MockClient;
let postPatch: Record<string, unknown> = {};
let creatorPatch: Record<string, unknown> = {};
let savedTip: Record<string, unknown> | null = null;

jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (table: string) => db.from(table),
    rpc: (name: string, args: unknown) => db.rpc(name, args),
  },
}));
jest.mock("@/lib/supabaseConnectAuth", () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({ id: tipperId, email: "viewer@example.test" }),
}));
jest.mock("@/lib/rateLimit", () => ({
  allowRequest: () => true,
  clientKey: () => "test-ip",
  tooManyRequests: () => { throw new Error("Unexpected rate limit in contract test."); },
}));
jest.mock("@/lib/stripeClient", () => ({
  getStripe: () => ({
    accounts: { retrieve: accountRetrieve },
    checkout: { sessions: { create: sessionCreate, retrieve: sessionRetrieve, expire: sessionExpire } },
  }),
}));

import { POST } from "@/app/api/tips/checkout/route";

function request(amountCents: unknown, key = requestKey) {
  return new NextRequest("https://creatornet.net/api/tips/checkout", {
    method: "POST",
    headers: { host: "creatornet.net", origin: "https://creatornet.net", "content-type": "application/json" },
    body: JSON.stringify({ postId, amountCents, requestKey: key }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CREATOR_PROCESSING_FEE_ENABLED = "false";
  postPatch = {}; creatorPatch = {}; savedTip = null;
  accountRetrieve.mockResolvedValue({ charges_enabled: true, payouts_enabled: true });
  sessionCreate.mockResolvedValue({ id: "cs_test_tip", client_secret: "cs_test_secret", status: "open" });
  sessionRetrieve.mockResolvedValue({ id: "cs_test_tip", client_secret: "cs_test_secret", status: "open" });
  sessionExpire.mockResolvedValue({ id: "cs_test_tip", status: "expired" });
  db = createMockClient((op: Op) => {
    if (op.table === "posts" && op.kind === "select") return { data: {
      id: postId, video_url: "https://media.example.test/lesson.mp4", creator_id: creatorId, product_id: null, offering_id: null, premium_path: null,
      price_cents: null, allow_booking: false, booking_url: null, cta_type: null,
      fulfillment_url: null, display_price: null, booking_url_override: null,
      tips_enabled: true, active: true, hidden_at: null, removed_at: null, ...postPatch,
    }, error: null };
    if (op.table === "profiles" && op.kind === "select") return { data: {
      id: creatorId, username: "creator", banned_at: null,
      stripe_account_id: "acct_destination", stripe_onboarding_complete: true, ...creatorPatch,
    }, error: null };
    if (op.table === "tips" && op.kind === "select") {
      if (op.columns === "*" && op.filters.client_request_key) return { data: savedTip, error: null };
      return { data: null, error: null };
    }
    if (op.table === "create_or_get_video_tip") {
      if (!savedTip) {
        const p = op.payload as Record<string, unknown>;
        savedTip = {
          id: p.p_id, tipper_id: p.p_tipper_id, creator_id: p.p_creator_id,
          post_id: p.p_post_id, client_request_key: p.p_client_request_key,
          terms_fingerprint: p.p_terms_fingerprint,
          gross_amount_cents: p.p_gross_amount_cents, platform_fee_cents: p.p_platform_fee_cents,
          processing_fee_cents: p.p_processing_fee_cents,
          total_creator_deduction_cents: p.p_total_creator_deduction_cents,
          creator_net_cents: p.p_creator_net_cents,
          processing_fee_enabled: p.p_processing_fee_enabled,
          processing_fee_basis_points: p.p_processing_fee_basis_points,
          processing_fee_fixed_cents: p.p_processing_fee_fixed_cents,
          fee_schedule_version: p.p_fee_schedule_version, currency: p.p_currency,
          status: "creating", stripe_destination_account_id: p.p_destination_account_id,
          stripe_checkout_params: p.p_checkout_params,
          stripe_checkout_session_id: null,
        };
      }
      return { data: savedTip, error: null };
    }
    if (op.table === "bind_video_tip_checkout") {
      if (savedTip) savedTip.stripe_checkout_session_id = "cs_test_tip";
      return { data: true, error: null };
    }
    return { data: null, error: null };
  });
});

test.each([500, 1000, 2000, 50000])("creates an exact destination-charge Checkout Session for %i cents", async (amount) => {
  const response = await POST(request(amount));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ tipId: expect.any(String), clientSecret: "cs_test_secret" });
  const [params, options] = sessionCreate.mock.calls[0];
  expect(params).toMatchObject({
    mode: "payment", ui_mode: "custom", client_reference_id: body.tipId,
    line_items: [{ price_data: { currency: "usd", unit_amount: amount }, quantity: 1 }],
    payment_intent_data: {
      application_fee_amount: Math.round(amount * 0.12),
      transfer_data: { destination: "acct_destination" },
      metadata: { payment_kind: "video_tip", tip_id: body.tipId, tipper_id: tipperId,
        creator_id: creatorId, post_id: postId },
    },
    metadata: { payment_kind: "video_tip", tip_id: body.tipId },
    return_url: `https://creatornet.net/dashboard?postId=${postId}&tipId=${body.tipId}`,
  });
  expect(options).toEqual({ idempotencyKey: `creatornet-video-tip:${body.tipId}` });
  expect(params.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 30 * 60);
  expect(params.expires_at).toBeLessThan(Math.floor(Date.now() / 1000) + 32 * 60);
});

test.each([499, 50001, 5.5, "500", null, Number.MAX_SAFE_INTEGER + 1])("rejects invalid amount %s", async (amount) => {
  const response = await POST(request(amount));
  expect(response.status).toBe(400);
  expect(sessionCreate).not.toHaveBeenCalled();
});

test("uses the trusted Vercel deployment host for Preview return URLs", async () => {
  const previousSite = process.env.NEXT_PUBLIC_SITE_URL;
  const previousBase = process.env.NEXT_PUBLIC_BASE_URL;
  const previousVercel = process.env.VERCEL_URL;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  process.env.VERCEL_URL = "creatornet-preview.vercel.app";
  try {
    const response = await POST(request(500));
    expect(response.status).toBe(200);
    const [params] = sessionCreate.mock.calls[0];
    expect(params.return_url).toMatch(/^https:\/\/creatornet-preview\.vercel\.app\/dashboard\?postId=/);
  } finally {
    if (previousSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previousSite;
    if (previousBase === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = previousBase;
    if (previousVercel === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = previousVercel;
  }
});

test("reuses one request key and Stripe Session without creating a second charge", async () => {
  const first = await POST(request(1000));
  process.env.CREATOR_PROCESSING_FEE_ENABLED = "true";
  process.env.STRIPE_PROCESSING_FEE_BPS = "290";
  process.env.STRIPE_PROCESSING_FEE_FIXED_CENTS = "30";
  process.env.STRIPE_PROCESSING_FEE_SCHEDULE_VERSION = "changed-fee-v2";
  const second = await POST(request(1000));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual(await first.json());
  expect(sessionCreate).toHaveBeenCalledTimes(1);
  expect(sessionRetrieve).toHaveBeenCalledWith("cs_test_tip");
});

test("retries an uncertain Stripe create with the original frozen parameters", async () => {
  const originalOrigin = process.env.NEXT_PUBLIC_SITE_URL;
  const now = jest.spyOn(Date, "now");
  now.mockReturnValue(1_800_000_000_000);
  sessionCreate.mockRejectedValueOnce(new Error("provider response lost"));
  try {
    expect((await POST(request(1000))).status).toBe(500);
    const [originalParams, originalOptions] = sessionCreate.mock.calls[0];
    now.mockReturnValue(1_800_000_120_000);
    process.env.NEXT_PUBLIC_SITE_URL = "https://new-preview.example.test";
    creatorPatch = { username: "renamed-creator" };
    expect((await POST(request(1000))).status).toBe(200);
    const [retryParams, retryOptions] = sessionCreate.mock.calls[1];
    expect(retryParams).toEqual(originalParams);
    expect(retryOptions).toEqual(originalOptions);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
    if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = originalOrigin;
  }
});

test.each([
  ["self-tip", { creator_id: tipperId }, {}, 403],
  ["paid post", { product_id: "55555555-5555-4555-8555-555555555555" }, {}, 409],
  ["post without video", { video_url: null }, {}, 409],
  ["disabled post", { tips_enabled: false }, {}, 409],
  ["hidden post", { hidden_at: "2026-09-24T00:00:00Z" }, {}, 404],
  ["banned creator", {}, { banned_at: "2026-09-24T00:00:00Z" }, 403],
])("rejects %s", async (_label, post, creator, status) => {
  postPatch = post; creatorPatch = creator;
  const response = await POST(request(500));
  expect(response.status).toBe(status);
  expect(sessionCreate).not.toHaveBeenCalled();
});

test("rejects a restricted Connect account", async () => {
  accountRetrieve.mockResolvedValue({ charges_enabled: false, payouts_enabled: true });
  const response = await POST(request(500));
  expect(response.status).toBe(409);
  expect(sessionCreate).not.toHaveBeenCalled();
});

test("expires a Session when tips are disabled during creation", async () => {
  sessionCreate.mockImplementation(async () => {
    postPatch = { tips_enabled: false };
    return { id: "cs_test_tip", client_secret: "cs_test_secret", status: "open" };
  });
  const response = await POST(request(500));
  expect(response.status).toBe(409);
  expect(sessionExpire).toHaveBeenCalledWith("cs_test_tip");
  expect(db.opsFor("tips").some((op) => op.kind === "update" &&
    (op.payload as { status?: string }).status === "canceled")).toBe(true);
});

test("keeps the 12% platform fee separate from creator-funded processing", async () => {
  process.env.CREATOR_PROCESSING_FEE_ENABLED = "true";
  process.env.STRIPE_PROCESSING_FEE_BPS = "290";
  process.env.STRIPE_PROCESSING_FEE_FIXED_CENTS = "30";
  process.env.STRIPE_PROCESSING_FEE_SCHEDULE_VERSION = "test-us-card-v1";
  const response = await POST(request(500));
  expect(response.status).toBe(200);
  const params = sessionCreate.mock.calls[0][0];
  expect(params.payment_intent_data.application_fee_amount).toBe(105);
  expect(params.metadata).toMatchObject({
    platform_fee_cents: "60", processing_fee_cents: "45",
  });
});
