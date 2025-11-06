// app/api/search/perform/route.ts
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";

type PostHit = {
  id: string;
  caption: string | null;
  media_url: string | null;   // from video_url
  creator_id: string;
  created_at: string;
  creator: {
    username: string | null;
    tagline: string | null;
    avatar_url: string | null;
  } | null;
};

// Allow for creator to sometimes be an array (depending on FK setup)
type RawRow = {
  id: string;
  caption: string | null;
  video_url: string | null;
  creator_id: string;
  created_at: string;
  // could be object, null, or [] depending on join behavior
  creator?:
    | null
    | {
        username?: string | null;
        tagline?: string | null;
        avatar_url?: string | null;
      }
    | Array<{
        username?: string | null;
        tagline?: string | null;
        avatar_url?: string | null;
      }>;
};

export async function POST(req: Request) {
  try {
    const supabase = createServerClient();
    const { q } = (await req.json().catch(() => ({}))) as { q?: string };

    const query = (q ?? "").trim();
    const isHashtag = query.startsWith("#");
    const tag = isHashtag ? query.slice(1).toLowerCase() : "";

    // NOTE: If your FK hint differs, replace !posts_creator_id_fkey accordingly
    let sel = supabase
      .from("posts")
      .select(
        `
        id,
        caption,
        video_url,
        creator_id,
        created_at,
        creator:profiles!posts_creator_id_fkey(
          username,
          tagline,
          avatar_url
        )
      `
      )
      .order("created_at", { ascending: false })
      .limit(30);

    if (isHashtag && tag) {
      sel = sel.overlaps("hashtags", [tag]);
    } else if (query) {
      const like = `%${query}%`;
      sel = sel.or(`caption.ilike.${like},niche.ilike.${like}`);
    }

    const { data, error } = await sel;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // Normalize creator to a single object (or null) and rename video_url -> media_url
    const items: PostHit[] = (data as RawRow[] | null)?.map((r) => {
      const rawCreator = r.creator;
      const c =
        Array.isArray(rawCreator)
          ? rawCreator[0] ?? null
          : rawCreator ?? null;

      return {
        id: r.id,
        caption: r.caption ?? null,
        media_url: r.video_url ?? null,
        creator_id: r.creator_id,
        created_at: r.created_at,
        creator: c
          ? {
              username: c.username ?? null,
              tagline: c.tagline ?? null,
              avatar_url: c.avatar_url ?? null,
            }
          : null,
      };
    }) ?? [];

    return NextResponse.json({ items });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Search failed" },
      { status: 500 }
    );
  }
}
