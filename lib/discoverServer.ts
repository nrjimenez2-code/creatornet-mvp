import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { createServerClient } from "@/lib/supabaseServer";
import {
  rankDiscover,
  type DiscoverCandidate,
  type DiscoverEvent,
  type DiscoverEvidence,
} from "@/lib/discoverRanking";
import { matchInterestTopics, normalizeTopics } from "@/lib/interestTopics";
import { isUnreliableVideoUrl } from "@/lib/feedV3";
import { isSellReadyProfile } from "@/lib/sellReady";
export const discoverEnabled = () => process.env.DISCOVER_V4_ENABLED === "true";
const COOKIE = "cn_discover_actor";
function sign(value: string) {
  return createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY!)
    .update("discover-actor:" + value)
    .digest("hex");
}
export async function discoverIdentity(req: NextRequest) {
  const { data, error } = await createServerClient().auth.getUser();
  if (error && error.name !== "AuthSessionMissingError")
    throw new Error("Could not verify feed identity");
  const anonymous = verifiedAnonymousIdentity(req);
  if (data.user) {
    if (anonymous) await claimDiscoverIdentity(anonymous.id, data.user.id);
    return {
      actor: "user:" + data.user.id,
      userId: data.user.id,
      cookie: null,
      token: null,
    };
  }
  if (anonymous) {
    const { data: linked, error: linkError } = await admin
      .from("discover_identity_links_v1")
      .select("anonymous_id")
      .eq("anonymous_id", anonymous.id)
      .maybeSingle();
    if (linkError) throw linkError;
    // Rotate a claimed token after sign-out so shared browsers cannot attach
    // another person's future activity to the previously signed-in account.
    if (!linked)
      return {
        actor: "anon:" + anonymous.id,
        userId: null,
        cookie: null,
        token: anonymous.token,
      };
  }
  const next = randomUUID();
  return {
    actor: "anon:" + next,
    userId: null,
    cookie: next + "." + sign(next),
    token: next + "." + sign(next),
  };
}
function verifiedAnonymousIdentity(req: NextRequest) {
  const cookie =
    req.headers.get("x-cn-discover-actor") ??
    req.cookies.get(COOKIE)?.value ??
    "";
  const [id, sig] = cookie.split(".");
  if (
    /^[a-f0-9-]{36}$/.test(id ?? "") &&
    /^[a-f0-9]{64}$/.test(sig ?? "") &&
    timingSafeEqual(Buffer.from(sig), Buffer.from(sign(id)))
  ) {
    return { id, token: cookie };
  }
  return null;
}
async function claimDiscoverIdentity(anonymousId: string, userId: string) {
  const { error } = await admin.rpc("link_discover_identity_v1", {
    p_anonymous: anonymousId,
    p_user: userId,
  });
  if (error) throw error;
}
export async function linkDiscoverHistory(
  req: NextRequest,
  authenticatedUserId: string,
) {
  if (!discoverEnabled()) return;
  const anonymous = verifiedAnonymousIdentity(req);
  if (anonymous) await claimDiscoverIdentity(anonymous.id, authenticatedUserId);
}
export function setDiscoverCookie(
  response: NextResponse,
  cookie: string | null,
) {
  if (cookie)
    response.cookies.set(COOKIE, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
// Explicit keyset reads avoid PostgREST's default row cap. Only initial ranking scans.
async function readAll(
  table: string,
  columns: string,
  where?: { column: string; value: string },
  equal?: { column: string; value: string },
) {
  const rows: Record<string, any>[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = admin.from(table).select(columns).order("id").limit(1000);
    if (cursor) query = query.gt("id", cursor);
    if (where) query = query.gte(where.column, where.value);
    if (equal) query = query.eq(equal.column, equal.value);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
    cursor = String((data[data.length - 1] as unknown as { id: string }).id);
  }
}
const POST_COLUMNS =
  "id,creator_id,product_id,offering_id,title,content,caption,interests,topics,hashtags,created_at,video_url,poster_url,price_cents,allow_booking,booking_url,likes_count,comments_count,shares_count,purchase_count,active,hidden_at,removed_at";
async function byIds(
  table: string,
  columns: string,
  ids: string[],
  column = "id",
) {
  const result: Record<string, any>[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .in(column, ids.slice(offset, offset + 200));
    if (error) throw error;
    result.push(...(data ?? []));
  }
  return result;
}
export async function discoverInventory(
  ids?: string[],
): Promise<Record<string, any>[]> {
  const posts = ids
    ? await byIds("posts", POST_COLUMNS, ids)
    : await readAll("posts", POST_COLUMNS);
  const creatorIds = [
    ...new Set(posts.map((p) => p.creator_id).filter(Boolean)),
  ];
  const productIds = [
    ...new Set(posts.map((p) => p.product_id).filter(Boolean)),
  ];
  const offeringIds = [
    ...new Set(posts.map((p) => p.offering_id).filter(Boolean)),
  ];
  const productColumns =
    "id,product_id,creator_id,title,description,type,price_cents,amount_cents,active";
  const [profiles, primaryProducts, legacyProducts, offerings] =
    await Promise.all([
      byIds(
        "profiles",
        "id,full_name,username,avatar_url,banned_at,stripe_account_id,stripe_onboarding_complete",
        creatorIds,
      ),
      byIds("products", productColumns, productIds),
      byIds("products", productColumns, productIds, "product_id"),
      byIds(
        "offerings",
        "id,creator_id,title,type,product_metadata,is_active",
        offeringIds,
      ),
    ]);
  const products = [...primaryProducts, ...legacyProducts];
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const productsById = new Map(
    products.flatMap(
      (p) =>
        [
          [p.id, p],
          [p.product_id, p],
        ] as [string, Record<string, any>][],
    ),
  );
  const offeringsById = new Map(offerings.map((o) => [o.id, o]));
  return posts
    .filter(
      (p) =>
        profilesById.has(p.creator_id) &&
        !profilesById.get(p.creator_id)?.banned_at &&
        p.active !== false &&
        !p.hidden_at &&
        !p.removed_at &&
        ((p.video_url?.trim() && !isUnreliableVideoUrl(p.video_url)) ||
          p.poster_url?.trim()),
    )
    .map((p) => {
      const found = productsById.get(p.product_id),
        foundOffering = offeringsById.get(p.offering_id);
      const product =
        found?.active !== false && found?.creator_id === p.creator_id
          ? found
          : undefined;
      const offering =
        foundOffering?.is_active && foundOffering?.creator_id === p.creator_id
          ? foundOffering
          : undefined;
      return {
        ...p,
        profile: profilesById.get(p.creator_id),
        product,
        offer_type:
          product?.type ??
          offering?.type ??
          (p.allow_booking ? "free_call" : "none"),
        offers: [
          ...(product
            ? [{ title: product.title, description: product.description }]
            : []),
          ...(offering
            ? [
                {
                  title: offering.title,
                  description: offering.product_metadata?.description,
                },
              ]
            : []),
        ],
      };
    });
}
async function readFollowedCreators(userId: string) {
  const data: { following_id: string }[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = admin
      .from("follows")
      .select("following_id")
      .eq("follower_id", userId)
      .order("following_id")
      .limit(1000);
    if (cursor) query = query.gt("following_id", cursor);
    const page = await query;
    if (page.error) throw page.error;
    data.push(...(page.data ?? []));
    if (!page.data || page.data.length < 1000) return { data, error: null };
    cursor = page.data[page.data.length - 1].following_id;
  }
}
export async function createDiscoverSession(
  actor: string,
  userId: string | null,
  tab: string,
) {
  const [inventory, events, profile, following, legacy] = await Promise.all([
    discoverInventory(),
    tab === "following"
      ? Promise.resolve([])
      : readAll(
          "discover_events_v1",
          "id,actor,post_id,kind,categories,topics,audience,offer_type,occurred_at,valid",
          {
            column: "occurred_at",
            value: new Date(Date.now() - 90 * 86400000).toISOString(),
          },
          { column: "actor", value: actor },
        ),
    userId
      ? admin
          .from("profiles")
          .select("interests,interest_topics")
          .eq("id", userId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    userId
      ? readFollowedCreators(userId)
      : Promise.resolve({ data: [], error: null }),
    userId
      ? admin
          .from("interest_taxonomy_archive_v1")
          .select("original")
          .eq("source", "user_interest_scores")
          .like("row_key", userId + ":%")
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (profile.error || following.error || legacy.error)
    throw profile.error ?? following.error ?? legacy.error;
  const evidence: DiscoverEvidence[] = [];
  if (tab !== "following")
    for (let offset = 0; offset < inventory.length; offset += 200) {
      const { data, error } = await admin.rpc("discover_rank_evidence_v1", {
        p_posts: inventory.slice(offset, offset + 200).map((p) => p.id),
      });
      if (error || !Array.isArray(data))
        throw error ?? new Error("Ranking evidence unavailable");
      evidence.push(...(data as DiscoverEvidence[]));
    }
  const follows = new Set((following.data ?? []).map((f) => f.following_id));
  const ids =
    tab === "following"
      ? inventory
          .filter((p) => userId && follows.has(p.creator_id))
          .sort(
            (a, b) =>
              Date.parse(b.created_at) - Date.parse(a.created_at) ||
              b.id.localeCompare(a.id),
          )
          .map((p) => p.id)
      : rankDiscover(
          inventory as unknown as DiscoverCandidate[],
          events.filter((e) => e.valid !== false) as DiscoverEvent[],
          actor,
          profile.data?.interests,
          profile.data?.interest_topics,
          Date.now(),
          (legacy.data ?? []).map((row) => row.original),
          evidence,
        );
  const declared = profile.data?.interests ?? [];
  const declaredTopics = [
    ...new Set([
      ...(profile.data?.interest_topics ?? []),
      ...events
        .filter(
          (e) =>
            e.actor === actor &&
            e.valid !== false &&
            [
              "qualified_view",
              "completion",
              "like",
              "product_tap",
              "checkout_start",
              "booking_scheduled",
              "purchase",
              "mentorship_purchase",
            ].includes(e.kind) &&
            Date.now() - Date.parse(e.occurred_at) < 30 * 86400000,
        )
        .flatMap((e) => e.topics ?? []),
    ]),
  ];
  const audiences = Object.fromEntries(
    inventory.map((p) => {
      const match = matchInterestTopics({
        interests: p.interests,
        topics: p.topics,
        title: p.title,
        description: [p.content, p.caption].filter(Boolean).join(" "),
        offers: p.offers,
      });
      return [
        p.id,
        match.topics.find((t) => normalizeTopics(declaredTopics).includes(t)) ??
          match.categories.find((c) => declared.includes(c)) ??
          declared[0] ??
          "general",
      ];
    }),
  );
  const { data, error } = await admin
    .from("discover_sessions_v1")
    .insert({ actor, user_id: userId, tab, post_ids: ids, audiences })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}
export async function readDiscoverPage(
  sessionId: string,
  actor: string,
  offset: number,
  limit: number,
  userId: string | null,
) {
  const { data: session, error } = await admin
    .from("discover_sessions_v1")
    .select("post_ids,expires_at")
    .eq("id", sessionId)
    .eq("actor", actor)
    .single();
  if (error || !session) throw new Error("Feed session unavailable");
  if (Date.parse(session.expires_at) <= Date.now())
    throw new Error("Feed session expired; refresh to continue");
  const ids: string[] = session.post_ids;
  const selected = ids.slice(offset, offset + limit);
  if (!selected.length)
    return { items: [], nextOffset: ids.length, hasMore: false };
  // Recheck moderation on every page; the snapshot freezes order, not permissions.
  const inventory = await discoverInventory(selected);
  const [likes, follows] = await Promise.all([
    userId
      ? admin
          .from("likes")
          .select("post_id")
          .eq("user_id", userId)
          .in("post_id", selected)
      : Promise.resolve({ data: [], error: null }),
    userId
      ? admin
          .from("follows")
          .select("following_id")
          .eq("follower_id", userId)
          .in("following_id", [...new Set(inventory.map((p) => p.creator_id))])
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (likes.error || follows.error) throw likes.error ?? follows.error;
  const liked = new Set((likes.data ?? []).map((l) => l.post_id));
  const followed = new Set((follows.data ?? []).map((f) => f.following_id));
  const items = selected.flatMap((id) => {
    const p = inventory.find((row) => row.id === id);
    if (!p) return [];
    return [
      {
        post_id: p.id,
        creator_id: p.creator_id,
        product_id: p.product_id,
        title: p.title,
        interests: p.interests,
        hashtags: p.hashtags,
        created_at: p.created_at,
        video_url: p.video_url,
        poster_url: p.poster_url,
        price_cents: p.price_cents,
        allow_booking: p.allow_booking,
        booking_url: p.booking_url,
        likes_count: p.likes_count,
        comments_count: p.comments_count,
        shares_count: p.shares_count,
        purchase_count: p.purchase_count,
        creator_name: userId ? p.profile?.full_name : null,
        creator_username: userId ? p.profile?.username : null,
        creator_avatar_url: userId ? p.profile?.avatar_url : null,
        creator_verified: isSellReadyProfile(p.profile),
        product_type: p.product?.type,
        product_price_cents: p.product?.amount_cents || p.product?.price_cents,
        is_liked: liked.has(p.id),
        is_following: followed.has(p.creator_id),
      },
    ];
  });
  if (!items.length && offset + limit < ids.length)
    return readDiscoverPage(sessionId, actor, offset + limit, limit, userId);
  return {
    items,
    nextOffset: Math.min(ids.length, offset + limit),
    hasMore: offset + limit < ids.length,
  };
}
export async function recordDiscoverEvent(input: {
  actor: string;
  userId: string | null;
  postId: string;
  kind: string;
  entityKey: string;
  audience?: string;
  amountCents?: number;
  currency?: string;
}) {
  const { data: p, error } = await admin
    .from("posts")
    .select(
      "id,creator_id,interests,topics,title,content,caption,product_id,offering_id,allow_booking",
    )
    .eq("id", input.postId)
    .single();
  if (error) throw error;
  if (!p?.creator_id || p.creator_id === input.userId) return;
  const productColumns =
    "id,product_id,creator_id,title,description,type,active";
  const [products, legacyProducts, offerings] = await Promise.all([
    p.product_id
      ? byIds("products", productColumns, [p.product_id])
      : Promise.resolve([]),
    p.product_id
      ? byIds("products", productColumns, [p.product_id], "product_id")
      : Promise.resolve([]),
    p.offering_id
      ? byIds(
          "offerings",
          "id,creator_id,title,type,product_metadata,is_active",
          [p.offering_id],
        )
      : Promise.resolve([]),
  ]);
  const foundProduct = products[0] ?? legacyProducts[0];
  const product =
    foundProduct?.creator_id === p.creator_id && foundProduct?.active !== false
      ? foundProduct
      : undefined;
  const offering = offerings.find(
    (row) => row.creator_id === p.creator_id && row.is_active,
  );
  const offers = [
    ...(product
      ? [{ title: product.title, description: product.description }]
      : []),
    ...(offering
      ? [
          {
            title: offering.title,
            description: offering.product_metadata?.description,
          },
        ]
      : []),
  ];
  const { categories, topics } = matchInterestTopics({
    interests: p.interests,
    topics: p.topics,
    title: p.title,
    description: [p.content, p.caption].filter(Boolean).join(" "),
    offers,
  });
  let audience = input.audience;
  if (!audience) {
    const { data: exposure, error: exposureError } = await admin
      .from("discover_events_v1")
      .select("audience")
      .eq("actor", input.actor)
      .eq("post_id", input.postId)
      .eq("kind", "exposure")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (exposureError) throw exposureError;
    audience = exposure?.audience ?? "general";
  }
  const { error: writeError } = await admin.from("discover_events_v1").upsert(
    {
      actor: input.actor,
      user_id: input.userId,
      post_id: p.id,
      creator_id: p.creator_id,
      kind: input.kind,
      entity_key: input.entityKey,
      categories,
      topics,
      audience,
      offer_type:
        product?.type ??
        offering?.type ??
        (p.allow_booking ? "free_call" : "none"),
      amount_cents: input.amountCents ?? 0,
      currency: input.currency ?? null,
    },
    { onConflict: "kind,entity_key", ignoreDuplicates: true },
  );
  if (writeError) throw writeError;
}
