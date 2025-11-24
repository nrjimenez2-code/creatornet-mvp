import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ postId: string }> }
) {
  try {
    const { postId } = await params;

    if (!postId) {
      return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error: shareError } = await admin.rpc("increment_post_shares", {
      p_post_id: postId,
    });

    if (shareError) {
      console.error("[share-api] RPC error:", shareError);
      return NextResponse.json(
        { error: shareError.message || "Failed to increment shares" },
        { status: 500 }
      );
    }

    const { data: postData, error: fetchError } = await admin
      .from("posts")
      .select("shares_count")
      .eq("id", postId)
      .single();

    if (fetchError) {
      console.error("[share-api] Fetch error:", fetchError);
      return NextResponse.json(
        {
          success: true,
          shares_count: null,
          warning: "Shares incremented but failed to fetch latest count",
        },
        { status: 200 }
      );
    }

    return NextResponse.json({
      success: true,
      shares_count: (postData?.shares_count as number) ?? null,
    });
  } catch (err: any) {
    console.error("[share-api] Unexpected error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to record share" },
      { status: 500 }
    );
  }
}


