// app/api/interest-score/route.ts
// Called from client components (VideoCard) to update user interest scores
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { updateInterestScore } from "@/lib/updateInterestScore";

export const runtime = "nodejs";

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
      delta?: number;
      category?: string;
    };

    if (!delta) return NextResponse.json({ ok: true });

    // Only score logged-in users
    const supabase = createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: true });

    // Caller can pass an explicit category (e.g. the hashtag the user
    // tapped). Otherwise, fall back to the post's primary interest.
    let category: string | null =
      typeof categoryOverride === "string" && categoryOverride.trim()
        ? categoryOverride.trim()
        : null;

    if (!category) {
      if (!post_id) return NextResponse.json({ ok: true });
      const admin = supabaseAdmin();
      const { data: post } = await admin
        .from("posts")
        .select("interests")
        .eq("id", post_id)
        .maybeSingle();
      category = Array.isArray(post?.interests)
        ? ((post.interests[0] as string) ?? null)
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
