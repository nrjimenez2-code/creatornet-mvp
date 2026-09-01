import { NextRequest, NextResponse } from "next/server";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { publicMessage } from "@/lib/apiError";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// The Book button. It dedupes per (post, buyer), so the ceiling is low
// anyway; this stops a script churning bookings across many posts.
const BOOKING_RATE = { limit: 20, windowMs: 60_000 };

export async function POST(req: NextRequest) {
  if (!allowRequest(clientKey(req), BOOKING_RATE)) {
    return tooManyRequests();
  }


  console.error("[bookings-seed] 🔥🔥🔥 ENDPOINT HIT - Request received");
  try {
    const body = await req.json().catch(() => ({}));
    console.error("[bookings-seed] 📦 Request body:", body);
    const { post_id } = body;
    
    if (!post_id) {
      console.error("[bookings-seed] ❌ Missing post_id in body:", body);
      return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
    }

    console.error("[bookings-seed] 🎯🎯🎯 SAVE BUTTON CLICKED - Request received", { post_id });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Try to get user from server client first (uses cookies)
    let userId: string | null = null;
    let authMethod = "none";

    // Check Authorization header FIRST (most reliable for API routes)
    const bearerHeader = req.headers.get("authorization");
    console.error("[bookings-seed] 🔍 Auth header check:", {
      hasHeader: !!bearerHeader,
    });
    
    if (bearerHeader) {
      const accessToken = extractBearerToken(bearerHeader);
      if (accessToken) {
        console.error("[bookings-seed] 📝 Trying Authorization header token");
        try {
          // Try to verify token with Supabase
          const { data: { user }, error: verifyError } = await admin.auth.getUser(accessToken);
          if (user) {
            userId = user.id;
            authMethod = "bearer_verified";
            console.error("[bookings-seed] ✅ Got user from verified bearer token:", userId);
          } else {
            // No unverified fallback. A token Supabase will not vouch for
            // (expired, revoked, forged) does not get to name a user.
            console.error("[bookings-seed] ❌ Bearer token rejected:", verifyError?.message);
          }
        } catch (decodeErr: any) {
          console.error("[bookings-seed] ❌ Token decode error:", decodeErr?.message);
        }
      }
    }

    // Fallback: try cookies via server client
    if (!userId) {
      try {
        console.error("[bookings-seed] 📝 Trying cookies via server client");
        const supabase = createServerClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (user) {
          userId = user.id;
          authMethod = "cookies";
          console.error("[bookings-seed] ✅ Got user from server client (cookies):", userId);
        } else {
          console.error("[bookings-seed] 📝 Cookie auth failed:", authError?.message);
        }
      } catch (cookieErr: any) {
        console.error("[bookings-seed] 📝 Cookie auth error:", cookieErr?.message);
      }
    }
    
    if (!userId) {
      console.error("[bookings-seed] ❌❌❌ NOT INSERTED - missing user id", {
        reason: "No valid authentication found",
        authMethod,
        hasAuthHeader: !!bearerHeader,
      });
      return NextResponse.json({ 
        error: "Unauthorized", 
        details: "Please sign in to create a booking. No valid authentication token found." 
      }, { status: 401 });
    }

    console.log("[bookings-seed] 🎯 Attempting to create booking:", { userId, post_id });

    const { data: post, error: postErr } = await admin
      .from("posts")
      .select("id, creator_id, title, product_id")
      .eq("id", post_id)
      .single();

    if (postErr || !post || !post.creator_id) {
      console.error("[bookings-seed] ❌ NOT INSERTED - post missing", {
        reason: postErr?.message || "post not found",
        post_id,
        userId,
        error: postErr,
      });
      return NextResponse.json({ error: "post_not_found" }, { status: 404 });
    }

    // Fetch product details for logging
    let productDetails: any = null;
    if (post.product_id) {
      const { data: prodData } = await admin
        .from("products")
        .select("product_id, title, amount_cents")
        .eq("product_id", post.product_id)
        .maybeSingle();
      productDetails = prodData;
    }

    const { data: existing } = await admin
      .from("bookings")
      .select("id")
      .eq("post_id", post.id)
      .eq("buyer_id", userId)
      .maybeSingle();

    if (existing?.id) {
      console.log("[bookings-seed] ✅ ALREADY EXISTS - booking not inserted (duplicate)", {
        booking_id: existing.id,
        post_id: post.id,
        post_title: post.title || "N/A",
        product_title: productDetails?.title || "N/A",
        product_amount: productDetails?.amount_cents || "N/A",
        buyer_id: userId,
        creator_id: post.creator_id,
        reason: "already_exists",
      });
      return NextResponse.json({ ok: true, booking_id: existing.id });
    }

    const { data, error: insertError } = await admin
      .from("bookings")
      .insert({
        post_id: post.id,
        creator_id: post.creator_id,
        buyer_id: userId,
        status: "booked",
      })
      .select("id")
      .maybeSingle();

    if (insertError) {
      console.error("[bookings-seed] ❌ NOT INSERTED - database error", {
        reason: insertError.message,
        post_id: post.id,
        post_title: post.title || "N/A",
        product_title: productDetails?.title || "N/A",
        product_amount: productDetails?.amount_cents || "N/A",
        buyer_id: userId,
        creator_id: post.creator_id,
        error_code: (insertError as any)?.code,
        error_details: (insertError as any)?.details,
      });
      return NextResponse.json({ error: publicMessage("bookings-seed", insertError, "Could not create the booking.") }, { status: 500 });
    }

    console.error("[bookings-seed] ✅✅✅✅✅ INSERTED - booking created successfully", {
      booking_id: data?.id ?? null,
      post_id: post.id,
      post_title: post.title || "N/A",
      product_title: productDetails?.title || "N/A",
      product_amount: productDetails?.amount_cents || "N/A",
      buyer_id: userId,
      creator_id: post.creator_id,
      status: "booked",
      reason: "inserted",
    });
    
    // Verify the booking was actually inserted
    if (data?.id) {
      const { data: verify } = await admin
        .from("bookings")
        .select("id, creator_id, post_id, buyer_id, status")
        .eq("id", data.id)
        .single();
      console.log("[bookings-seed] 🔍 Verification query result:", verify);
    }
    
    return NextResponse.json({ ok: true, booking_id: data?.id ?? null });
  } catch (err: any) {
    console.error("[bookings-seed] not seeded not seeded seeded", err?.message || err);
    return NextResponse.json({ error: publicMessage("bookings-seed", err, "Failed to seed booking") }, { status: 500 });
  }
}


function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/Bearer\s+(.+)/i);
  return match ? match[1].trim() : null;
}



