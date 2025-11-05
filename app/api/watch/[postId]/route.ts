import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Optional: keep this dynamic so Vercel won't try to prerender
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: any) {
  // Pull postId without giving TS anything to “helpfully” retype
  const postId = String(ctx?.params?.postId || "");

  if (!postId) {
    return NextResponse.json({ error: "Missing postId" }, { status: 400 });
  }

  const supabase = await createSupabaseServer();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: post, error: postErr } = await supabase
    .from("posts")
    .select("id, creator_id, premium_path")
    .eq("id", postId)
    .maybeSingle();

  if (postErr || !post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  if (!post.premium_path) {
    return NextResponse.json(
      { error: "No premium file for this post" },
      { status: 404 }
    );
  }

  let allowed = post.creator_id === user.id;

  if (!allowed) {
    const { data: purchase, error: pErr } = await supabase
      .from("purchases")
      .select("id")
      .eq("post_id", postId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!pErr && purchase) allowed = true;
  }

  if (!allowed) {
    return NextResponse.json({ error: "Payment required" }, { status: 402 });
  }

  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from("premium")
    .createSignedUrl(post.premium_path as string, 60 * 60);

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not sign URL" }, { status: 500 });
  }

  return NextResponse.json({ url: signed.signedUrl });
}
