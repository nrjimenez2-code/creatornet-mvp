import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { membershipManualBuyerReady, membershipManualPayoffRecoveryReady } from "@/lib/membershipManualBuyer";
import { parseManualPaymentAction } from "@/lib/manualPaymentAction";
import { createMembershipRuntime } from "@/lib/membershipRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization", "Referrer-Policy": "no-referrer" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
type Route = { params: Promise<{ membershipId: string }> };

export async function GET(req: NextRequest, route: Route) {
  if (!membershipManualPayoffRecoveryReady()) return json({ error: "Monthly payoff recovery is unavailable." }, 409);
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: "Sign in to review your payoff." }, 401);
  try {
    if (req.nextUrl.searchParams.size) return json({ error: "Invalid original payoff." }, 400);
    const { membershipId } = await route.params; assertMembershipId(membershipId);
    const owned = await createMembershipRuntime().readOwnedManualPayoff(membershipId, user.id);
    return json({ ...owned, newPaymentAllowed: membershipManualBuyerReady() &&
      owned.status === "accepted" && Boolean(owned.selectionId) &&
      owned.acceptanceExpiresAt !== null && Math.floor(Date.now() / 1000) < owned.acceptanceExpiresAt,
      acceptanceAllowed: membershipManualBuyerReady() && owned.manualAvailable &&
        (owned.status === "quoted" || owned.status === "accepted" && !owned.selectionId &&
          owned.acceptanceExpiresAt !== null && Math.floor(Date.now() / 1000) < owned.acceptanceExpiresAt) });
  } catch { return json({ error: "Your original payoff needs review." }, 409); }
}

/** The browser supplies only consent or action intent. The owner, amount,
 * accepted payoff and original intent are loaded from saved server state. */
export async function POST(req: NextRequest, route: Route) {
  if (!membershipManualPayoffRecoveryReady()) return json({ error: "Monthly payoff recovery is unavailable." }, 409);
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: "Sign in to continue your payoff." }, 401);
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin)
      return json({ error: "Invalid request origin." }, 403);
    const { membershipId } = await route.params; assertMembershipId(membershipId);
    if (req.nextUrl.searchParams.size || req.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      return json({ error: "Invalid original payoff action." }, 400);
    const raw = await req.text();
    if (raw.length > 2048) return json({ error: "Invalid original payoff action." }, 400);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); if (!body || typeof body !== "object" || Array.isArray(body)) throw Error(); }
    catch { return json({ error: "Invalid original payoff action." }, 400); }
    const api = createMembershipRuntime();
    if (body.kind === "accept") {
      if (!membershipManualBuyerReady()) return json({ error: "New payoff acceptance is paused." }, 409);
      if (Object.keys(body).sort().join(",") !== "consent,kind") return json({ error: "Invalid payoff acceptance." }, 400);
      const consent = body.consent as Record<string, unknown> | null;
      if (!consent || typeof consent !== "object" || Array.isArray(consent) ||
        Object.keys(consent).sort().join(",") !== "accepted,fingerprint,version" ||
        consent.accepted !== true || typeof consent.version !== "string" ||
        typeof consent.fingerprint !== "string") return json({ error: "Invalid payoff acceptance." }, 400);
      const current = await api.readOwnedManualPayoff(membershipId, user.id);
      if (current.selectionId) return json({ requestId: membershipId, status: "payoff_selected",
        selectionId: current.selectionId, payoffId: current.payoffId });
      if (!current.manualAvailable || !["quoted", "accepted"].includes(current.status) ||
        current.acceptanceExpiresAt !== null && Math.floor(Date.now() / 1000) >= current.acceptanceExpiresAt)
        return json({ error: "The existing payoff requires original-payment recovery." }, 409);
      const accepted = await api.acceptPayoff(membershipId, user.id,
        consent as { accepted: true; version: string; fingerprint: string });
      const selected = await api.selectManualPayoff(membershipId, user.id, accepted.payoff.id);
      return json({ requestId: membershipId, status: "payoff_selected",
        selectionId: selected.selectionId, payoffId: accepted.payoff.id });
    }
    if (body.kind === "stop") {
      if (Object.keys(body).sort().join(",") !== "confirmed,kind" || body.confirmed !== true)
        return json({ error: "Explicit payoff stop confirmation required." }, 400);
    }
    let action: ReturnType<typeof parseManualPaymentAction>;
    try { action = parseManualPaymentAction(body.kind === "stop" ? { kind: "stop" } : body); }
    catch { return json({ error: "Invalid original payoff action." }, 400); }
    if (action.kind === "token" || action.kind === "replacement")
      return json({ error: "Use the original card payment form." }, 400);
    if (["prepare", "card", "card_replacement"].includes(action.kind) && !membershipManualBuyerReady())
      return json({ error: "New payoff card actions are paused. Check the original status." }, 409);
    const owned = await api.readOwnedManualPayoff(membershipId, user.id);
    if (!owned.selectionId) return json({ error: "Accept the exact payoff before card payment." }, 409);
    if (owned.status === "captured") return json({ requestId: membershipId, status: "payment_accounted" });
    if (owned.status === "abandoned") return json({ requestId: membershipId, status: "abandoned" });
    if (owned.status !== "accepted") throw Error();
    if (action.kind === "stop") {
      const closed = await api.releaseManualPayoff(membershipId, user.id, owned.selectionId, true);
      if (closed.status === "already_paid") return json({ requestId: membershipId, status: "payment_accounted" });
      if (closed.status !== "abandoned") return json({ requestId: membershipId,
        status: "reconciliation_required", accessGranted: false }, 409);
      return json({ requestId: membershipId, status: "abandoned",
        originalMonthlyPaymentsMayResume: closed.originalMonthlyPaymentsMayResume });
    }
    if (action.kind === "prepare") {
      const prepared = await api.prepareManualPayoffIntent(membershipId, user.id, owned.selectionId);
      return prepared.status === "bound_unpublished" ? json({ requestId: membershipId,
        status: "payment_prepared", amountCents: owned.amountCents, currency: "usd",
        accessGranted: false }) : json({ requestId: membershipId,
        status: "reconciliation_required", accessGranted: false }, 409);
    }
    if (action.kind === "authenticate") {
      const result = await api.authenticateManualPayoffIntent(membershipId, user.id,
        owned.selectionId, action.operationId);
      return json({ requestId: membershipId, ...result });
    }
    const observed = await api.confirmManualPayoffIntent(membershipId, user.id, owned.selectionId, action);
    if (observed.status === "busy") return json({ requestId: membershipId, status: "busy", accessGranted: false });
    if (observed.status !== "observed") throw Error();
    if (observed.observation.status === "succeeded") {
      await api.recordManualPayoffCapture(membershipId, user.id, owned.selectionId);
      const accounted = await api.readOwnedManualPayoff(membershipId, user.id);
      if (accounted.status !== "captured" || accounted.selectionId !== owned.selectionId) throw Error();
      return json({ requestId: membershipId, status: "payment_accounted" });
    }
    return json({ requestId: membershipId, status: "payment_observed",
      operationId: observed.operationId, paymentStatus: observed.observation.status,
      replacementAllowed: observed.observation.status === "requires_payment_method" &&
        Boolean(observed.observation.failure), accessGranted: false });
  } catch { return json({ error: "Your original payoff needs reconciliation. Keep its membership reference; do not start a second payment." }, 409); }
}
