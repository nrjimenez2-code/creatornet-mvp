import { NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * GET /api/posts/product-ids?ids=id1,id2,id3
 * Returns { "postId": "productId" | null } for each requested post (posts table uses "id" as PK).
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("ids");
    if (!idsParam || !idsParam.trim()) {
      return NextResponse.json({});
    }
    const ids = idsParam
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
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
