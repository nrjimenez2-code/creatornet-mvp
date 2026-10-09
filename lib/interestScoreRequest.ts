import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { isAllowedInterestDelta, toInterestCategory } from "@/lib/interestCategories";
import { allowRequest } from "@/lib/rateLimit";

const RATE = { limit: 60, windowMs: 60_000 };

/** Shared browser/native scoring rules. The authenticated actor comes from the caller, never the body. */
export async function scoreInterestRequest(userId: string | null, body: unknown) {
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  if (!isAllowedInterestDelta(input.delta) || !userId) return { ok: true };
  if (!allowRequest(`interest:${userId}`, RATE)) return { ok: true, limited: true };

  let category = toInterestCategory(input.category);
  if (!category) {
    if (typeof input.post_id !== "string") return { ok: true };
    const { data: post } = await supabaseAdmin.from("posts")
      .select("interests").eq("id", input.post_id).maybeSingle();
    category = Array.isArray(post?.interests) ? toInterestCategory(post.interests[0]) : null;
  }
  if (category) await updateInterestScore(userId, category, input.delta);
  return { ok: true };
}
