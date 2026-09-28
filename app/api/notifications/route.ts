import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { decodeTipCursor, encodeTipCursor } from "@/lib/tipCursor";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const rawCursor = req.nextUrl.searchParams.get("cursor");
  const cursor = rawCursor ? decodeTipCursor(rawCursor) : null;
  if (rawCursor && !cursor) return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
  let query = supabaseAdmin.from("notifications")
    .select("id,actor_id,kind,tip_id,post_id,read_at,created_at")
    .eq("recipient_id", user.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(26);
  if (cursor) query = query.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Notifications are unavailable." }, { status: 500 });
  const rows = data ?? [], page = rows.slice(0, 25);
  const actorIds = [...new Set(page.map((row) => row.actor_id).filter(Boolean))] as string[];
  const tipIds = [...new Set(page.map((row) => row.tip_id).filter(Boolean))] as string[];
  const [actors, tips] = await Promise.all([
    actorIds.length ? supabaseAdmin.from("profiles").select("id,username,avatar_url").in("id", actorIds) : Promise.resolve({ data: [], error: null }),
    tipIds.length ? supabaseAdmin.from("tips").select("id,gross_amount_cents,currency").in("id", tipIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (actors.error || tips.error) {
    return NextResponse.json({ error: "Notifications are unavailable." }, { status: 500 });
  }
  const actorMap = new Map((actors.data ?? []).map((row) => [row.id, row]));
  const tipMap = new Map((tips.data ?? []).map((row) => [row.id, row]));
  const unread = await supabaseAdmin.from("notifications").select("id", { count: "exact", head: true })
    .eq("recipient_id", user.id).is("read_at", null);
  if (unread.error) return NextResponse.json({ error: "Notifications are unavailable." }, { status: 500 });
  return NextResponse.json({
    unreadCount: unread.count ?? 0,
    items: page.map((row) => ({
      id: row.id, kind: row.kind, postId: row.post_id, readAt: row.read_at, createdAt: row.created_at,
      actorUsername: row.actor_id ? actorMap.get(row.actor_id)?.username ?? null : null,
      actorAvatarUrl: row.actor_id ? actorMap.get(row.actor_id)?.avatar_url ?? null : null,
      amountCents: row.tip_id ? Number(tipMap.get(row.tip_id)?.gross_amount_cents ?? 0) : 0,
      currency: row.tip_id ? tipMap.get(row.tip_id)?.currency ?? "usd" : "usd",
    })),
    nextCursor: rows.length > 25 && page.length ? encodeTipCursor(page[page.length - 1]) : null,
  });
}

export async function PATCH(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  let body: { id?: unknown; all?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  let query = supabaseAdmin.from("notifications").update({ read_at: new Date().toISOString() }).eq("recipient_id", user.id).is("read_at", null);
  if (body.all !== true) {
    if (typeof body.id !== "string") return NextResponse.json({ error: "Notification id required." }, { status: 400 });
    query = query.eq("id", body.id);
  }
  const { error } = await query;
  if (error) return NextResponse.json({ error: "Notification could not be updated." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
