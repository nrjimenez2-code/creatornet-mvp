import { NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isSafeId } from "@/lib/ids";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

// Unauthenticated and running on the service-role client, so the query string
// is the only thing bounding this route's work. Same cap and id check as
// /api/posts/creators, which had the identical shape.
const MAX_POST_IDS = 200;

// The only caller sends ONE id, from the Buy button, and cannot fire while a
// checkout is already in flight. 120 is far above any human tapping Buy.
const PRODUCT_IDS_RATE = { limit: 120, windowMs: 60_000 };

/**
 * GET /api/posts/product-ids?ids=id1,id2,id3
 * Returns { "postId": "productId" | null } for each requested post (posts table uses "id" as PK).
 */
export async function GET(req: Request) {
  if (!allowRequest(`product-ids:${clientKey(req)}`, PRODUCT_IDS_RATE)) return tooManyRequests();
  try {
    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("ids");
    if (!idsParam || !idsParam.trim()) {
      return NextResponse.json({});
    }
    // Cap and validate before this reaches the database. Without the cap an
    // anonymous caller could pass 100k ids and make the service-role client
    // build one enormous IN (...); without the id check, junk strings hit a
    // uuid column and fail the whole batch.
    const ids = idsParam
      .split(",")
      .map((id) => id.trim())
      .filter((id): id is string => isSafeId(id))
      .slice(0, MAX_POST_IDS);
    if (ids.length === 0) return NextResponse.json({});

    const { data, error } = await supabaseAdmin
      .from("posts")
      .select("id, product_id")
      .in("id", ids);

    if (error) {
      return NextResponse.json({ error: publicMessage("product-ids", error, "Could not load products.") }, { status: 400 });
    }

    const map: Record<string, string | null> = {};
    for (const id of ids) {
      map[id] = null;
    }
    for (const row of data ?? []) {
      const r = row as { id: string; product_id: string | null };
      map[r.id] = r.product_id ?? null;
    }
    return NextResponse.json(map);
  } catch (e: any) {
    return NextResponse.json({ error: publicMessage("product-ids", e, "Server error") }, { status: 500 });
  }
}
