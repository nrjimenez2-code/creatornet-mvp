import type { NextRequest } from "next/server";
import {
  deriveUserStatus,
  runModerationAction,
  type ProfileModerationRow,
} from "@/lib/admin/moderation";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return runModerationAction<ProfileModerationRow>(req, {
    action: "ban_user",
    targetTable: "profiles",
    bodyKey: "userId",
    selectColumns: "banned_at, flag_reason",
    buildUpdate: (reason) => ({
      banned_at: new Date().toISOString(),
      flag_reason: reason,
    }),
    deriveStatus: deriveUserStatus,
  });
}
