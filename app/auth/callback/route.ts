// app/auth/callback/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
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
      await supabase.auth.signOut();
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
        { ok: false, reason: "setSession_error", message: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, reason: "exception", message: e?.message || String(e) },
      { status: 400 }
    );
  }
}
