import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isCreatorSellReady } from "@/lib/creatorStripeConnect";

/**
 * POST /api/posts – create a post (server-side so product_id FK is verified with admin client)
 */
export async function POST(req: Request) {
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
    const premium_path = body?.premium_path ?? null;
    const interests = Array.isArray(body?.interests) ? body.interests : body?.interests != null ? [body.interests] : null;
    const product_id: string | null =
      body?.product_id != null && String(body.product_id).trim()
        ? String(body.product_id).trim()
        : null;
    const price_cents = typeof body?.price_cents === "number" ? body.price_cents : null;
    const allow_booking = Boolean(body?.allow_booking);
    const booking_url = (body?.booking_url ?? "")?.trim() || null;
    const hashtags = Array.isArray(body?.hashtags) ? body.hashtags : null;

    if (!video_url) {
      return NextResponse.json({ success: false, error: "video_url is required" }, { status: 400 });
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
      return NextResponse.json({ success: false, error: insErr.message }, { status: 400 });
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
    return NextResponse.json({ success: false, error: e?.message ?? "Server error" }, { status: 500 });
  }
}
