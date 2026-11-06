import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { membershipManualBuyerReady, membershipManualBuyerRecoveryReady } from "@/lib/membershipManualBuyer";
import { parseManualPaymentAction } from "@/lib/manualPaymentAction";
import { createMembershipRuntime } from "@/lib/membershipRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization", "Referrer-Policy": "no-referrer" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
type Route = { params: Promise<{ membershipId: string }> };

export async function GET(req: NextRequest, route: Route) {
  if (!membershipManualBuyerRecoveryReady()) return json({ error: "Monthly payment recovery is not enabled." }, 409);
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: "Sign in to recover your membership." }, 401);
  try {
    if (req.nextUrl.searchParams.size) return json({ error: "Invalid original membership." }, 400);
    const { membershipId } = await route.params; assertMembershipId(membershipId);
    const owned = await createMembershipRuntime().readOwnedManualFirst(membershipId, user.id);
    return json({ ...owned, newPaymentAllowed: membershipManualBuyerReady() &&
      !owned.firstPaymentRecorded && !owned.initialAbandonRequested &&
      Math.floor(Date.now() / 1000) < owned.acceptanceExpiresAt });
  } catch { return json({ error: "Your original monthly payment needs review." }, 409); }
}

/** Only action intent crosses HTTP; owner, source, amount and original provider
 * identity are loaded from the authenticated buyer's frozen selection. */
export async function POST(req: NextRequest, route: Route) {
  if (!membershipManualBuyerRecoveryReady()) return json({ error: "Monthly payment recovery is not enabled." }, 409);
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: "Sign in to continue your membership." }, 401);
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return json({ error: "Invalid request origin." }, 403);
    const { membershipId } = await route.params; assertMembershipId(membershipId);
    if (req.nextUrl.searchParams.size || req.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      return json({ error: "Invalid original payment action." }, 400);
    const text = await req.text();
    if (text.length > 2048) return json({ error: "Invalid original payment action." }, 400);
    let action: ReturnType<typeof parseManualPaymentAction>;
    try { action = parseManualPaymentAction(JSON.parse(text)); }
    catch { return json({ error: "Invalid original payment action." }, 400); }
    if (action.kind === "token" || action.kind === "replacement") return json({ error: "Use the original card payment form." }, 400);
    if (["prepare", "card", "card_replacement"].includes(action.kind) && !membershipManualBuyerReady())
      return json({ error: "New monthly card payment actions are paused. Check the original status or contact support." }, 409);
    const api = createMembershipRuntime(), owned = await api.readOwnedManualFirst(membershipId, user.id);
    if (owned.initialAbandoned) return json({ requestId: membershipId, status: "released", releasedAt: owned.initialAbandonedAt,
      accessGranted: false, canSwitchPaymentMode: true });
    if (owned.firstPaymentRecorded) return json({ requestId: membershipId, status: "payment_accounted" });
    if (action.kind === "stop") {
      const closed = await api.closeManualFirst(membershipId, user.id, owned.selectionId, true);
      if (closed.status !== "abandoned") return json({ requestId: membershipId, status: "reconciliation_required", accessGranted: false }, 409);
      const retired = await api.readOwnedManualFirst(membershipId, user.id);
      if (!retired.initialAbandonedAt) throw Error();
      return json({ requestId: membershipId, status: "released", releasedAt: retired.initialAbandonedAt,
        accessGranted: false, canSwitchPaymentMode: true });
    }
    if (action.kind === "prepare") {
      const prepared = await api.prepareManualFirstIntent(membershipId, user.id, owned.selectionId);
      return prepared.status === "bound_unpublished" ? json({ requestId: membershipId, status: "payment_prepared",
        amountCents: owned.amountCents, currency: "usd", accessGranted: false }) :
        json({ requestId: membershipId, status: "reconciliation_required", accessGranted: false }, 409);
    }
    if (action.kind === "authenticate") {
      const result = await api.authenticateManualFirstIntent(membershipId, user.id, owned.selectionId, action.operationId);
      return json({ requestId: membershipId, ...result });
    }
    const observed = await api.confirmManualFirstIntent(membershipId, user.id, owned.selectionId, action);
    if (observed.status === "busy") return json({ requestId: membershipId, status: "busy", accessGranted: false });
    if (observed.status !== "observed") throw Error();
    if (observed.observation.status === "succeeded") {
      const captured = await api.recordManualFirstCapture(membershipId, user.id, owned.selectionId);
      if (!captured.summary.firstPaymentRecorded) throw Error();
      return json({ requestId: membershipId, status: "payment_accounted" });
    }
    return json({ requestId: membershipId, status: "payment_observed", operationId: observed.operationId,
      paymentStatus: observed.observation.status,
      replacementAllowed: observed.observation.status === "requires_payment_method" && Boolean(observed.observation.failure),
      accessGranted: false });
  } catch { return json({ error: "Your original monthly payment needs reconciliation. Keep its membership reference; do not start a second payment." }, 409); }
}
