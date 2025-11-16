import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

// Optional: keep this dynamic so Vercel won't try to prerender
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  let token = authHeader?.match(/Bearer\s+(.+)/i)?.[1] ?? null;
  if (!token) {
    const store = await cookies();
    const cookieName = `sb-${new URL(SUPABASE_URL).host.split(".")[0]}-auth-token`;
    const raw = store.get(cookieName)?.value;
    if (raw) {
      let val = raw.startsWith("base64-") ? raw.slice("base64-".length) : raw;
      try {
        const parsed = JSON.parse(val);
        token = Array.isArray(parsed) ? parsed[0] : parsed?.access_token ?? null;
      } catch {
        try {
          const normalized = val.replace(/-/g, "+").replace(/_/g, "/");
          const decoded = Buffer.from(normalized, "base64").toString("utf8");
          const parsed = JSON.parse(decoded);
          token = Array.isArray(parsed) ? parsed[0] : parsed?.access_token ?? null;
        } catch {
          token = null;
        }
      }
    }
  }
  if (!token) return null;
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export async function GET(_req: NextRequest, ctx: any) {
  // Pull postId without giving TS anything to “helpfully” retype
  const postId = String(ctx?.params?.postId || "");

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
      .eq("user_id", user.id)
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
