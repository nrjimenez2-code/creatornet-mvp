import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { adminAuthErrorResponse, requireAdmin } from "@/lib/admin/server";
import type { UserStatus, VideoStatus } from "@/types/admin";

const TARGET_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_REASON_LENGTH = 500;

export type ModerationActionName =
  | "ban_user"
  | "unban_user"
  | "hide_post"
  | "unhide_post"
  | "remove_post"
  | "approve_post";

export interface ProfileModerationRow {
  banned_at: string | null;
  flag_reason: string | null;
}

export interface PostModerationRow {
  hidden_at: string | null;
  removed_at: string | null;
  flag_reason: string | null;
}

export function deriveUserStatus(row: ProfileModerationRow): UserStatus {
  if (row.banned_at !== null) return "banned";
  if (row.flag_reason !== null) return "flagged";
  return "active";
}

export function derivePostStatus(row: PostModerationRow): VideoStatus {
  if (row.removed_at !== null) return "removed";
  if (row.hidden_at !== null) return "hidden";
  if (row.flag_reason !== null) return "flagged";
  return "live";
}

export interface ModerationSpec<Row> {
  /** admin_actions.action value; also tags server logs. */
  action: ModerationActionName;
  targetTable: "profiles" | "posts";
  bodyKey: "userId" | "postId";
  /** Columns re-read after the update so the response status is derived from the real row. */
  selectColumns: string;
  buildUpdate: (reason: string | null) => Record<string, string | null>;
  deriveStatus: (row: Row) => UserStatus | VideoStatus;
}

type ParsedModerationBody =
  | { ok: true; targetId: string; reason: string | null }
  | { ok: false };

function parseModerationBody(
  body: unknown,
  bodyKey: "userId" | "postId"
): ParsedModerationBody {
  if (typeof body !== "object" || body === null) return { ok: false };

  const record = body as Record<string, unknown>;
  const targetId = record[bodyKey];
  if (typeof targetId !== "string" || !TARGET_ID_PATTERN.test(targetId)) {
    return { ok: false };
  }

  const rawReason = record.reason;
  if (rawReason === undefined || rawReason === null) {
    return { ok: true, targetId, reason: null };
  }
  if (typeof rawReason !== "string" || rawReason.length > MAX_REASON_LENGTH) {
    return { ok: false };
  }
  const reason = rawReason.trim();
  return { ok: true, targetId, reason: reason === "" ? null : reason };
}

/**
 * Shared POST handler for the /api/admin/* moderation routes: requireAdmin ->
 * validate body -> update the target row -> insert the admin_actions audit
 * row. The audit row is part of the operation: if its insert fails the route
 * returns 500 so the admin retries and the trail stays complete. Client
 * messages are generic; full detail goes to server logs only.
 */
export async function runModerationAction<Row>(
  req: NextRequest,
  spec: ModerationSpec<Row>
): Promise<NextResponse> {
  let actorId: string;
  let admin: Awaited<ReturnType<typeof requireAdmin>>["admin"];
  try {
    const ctx = await requireAdmin(req);
    actorId = ctx.user.id;
    admin = ctx.admin;
  } catch (err) {
    return adminAuthErrorResponse(err, spec.action);
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const parsed = parseModerationBody(rawBody, spec.bodyKey);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { targetId, reason } = parsed;

  try {
    const { data: row, error: updateError } = await admin
      .from(spec.targetTable)
      .update(spec.buildUpdate(reason))
      .eq("id", targetId)
      .select(spec.selectColumns)
      .maybeSingle<Row>();

    if (updateError) {
      console.error(
        `[admin:${spec.action}] update failed for ${spec.targetTable} ${targetId}:`,
        updateError
      );
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json({ error: "Target not found" }, { status: 404 });
    }

    const { error: auditError } = await admin.from("admin_actions").insert({
      actor_id: actorId,
      action: spec.action,
      target_table: spec.targetTable,
      target_id: targetId,
      reason,
    });

    if (auditError) {
      console.error(
        `[admin:${spec.action}] AUDIT INSERT FAILED after update of ${spec.targetTable} ${targetId} by ${actorId}:`,
        auditError
      );
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, status: spec.deriveStatus(row) });
  } catch (err) {
    console.error(`[admin:${spec.action}] unexpected error:`, err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
