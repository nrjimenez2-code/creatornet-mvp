import { NextRequest, NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { createServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isSafeId } from "@/lib/ids";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

/**
 * GET /api/users/[userId]/follows?type=followers|following&cursor=<created_at>|<otherId>&limit=<=25
 *
 * Paginated follower / following list for one account. Keyset pagination on
 * (created_at desc, other id desc) so a follow that lands mid-scroll cannot
 * shift the page and duplicate a row. Reads `follows` with the service role
 * (mirrors app/api/follow) and hydrates `profiles` the same way, since
 * profiles has no cross-user SELECT policy. Sign-in required so the list is
 * not a public scrape target — same stance as /api/profiles.
 */

// Sixty a minute per address: a person paging a list needs a handful.
const FOLLOW_LIST_RATE = { limit: 60, windowMs: 60_000 };
const MAX_PAGE_SIZE = 25;
const CURSOR_SEPARATOR = "|";
// ISO timestamp as PostgREST returns it (Z or a numeric offset). Anything
// else is refused before it can reach the .or() filter string.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

type ListType = "followers" | "following";
type Cursor = { createdAt: string; id: string };
type FollowRow = { created_at: string | null } & Record<string, string | null>;
type ProfileRow = { id: string; username: string | null; full_name: string | null; avatar_url: string | null };

function parseLimit(raw: string | null): number {
  if (raw === null) return MAX_PAGE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return MAX_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

/** Returns null for "no cursor", undefined for a malformed one. */
function parseCursor(raw: string | null): Cursor | null | undefined {
  if (raw === null || raw === "") return null;
  const at = raw.indexOf(CURSOR_SEPARATOR);
  if (at <= 0) return undefined;
  const createdAt = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!TIMESTAMP.test(createdAt) || !isSafeId(id)) return undefined;
  return { createdAt, id };
}

function encodeCursor(row: FollowRow, otherCol: string): string | null {
  const createdAt = row.created_at;
  const id = row[otherCol];
  if (!createdAt || !id) return null;
  return `${createdAt}${CURSOR_SEPARATOR}${id}`;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  if (!allowRequest(`follow-list:${clientKey(req)}`, FOLLOW_LIST_RATE)) {
    return tooManyRequests();
  }

  try {
    const supabase = createServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId } = await params;
    if (!isSafeId(userId)) {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }

    const searchParams = new URL(req.url).searchParams;
    const type = searchParams.get("type");
    if (type !== "followers" && type !== "following") {
      return NextResponse.json({ error: "type must be followers or following" }, { status: 400 });
    }

    const cursor = parseCursor(searchParams.get("cursor"));
    if (cursor === undefined) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }

    const limit = parseLimit(searchParams.get("limit"));
    const listType: ListType = type;
    // followers = rows where this account is being followed; the "other" side
    // is who did the following. Mirror image for following.
    const ownCol = listType === "followers" ? "following_id" : "follower_id";
    const otherCol = listType === "followers" ? "follower_id" : "following_id";

    let query = supabaseAdmin
      .from("follows")
      .select(`${otherCol}, created_at`)
      .eq(ownCol, userId);

    if (cursor) {
      // Strictly after the cursor row in (created_at desc, other id desc)
      // order. Both values were validated above, so the filter string is safe.
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},${otherCol}.lt.${cursor.id})`
      );
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order(otherCol, { ascending: false })
      .limit(limit + 1);

    if (error) {
      console.error("[api/users/follows] follows query error:", error);
      return NextResponse.json(
        { error: publicMessage("follow-list", error, "Could not load list.") },
        { status: 500 }
      );
    }

    const rows = (data ?? []) as FollowRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page
      .map((row) => row[otherCol])
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const profilesById = new Map<string, ProfileRow>();
    if (ids.length > 0) {
      const { data: profiles, error: profilesError } = await supabaseAdmin
        .from("profiles")
        .select("id, username, full_name, avatar_url")
        .in("id", ids);

      if (profilesError) {
        console.error("[api/users/follows] profiles query error:", profilesError);
        return NextResponse.json(
          { error: publicMessage("follow-list", profilesError, "Could not load list.") },
          { status: 500 }
        );
      }
      for (const p of (profiles ?? []) as ProfileRow[]) {
        profilesById.set(p.id, p);
      }
    }

    // A follow row whose profile is missing still counts (the stat counts it
    // too), so it renders with the id and fallbacks rather than vanishing.
    const items = ids.map((id) => {
      const profile = profilesById.get(id);
      return {
        id,
        username: profile?.username ?? null,
        full_name: profile?.full_name ?? null,
        avatar_url: profile?.avatar_url ?? null,
      };
    });

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last, otherCol) : null;

    return NextResponse.json({ items, nextCursor });
  } catch (err) {
    console.error("[api/users/follows] Unexpected error:", err);
    return NextResponse.json(
      { error: publicMessage("follow-list", err, "Could not load list.") },
      { status: 500 }
    );
  }
}
