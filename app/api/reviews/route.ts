import { NextRequest, NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
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

    const body = await req.json().catch(() => ({}));
    const creatorId = body.creator_id as string;
    const rating = Number(body.rating);
    const comment = String(body.comment || "").trim();

    // Validation
    if (!creatorId) {
      return NextResponse.json(
        { error: "creator_id is required" },
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

    // Check if review already exists (upsert)
    const { data: existingReview } = await supabase
      .from("reviews")
      .select("id")
      .eq("reviewer_id", user.id)
      .eq("creator_id", creatorId)
      .maybeSingle();

    const reviewData = {
      reviewer_id: user.id,
      creator_id: creatorId,
      rating,
      comment,
      updated_at: new Date().toISOString(),
    };

    let result;
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
    }

    // Recalculate average rating using RPC (backend calculation)
    // Use service role client to ensure we have permissions to update profiles
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    let ratingData: any = null;
    
    if (SERVICE_ROLE_KEY && SUPABASE_URL) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      
      const { data, error: rpcError } = await admin.rpc("update_profile_rating", {
        p_profile_id: creatorId,
      });

      if (rpcError) {
        console.error("Error updating profile rating:", rpcError);
        // Don't fail the request, but log the error for debugging
      } else {
        ratingData = data;
        console.log("Profile rating updated successfully:", ratingData);
      }
    } else {
      console.warn("SERVICE_ROLE_KEY not available, skipping rating update");
    }

    return NextResponse.json({
      success: true,
      review: result,
      rating: ratingData?.[0] || null, // Return the updated rating for immediate UI update
    });
  } catch (err: any) {
    console.error("Review submission error:", err);
    return NextResponse.json(
      { error: publicMessage("reviews", err, "Failed to submit review") },
      { status: 500 }
    );
  }
}

