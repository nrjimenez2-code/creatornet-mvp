/** @jest-environment node */
import { NextRequest } from "next/server";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";
import { membershipTestContext as context } from "../test-support/membership-fixtures";

let ready = true, recovery = true, user: { id: string } | null;
const auth = jest.fn(async () => user), owned = jest.fn(), accept = jest.fn(), select = jest.fn();
const prepare = jest.fn(), confirm = jest.fn(), capture = jest.fn(), stop = jest.fn(), authenticate = jest.fn();
const resolve = jest.fn();
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => auth() }));
jest.mock("@/lib/membershipManualBuyer", () => ({ membershipManualBuyerReady: () => ready,
  membershipManualPayoffRecoveryReady: () => recovery,
  membershipManualBuyerRecoveryReady: () => recovery }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({
  readOwnedManualPayoff: owned, acceptPayoff: accept, selectManualPayoff: select,
  prepareManualPayoffIntent: prepare, confirmManualPayoffIntent: confirm,
  recordManualPayoffCapture: capture, releaseManualPayoff: stop,
  authenticateManualPayoffIntent: authenticate, resolveManualPaymentReturn: resolve,
}) }));
import { GET, POST } from "@/app/api/memberships/[membershipId]/manual-payoff/route";
import { GET as resolveReturn } from "@/app/api/memberships/manual/resolve/route";

const f = membershipPayoffFixture(false), membershipId = f.a.id, buyerId = f.a.buyer_id;
const selectionId = "40000000-0000-4000-8000-000000000011";
const scope = { params: Promise.resolve({ membershipId }) };
const req = (body: unknown, origin = context.siteOrigin) => new NextRequest(
  context.siteOrigin + `/api/memberships/${membershipId}/manual-payoff`,
  { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const saved = { membershipId, selectionId, buyerId, productId: f.a.product_id,
  title: f.a.terms.title, amountCents: f.p.terms.amountCents, currency: "usd",
  payoffId: f.p.id, status: "accepted", terms: f.p.terms, fingerprint: f.p.fingerprint,
  acceptanceExpiresAt: Math.floor(Date.now() / 1000) + 3600, manualAvailable: true };

beforeEach(() => {
  jest.clearAllMocks(); ready = true; recovery = true; user = { id: buyerId };
  owned.mockResolvedValue(saved);
  accept.mockResolvedValue({ payoff: { id: f.p.id } });
  select.mockResolvedValue({ selectionId });
  prepare.mockResolvedValue({ status: "bound_unpublished" });
  confirm.mockResolvedValue({ status: "observed", operationId: selectionId,
    observation: { status: "requires_action", failure: null } });
  stop.mockResolvedValue({ status: "abandoned", originalMonthlyPaymentsMayResume: true });
  resolve.mockResolvedValue({ membershipId, selectionId, kind: "payoff" });
});

test("owner readback keeps exact payoff and disables new admission while paused", async () => {
  const url = context.siteOrigin + `/api/memberships/${membershipId}/manual-payoff`;
  expect(await (await GET(new NextRequest(url), scope)).json()).toMatchObject({
    selectionId, amountCents: saved.amountCents, newPaymentAllowed: true });
  ready = false;
  expect(await (await GET(new NextRequest(url), scope)).json()).toMatchObject({
    selectionId, newPaymentAllowed: false, acceptanceAllowed: false });
  expect((await POST(req({ kind: "prepare" }), scope)).status).toBe(409);
  expect(prepare).not.toHaveBeenCalled();
  expect((await POST(req({ kind: "observe" }), scope)).status).toBe(200);
});

test("separate exact consent selects the server accepted payoff before any intent", async () => {
  owned.mockResolvedValueOnce({ ...saved, selectionId: null, status: "quoted",
    payoffId: null, acceptanceExpiresAt: null });
  const consent = { accepted: true, version: f.p.terms.version, fingerprint: f.p.fingerprint };
  const response = await POST(req({ kind: "accept", consent }), scope);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "payoff_selected", selectionId });
  expect(accept).toHaveBeenCalledWith(membershipId, buyerId, consent);
  expect(select).toHaveBeenCalledWith(membershipId, buyerId, f.p.id);
  expect(prepare).not.toHaveBeenCalled();
});

test("hosted or uncertain payoff cannot switch to a new manual intent", async () => {
  owned.mockResolvedValueOnce({ ...saved, selectionId: null, manualAvailable: false });
  const response = await POST(req({ kind: "accept", consent: {
    accepted: true, version: f.p.terms.version, fingerprint: f.p.fingerprint } }), scope);
  expect(response.status).toBe(409);
  expect(accept).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});

test("prepare, original observation and capture never take a browser amount or intent ID", async () => {
  const prepared = await POST(req({ kind: "prepare" }), scope);
  expect(await prepared.json()).toMatchObject({ requestId: membershipId,
    status: "payment_prepared", amountCents: saved.amountCents });
  expect(prepare).toHaveBeenCalledWith(membershipId, buyerId, selectionId);
  confirm.mockResolvedValueOnce({ status: "observed", operationId: selectionId,
    observation: { status: "succeeded" } });
  owned.mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, status: "captured" });
  const captured = await POST(req({ kind: "observe" }), scope);
  expect(await captured.json()).toMatchObject({ status: "payment_accounted" });
  expect(capture).toHaveBeenCalledWith(membershipId, buyerId, selectionId);
  expect((await POST(req({ kind: "card", paymentMethodId: "pm_ok", amountCents: 1 }), scope)).status).toBe(400);
});

test("stop needs explicit buyer confirmation and keeps an unbound original held", async () => {
  expect((await POST(req({ kind: "stop" }), scope)).status).toBe(400);
  expect(stop).not.toHaveBeenCalled();
  stop.mockResolvedValueOnce({ status: "reconciliation_required", releaseAllowed: false });
  expect((await POST(req({ kind: "stop", confirmed: true }), scope)).status).toBe(409);
  expect((await POST(req({ kind: "stop", confirmed: true }), scope)).status).toBe(200);
  expect(stop).toHaveBeenCalledWith(membershipId, buyerId, selectionId, true);
});

test("bank return maps the owned payoff attempt without confirming or crediting it", async () => {
  const url = context.siteOrigin + `/api/memberships/manual/resolve?attempt_id=${selectionId}`;
  const response = await resolveReturn(new NextRequest(url));
  expect(await response.json()).toEqual({ membershipId, selectionId, kind: "payoff" });
  expect(confirm).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  expect((await resolveReturn(new NextRequest(url + "&payment_intent=pi_other"))).status).toBe(400);
});

test("authentication and route boundaries are owner scoped", async () => {
  authenticate.mockResolvedValueOnce({ status: "authentication_required", operationId: selectionId,
    clientSecret: "pi_secret_fixture" });
  expect((await POST(req({ kind: "authenticate", operationId: selectionId }), scope)).status).toBe(200);
  expect(authenticate).toHaveBeenCalledWith(membershipId, buyerId, selectionId, selectionId);
  expect((await POST(req({ kind: "prepare" }, "https://other.invalid"), scope)).status).toBe(403);
  user = null;
  expect((await POST(req({ kind: "prepare" }), scope)).status).toBe(401);
  expect((await GET(new NextRequest(context.siteOrigin + `/api/memberships/${membershipId}/manual-payoff`), scope)).status).toBe(401);
});
