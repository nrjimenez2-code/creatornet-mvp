import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { decodeTipCursor, encodeTipCursor } from "@/lib/tipCursor";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const rawCursor = req.nextUrl.searchParams.get("cursor");
  const cursor = rawCursor ? decodeTipCursor(rawCursor) : null;
  if (rawCursor && !cursor) return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
  let query = supabaseAdmin.from("tips")
    .select("id,creator_id,post_id,gross_amount_cents,currency,status,refunded_amount_cents,created_at,paid_at")
    .eq("tipper_id", user.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(26);
  if (cursor) query = query.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Tip history is unavailable." }, { status: 500 });
  const rows = data ?? [];
  const page = rows.slice(0, 25);
  const creatorIds = [...new Set(page.map((row) => row.creator_id))];
  const postIds = [...new Set(page.map((row) => row.post_id))];
  const [profiles, posts] = await Promise.all([
    creatorIds.length ? supabaseAdmin.from("profiles").select("id,username,full_name").in("id", creatorIds) : Promise.resolve({ data: [], error: null }),
    postIds.length ? supabaseAdmin.from("posts").select("id,title").in("id", postIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const profileMap = new Map((profiles.data ?? []).map((row) => [row.id, row]));
  const postMap = new Map((posts.data ?? []).map((row) => [row.id, row]));
  return NextResponse.json({
    items: page.map((row) => ({
      id: row.id, creatorId: row.creator_id,
      creatorUsername: profileMap.get(row.creator_id)?.username ?? null,
      creatorName: profileMap.get(row.creator_id)?.full_name ?? null,
      postId: row.post_id, postTitle: postMap.get(row.post_id)?.title ?? "Video",
      amountCents: Number(row.gross_amount_cents), currency: row.currency, status: row.status,
      refundedAmountCents: Number(row.refunded_amount_cents || 0), createdAt: row.created_at, paidAt: row.paid_at,
    })),
    nextCursor: rows.length > 25 && page.length ? encodeTipCursor(page[page.length - 1]) : null,
  });
}
