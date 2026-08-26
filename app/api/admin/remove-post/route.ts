import type { NextRequest } from "next/server";
import {
  derivePostStatus,
  runModerationAction,
  type PostModerationRow,
} from "@/lib/admin/moderation";

export const runtime = "nodejs";

// TODO: removal only sets posts.removed_at — the video object stays in R2.
// A later pass should delete it via lib/r2.ts once retention policy is
// decided (removed_at gives us the paper trail either way).
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
