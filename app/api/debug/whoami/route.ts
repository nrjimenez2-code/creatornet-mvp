// app/api/debug/whoami/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export async function GET() {
  try {
    const store = await cookies();

    // ✅ keep your adapter, force types so TS accepts it
    const cookieAdapter: any = {
      get: (n: string) => store.get(n)?.value,
      set: (n: string, v: string, o?: any) => { store.set(n, v, o as any); },
      remove: (n: string, o?: any) => { store.set(n, "", { ...(o || {}), maxAge: 0 }); },
    };

    // @ts-ignore – accept our adapter shape at runtime
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: cookieAdapter as any }
    );

    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      return NextResponse.json({ ok: false, userId: null, err: "Auth session missing!" });
    }
    return NextResponse.json({ ok: true, userId: data.user.id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, err: e?.message ?? String(e) }, { status: 500 });
  }
}
