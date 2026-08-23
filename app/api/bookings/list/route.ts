import { NextResponse, type NextRequest } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabaseClient";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type BookingRow = {
  id: string;
  post_id: string;
  buyer_id: string;
  creator_id: string;
  status: string;
  linked_order_id: string | null;
  created_at: string;
};

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "Unauthorized", details: "Auth session not found; please sign in again." },
      { status: 401 }
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    console.log("[bookings-list] Querying bookings for creator_id:", user.id);
    const { data: bookings, error: bookingsError } = await admin
      .from("bookings")
      .select("id, post_id, buyer_id, creator_id, status, linked_order_id, created_at")
      .eq("creator_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<BookingRow[]>();

    console.log("[bookings-list] Query result:", {
      count: bookings?.length || 0,
      error: bookingsError?.message,
    });

    if (bookingsError) {
      console.error("[bookings-list] bookings query error:", {
        message: bookingsError.message,
        details: (bookingsError as any)?.details,
        hint: (bookingsError as any)?.hint,
        code: (bookingsError as any)?.code,
      });
      throw bookingsError;
    }

    if (!bookings || bookings.length === 0) {
      return NextResponse.json({ bookings: [] });
    }

    const unique = <T extends string | null | undefined>(values: T[]) =>
      Array.from(new Set(values.filter(Boolean) as string[]));

    const bookingIds = unique(bookings.map((b) => b.id));
    const postIds = unique(bookings.map((b) => b.post_id));
    const buyerIds = unique(bookings.map((b) => b.buyer_id));

    const [
      { data: posts, error: postsError },
      { data: buyerProfiles, error: buyersError },
      { data: payments, error: paymentsError },
    ] = await Promise.all([
      postIds.length
        ? admin
            .from("posts")
            .select("id, title, product_id, product_type, price_cents")
            .in("id", postIds)
        : Promise.resolve({ data: [], error: null }),
      buyerIds.length
        ? admin
            .from("profiles")
            .select("id, username, full_name, avatar_url")
            .in("id", buyerIds)
        : Promise.resolve({ data: [], error: null }),
      bookingIds.length
        ? admin
            .from("booking_payments")
            .select(
              "id, booking_id, plan_type, installment_months, status, link_url, stripe_checkout_session_id, stripe_payment_intent_id, stripe_subscription_id, amount_total_cents, installment_amount_cents, platform_fee_cents, currency, created_at, completed_at, link_sent_at, closer_user_id"
            )
            .in("booking_id", bookingIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (postsError) {
      console.warn("[bookings-list] posts query error:", {
        message: postsError.message,
        details: (postsError as any)?.details,
        hint: (postsError as any)?.hint,
        code: (postsError as any)?.code,
      });
    }
    if (buyersError) {
      console.warn("[bookings-list] profiles query error:", {
        message: buyersError.message,
        details: (buyersError as any)?.details,
        hint: (buyersError as any)?.hint,
        code: (buyersError as any)?.code,
      });
    }
    if (paymentsError && !/booking_payments.*does not exist/i.test(paymentsError.message || "")) {
      console.warn("[bookings-list] payments query error:", {
        message: paymentsError.message,
        details: (paymentsError as any)?.details,
        hint: (paymentsError as any)?.hint,
        code: (paymentsError as any)?.code,
      });
    }

    const productIds = unique(
      (posts || [])
        .map((p: any) => p?.product_id)
        .filter(Boolean)
    );

    const { data: products, error: productsError } = productIds.length
      ? await admin
          .from("products")
          .select("product_id, title, amount_cents, currency, stripe_price_id")
          .in("product_id", productIds)
      : { data: [], error: null };

    if (productsError) {
      console.warn("[bookings-list] products query error:", {
        message: productsError.message,
        details: (productsError as any)?.details,
        hint: (productsError as any)?.hint,
        code: (productsError as any)?.code,
      });
    }

    const closerIds = unique((payments || []).map((p: any) => p?.closer_user_id));
    const { data: closerProfiles, error: closersError } = closerIds.length
      ? await admin
          .from("profiles")
          .select("id, username, full_name, avatar_url")
          .in("id", closerIds)
      : { data: [], error: null };

    if (closersError) {
      console.warn("[bookings-list] closer profiles query error:", {
        message: closersError.message,
        details: (closersError as any)?.details,
        hint: (closersError as any)?.hint,
        code: (closersError as any)?.code,
      });
    }

    const postMap = new Map((posts || []).map((p: any) => [p.id, p]));
    const productMap = new Map((products || []).map((p: any) => [p.product_id, p]));
    const buyerMap = new Map((buyerProfiles || []).map((p: any) => [p.id, p]));
    const closerMap = new Map((closerProfiles || []).map((p: any) => [p.id, p]));

    const paymentsByBooking = new Map<string, any[]>();
    for (const payment of payments || []) {
      if (!payment) continue;
      const list = paymentsByBooking.get(payment.booking_id) || [];
      list.push({
        ...payment,
        closer_profile: payment.closer_user_id ? closerMap.get(payment.closer_user_id) ?? null : null,
      });
      paymentsByBooking.set(payment.booking_id, list);
    }

    const result = bookings.map((booking) => {
      const post = postMap.get(booking.post_id) ?? null;
      const product =
        post && post.product_id ? productMap.get(post.product_id as string) ?? null : null;

      return {
        booking,
        post,
        product,
        buyer: buyerMap.get(booking.buyer_id) ?? null,
        payments: paymentsByBooking.get(booking.id) ?? [],
      };
    });

    return NextResponse.json({ bookings: result });
  } catch (error: any) {
    const message = error?.message || String(error);
    const details = error?.details || null;
    const hint = error?.hint || null;
    const code = error?.code || null;

    console.error("[bookings-list] error:", {
      message,
      details,
      hint,
      code,
      stack: error?.stack,
    });
    return NextResponse.json(
      {
        error: "Failed to load bookings",
        details: publicMessage("bookings-list", error, "Unknown error"),
      },
      { status: 500 }
    );
  }
}



