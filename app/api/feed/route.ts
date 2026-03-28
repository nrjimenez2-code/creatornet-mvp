// /app/api/feed/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";

export async function GET(req: NextRequest) {
  const supabase = createRouteHandlerClient({ cookies });

  // get current user (ok if null → shows global feed)
  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes?.user?.id ?? null;

  const limit = Number(req.nextUrl.searchParams.get("limit") || 20);
  const offset = Number(req.nextUrl.searchParams.get("offset") || 0);

  const { data, error } = await supabase.rpc("get_feed_v2", {
    p_user_id: userId,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) {
    console.error("feed rpc error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ items: data ?? [] });
}
