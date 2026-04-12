import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabaseClient";

// Optional: keep this dynamic so Vercel won't try to prerender
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function getUserFromRequest(_req: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;

  if (!postId) {
    return NextResponse.json({ error: "Missing postId" }, { status: 400 });
  }

  const user = await getUserFromRequest(_req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: post, error: postErr } = await admin
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
    const { data: purchase, error: purchaseError } = await admin
      .from("purchases")
      .select("id")
      .eq("post_id", postId)
      .eq("buyer_id", user.id)
      .eq("access_granted", true)
      .maybeSingle();

    if (!purchaseError && purchase) allowed = true;
  }

  if (!allowed) {
    return NextResponse.json({ error: "Payment required" }, { status: 402 });
  }

  const { data: signed, error: signErr } = await admin.storage
    .from("premium")
    .createSignedUrl(post.premium_path as string, 60 * 60);

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not sign URL" }, { status: 500 });
  }

  return NextResponse.json({ url: signed.signedUrl });
}
