import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { adminClient } from "@/lib/admin/server";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401, headers });
  const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").filter(Boolean);
  if (!ids.length || ids.length > 100 || ids.some(id => !/^[a-f0-9-]{36}$/i.test(id))) return NextResponse.json({ error: "Invalid creator IDs." }, { status: 400, headers });
  try {
    const db = adminClient();
    const owned = await db.from("purchases").select("posts!inner(creator_id)").eq("buyer_id", user.id).in("posts.creator_id", ids).limit(1000);
    if (owned.error) throw new Error("Purchase lookup unavailable");
    const allowed = [...new Set((owned.data ?? []).flatMap(row => Array.isArray(row.posts) ? row.posts : [row.posts]).filter(Boolean).map(post => post.creator_id))];
    if (!allowed.length) return NextResponse.json({ profiles: [] }, { headers });
    const profiles = await db.from("profiles").select("id,username,full_name").in("id", allowed);
    if (profiles.error) throw new Error("Creator names unavailable");
    return NextResponse.json({ profiles: profiles.data }, { headers });
  } catch { return NextResponse.json({ error: "Purchase creator names are unavailable." }, { status: 503, headers }); }
}
