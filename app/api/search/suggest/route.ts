import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { interpretSearch } from "@/lib/searchQuery";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

export async function GET(req: Request) {
  if (!allowRequest(`search-suggest:${clientKey(req)}`, { limit: 90, windowMs: 60_000 })) return tooManyRequests();
  let input: ReturnType<typeof interpretSearch>;
  try { input = interpretSearch(new URL(req.url).searchParams.get("q") ?? ""); }
  catch { return NextResponse.json({ error: "Invalid search query." }, { status: 400 }); }
  try {
    const [topics, matches] = await Promise.all([
      supabaseAdmin.rpc("search_topics_v1", { query_text: input.normalized }),
      input.normalized ? supabaseAdmin.rpc("search_relevance_v1", { query_text: input.normalized, identity_query: input.raw.replace(/^#/, ""), related_terms: [], page_number: 0, page_size: 5 }) : Promise.resolve({ data: null, error: null }),
    ]);
    if (topics.error || matches.error) throw topics.error ?? matches.error;
    const suggestions: Array<{ label: string; type: string }> = [];
    for (const creator of matches.data?.creators ?? []) {
      // Typeahead identities must match the name, not just the person's topic.
      if (creator.username.toLowerCase().startsWith(input.raw.toLowerCase().replace(/^#/, ""))) suggestions.push({ label: creator.username, type: "creator" });
    }
    for (const topic of topics.data ?? []) suggestions.push({ label: topic.label, type: "topic" });
    for (const offering of matches.data?.offerings ?? []) suggestions.push({ label: offering.title, type: "offering" });
    return NextResponse.json({ suggestions: suggestions.slice(0,10), topics: topics.data ?? [] });
  } catch (error) {
    console.error("[search/suggest]", error);
    return NextResponse.json({ error: "Suggestions unavailable." }, { status: 503 });
  }
}
