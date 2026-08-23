// app/api/interest-score/route.ts
// Called from client components (VideoCard) to update user interest scores
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { isAllowedInterestDelta, toInterestCategory } from "@/lib/interestCategories";
import { allowRequest } from "@/lib/rateLimit";

export const runtime = "nodejs";

// One user's honest activity comes nowhere near this; a script does.
const RATE = { limit: 60, windowMs: 60_000 };

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST(req: NextRequest) {
  try {
    const { post_id, delta, category: categoryOverride } = (await req.json()) as {
      post_id?: string;
      delta?: unknown;
      category?: unknown;
    };

    // Only the spec'd deltas (1,2,3,4,5,10,15,25). Negative, huge or
    // non-numeric values are dropped, not clamped.
    if (!isAllowedInterestDelta(delta)) return NextResponse.json({ ok: true });

    // Only score logged-in users
    const supabase = createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: true });

    if (!allowRequest(`interest:${user.id}`, RATE)) {
      return NextResponse.json({ ok: true, limited: true });
    }

    // Caller can pass an explicit category (e.g. the hashtag the user
    // tapped). It must be one of the known interest categories; anything
    // else is ignored. Otherwise, fall back to the post's primary interest.
    let category: string | null = toInterestCategory(categoryOverride);

    if (!category) {
      if (!post_id || typeof post_id !== "string") return NextResponse.json({ ok: true });
      const admin = supabaseAdmin();
      const { data: post } = await admin
        .from("posts")
        .select("interests")
        .eq("id", post_id)
        .maybeSingle();
      category = Array.isArray(post?.interests)
        ? toInterestCategory(post.interests[0])
        : null;
    }

    if (!category) return NextResponse.json({ ok: true });

    await updateInterestScore(user.id, category, delta);
    return NextResponse.json({ ok: true });
  } catch {
    // Never fail a request for analytics
    return NextResponse.json({ ok: true });
  }
}
