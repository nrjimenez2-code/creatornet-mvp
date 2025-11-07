import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ suggestions: [] });

  const supabase = await createServerClient();

  const { data: creators } = await supabase
    .from("profiles")
    .select("username")
    .ilike("username", `%${q}%`)
    .limit(5);

  const { data: tags } = await supabase
    .from("posts")
    .select("hashtags")
    .ilike("hashtags", `%${q}%`)
    .limit(5);

  const out = new Set<string>();
  (creators || []).forEach((c) => c?.username && out.add(c.username));
  (tags || []).forEach((t) => {
    if (t?.hashtags) String(t.hashtags).split(/[ ,#]+/).forEach(h=>{ if(h) out.add(h); });
  });

  return NextResponse.json({ suggestions: Array.from(out).slice(0, 10) });
}
