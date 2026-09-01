import { NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { isOwnPremiumPath } from "@/lib/premiumPath";
import { isSafeBookingTarget } from "@/lib/bookingUrl";
import { headR2Object, deleteR2Object, r2KeyFromPublicUrl } from "@/lib/r2";
import { isAllowedUpload, maxBytesFor, type UploadFolder } from "@/lib/uploadPolicy";

/** Returns an error message if the object at `url` (if it is ours) is too big or the wrong type; null if fine. */
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
  return null;
}
import { createSupabaseServer } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isCreatorSellReady } from "@/lib/creatorStripeConnect";
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

    const body = await req.json().catch(() => ({}));
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
    const interests = Array.isArray(body?.interests) ? body.interests : body?.interests != null ? [body.interests] : null;
    const product_id: string | null =
      body?.product_id != null && String(body.product_id).trim()
        ? String(body.product_id).trim()
        : null;
    const price_cents = typeof body?.price_cents === "number" ? body.price_cents : null;
    const allow_booking = Boolean(body?.allow_booking);
    const bookingRaw = (body?.booking_url ?? "")?.trim() || null;
    if (bookingRaw && !isSafeBookingTarget(bookingRaw)) {
      return NextResponse.json(
        { error: "Booking link must be an https:// URL." },
        { status: 400 }
      );
    }
    const booking_url = bookingRaw;
    const hashtags = Array.isArray(body?.hashtags) ? body.hashtags : null;

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
    if (product_id && typeof product_id === "string" && product_id.trim()) {
      const trimmed = product_id.trim();
      const byProductId = await supabaseAdmin
        .from("products")
        .select("product_id, id, creator_id")
        .eq("product_id", trimmed)
        .maybeSingle();
      const byId =
        !byProductId.data || (byProductId.data as { creator_id?: string }).creator_id !== user.id
          ? await supabaseAdmin
              .from("products")
              .select("product_id, id, creator_id")
              .eq("id", trimmed)
              .maybeSingle()
          : { data: null as unknown as typeof byProductId.data };
      const row = (byProductId.data && (byProductId.data as { creator_id?: string }).creator_id === user.id
        ? byProductId.data
        : byId.data && (byId.data as { creator_id?: string }).creator_id === user.id
          ? byId.data
          : null) as { product_id?: string | null; id?: string } | null;
      if (row) {
        resolvedProductId = row.product_id ?? row.id ?? trimmed;
      }
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const finalProductId =
      resolvedProductId && uuidRegex.test(resolvedProductId) ? resolvedProductId : null;

    const selling =
      !!finalProductId || (typeof price_cents === "number" && price_cents > 0);
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

    const postRow = {
      creator_id: user.id,
      title,
      content,
      video_url,
      poster_url,
      premium_path,
      interests,
      product_id: finalProductId,
      price_cents,
      allow_booking,
      booking_url,
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
      if (isPriced) {
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
        .insert([{ ...postRow, product_id: null }])
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
  } catch (e: any) {
    return NextResponse.json({ success: false, error: publicMessage("posts", e, "Server error") }, { status: 500 });
  }
}
