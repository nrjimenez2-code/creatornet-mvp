import type { NextRequest } from "next/server";
import {
  derivePostStatus,
  runModerationAction,
  type PostModerationRow,
} from "@/lib/admin/moderation";

export const runtime = "nodejs";

// Removal retains media and purchase relationships. Buyers must keep access;
// never turn this into storage deletion without preserving paid delivery.
export async function POST(req: NextRequest) {
  return runModerationAction<PostModerationRow>(req, {
    action: "remove_post",
    targetTable: "posts",
    bodyKey: "postId",
    selectColumns: "hidden_at, removed_at, flag_reason",
    buildUpdate: () => ({ removed_at: new Date().toISOString() }),
    deriveStatus: derivePostStatus,
  });
}
