import { NextResponse, type NextRequest } from "next/server";
import { AdminAuthError, requireAdmin } from "@/lib/admin/server";

export const runtime = "nodejs";

const REVIEW_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_REASON_LENGTH = 500;

type ParsedBody = { ok: true; reviewId: string; reason: string | null } | { ok: false };

function parseBody(body: unknown): ParsedBody {
  if (typeof body !== "object" || body === null) return { ok: false };
  const record = body as Record<string, unknown>;

  const reviewId = record.reviewId;
  if (typeof reviewId !== "string" || !REVIEW_ID_PATTERN.test(reviewId)) {
    return { ok: false };
  }

  const rawReason = record.reason;
  if (rawReason === undefined || rawReason === null) {
    return { ok: true, reviewId, reason: null };
  }
  if (typeof rawReason !== "string" || rawReason.length > MAX_REASON_LENGTH) {
    return { ok: false };
  }
  const reason = rawReason.trim();
  return { ok: true, reviewId, reason: reason === "" ? null : reason };
}

/**
 * POST /api/admin/remove-review — deletes a fake/abusive review, recomputes
 * the creator's aggregate rating (same RPC the submit flow in
 * /api/reviews uses), and writes the admin_actions audit row. Deletion is the
 * correct shape here (reviews has no hidden/removed columns), and the audit
 * row preserves the paper trail. Follows the runModerationAction contract:
 * audit-insert failure returns 500 so the admin retries and the trail stays
 * complete.
 */
export async function POST(req: NextRequest) {
  let actorId: string;
  let admin: Awaited<ReturnType<typeof requireAdmin>>["admin"];
  try {
    const ctx = await requireAdmin(req);
    actorId = ctx.user.id;
    admin = ctx.admin;
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[admin:remove_review] auth check failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
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
  const { reviewId, reason } = parsed;

  try {
    // Fetch first: the creator id drives the rating recompute, and a missing
    // row should 404 instead of silently "succeeding".
    const { data: review, error: fetchError } = await admin
      .from("reviews")
      .select("id, creator_id")
      .eq("id", reviewId)
      .maybeSingle<{ id: string; creator_id: string }>();

    if (fetchError) {
      console.error(`[admin:remove_review] fetch failed for ${reviewId}:`, fetchError);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
    if (!review) {
      return NextResponse.json({ error: "Target not found" }, { status: 404 });
    }

    const { error: deleteError } = await admin
      .from("reviews")
      .delete()
      .eq("id", reviewId);

    if (deleteError) {
      console.error(`[admin:remove_review] delete failed for ${reviewId}:`, deleteError);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }

    // Keep profiles.review_rating / review_count honest. Non-fatal on error,
    // matching the submit flow: the next review write recomputes it anyway.
    const { error: rpcError } = await admin.rpc("update_profile_rating", {
      p_profile_id: review.creator_id,
    });
    if (rpcError) {
      console.error(
        `[admin:remove_review] rating recompute failed for creator ${review.creator_id}:`,
        rpcError
      );
    }

    const { error: auditError } = await admin.from("admin_actions").insert({
      actor_id: actorId,
      action: "remove_review",
      target_table: "reviews",
      target_id: reviewId,
      reason,
    });

    if (auditError) {
      console.error(
        `[admin:remove_review] AUDIT INSERT FAILED after delete of review ${reviewId} by ${actorId}:`,
        auditError
      );
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin:remove_review] unexpected error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
