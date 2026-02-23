import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * GET /api/profiles?ids=id1,id2,id3
 * Returns public profile fields (id, full_name, username, avatar_url) for the given user IDs.
 * Uses service role so creator avatars can be shown in the feed (RLS would block client-side reads).
 * Requires an authenticated user so the endpoint is not a public scrape.
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = createServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idsParam = req.nextUrl.searchParams.get("ids");
    if (!idsParam || typeof idsParam !== "string") {
      return NextResponse.json({ error: "Missing ids query parameter" }, { status: 400 });
    }

    const ids = idsParam
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return NextResponse.json({ profiles: [] });
    }
    if (ids.length > 100) {
      return NextResponse.json({ error: "Too many ids (max 100)" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, username, avatar_url")
      .in("id", ids);

    if (error) {
      console.error("[api/profiles] Error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      profiles: (data ?? []).map((row) => ({
        id: row.id,
        full_name: row.full_name ?? null,
        username: row.username ?? null,
        avatar_url: row.avatar_url ?? null,
      })),
    });
  } catch (err) {
    console.error("[api/profiles] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
