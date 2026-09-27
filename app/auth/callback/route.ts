// app/auth/callback/route.ts
import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createServerClient as createAppServerClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { data, error } = await createAppServerClient().auth.getUser();
    return NextResponse.json({ ok: !error && !!data.user, userId: !error ? data.user?.id ?? null : null },
      { status: !error && data.user ? 200 : 401, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(req: Request) {
  try {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, reason: "bad_origin" }, { status: 403 });
  }
    const { event, access_token, refresh_token } = await req.json();

    // Important in Next 16.x: await cookies()
    const cookieStore = await cookies();

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value;
          },
          set(name: string, value: string, options: any) {
            cookieStore.set(name, value, options);
          },
          remove(name: string, options: any) {
            cookieStore.set(name, "", { ...options, maxAge: 0 });
          },
        },
      }
    );

    // If the user signed out, clear server cookies
    if (event === "SIGNED_OUT" || (!access_token && !refresh_token)) {
      // Cookie synchronization must never revoke another device's sessions.
      const key = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0]}-auth-token`;
      for (const cookie of cookieStore.getAll()) {
        if (cookie.name === key || cookie.name.startsWith(key + ".")) {
          cookieStore.set(cookie.name, "", { path: "/", maxAge: 0 });
        }
      }
      return NextResponse.json({ ok: true, cleared: true }, { status: 200 });
    }

    if (!access_token || !refresh_token) {
      return NextResponse.json({ ok: false, reason: "tokens_missing" }, { status: 400 });
    }

    const { error } = await supabase.auth.setSession({
      access_token,
      refresh_token,
    });

    if (error) {
      return NextResponse.json(
        { ok: false, reason: "setSession_error" },
        { status: 400 }
      );
    }

    const verified = await supabase.auth.getUser();
    if (verified.error || !verified.data.user) {
      return NextResponse.json({ ok: false, reason: "invalid_session" }, { status: 401 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    console.error("[auth-callback]", e?.message || String(e));
    return NextResponse.json({ ok: false, reason: "exception" }, { status: 400 });
  }
}
