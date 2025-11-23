import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(req: NextRequest) {
  try {
    const supabase = createServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { creator_id, action } = body; // action: "follow" | "unfollow"

    if (!creator_id || !action) {
      return NextResponse.json({ error: "Missing creator_id or action" }, { status: 400 });
    }

    if (user.id === creator_id) {
      return NextResponse.json({ error: "Cannot follow yourself" }, { status: 400 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (action === "follow") {
      // Check if already following
      const { data: existing, error: checkError } = await admin
        .from("follows")
        .select("follower_id, following_id")
        .eq("follower_id", user.id)
        .eq("following_id", creator_id)
        .maybeSingle();

      if (checkError && !checkError.message.includes("No rows")) {
        console.error("[follow-api] Check error:", checkError);
        return NextResponse.json({ error: checkError.message }, { status: 500 });
      }

      if (existing) {
        // Already following, return success
        console.log("[follow-api] Already following:", { follower_id: user.id, following_id: creator_id });
        return NextResponse.json({ success: true, following: true });
      }

      // Insert follow
      const { error: insertError } = await admin
        .from("follows")
        .insert({
          follower_id: user.id,
          following_id: creator_id,
        });

      if (insertError) {
        // Check if it's a duplicate key error (race condition or double-click)
        if (insertError.message.includes("duplicate") || 
            insertError.message.includes("unique constraint") ||
            insertError.message.includes("follows_pkey")) {
          console.log("[follow-api] Duplicate follow detected (likely race condition), treating as success");
          return NextResponse.json({ success: true, following: true });
        }
        console.error("[follow-api] Insert error:", insertError);
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }

      console.log("[follow-api] Successfully followed:", { follower_id: user.id, following_id: creator_id });
      return NextResponse.json({ success: true, following: true });
    } else if (action === "unfollow") {
      // Check if following
      const { data: existing } = await admin
        .from("follows")
        .select("follower_id, following_id")
        .eq("follower_id", user.id)
        .eq("following_id", creator_id)
        .maybeSingle();

      if (!existing) {
        // Not following, return success
        return NextResponse.json({ success: true, following: false });
      }

      const { error: deleteError } = await admin
        .from("follows")
        .delete()
        .eq("follower_id", user.id)
        .eq("following_id", creator_id);

      if (deleteError) {
        console.error("[follow-api] Delete error:", deleteError);
        return NextResponse.json({ error: deleteError.message }, { status: 500 });
      }

      console.log("[follow-api] Successfully unfollowed:", { follower_id: user.id, following_id: creator_id });
      return NextResponse.json({ success: true, following: false });
    } else {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to update follow status" }, { status: 500 });
  }
}

