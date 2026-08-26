// app/api/auth/callback/route.ts
import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { createSupabaseServer } from "@/lib/supabaseServer";

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, reason: "bad_origin" }, { status: 403 });
  }
  const supabase = await createSupabaseServer();

  // The Supabase client emits { event, session } on any auth change
  const { session } = await req.json().catch(() => ({ session: null }));

  if (session) {
    // ✅ Set the cookies for server-side Supabase
    await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token!,
    });
  } else {
    // ❌ No session — clear cookies (logout)
    await supabase.auth.signOut();
  }

  return NextResponse.json({ ok: true });
}
