// app/api/search/perform/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type CreatorHit = {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  tagline: string | null;
};

type PostHit = {
  id: string;
  content: string | null;
  media_url: string | null;
  poster_url: string | null;
  creator_id: string;
  created_at: string;
  likes_count?: number;
  creator: {
    username: string | null;
    full_name: string | null;
    tagline: string | null;
    avatar_url: string | null;
  } | null;
};

type RawPostRow = {
  id: string;
  content: string | null;
  video_url: string | null;
  poster_url: string | null;
  creator_id: string;
  created_at: string;
  likes_count?: number | null;
  creator?:
    | null
    | {
        username?: string | null;
        full_name?: string | null;
        tagline?: string | null;
        avatar_url?: string | null;
      }
    | Array<{
        username?: string | null;
        full_name?: string | null;
        tagline?: string | null;
        avatar_url?: string | null;
      }>;
};

function normalizePost(r: RawPostRow): PostHit {
  const rawCreator = r.creator;
  const c = Array.isArray(rawCreator) ? rawCreator[0] ?? null : rawCreator ?? null;
  return {
    id: r.id,
    content: r.content ?? null,
    media_url: r.video_url ?? null,
    poster_url: r.poster_url ?? null,
    creator_id: r.creator_id,
    created_at: r.created_at,
    likes_count: typeof r.likes_count === "number" ? r.likes_count : undefined,
    creator: c
      ? {
          username: c.username ?? null,
          full_name: c.full_name ?? null,
          tagline: c.tagline ?? null,
          avatar_url: c.avatar_url ?? null,
        }
      : null,
  };
}

const postSelect = `
  id,
  content,
  video_url,
  poster_url,
  creator_id,
  created_at,
  likes_count
`;

export async function POST(req: Request) {
  try {
    const { q } = (await req.json().catch(() => ({}))) as { q?: string };
    const query = (q ?? "").trim();
    const admin = supabaseAdmin;

    if (!query) {
      return NextResponse.json({ creators: [], items: [] });
    }

    const isHashtag = query.startsWith("#");
    const tag = isHashtag ? query.slice(1).toLowerCase().trim() : "";

    // —— #tag: top posts by likes ——
    if (isHashtag && tag) {
      const tagPattern = `%${tag}%`;
      const captionTagPattern = `%#${tag}%`;
      const [fromHashtags, fromCaption] = await Promise.all([
        admin
          .from("posts")
          .select(postSelect)
          .ilike("hashtags", tagPattern)
          .order("likes_count", { ascending: false, nullsFirst: false })
          .limit(30),
        admin
          .from("posts")
          .select(postSelect)
          .ilike("content", captionTagPattern)
          .order("likes_count", { ascending: false, nullsFirst: false })
          .limit(30),
      ]);

      if (fromHashtags.error) {
        console.error("[search/perform] hashtag(text) error:", fromHashtags.error.message);
      }
      if (fromCaption.error) {
        console.error("[search/perform] hashtag(caption) error:", fromCaption.error.message);
      }

      const merged: RawPostRow[] = [];
      const seenIds = new Set<string>();
      for (const row of [
        ...((fromHashtags.data ?? []) as RawPostRow[]),
        ...((fromCaption.data ?? []) as RawPostRow[]),
      ]) {
        if (!row?.id || seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        merged.push(row);
      }
      merged.sort((a, b) => (b.likes_count ?? 0) - (a.likes_count ?? 0));
      const items: PostHit[] = merged.slice(0, 30).map(normalizePost);
      return NextResponse.json({ creators: [], items, isTagSearch: true });
    }

    // —— Text/name search: creators + posts ——
    // 1) Find creators by username or full_name (two queries to avoid .or() URL-encoding % in pattern)
    const pattern = `%${query}%`;
    const [byUsername, byFullName] = await Promise.all([
      admin
        .from("profiles")
        .select("id, username, full_name, avatar_url, tagline")
        .ilike("username", pattern)
        .limit(20),
      admin
        .from("profiles")
        .select("id, username, full_name, avatar_url, tagline")
        .ilike("full_name", pattern)
        .limit(20),
    ]);

    const seen = new Set<string>();
    const creators: CreatorHit[] = [];
    for (const row of [...(byUsername.data ?? []), ...(byFullName.data ?? [])]) {
      const id = row?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      creators.push({
        id,
        username: row.username ?? null,
        full_name: row.full_name ?? null,
        avatar_url: row.avatar_url ?? null,
        tagline: row.tagline ?? null,
      });
    }
    creators.splice(20); // keep at most 20

    const creatorIds = creators.map((c) => c.id);

    // 2) Posts:
    // - If creators matched, return ONLY those creators' posts.
    // - If no creators matched, fall back to caption search.
    let postData: RawPostRow[] | null = null;
    if (creatorIds.length > 0) {
      const byCreator = await admin
        .from("posts")
        .select(postSelect)
        .in("creator_id", creatorIds)
        .order("created_at", { ascending: false })
        .limit(30);
      if (byCreator.error) {
        console.error("[search/perform] byCreator error:", byCreator.error.message);
        postData = [];
      } else {
        postData = (byCreator.data ?? []) as RawPostRow[];
      }
    } else {
      const res = await admin.from("posts").select(postSelect).ilike("content", pattern).order("created_at", { ascending: false }).limit(30);
      if (res.error) {
        console.error("[search/perform] caption-only error:", res.error.message);
        postData = [];
      } else {
        postData = res.data as RawPostRow[] | null;
      }
    }

    const items: PostHit[] = (postData ?? []).map(normalizePost);

    // 3) No creators found → suggest random creators + their posts
    let noUserFound = false;
    let suggested_creators: CreatorHit[] = [];
    let suggested_posts: PostHit[] = [];

    if (creators.length === 0) {
      noUserFound = true;
      const { data: suggestedProfiles } = await admin
        .from("profiles")
        .select("id, username, full_name, avatar_url, tagline")
        .limit(6);

      suggested_creators = (suggestedProfiles ?? []).map((p: any) => ({
        id: p.id,
        username: p.username ?? null,
        full_name: p.full_name ?? null,
        avatar_url: p.avatar_url ?? null,
        tagline: p.tagline ?? null,
      }));

      const suggestedIds = suggested_creators.map((c) => c.id);
      if (suggestedIds.length > 0) {
        const { data: suggestedPostRows } = await admin
          .from("posts")
          .select(postSelect)
          .in("creator_id", suggestedIds)
          .order("created_at", { ascending: false })
          .limit(12);

        suggested_posts = (suggestedPostRows as RawPostRow[] | null)?.map(normalizePost) ?? [];
      }
    }

    return NextResponse.json({
      creators,
      items,
      noUserFound,
      suggested_creators: noUserFound ? suggested_creators : undefined,
      suggested_posts: noUserFound ? suggested_posts : undefined,
    });
  } catch (err: unknown) {
    console.error("[search/perform]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 }
    );
  }
}
