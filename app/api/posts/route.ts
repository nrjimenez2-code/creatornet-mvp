import { normalizeTopics } from "@/lib/interestTopics";
import { extractHashtags, normalizeHashtags } from "@/lib/hashtags";
import { AUTOMATIC_POST_CLASSIFICATION_VERSION, automaticPostMetadata } from "@/lib/automaticPostMetadata";
import { normalizeInterests } from "@/lib/interestCategories";
import { NextResponse } from "next/server";
import { isUserBanned, bannedResponse } from "@/lib/bannedUser";
import { publicMessage } from "@/lib/apiError";
import { readPostAction } from "@/lib/productDelivery";
import type { PostAction } from "@/lib/productDelivery";
import { premiumPostingReady, premiumSchemaReady } from "@/lib/premiumReadiness";
import { isOwnPremiumPath } from "@/lib/premiumPath";
import { isSafeBookingTarget } from "@/lib/bookingUrl";
import { headR2Object, deleteR2Object, r2KeyFromPublicUrl, readR2ObjectPrefix } from "@/lib/r2";
import { isAllowedUpload, maxBytesFor, bytesAllowedForFolder, SNIFF_BYTES, type UploadFolder } from "@/lib/uploadPolicy";

/** Returns an error message if the object at `url` (if it is ours) is too big, the wrong declared type, or not actually that format; null if fine. */
async function enforceUploadSize(url: string | null, folder: UploadFolder): Promise<string | null> {
  if (!url) return null;
  const key = r2KeyFromPublicUrl(url);
  if (!key) return null; // not in our bucket (legacy/external URL); nothing to check
  const head = await headR2Object(key);
  if (!head) return null; // cannot verify; do not block the creator on an R2 hiccup
  const max = maxBytesFor(folder);
  if (head.size > max) {
    await deleteR2Object(key);
    const mb = Math.round(max / (1024 * 1024));
    return folder === "videos"
      ? `Video is too large. The limit is ${mb} MB.`
      : `Thumbnail is too large. The limit is ${mb} MB.`;
  }
  if (head.contentType && !isAllowedUpload(folder, head.contentType)) {
    await deleteR2Object(key);
    return folder === "videos" ? "Uploaded file is not a video." : "Uploaded file is not an image.";
  }
  // Everything above trusts a Content-Type the UPLOADER chose. Uploads go
  // straight from the browser to R2 on a presigned URL, so this is the first
  // point at which the actual bytes can be looked at. It matters because sharp
  // sniffs the real format, not the header: a HEIC or AVIF sent as image/jpeg
  // lands under media.creatornet.net/thumbnails, which is exactly the
  // remotePatterns entry /_next/image will fetch and decode.
  // Reads 16 bytes, not the file. Fails open on an R2 hiccup, like the HEAD above.
  const prefix = await readR2ObjectPrefix(key, SNIFF_BYTES);
  if (prefix && !bytesAllowedForFolder(folder, prefix)) {
    await deleteR2Object(key);
    return folder === "videos"
      ? "That file is not a video. Please upload an MP4."
      : "That image is not a JPG or PNG. Please re-export it and try again.";
  }
  return null;
}
import { createSupabaseServer } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isCreatorSellReady } from "@/lib/creatorStripeConnect";
import { getStripe } from "@/lib/stripeClient";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

/**
 * POST /api/posts – create a post (server-side so product_id FK is verified with admin client)
 */
// Creating a post involves an upload first, so this is naturally slow. Ten a
// minute only ever catches automated posting.
const CREATE_POST_RATE = { limit: 10, windowMs: 60_000 };

export async function POST(req: Request) {
  if (!allowRequest(`createPost:${clientKey(req)}`, CREATE_POST_RATE)) {
    return tooManyRequests();
  }

  try {
    const supabase = createSupabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    // A banned account may not create anything. Fails open on a lookup error —
    // see lib/bannedUser.ts.
    if (await isUserBanned(supabase, user.id)) {
      return bannedResponse();
    }

    const body = await req.json().catch(() => ({}));
    if (premiumSchemaReady() && !premiumPostingReady()) {
      return NextResponse.json({ error: "New video posting is not enabled yet." }, { status: 409 });
    }
    const canonicalAction = Object.prototype.hasOwnProperty.call(body, "video_action");
    if (premiumPostingReady() && !canonicalAction) {
      return NextResponse.json({ error: "Choose the video button when publishing.", code: "VIDEO_ACTION_REQUIRED" }, { status: 400 });
    }
    let videoAction: PostAction = null;
    if (canonicalAction) {
      if (!premiumPostingReady()) return NextResponse.json({ error: "New video posting is not enabled yet." }, { status: 409 });
      try { videoAction = readPostAction(body.video_action); }
      catch { return NextResponse.json({ error: "Invalid video button." }, { status: 400 }); }
      if ((videoAction !== "buy" && (body.product_id || body.premium_path || Number(body.price_cents || 0) !== 0)) ||
          (videoAction !== "book" && (body.allow_booking || body.booking_url)) ||
          (videoAction !== "tip" && body.tips_enabled) ||
          body.offering_id || body.fulfillment_url || body.booking_url_override || body.display_price ||
          body.cta_type && body.cta_type !== "none") {
        return NextResponse.json({ error: "Choose only one video button.", code: "CONFLICTING_VIDEO_ACTION" }, { status: 400 });
      }
    }
    const automatic = body?.classification_version !== undefined;
    if (automatic && body.classification_version !== AUTOMATIC_POST_CLASSIFICATION_VERSION) {
      return NextResponse.json({ success: false, error: "Unsupported classification version." }, { status: 400 });
    }
    if (automatic && ((body.title != null && typeof body.title !== "string") ||
        (body.content != null && typeof body.content !== "string") || (body.content?.length ?? 0) > 300)) {
      return NextResponse.json({ success: false, error: "Caption must be at most 300 characters." }, { status: 400 });
    }
    const title = (body?.title ?? "")?.trim() || null;
    const content = (body?.content ?? "")?.trim() || null;
    const video_url = (body?.video_url ?? "")?.trim() || null;
    const poster_url = (body?.poster_url ?? "")?.trim() || null;
    const premiumRaw = body?.premium_path ?? null;
    if (premiumRaw && !isOwnPremiumPath(premiumRaw, user.id)) {
      return NextResponse.json(
        { success: false, error: "Premium file path is not valid." },
        { status: 400 }
      );
    }
    const premium_path = premiumRaw ? String(premiumRaw).trim() : null;
    let interests = normalizeInterests(body?.interests);
    let topics = normalizeTopics(body?.topics);
    const product_id: string | null =
      body?.product_id != null && String(body.product_id).trim()
        ? String(body.product_id).trim()
        : null;
    let price_cents = typeof body?.price_cents === "number" ? body.price_cents : null;
    const allow_booking = canonicalAction ? videoAction === "book" : Boolean(body?.allow_booking);
    const tips_enabled = canonicalAction ? videoAction === "tip" : body?.tips_enabled === true;
    const bookingRaw = (body?.booking_url ?? "")?.trim() || null;
    if (bookingRaw && !isSafeBookingTarget(bookingRaw)) {
      return NextResponse.json(
        { error: "Booking link must be an https:// URL." },
        { status: 400 }
      );
    }
    const booking_url = bookingRaw;
    const hashtags = automatic ? extractHashtags(content) : Array.isArray(body?.hashtags) ? normalizeHashtags(body.hashtags) : null;

    if (!video_url) {
      return NextResponse.json({ success: false, error: "video_url is required" }, { status: 400 });
    }

    // Size cap for files that went to our R2 bucket. The presigned PUT cannot
    // enforce a length (the browser never tells us the size up front), so the
    // check runs here, after upload and before a post points at the file.
    // Anything over the cap is deleted and the post is refused.
    const [videoProblem, posterProblem] = await Promise.all([
      enforceUploadSize(video_url, "videos"),
      enforceUploadSize(poster_url, "thumbnails"),
    ]);
    const sizeProblem = videoProblem ?? posterProblem;
    if (sizeProblem) {
      return NextResponse.json({ success: false, error: sizeProblem }, { status: 413 });
    }

    // products table uses "id" as PK (product_id is null); FK may reference products.id — resolve to products.id for insert
    let resolvedProductId: string | null = null;
    let verifiedOffer: { title?: string | null; description?: string | null } | null = null;
    if (product_id && typeof product_id === "string" && product_id.trim()) {
      const trimmed = product_id.trim();
      const byProductId = await supabaseAdmin
        .from("products")
        .select(automatic ? "product_id, id, creator_id, title, description, active" : "product_id, id, creator_id")
        .eq("product_id", trimmed)
        .maybeSingle();
      const byId =
        !byProductId.data || (byProductId.data as { creator_id?: string }).creator_id !== user.id
          ? await supabaseAdmin
              .from("products")
              .select(automatic ? "product_id, id, creator_id, title, description, active" : "product_id, id, creator_id")
              .eq("id", trimmed)
              .maybeSingle()
          : { data: null as unknown as typeof byProductId.data };
      const row = (byProductId.data && (byProductId.data as { creator_id?: string }).creator_id === user.id
        ? byProductId.data
        : byId.data && (byId.data as { creator_id?: string }).creator_id === user.id
          ? byId.data
          : null) as { product_id?: string | null; id?: string; title?: string | null; description?: string | null; active?: boolean } | null;
      if (row) {
        resolvedProductId = row.product_id ?? row.id ?? trimmed;
        if (row.active !== false) verifiedOffer = { title: row.title, description: row.description };
      }
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const finalProductId =
      resolvedProductId && uuidRegex.test(resolvedProductId) ? resolvedProductId : null;

    if (canonicalAction && videoAction === "buy") {
      if (!finalProductId) return NextResponse.json({ error: "Select an owned product." }, { status: 400 });
      const selected = await supabaseAdmin.from("products").select("id,creator_id,type,price_cents,active,is_active,delivery_revision,deliver_url,discord_invite_url,whop_listing_url")
        .eq("id", finalProductId).eq("creator_id", user.id).maybeSingle();
      if (selected.error || !selected.data || selected.data.active === false || selected.data.is_active === false) {
        return NextResponse.json({ error: "Product unavailable." }, { status: 409 });
      }
      if (price_cents !== null && price_cents !== selected.data.price_cents) {
        return NextResponse.json({ error: "Buy uses the saved product price.", code: "PRODUCT_PRICE_REQUIRED" }, { status: 400 });
      }
      price_cents = selected.data.price_cents;
      if (!Number.isSafeInteger(price_cents) || Number(price_cents) < 50) {
        return NextResponse.json({ error: "Save a product price of at least $0.50 before publishing Buy." }, { status: 409 });
      }
      if (["video", "bundle", "course", "mentorship"].includes(selected.data.type) && !selected.data.delivery_revision) {
        return NextResponse.json({ error: "Complete the product delivery before publishing." }, { status: 409 });
      }
    }
    if (canonicalAction && videoAction === "book" && !booking_url) {
      return NextResponse.json({ error: "Choose a free-call scheduling destination." }, { status: 400 });
    }

    let profileContext: { bio?: string | null; tagline?: string | null } = {};
    if (automatic) {
      const profile = await supabaseAdmin.from("profiles").select("bio,tagline").eq("id", user.id).maybeSingle();
      if (profile.error) throw new Error("post_classification_context_unavailable");
      profileContext = profile.data ?? {};
      const metadata = automaticPostMetadata({ title, content, ...profileContext,
        offers: finalProductId && verifiedOffer ? [verifiedOffer] : [] });
      interests = metadata.interests;
      topics = metadata.topics;
    }

    const selling =
      !!finalProductId || (typeof price_cents === "number" && price_cents > 0);
    if (tips_enabled && (
      product_id || selling || premium_path || price_cents !== null && price_cents !== 0 ||
      allow_booking || booking_url || body?.offering_id || body?.fulfillment_url ||
      body?.display_price || body?.booking_url_override ||
      body?.cta_type && body.cta_type !== "none"
    )) {
      return NextResponse.json(
        { success: false, error: "Tips can only be enabled on a completely free video.", code: "TIP_ONLY_REQUIRED" },
        { status: 400 }
      );
    }
    if (tips_enabled && process.env.CREATOR_TIPPING_ENABLED !== "true") {
      return NextResponse.json(
        { success: false, error: "Tipping is not available yet.", code: "TIPPING_UNAVAILABLE" },
        { status: 409 }
      );
    }
    if (selling && !(await isCreatorSellReady(user.id))) {
      return NextResponse.json(
        {
          success: false,
          error: "Connect Stripe in the dashboard to sell products or enable bookings.",
          code: "STRIPE_CONNECT_REQUIRED",
        },
        { status: 403 }
      );
    }
    if (tips_enabled) {
      if (!(await isCreatorSellReady(user.id))) {
        return NextResponse.json({ error: "Connect Stripe before enabling tips.", code: "STRIPE_CONNECT_REQUIRED" }, { status: 403 });
      }
      const profile = await supabaseAdmin.from("profiles")
        .select("stripe_account_id,banned_at").eq("id", user.id).maybeSingle();
      const accountId = profile.data?.stripe_account_id;
      if (profile.error || profile.data?.banned_at || typeof accountId !== "string" ||
          !/^acct_[A-Za-z0-9]+$/.test(accountId)) {
        return NextResponse.json({ error: "Your Stripe account cannot receive tips right now.", code: "CONNECT_UNAVAILABLE" }, { status: 409 });
      }
      const account = await getStripe().accounts.retrieve(accountId);
      if (!account.charges_enabled || !account.payouts_enabled) {
        return NextResponse.json({ error: "Your Stripe account cannot receive tips right now.", code: "CONNECT_UNAVAILABLE" }, { status: 409 });
      }
    }

    const postRow = {
      creator_id: user.id,
      title,
      content,
      video_url,
      poster_url,
      premium_path,
      interests,
      topics,
      ...(automatic ? { classification_version: AUTOMATIC_POST_CLASSIFICATION_VERSION } : {}),
      product_id: finalProductId,
      price_cents,
      allow_booking,
      booking_url,
      tips_enabled,
      ...(canonicalAction ? { video_action: videoAction, action_version: 1 } : {}),
      hashtags,
    };

    const insertResult = await supabaseAdmin
      .from("posts")
      .insert([postRow])
      .select("id, product_id")
      .maybeSingle();
    let insErr = insertResult.error;
    let inserted = insertResult.data as { id?: string; product_id?: string | null } | null;
    let productDropped = false;

    if (insErr?.message?.includes("posts_product_fk") && finalProductId) {
      // Retrying without the product is only acceptable for a FREE post.
      //
      // This retry used to run unconditionally and kept `price_cents`, so a
      // failed product link produced a post that advertises a price and has no
      // product — and /api/checkout rejects those with "Missing product_id",
      // meaning the Buy button is dead on arrival. 14 such rows exist in
      // production. For a priced post the honest outcome is to fail, so the
      // creator finds out now instead of discovering it when a buyer can't pay.
      const isPriced = typeof price_cents === "number" && price_cents > 0;
      if (isPriced || canonicalAction && videoAction === "buy") {
        return NextResponse.json(
          {
            success: false,
            error:
              "This post could not be linked to its product, so it cannot be sold. Please try attaching the product again.",
            code: "PRODUCT_LINK_FAILED",
          },
          { status: 400 }
        );
      }

      productDropped = true;
      const retryResult = await supabaseAdmin
        .from("posts")
        .insert([{ ...postRow, product_id: null, ...(automatic ? (() => {
          const metadata = automaticPostMetadata({ title, content, ...profileContext });
          return { interests: metadata.interests, topics: metadata.topics };
        })() : {}) }])
        .select("id, product_id")
        .maybeSingle();
      insErr = retryResult.error;
      if (!retryResult.error) inserted = retryResult.data as { id?: string; product_id?: string | null } | null;
    }

    if (insErr) {
      return NextResponse.json({ success: false, error: publicMessage("posts", insErr, "Could not create the post.") }, { status: 400 });
    }

    const postId = inserted?.id ?? null;

    // Create empty post_metrics row for this post
    if (postId) {
      await supabaseAdmin.from("post_metrics").insert({ post_id: postId }).select("post_id").maybeSingle();
    }

    return NextResponse.json({
      success: true,
      post_id: postId,
      product_attached: !productDropped && !!finalProductId,
      ...(productDropped && {
        warning:
          "Post created but product could not be attached. In Supabase, ensure the foreign key posts.product_id references the products table (and the products table has a product_id column with the same values).",
      }),
    });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: publicMessage("posts", e, "Server error") }, { status: 500 });
  }
}
