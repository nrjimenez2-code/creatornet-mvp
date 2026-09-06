import { NextRequest, NextResponse } from "next/server";
import { isUserBanned, bannedResponse } from "@/lib/bannedUser";
import { publicMessage } from "@/lib/apiError";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { isSafeId } from "@/lib/ids";
import {
  hasQualifyingPurchaseForPost,
  isPostOwnedByCreator,
  PURCHASE_REQUIRED_CODE,
  PURCHASE_REQUIRED_MESSAGE,
} from "@/lib/reviewEligibility";

// Reviews are rare and they move a creator's public rating, so this is the
// tightest limit here. Ten a minute is far more than anyone writes honestly.
const REVIEW_RATE = { limit: 10, windowMs: 60_000 };

export async function POST(req: NextRequest) {
  if (!allowRequest(`review:${clientKey(req)}`, REVIEW_RATE)) {
    return tooManyRequests();
  }

  try {
    const supabase = createServerClient();

    // Get authenticated user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // A banned account may not create anything. Fails open on a lookup error —
    // see lib/bannedUser.ts.
    if (await isUserBanned(supabase, user.id)) {
      return bannedResponse();
    }

    const body = await req.json().catch(() => ({}));
    const creatorId = body.creator_id as string;
    const postId = body.post_id;
    const rating = Number(body.rating);
    const comment = String(body.comment || "").trim();

    // Validation
    if (!creatorId) {
      return NextResponse.json(
        { error: "creator_id is required" },
        { status: 400 }
      );
    }

    // Reviews are per offer: the post the buyer paid for. Same id guard as
    // checkout, since the id goes straight into PostgREST filters.
    if (!isSafeId(postId)) {
      return NextResponse.json(
        { error: "post_id is required" },
        { status: 400 }
      );
    }

    if (!rating || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: "Rating must be between 1 and 5" },
        { status: 400 }
      );
    }

    if (!comment || comment.length < 10) {
      return NextResponse.json(
        { error: "Review comment must be at least 10 characters" },
        { status: 400 }
      );
    }

    if (comment.length > 1000) {
      return NextResponse.json(
        { error: "Review comment must be less than 1000 characters" },
        { status: 400 }
      );
    }

    // Prevent self-review
    if (user.id === creatorId) {
      return NextResponse.json(
        { error: "You cannot review yourself" },
        { status: 400 }
      );
    }

    // Purchaser-only: the reviewer must hold a live purchase of THIS offer
    // (lib/reviewEligibility.ts). Service role, because RLS on purchases is
    // buyer-scoped; without it we cannot verify, so fail closed rather than
    // let anyone through. Nothing has been written before this point.
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      console.error("[reviews] SUPABASE_SERVICE_ROLE_KEY missing; cannot verify purchases");
      return NextResponse.json(
        { error: "Reviews are temporarily unavailable" },
        { status: 503 }
      );
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // The offer must be this creator's. A post from someone else is a
    // malformed request (400), not a missing purchase (403).
    if (!(await isPostOwnedByCreator(admin, postId, creatorId))) {
      return NextResponse.json(
        { error: "post_id does not belong to this creator" },
        { status: 400 }
      );
    }

    if (!(await hasQualifyingPurchaseForPost(admin, user.id, postId))) {
      return NextResponse.json(
        { code: PURCHASE_REQUIRED_CODE, error: PURCHASE_REQUIRED_MESSAGE },
        { status: 403 }
      );
    }

    // One review per buyer per offer: a second submit for the same post
    // edits it. (Rows from before 024 have post_id NULL and are left alone.)
    const { data: existingReview } = await supabase
      .from("reviews")
      .select("id")
      .eq("reviewer_id", user.id)
      .eq("post_id", postId)
      .maybeSingle();

    const reviewData = {
      reviewer_id: user.id,
      creator_id: creatorId,
      post_id: postId,
      rating,
      comment,
      updated_at: new Date().toISOString(),
    };

    let result;
    let status = 200;
    if (existingReview) {
      // Update existing review
      const { data, error } = await supabase
        .from("reviews")
        .update(reviewData)
        .eq("id", existingReview.id)
        .select()
        .single();

      if (error) throw error;
      result = data;
    } else {
      // Insert new review
      const { data, error } = await supabase
        .from("reviews")
        .insert(reviewData)
        .select()
        .single();

      if (error) throw error;
      result = data;
      status = 201;
    }

    // Recalculate average rating using RPC (backend calculation), with the
    // same service-role client that verified the purchase above.
    let ratingData: any = null;

    const { data: rpcData, error: rpcError } = await admin.rpc("update_profile_rating", {
      p_profile_id: creatorId,
    });

    if (rpcError) {
      console.error("Error updating profile rating:", rpcError);
      // Don't fail the request, but log the error for debugging
    } else {
      ratingData = rpcData;
      console.log("Profile rating updated successfully:", ratingData);
    }

    return NextResponse.json(
      {
        success: true,
        review: result,
        rating: ratingData?.[0] || null, // Return the updated rating for immediate UI update
      },
      { status }
    );
  } catch (err: any) {
    console.error("Review submission error:", err);
    return NextResponse.json(
      { error: publicMessage("reviews", err, "Failed to submit review") },
      { status: 500 }
    );
  }
}

