// app/api/premium/access/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * POST body: { post_id: string }
 * Returns: { success: boolean, url?: string }
 *
 * Verifies the requester owns a purchase for the post,
 * then generates a short-lived signed URL for the premium file path.
 */
export async function POST(req: Request) {
  try {
    const { post_id } = await req.json();
    if (!post_id) {
      return NextResponse.json({ success: false, error: "Missing post_id" }, { status: 400 });
    }

    // user session via cookies
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
    );

    // get user
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });
    }

    // does user own a purchase for this post?
    const { data: hasPurchase, error: purchaseErr } = await supabase
      .from("purchases")
      .select("id")
      .eq("user_id", userId)
      .eq("post_id", post_id)
      .limit(1)
      .maybeSingle();

    if (purchaseErr) {
      console.error("purchase lookup error:", purchaseErr);
      return NextResponse.json({ success: false, error: "Purchase lookup failed" }, { status: 500 });
    }
    if (!hasPurchase) {
      return NextResponse.json({ success: false, error: "No access" }, { status: 403 });
    }

    // fetch post to get its premium_path
    const { data: post, error: postErr } = await supabase
      .from("posts")
      .select("premium_path")
      .eq("id", post_id)
      .maybeSingle();

    if (postErr) {
      console.error("post lookup error:", postErr);
      return NextResponse.json({ success: false, error: "Post lookup failed" }, { status: 500 });
    }
    if (!post?.premium_path) {
      return NextResponse.json({ success: false, error: "No premium file for this post" }, { status: 404 });
    }

    // generate short-lived signed URL (e.g., 60 minutes)
    const { data: signed, error: signErr } = await supabase.storage
      .from("premium")
      .createSignedUrl(post.premium_path, 60 * 60);

    if (signErr || !signed?.signedUrl) {
      console.error("signed url error:", signErr);
      return NextResponse.json({ success: false, error: "Failed to sign URL" }, { status: 500 });
    }

    return NextResponse.json({ success: true, url: signed.signedUrl }, { status: 200 });
  } catch (e: any) {
    console.error("access route error:", e?.message || e);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
