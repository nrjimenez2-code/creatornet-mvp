import { NextRequest } from "next/server";
import { membershipFixture, membershipTestContext as context } from "../test-support/membership-fixtures";

let enabled = true, recoveryEnabled = true, user: { id: string } | null;
const auth = jest.fn(async () => user);
const accept = jest.fn(), select = jest.fn(), owned = jest.fn(), prepare = jest.fn(), confirm = jest.fn();
const authenticate = jest.fn(), capture = jest.fn(), close = jest.fn(), resolve = jest.fn();
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => auth() }));
jest.mock("@/lib/membershipManualBuyer", () => ({ membershipManualBuyerReady: () => enabled,
  membershipManualBuyerRecoveryReady: () => recoveryEnabled }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({
  accept, selectManualFirst: select, readOwnedManualFirst: owned,
  prepareManualFirstIntent: prepare, confirmManualFirstIntent: confirm,
  authenticateManualFirstIntent: authenticate, recordManualFirstCapture: capture, closeManualFirst: close,
  resolveManualPaymentReturn: resolve,
}) }));
import { POST as start } from "@/app/api/memberships/manual/route";
import { GET, POST } from "@/app/api/memberships/[membershipId]/manual/route";
import { POST as hostedCheckout } from "@/app/api/memberships/checkout/route";
import { GET as resolveReturn } from "@/app/api/memberships/manual/resolve/route";

const f = membershipFixture(false), membershipId = f.a.id, buyerId = f.a.buyer_id;
const selectionId = "16000000-0000-4000-8000-000000000099";
const scope = { params: Promise.resolve({ membershipId }) };
const req = (path: string, body: unknown, origin = context.siteOrigin) => new NextRequest(context.siteOrigin + path,
  { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const startReq = (body: unknown, origin = context.siteOrigin) => req("/api/memberships/manual", body, origin);
const actionReq = (body: unknown, origin = context.siteOrigin) => req(`/api/memberships/${membershipId}/manual`, body, origin);
const saved = { membershipId, selectionId, buyerId, productId: f.a.product_id, title: f.a.terms.title,
  amountCents: f.a.monthly_price_cents, currency: "usd", firstPaymentRecorded: false,
  initialAbandoned: false, initialAbandonedAt: null, initialAbandonRequested: false,
  acceptanceExpiresAt: Math.floor(Date.now() / 1000) + 3600 };

beforeEach(() => {
  jest.clearAllMocks(); enabled = true; recoveryEnabled = true; user = { id: buyerId };
  accept.mockResolvedValue({ membershipId }); select.mockResolvedValue({ membershipId, selectionId });
  owned.mockResolvedValue(saved); prepare.mockResolvedValue({ status: "bound_unpublished" });
  confirm.mockResolvedValue({ status: "observed", operationId: selectionId,
    observation: { status: "requires_action", failure: null } });
  capture.mockResolvedValue({ summary: { firstPaymentRecorded: true } });
  close.mockResolvedValue({ status: "abandoned" });
  resolve.mockResolvedValue({ membershipId, selectionId, kind: "first" });
});

test("acceptance returns the saved agreement before manual selection or provider preparation", async () => {
  const consent = { accepted: true, version: f.a.terms.version, fingerprint: f.a.fingerprint };
  const response = await start(startReq({ action: "accept", product_id: f.a.product_id, post_id: f.a.post_id, consent }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ membershipId });
  expect(accept).toHaveBeenCalledWith(buyerId, f.a.product_id, f.a.post_id, consent);
  expect(select).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("selection takes only an owned agreement ID, and preparation resolves its saved source", async () => {
  expect((await start(startReq({ action: "select", membership_id: membershipId }))).status).toBe(200);
  expect(select).toHaveBeenCalledWith(membershipId, buyerId);
  const result = await POST(actionReq({ kind: "prepare" }), scope);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ requestId: membershipId, status: "payment_prepared", amountCents: f.a.monthly_price_cents });
  expect(owned).toHaveBeenCalledWith(membershipId, buyerId);
  expect(prepare).toHaveBeenCalledWith(membershipId, buyerId, selectionId);
});

test("only the original owned confirmation can be observed and accounted", async () => {
  confirm.mockResolvedValueOnce({ status: "observed", operationId: selectionId, observation: { status: "succeeded" } });
  const response = await POST(actionReq({ kind: "observe" }), scope);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ requestId: membershipId, status: "payment_accounted" });
  expect(confirm).toHaveBeenCalledWith(membershipId, buyerId, selectionId, { kind: "observe" });
  expect(capture).toHaveBeenCalledWith(membershipId, buyerId, selectionId);
});

test("stop closes only the saved selection and returns a dated release", async () => {
  owned.mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, initialAbandoned: true,
    initialAbandonedAt: "2026-09-25T12:00:00.000Z" });
  const response = await POST(actionReq({ kind: "stop" }), scope);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "released", releasedAt: "2026-09-25T12:00:00.000Z" });
  expect(close).toHaveBeenCalledWith(membershipId, buyerId, selectionId, true);
  expect(prepare).not.toHaveBeenCalled();
});

test("saved details and bank capability are private to the authenticated buyer", async () => {
  expect((await GET(new NextRequest(context.siteOrigin + `/api/memberships/${membershipId}/manual`), scope)).status).toBe(200);
  authenticate.mockResolvedValueOnce({ status: "authentication_required", operationId: selectionId,
    clientSecret: "pi_secret_fixture", paymentIntentId: "pi_fixture" });
  expect((await POST(actionReq({ kind: "authenticate", operationId: selectionId }), scope)).status).toBe(200);
  expect(authenticate).toHaveBeenCalledWith(membershipId, buyerId, selectionId, selectionId);
  user = null;
  expect((await POST(actionReq({ kind: "prepare" }), scope)).status).toBe(401);
  expect(prepare).not.toHaveBeenCalled();
});

test.each([{ kind: "prepare", buyer_id: "other" }, { kind: "card", paymentMethodId: "pm_ok", amountCents: 1 },
  { kind: "token", tokenId: "ctoken_fixture" }, { kind: "stop", confirmed: false }])(
  "overriding or unsupported action %p is refused before payment dispatch", async body => {
    expect((await POST(actionReq(body), scope)).status).toBe(400);
    expect(prepare).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });

test("cross-origin, disabled and uncertain requests fail without payment authority", async () => {
  expect((await start(startReq({ action: "select", membership_id: membershipId }, "https://other.invalid"))).status).toBe(403);
  expect((await POST(actionReq({ kind: "prepare" }, "https://other.invalid"), scope)).status).toBe(403);
  auth.mockClear();
  recoveryEnabled = false;
  expect((await POST(actionReq({ kind: "prepare" }), scope)).status).toBe(409);
  expect(auth).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  recoveryEnabled = true;
  enabled = true; prepare.mockResolvedValueOnce({ status: "original_reply_unknown" });
  expect((await POST(actionReq({ kind: "prepare" }), scope)).status).toBe(409);
});

test("pausing new admission preserves owner readback and an original observation", async () => {
  enabled = false;
  const details = await GET(new NextRequest(context.siteOrigin + `/api/memberships/${membershipId}/manual`), scope);
  expect(details.status).toBe(200);
  expect(await details.json()).toMatchObject({ membershipId, newPaymentAllowed: false });
  expect((await POST(actionReq({ kind: "prepare" }), scope)).status).toBe(409);
  expect(prepare).not.toHaveBeenCalled();
  expect((await POST(actionReq({ kind: "observe" }), scope)).status).toBe(200);
  expect(confirm).toHaveBeenCalledWith(membershipId, buyerId, selectionId, { kind: "observe" });
});

test("expired acceptance remains readable without offering a new payment action", async () => {
  owned.mockResolvedValueOnce({ ...saved, acceptanceExpiresAt: Math.floor(Date.now() / 1000) - 1 });
  const result = await GET(new NextRequest(context.siteOrigin + `/api/memberships/${membershipId}/manual`), scope);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ membershipId, newPaymentAllowed: false });
});

test("enabling the manual buyer path blocks new hosted Checkout admission", async () => {
  const prior = process.env.CREATOR_MONTHLY_MANUAL_BUYER_READY;
  process.env.CREATOR_MONTHLY_MANUAL_BUYER_READY = "true";
  try {
    const result = await hostedCheckout(req("/api/memberships/checkout", {}));
    expect(result.status).toBe(409);
    expect(auth).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
  } finally {
    if (prior === undefined) delete process.env.CREATOR_MONTHLY_MANUAL_BUYER_READY;
    else process.env.CREATOR_MONTHLY_MANUAL_BUYER_READY = prior;
  }
});

test("bank return resolves only the authenticated original selection and never confirms payment", async () => {
  const url = context.siteOrigin + `/api/memberships/manual/resolve?attempt_id=${selectionId}`;
  const result = await resolveReturn(new NextRequest(url));
  expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(await result.json()).toEqual({ membershipId, selectionId, kind: "first" });
  expect(resolve).toHaveBeenCalledWith(selectionId, buyerId);
  expect(confirm).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  expect((await resolveReturn(new NextRequest(url + "&payment_intent=pi_other"))).status).toBe(400);
  user = null;
  expect((await resolveReturn(new NextRequest(url))).status).toBe(401);
});
