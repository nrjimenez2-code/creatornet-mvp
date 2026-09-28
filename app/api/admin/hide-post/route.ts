import type { NextRequest } from "next/server";
import {
  derivePostStatus,
  runModerationAction,
  type PostModerationRow,
} from "@/lib/admin/moderation";
import { expireOpenTipSessions } from "@/lib/tipCheckout";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return runModerationAction<PostModerationRow>(req, {
    action: "hide_post",
    targetTable: "posts",
    bodyKey: "postId",
    selectColumns: "hidden_at, removed_at, flag_reason",
    buildUpdate: () => ({ hidden_at: new Date().toISOString() }),
    deriveStatus: derivePostStatus,
    afterUpdate: (admin, postId) => expireOpenTipSessions(admin, { postId }),
  });
}
