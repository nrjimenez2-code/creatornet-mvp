import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { onlyVisiblePosts } from "@/lib/visiblePosts";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ suggestions: [] });

  // PostgREST's ilike filter is a comma/parenthesis-delimited DSL, so a raw
  // user string can change the shape of the filter. Strip the delimiters and
  // the wildcards rather than passing the query through untouched.
  const safeQ = q.replace(/[%_,()\\*]/g, "").slice(0, 64);
  if (!safeQ) return NextResponse.json({ suggestions: [] });

  // Service-role, like the sibling /api/search/perform and /api/tag routes.
  //
  // This used to use the RLS-scoped server client, but public.profiles has NO
  // cross-user SELECT policy — only auth.uid() = id — so the creator half of
  // the typeahead returned at most the caller's own name, and nothing at all
  // for a signed-out visitor. The error was destructured away, so it failed
  // silently. Only display columns are selected, so the service role cannot
  // leak stripe_*, banned_at or role.
  const supabase = supabaseAdmin;

  const { data: creators, error: creatorsErr } = await supabase
    .from("profiles")
    .select("username")
    .ilike("username", `%${safeQ}%`)
    .limit(5);
  if (creatorsErr) {
    console.warn("[search/suggest] creators lookup failed:", creatorsErr.message);
  }

  const { data: tags, error: tagsErr } = await onlyVisiblePosts(supabase.from("posts").select("hashtags"))
    .ilike("hashtags", `%${safeQ}%`)
    .limit(5);
  if (tagsErr) {
    console.warn("[search/suggest] tags lookup failed:", tagsErr.message);
  }

  const out = new Set<string>();
  (creators || []).forEach((c) => c?.username && out.add(c.username));
  (tags || []).forEach((t) => {
    if (t?.hashtags) String(t.hashtags).split(/[ ,#]+/).forEach(h=>{ if(h) out.add(h); });
  });

  return NextResponse.json({ suggestions: Array.from(out).slice(0, 10) });
}
