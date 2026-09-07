import { NextResponse, type NextRequest } from "next/server";
import { adminAuthErrorResponse, requireAdmin } from "@/lib/admin/server";
import { isSafeId } from "@/lib/ids";
import {
  DECISION_RESULT,
  canTransition,
  isVerificationDecision,
  type VerificationDecision,
  type VerificationStatus,
} from "@/lib/verification";

export const runtime = "nodejs";

const MAX_REASON_LENGTH = 500;

type ParsedBody =
  | { ok: true; requestId: string; decision: VerificationDecision; reason: string | null }
  | { ok: false };

function parseBody(body: unknown): ParsedBody {
  if (typeof body !== "object" || body === null) return { ok: false };
  const record = body as Record<string, unknown>;

  const requestId = record.requestId;
  if (!isSafeId(requestId)) {
    return { ok: false };
  }
  if (!isVerificationDecision(record.decision)) return { ok: false };

  const rawReason = record.reason;
  if (rawReason === undefined || rawReason === null) {
    return { ok: true, requestId, decision: record.decision, reason: null };
  }
  if (typeof rawReason !== "string" || rawReason.length > MAX_REASON_LENGTH) {
    return { ok: false };
  }
  const reason = rawReason.trim();
  return { ok: true, requestId, decision: record.decision, reason: reason === "" ? null : reason };
}

interface RequestRow {
  id: string;
  creator_id: string;
  status: VerificationStatus;
}

/**
 * POST /api/admin/verification {requestId, decision, reason?} — decide a
 * blue-check request. approve/reject need a pending code; revoke needs an
 * approved badge (lib/verification.ts#ALLOWED_TRANSITIONS); anything else is
 * 409. Approve stamps profiles.authenticity_verified_at, revoke clears it,
 * reject touches only the request. Same contract as lib/admin/moderation.ts:
 * the admin_actions row is part of the operation, so an audit-insert failure
 * returns 500 and the admin retries. The response never carries the code —
 * the admin page already shows it where it is needed.
 */
export async function POST(req: NextRequest) {
  let actorId: string;
  let admin: Awaited<ReturnType<typeof requireAdmin>>["admin"];
  try {
    const ctx = await requireAdmin(req);
    actorId = ctx.user.id;
    admin = ctx.admin;
  } catch (err) {
    return adminAuthErrorResponse(err, "verification");
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const parsed = parseBody(rawBody);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { requestId, decision, reason } = parsed;
  const action = `verification.${decision}`;

  try {
    const { data: request, error: fetchError } = await admin
      .from("verification_requests")
      .select("id, creator_id, status")
      .eq("id", requestId)
      .maybeSingle<RequestRow>();

    if (fetchError) {
      console.error(`[admin:${action}] fetch failed for ${requestId}:`, fetchError);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
    if (!request) {
      return NextResponse.json({ error: "Target not found" }, { status: 404 });
    }
    if (!canTransition(request.status, decision)) {
      return NextResponse.json(
        { error: `Cannot ${decision} a request that is ${request.status.replace("_", " ")}.` },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const nextStatus = DECISION_RESULT[decision];

    // The status filter makes this a compare-and-set: two admins clicking at
    // once cannot both "win" — the second sees no row and gets the 409.
    const { data: updated, error: updateError } = await admin
      .from("verification_requests")
      .update({
        status: nextStatus,
        reason,
        decided_by: actorId,
        decided_at: now,
        updated_at: now,
      })
      .eq("id", requestId)
      .eq("status", request.status)
      .select("id")
      .maybeSingle<{ id: string }>();

    if (updateError) {
      console.error(`[admin:${action}] update failed for ${requestId}:`, updateError);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
    if (!updated) {
      return NextResponse.json({ error: "This request was just decided by someone else." }, { status: 409 });
    }

    if (decision !== "reject") {
      const { error: profileError } = await admin
        .from("profiles")
        .update({ authenticity_verified_at: decision === "approve" ? now : null })
        .eq("id", request.creator_id);

      if (profileError) {
        console.error(
          `[admin:${action}] PROFILE UPDATE FAILED after request ${requestId} moved to ${nextStatus}:`,
          profileError
        );
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      }
    }

    const { error: auditError } = await admin.from("admin_actions").insert({
      actor_id: actorId,
      action,
      target_table: "verification_requests",
      target_id: requestId,
      reason,
    });

    if (auditError) {
      console.error(
        `[admin:${action}] AUDIT INSERT FAILED after request ${requestId} moved to ${nextStatus} by ${actorId}:`,
        auditError
      );
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, status: nextStatus });
  } catch (err) {
    console.error(`[admin:${action}] unexpected error:`, err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
