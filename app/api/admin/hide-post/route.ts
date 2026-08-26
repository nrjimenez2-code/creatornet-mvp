import type { NextRequest } from "next/server";
import {
  derivePostStatus,
  runModerationAction,
  type PostModerationRow,
} from "@/lib/admin/moderation";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return runModerationAction<PostModerationRow>(req, {
    action: "hide_post",
    targetTable: "posts",
    bodyKey: "postId",
    selectColumns: "hidden_at, removed_at, flag_reason",
    buildUpdate: () => ({ hidden_at: new Date().toISOString() }),
    deriveStatus: derivePostStatus,
  });
}
