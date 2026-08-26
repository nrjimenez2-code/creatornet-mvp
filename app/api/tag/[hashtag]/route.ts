import { NextRequest, NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type TagPost = {
  id: string;
  title: string | null;
  content: string | null;
  video_url: string | null;
  poster_url: string | null;
  interests: string[] | null;
  hashtags: string[] | null;
  creator_id: string;
  product_id: string | null;
  price_cents: number | null;
  allow_booking: boolean | null;
  booking_url: string | null;
  created_at: string;
  likes_count?: number | null;
  comments_count?: number | null;
  shares_count?: number | null;
  product_type?: string | null;
  creator?: {
    username: string | null;
    full_name: string | null;
    avatar_url: string | null;
  } | null;
};

const BASE_SELECT = `
  id,
  title,
  content,
  video_url,
  poster_url,
  interests,
  hashtags,
  creator_id,
  product_id,
  price_cents,
  allow_booking,
  booking_url,
  created_at,
  likes_count,
  comments_count,
  shares_count
`;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ hashtag: string }> }
) {
  try {
    const { hashtag } = await params;
    const rawTag = decodeURIComponent(hashtag || "").trim();
    const normalizedTag = rawTag.toLowerCase();
    if (!rawTag) {
      return NextResponse.json({ items: [], hasMore: false, nextOffset: 0 });
    }

    const limit = Math.min(
      Math.max(Number(req.nextUrl.searchParams.get("limit") || 12), 1),
      30
    );
    const offset = Math.max(Number(req.nextUrl.searchParams.get("offset") || 0), 0);
    const take = offset + limit;

    const tagPattern = `%${normalizedTag}%`;
    const captionTagPattern = `%#${normalizedTag}%`;
    const titleCaseTag = rawTag
      .split(/\s+/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");

    const [fromHashtags, fromCaption, fromInterestsRaw, fromInterestsLower, fromInterestsTitle] = await Promise.all([
      supabaseAdmin
        .from("posts")
        .select(BASE_SELECT)
        .ilike("hashtags", tagPattern)
        .order("created_at", { ascending: false })
        .limit(Math.max(take, limit)),
      supabaseAdmin
        .from("posts")
        .select(BASE_SELECT)
        .ilike("content", captionTagPattern)
        .order("created_at", { ascending: false })
        .limit(Math.max(take, limit)),
      supabaseAdmin
        .from("posts")
        .select(BASE_SELECT)
        .contains("interests", [rawTag])
        .order("created_at", { ascending: false })
        .limit(Math.max(take, limit)),
      supabaseAdmin
        .from("posts")
        .select(BASE_SELECT)
        .contains("interests", [normalizedTag])
        .order("created_at", { ascending: false })
        .limit(Math.max(take, limit)),
      supabaseAdmin
        .from("posts")
        .select(BASE_SELECT)
        .contains("interests", [titleCaseTag])
        .order("created_at", { ascending: false })
        .limit(Math.max(take, limit)),
    ]);

    if (fromHashtags.error) {
      console.error("[api/tag] hashtag search error:", fromHashtags.error.message);
    }
    if (fromCaption.error) {
      console.error("[api/tag] caption search error:", fromCaption.error.message);
    }
    if (fromInterestsRaw.error) {
      console.error("[api/tag] interests(raw) search error:", fromInterestsRaw.error.message);
    }
    if (fromInterestsLower.error) {
      console.error("[api/tag] interests(lower) search error:", fromInterestsLower.error.message);
    }
    if (fromInterestsTitle.error) {
      console.error("[api/tag] interests(title) search error:", fromInterestsTitle.error.message);
    }

    const merged: TagPost[] = [];
    const seen = new Set<string>();
    const rows = [
      ...((fromHashtags.data ?? []) as TagPost[]),
      ...((fromCaption.data ?? []) as TagPost[]),
      ...((fromInterestsRaw.data ?? []) as TagPost[]),
      ...((fromInterestsLower.data ?? []) as TagPost[]),
      ...((fromInterestsTitle.data ?? []) as TagPost[]),
    ];
    for (const row of rows) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    merged.sort((a, b) => {
      const at = new Date(a.created_at).getTime();
      const bt = new Date(b.created_at).getTime();
      return bt - at;
    });

    const creatorIds = Array.from(
      new Set(merged.map((p) => p.creator_id).filter(Boolean))
    );
    const productIds = Array.from(
      new Set(merged.map((p) => p.product_id).filter(Boolean))
    ) as string[];
    const profileMap = new Map<
      string,
      { username: string | null; full_name: string | null; avatar_url: string | null }
    >();
    const productMap = new Map<
      string,
      { type: string | null; price: number | null }
    >();

    if (creatorIds.length > 0) {
      const { data: profs, error: profErr } = await supabaseAdmin
        .from("profiles")
        .select("id, username, full_name, avatar_url")
        .in("id", creatorIds);
      if (profErr) {
        console.error("[api/tag] profiles lookup error:", profErr.message);
      } else {
        for (const p of profs ?? []) {
          profileMap.set(p.id, {
            username: p.username ?? null,
            full_name: p.full_name ?? null,
            avatar_url: p.avatar_url ?? null,
          });
        }
      }
    }

    if (productIds.length > 0) {
      const { data: products, error: prodErr } = await supabaseAdmin
        .from("products")
        .select("product_id, type, amount_cents, price_cents")
        .in("product_id", productIds);
      if (prodErr) {
        console.error("[api/tag] product lookup error:", prodErr.message);
      } else {
        for (const p of products ?? []) {
          const derivedPrice =
            (typeof p.amount_cents === "number" && p.amount_cents > 0
              ? p.amount_cents
              : null) ??
            (typeof p.price_cents === "number" && p.price_cents > 0
              ? p.price_cents
              : null);
          productMap.set(p.product_id, {
            type: p.type ?? null,
            price: derivedPrice,
          });
        }
      }
    }

    const enriched = merged.map((row) => ({
      ...row,
      product_type: row.product_id ? (productMap.get(row.product_id)?.type ?? null) : null,
      price_cents:
        (typeof row.price_cents === "number" && row.price_cents > 0
          ? row.price_cents
          : null) ??
        (row.product_id ? (productMap.get(row.product_id)?.price ?? null) : null),
      creator: profileMap.get(row.creator_id) ?? null,
    }));
    const paged = enriched.slice(offset, offset + limit);
    const nextOffset = offset + paged.length;
    const hasMore = nextOffset < enriched.length;

    return NextResponse.json({
      items: paged,
      hasMore,
      nextOffset,
      tag: normalizedTag,
    });
  } catch (err) {
    console.error("[api/tag] error:", err);
    return NextResponse.json(
      { error: publicMessage("tag", err, "Failed to load tag feed") },
      { status: 500 }
    );
  }
}

