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
  type DiscoverPlacement,
} from "@/lib/discoverRanking";
import { matchInterestTopics, normalizeTopics } from "@/lib/interestTopics";
import { isUnreliableVideoUrl } from "@/lib/feedV3";
import { isSellReadyProfile } from "@/lib/sellReady";
import { assignDiscoverPilot } from "@/lib/discoverPilot";
import { inFlightRead } from "@/lib/inFlightRead";
import { discoverSharedRead } from "@/lib/discoverSharedRead";
import { observeDiscoverSharedRead } from "@/lib/discoverSharedReadTiming";
import { readDiscoverEvidenceBatches } from "@/lib/discoverEvidenceBatches";
import { DiscoverSessionUnavailableError } from "@/lib/discoverFeedError";
const initialInventoryRead = inFlightRead<Record<string, any>[]>();
const rankingEvidenceRead = inFlightRead<DiscoverEvidence[]>();
export const discoverEnabled = () => process.env.DISCOVER_V4_ENABLED === "true";
const COOKIE = "cn_discover_actor";
function sign(value: string) {
  return createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY!)
    .update("discover-actor:" + value)
    .digest("hex");
}
export async function discoverIdentity(req: NextRequest) {
  return resolveDiscoverIdentity(req, false);
}
// This is only a verified token, not an authorized feed/event actor. The private
// page RPC must freshly check its claim before it can return an owned page.
export type DiscoverAnonymousPageCandidate = {
  anonymousPageCandidate: true;
  anonymousId: string;
  token: string;
};
export async function discoverExistingPageIdentity(req: NextRequest) {
  if (!discoverEnabled() || !req.nextUrl.searchParams.has('session') ||
      process.env.DISCOVER_ANON_PAGE_ENABLED !== 'true' ||
      process.env.DISCOVER_PAGE_INVENTORY_ENABLED !== 'true' ||
      process.env.DISCOVER_COMPACT_PAGE_ENABLED !== 'true')
    return discoverIdentity(req);
  const verified = await verifyDiscoverIdentity(req);
  if (!verified.user && verified.anonymous) {
    const candidate: DiscoverAnonymousPageCandidate = {
      anonymousPageCandidate: true,
      anonymousId: verified.anonymous.id,
      token: verified.anonymous.token,
    };
    return candidate;
  }
  return resolveVerifiedDiscoverIdentity(verified, false);
}
// An event candidate cannot create/read feed sessions. Its anonymous claim check
// is resolved by loadDiscoverEventContext before it becomes an event actor.
export type DiscoverEventIdentity = {
  actorCandidate: string;
  userId: string | null;
  anonymousClaimCheck: 'context' | 'complete';
};
export async function discoverEventIdentity(req: NextRequest): Promise<DiscoverEventIdentity> {
  const deferred = process.env.DISCOVER_EVENT_CONTEXT_ENABLED === 'true';
  const identity = await resolveDiscoverIdentity(req, deferred);
  return { actorCandidate: identity.actor, userId: identity.userId, anonymousClaimCheck: deferred ? 'context' : 'complete' };
}
async function resolveDiscoverIdentity(req: NextRequest, deferAnonymousClaimCheck: boolean) {
  return resolveVerifiedDiscoverIdentity(await verifyDiscoverIdentity(req), deferAnonymousClaimCheck);
}
async function verifyDiscoverIdentity(req: NextRequest) {
  const { data, error } = await createServerClient().auth.getUser();
  if (error && error.name !== "AuthSessionMissingError")
    throw new Error("Could not verify feed identity");
  return { user: data.user, anonymous: verifiedAnonymousIdentity(req) };
}
async function resolveVerifiedDiscoverIdentity(
  {user, anonymous}: Awaited<ReturnType<typeof verifyDiscoverIdentity>>,
  deferAnonymousClaimCheck: boolean,
) {
  if (user) {
    if (anonymous) await claimDiscoverIdentity(anonymous.id, user.id);
    return {
      actor: "user:" + user.id,
      newAnonymous: false,
      userId: user.id,
      cookie: null,
      token: null,
    };
  }
  if (anonymous) {
    if (deferAnonymousClaimCheck)
      return {
        actor: "anon:" + anonymous.id,
        newAnonymous: false,
        userId: null,
        cookie: null,
        token: anonymous.token,
      };
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
        newAnonymous: false,
        userId: null,
        cookie: null,
        token: anonymous.token,
      };
  }
  const next = randomUUID();
  return {
    actor: "anon:" + next,
    newAnonymous: true,
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
  preloaded?: Record<string, any>,
): Promise<Record<string, any>[]> {
  let posts: Record<string, any>[], profiles: Record<string, any>[],
    primaryProducts: Record<string, any>[], legacyProducts: Record<string, any>[],
    offerings: Record<string, any>[];
  if (preloaded || (ids && process.env.DISCOVER_BATCH_INVENTORY_ENABLED === 'true')) {
    const {data,error} = preloaded ? {data:preloaded,error:null} : await admin.rpc('discover_inventory_batch_v1',{p_ids:ids});
    if(error) throw error;
    if(!data || !['posts','profiles','primaryProducts','legacyProducts','offerings']
      .every(key => Array.isArray(data[key]))) throw new Error('Inventory batch unavailable');
    ({posts,profiles,primaryProducts,legacyProducts,offerings}=data);
  } else {
  posts = ids
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
  [profiles, primaryProducts, legacyProducts, offerings] =
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
  }
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
export type DiscoverSessionPhase =
  | 'sessionpilot' | 'sessioninput' | 'sessionevidence'
  | 'sessionrank' | 'sessionaudience' | 'sessionwrite' | 'sessionwritepage';
export async function createDiscoverSession(
  actor: string, userId: string | null, tab: string, newAnonymous = false,
  onPhase?: (phase: DiscoverSessionPhase, durationMs: number) => void,
) {
  return (await prepareDiscoverSession(actor,userId,tab,newAnonymous,onPhase)).id;
}
export async function createDiscoverSessionWithFirstPage(
  actor: string, userId: string | null, tab: string, newAnonymous: boolean,
  offset: number, limit: number,
  onPhase?: (phase: DiscoverSessionPhase, durationMs: number) => void,
) {
  const saved = await prepareDiscoverSession(actor,userId,tab,newAnonymous,onPhase,{offset,limit});
  const result = await renderDiscoverPage(saved.page,offset,limit,userId,
    nextOffset => readDiscoverPage(saved.id,actor,nextOffset,limit,userId));
  return {session:saved.id,result};
}
async function prepareDiscoverSession(
  actor: string,
  userId: string | null,
  tab: string,
  newAnonymous = false,
  onPhase?: (phase: DiscoverSessionPhase, durationMs: number) => void,
  firstPage?: {offset:number;limit:number},
) {
  // Per-call numeric diagnostics; no actor data or shared timing state.
  let phaseStarted = onPhase ? performance.now() : 0;
  const mark = (phase: DiscoverSessionPhase) => {
    if (!onPhase) return;
    const duration = performance.now() - phaseStarted;
    try { onPhase(phase, duration); } catch { /* Diagnostics cannot fail a feed. */ }
    phaseStarted = performance.now();
  };
  const pilot = await assignDiscoverPilot(admin, userId, tab);
  mark('sessionpilot');
  const [inventory, events, profile, following, legacy] = await Promise.all([
    observeDiscoverSharedRead('inventory', observation => initialInventoryRead('inventory',
      () => discoverSharedRead('inventory', () => discoverInventory(), observation), () => observation?.event('join'))),
    // Only the server identity issuer can mark a just-minted anonymous UUID.
    // Returning actors and every authenticated viewer still read their history.
    tab === "following" || (newAnonymous && userId === null && actor.startsWith('anon:'))
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
  mark('sessioninput');
  const evidence = tab === "following" ? [] : await readDiscoverEvidenceBatches(
    inventory.map(p => p.id),
    postIds => observeDiscoverSharedRead('evidence', observation => rankingEvidenceRead(JSON.stringify(postIds),
      () => discoverSharedRead('evidence:'+JSON.stringify(postIds), async () => {
        const { data, error } = await admin.rpc("discover_rank_evidence_v1", {p_posts: postIds});
        if (error || !Array.isArray(data))
          throw error ?? new Error("Ranking evidence unavailable");
        return data as DiscoverEvidence[];
      }, observation), () => observation?.event('join'))),
    process.env.DISCOVER_EVIDENCE_BOUNDED_READS_ENABLED === 'true',
  );
  mark('sessionevidence');
  const follows = new Set((following.data ?? []).map((f) => f.following_id));
  const placements: Record<string, DiscoverPlacement> = {};
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
          { commercialOrdering: pilot?.variant !== "control",
            ...(pilot ? { onPlacement: (id: string, value: DiscoverPlacement) => { placements[id] = value; } } : {}) },
        );
  mark('sessionrank');
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
  // Viewer topics are constant throughout this session. Normalize once rather
  // than once for each candidate topic; retain each post's match priority.
  const declaredTopicSet = new Set(normalizeTopics(declaredTopics));
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
        match.topics.find((t) => declaredTopicSet.has(t)) ??
          match.categories.find((c) => declared.includes(c)) ??
          declared[0] ??
          "general",
      ];
    }),
  );
  mark('sessionaudience');
  if (firstPage) {
    const saved = await observeDiscoverSharedRead('write', async () => {
      const {data,error} = await admin.rpc(process.env.DISCOVER_COMPACT_PAGE_ENABLED === 'true'
        ? 'discover_create_compact_page_v1' : 'discover_create_page_v1', {
        p_actor:actor,p_user_id:userId,p_tab:tab,p_post_ids:ids,p_audiences:audiences,
        p_offset:firstPage.offset,p_limit:firstPage.limit,p_pilot_id:pilot?.experimentId ?? null,
        p_pilot_variant:pilot?.variant ?? null,p_pilot_placements:pilot ? placements : {},
      });
      if (error) throw error;
      if (!data || typeof data.id !== 'string' || !data.page || !data.page.inventory)
        throw new Error('Initial feed page unavailable');
      return {id:data.id as string,page:data.page};
    });
    mark('sessionwritepage');
    return saved;
  }
  const saved = await observeDiscoverSharedRead('write', async () => {
    const { data, error } = await admin
      .from("discover_sessions_v1")
      .insert({ actor, user_id: userId, tab, post_ids: ids, audiences,
        ...(pilot ? { pilot_id: pilot.experimentId, pilot_variant: pilot.variant, pilot_placements: placements } : {}) })
      .select("id")
      .single();
    if (error) throw error;
    return {id:data.id as string,page:undefined};
  });
  mark('sessionwrite');
  return saved;
}
type DiscoverPageResult = {items: Record<string,any>[];nextOffset:number;hasMore:boolean};
export async function readDiscoverPage(
  sessionId: string,
  actor: string,
  offset: number,
  limit: number,
  userId: string | null,
): Promise<DiscoverPageResult> {
  const { data: session, error } = process.env.DISCOVER_PAGE_INVENTORY_ENABLED === 'true'
    ? await admin.rpc(process.env.DISCOVER_COMPACT_PAGE_ENABLED === 'true'
      ? 'discover_compact_page_v1' : 'discover_page_inventory_v1', {p_session:sessionId,p_actor:actor,p_offset:offset,p_limit:limit})
    : await admin
    .from("discover_sessions_v1")
    .select("post_ids,expires_at")
    .eq("id", sessionId)
    .eq("actor", actor)
    .maybeSingle();
  // The private page RPC uses a dedicated SQLSTATE for missing, expired and
  // differently owned snapshots. Temporary database failures keep Retry semantics.
  if (error?.code === "CN001") throw new DiscoverSessionUnavailableError();
  if (error) throw error;
  return renderDiscoverPage(session,offset,limit,userId,
    nextOffset => readDiscoverPage(sessionId,actor,nextOffset,limit,userId));
}
export async function readDiscoverAnonymousPage(
  sessionId: string,
  candidate: DiscoverAnonymousPageCandidate,
  offset: number,
  limit: number,
): Promise<DiscoverPageResult> {
  const { data, error } = await admin.rpc('discover_anon_compact_page_v1', {
    p_session: sessionId, p_anonymous: candidate.anonymousId, p_offset: offset, p_limit: limit,
  });
  if (error?.code === 'CN001') throw new DiscoverSessionUnavailableError();
  if (error) throw error;
  const page = data?.page;
  // Never fall back to an unchecked page or direct inventory lookup for an
  // unresolved candidate, including an empty page with malformed metadata.
  if (data?.anonymousClaimChecked !== true || !page ||
      !Array.isArray(page.page_post_ids) || !Number.isSafeInteger(page.total_count) ||
      typeof page.expires_at !== 'string' || !Number.isFinite(Date.parse(page.expires_at)) ||
      !page.inventory || !['posts','profiles','primaryProducts','legacyProducts','offerings']
        .every(key => Array.isArray(page.inventory[key]) && page.inventory[key]
          .every((row: unknown) => row !== null && typeof row === 'object' && !Array.isArray(row))))
    throw new Error('Checked anonymous feed page unavailable');
  return renderDiscoverPage(page,offset,limit,null,
    nextOffset => readDiscoverAnonymousPage(sessionId,candidate,nextOffset,limit));
}
async function renderDiscoverPage(
  session: ({post_ids:string[]} | {page_post_ids:string[];total_count:number}) &
    {expires_at:string;inventory?:Record<string,any>} | null | undefined,
  offset:number, limit:number, userId:string | null,
  readNextPage: (offset: number) => Promise<DiscoverPageResult>,
): Promise<DiscoverPageResult> {
  if (!session) throw new DiscoverSessionUnavailableError();
  if (Date.parse(session.expires_at) <= Date.now())
    throw new DiscoverSessionUnavailableError();
  const compact = 'page_post_ids' in session;
  const total = compact ? session.total_count : session.post_ids.length;
  const selected = compact ? session.page_post_ids : session.post_ids.slice(offset, offset + limit);
  if (compact && (!Number.isSafeInteger(total) || total<0 || !Array.isArray(selected) ||
      selected.length!==Math.min(limit,Math.max(0,total-offset)) ||
      selected.some(id=>typeof id!=='string') || new Set(selected).size!==selected.length))
    throw new Error('Invalid compact feed page');
  if (!selected.length)
    return { items: [], nextOffset: total, hasMore: false };
  // Recheck moderation on every page; the snapshot freezes order, not permissions.
  const inventory = await discoverInventory(selected, session.inventory);
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
        // Creator identity is PUBLIC: creator profile pages render it to anyone,
        // and the legacy get_feed_v3 path returns it to anon too. Gating these on
        // userId made every post on the signed-out front door read "Creator",
        // undoing the fix migration 060/#153 shipped for exactly that. The
        // profile is already loaded unconditionally here — creator_verified just
        // below reads the same p.profile with no gate — so this was throwing
        // away data it had already fetched.
        creator_name: p.profile?.full_name ?? null,
        creator_username: p.profile?.username ?? null,
        creator_avatar_url: p.profile?.avatar_url ?? null,
        creator_verified: isSellReadyProfile(p.profile),
        product_type: p.product?.type,
        product_price_cents: p.product?.amount_cents || p.product?.price_cents,
        is_liked: liked.has(p.id),
        is_following: followed.has(p.creator_id),
      },
    ];
  });
  if (!items.length && offset + limit < total)
    return readNextPage(offset + limit);
  return {
    items,
    nextOffset: Math.min(total, offset + limit),
    hasMore: offset + limit < total,
  };
}
type DiscoverEventInput = {
  actor: string;
  userId: string | null;
  postId: string;
  kind: string;
  entityKey: string;
  audience?: string;
  amountCents?: number;
  currency?: string;
};
export const DISCOVER_EVENT_POST_COLUMNS =
  "id,creator_id,interests,topics,title,content,caption,product_id,offering_id,allow_booking";
export type DiscoverEventPost = {
  id: string;
  creator_id: string;
  interests?: string[] | null;
  topics?: string[] | null;
  title?: string | null;
  content?: string | null;
  caption?: string | null;
  product_id?: string | null;
  offering_id?: string | null;
  allow_booking?: boolean | null;
};
export type DiscoverEventOffers = {
  primaryProducts: Record<string, any>[];
  legacyProducts: Record<string, any>[];
  offerings: Record<string, any>[];
};
export async function recordDiscoverEvent(input: DiscoverEventInput) {
  return recordDiscoverEvents(input, [{kind:input.kind,entityKey:input.entityKey}]);
}
export async function recordDiscoverEvents(
  input: Omit<DiscoverEventInput, 'kind' | 'entityKey'>,
  events: Array<Pick<DiscoverEventInput, 'kind' | 'entityKey'>>,
  // Only server-loaded metadata from this request; never a browser payload or cache.
  loadedPost?: DiscoverEventPost,
  loadedOffers?: DiscoverEventOffers,
) {
  if (!events.length) return;
  let p = loadedPost;
  if (p && p.id !== input.postId) throw new Error("Event metadata post mismatch");
  if (!p) {
    const { data, error } = await admin
      .from("posts")
      .select(DISCOVER_EVENT_POST_COLUMNS)
      .eq("id", input.postId)
      .single();
    if (error) throw error;
    p = data;
  }
  if (!p?.creator_id || p.creator_id === input.userId) return;
  const productColumns =
    "id,product_id,creator_id,title,description,type,active";
  const [products, legacyProducts, offerings] = loadedOffers
    ? [loadedOffers.primaryProducts, loadedOffers.legacyProducts, loadedOffers.offerings]
    : await Promise.all([
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
  const rows = events.map(event => ({
      actor: input.actor,
      user_id: input.userId,
      post_id: p.id,
      creator_id: p.creator_id,
      kind: event.kind,
      entity_key: event.entityKey,
      categories,
      topics,
      audience,
      offer_type:
        product?.type ??
        offering?.type ??
        (p.allow_booking ? "free_call" : "none"),
      amount_cents: input.amountCents ?? 0,
      currency: input.currency ?? null,
    }));
  const { error: writeError } = await admin.from("discover_events_v1").upsert(
    rows.length === 1 ? rows[0] : rows,
    { onConflict: "kind,entity_key", ignoreDuplicates: true },
  );
  if (writeError) throw writeError;
}
