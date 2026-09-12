import { after, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { interpretSearch, SEARCH_PAGE_SIZE } from "@/lib/searchQuery";

const SEARCH_RATE = { limit: 60, windowMs: 60_000 };
export const maxDuration = 180;

export async function POST(req: Request) {
  if (!allowRequest(`search:${clientKey(req)}`, SEARCH_RATE)) return tooManyRequests();
  let input: ReturnType<typeof interpretSearch>;
  let page: number;
  try {
    const body = await req.json();
    input = interpretSearch(body?.q);
    page = body?.page ?? 0;
    if (!Number.isInteger(page) || page < 0 || page > 500) throw new Error("Invalid search page.");
  } catch {
    return NextResponse.json({ error: "Enter a valid search of up to 160 characters and a valid page." }, { status: 400 });
  }
  if (!input.normalized) {
    return NextResponse.json({ creators: [], items: [], offerings: [], totals: { creators: 0, videos: 0, offerings: 0 }, page, page_size: SEARCH_PAGE_SIZE });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc("search_relevance_v1", {
      query_text: input.normalized,
      related_terms: input.related,
      page_number: page,
      page_size: SEARCH_PAGE_SIZE,
      identity_query: input.raw.replace(/^#/, ""),
    });
    if (error || !data) throw error ?? new Error("Missing search response");
    // Wake the durable queue after delivering results. A database lease admits
    // only one extraction, regardless of how many visitors search concurrently.
    if (process.env.VERCEL === "1") after(async () => {
      try { const { processNextSearchVideo } = await import("@/lib/searchVideoText"); await processNextSearchVideo(); }
      catch { console.warn("[search/video] queue processing needs retry"); }
    });
    return NextResponse.json({ ...data, isTagSearch: input.isTagSearch, normalized_query: input.normalized });
  } catch (error) {
    console.error("[search/perform] search failed", error);
    return NextResponse.json({ error: "Search isn't working right now. Please try again." }, { status: 503 });
  }
}
