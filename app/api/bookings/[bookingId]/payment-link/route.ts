import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { randomUUID } from "crypto";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: undefined });
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
const PLATFORM_FEE_RATE = 0.12;

type BookingRow = {
  id: string;
  post_id: string;
  buyer_id: string;
  creator_id: string;
  status: string;
};

type ProductRow = {
  product_id: string;
  title: string | null;
  amount_cents: number;
  currency: string | null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  const { bookingId } = await params;
  if (!bookingId) {
    return NextResponse.json({ error: "Missing booking id" }, { status: 400 });
  }

  const headerToken = extractBearerToken(req.headers.get("authorization"));
  const cookieStore = await cookies();
  const accessToken = headerToken || extractAccessToken(cookieStore);

  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
    error: authError,
  } = await admin.auth.getUser(accessToken);

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    plan_type: "full" | "installment";
    installment_months?: number;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const planType = body?.plan_type;
  if (planType !== "full" && planType !== "installment") {
    return NextResponse.json({ error: "plan_type must be 'full' or 'installment'" }, { status: 400 });
  }

  try {
    const { data: booking, error: bookingError } = await admin
      .from("bookings")
      .select("id, post_id, buyer_id, creator_id, status")
      .eq("id", bookingId)
      .maybeSingle<BookingRow>();

    if (bookingError) throw bookingError;
    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    if (booking.creator_id !== user.id) {
      return NextResponse.json({ error: "You do not own this booking" }, { status: 403 });
    }

    const { data: post, error: postError } = await admin
      .from("posts")
      .select("id, title, product_id")
      .eq("id", booking.post_id)
      .maybeSingle<{ id: string; title: string | null; product_id: string | null }>();

    if (postError) throw postError;
    if (!post || !post.product_id) {
      return NextResponse.json(
        { error: "The post linked to this booking is missing a product" },
        { status: 400 }
      );
    }

    const { data: product, error: productError } = await admin
      .from("products")
      .select("product_id, title, amount_cents, currency")
      .eq("product_id", post.product_id)
      .maybeSingle<ProductRow>();

    if (productError) throw productError;
    if (!product) {
      return NextResponse.json(
        { error: "Product not found for this booking" },
        { status: 400 }
      );
    }

    const totalCents = Number(product.amount_cents ?? 0);
    if (!Number.isFinite(totalCents) || totalCents < 50) {
      return NextResponse.json({ error: "Product amount must be at least 50 cents" }, { status: 400 });
    }

    const currency = product.currency || "usd";
    const paymentId = randomUUID();
    const nowIso = new Date().toISOString();
    const platformFeeCents = Math.round(totalCents * PLATFORM_FEE_RATE);

    let installmentMonths: number | null = null;
    let installmentAmountCents: number | null = null;

    if (planType === "installment") {
      installmentMonths = Number(body.installment_months);
      if (!Number.isInteger(installmentMonths) || installmentMonths < 2 || installmentMonths > 24) {
        return NextResponse.json(
          { error: "installment_months must be an integer between 2 and 24" },
          { status: 400 }
        );
      }
      installmentAmountCents = Math.round(totalCents / installmentMonths);
      if (installmentAmountCents < 50) {
        return NextResponse.json(
          { error: "Each installment must be at least 50 cents. Reduce the number of months." },
          { status: 400 }
        );
      }
    }

    // Seed the booking_payments row upfront so we can reference the id in metadata
    const { error: insertError } = await admin.from("booking_payments").insert({
      id: paymentId,
      booking_id: booking.id,
      product_id: product.product_id,
      closer_user_id: user.id,
      buyer_id: booking.buyer_id,
      plan_type: planType,
      installment_months: installmentMonths,
      status: "pending",
      amount_total_cents: totalCents,
      installment_amount_cents: installmentAmountCents,
      platform_fee_cents: platformFeeCents,
      currency,
      created_at: nowIso,
      updated_at: nowIso,
    });

    if (insertError) throw insertError;

    const metadataBase = {
      booking_id: booking.id,
      booking_payment_id: paymentId,
      product_id: product.product_id,
      creator_id: booking.creator_id,
      buyer_id: booking.buyer_id,
      plan_type: planType,
      plan_months: String(installmentMonths ?? 1),
      closer_user_id: user.id,
    };

    let session: Stripe.Checkout.Session;

    if (planType === "full") {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency,
              unit_amount: totalCents,
              product_data: {
                name: product.title || post.title || "Purchase",
              },
            },
            quantity: 1,
          },
        ],
        metadata: metadataBase,
        success_url: `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/dashboard`,
      });
    } else {
      // installment flow using subscription
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency,
              unit_amount: installmentAmountCents!,
              product_data: {
                name: `${product.title || post.title || "Installment"} plan`,
              },
              recurring: {
                interval: "month",
                interval_count: 1,
              },
            },
            quantity: 1,
          },
        ],
        subscription_data: {
          metadata: metadataBase,
        },
        metadata: metadataBase,
        success_url: `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/dashboard`,
      });
    }

    const { data: updated, error: updateError } = await admin
      .from("booking_payments")
      .update({
        stripe_checkout_session_id: session.id,
        link_url: session.url,
        status: "link_sent",
        link_sent_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", paymentId)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;

    return NextResponse.json({
      url: session.url,
      payment: updated,
    });
  } catch (error: any) {
    console.error("[payment-link] error:", error?.message || error);
    return NextResponse.json(
      { error: error?.message || "Failed to generate payment link" },
      { status: 500 }
    );
  }
}

type BookingRow = {
  id: string;
  post_id: string;
  buyer_id: string;
  creator_id: string;
  status: string;
};

type ProductRow = {
  product_id: string;
  title: string | null;
  amount_cents: number;
  currency: string | null;
};

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/Bearer\s+(.+)/i);
  return match ? match[1].trim() : null;
}

function extractAccessToken(cookieStore: CookieStore): string | null {
  try {
    const projectRef = new URL(SUPABASE_URL).host.split(".")[0];
    const cookieName = `sb-${projectRef}-auth-token`;
    const cookie = cookieStore.get(cookieName);
    if (!cookie?.value) return null;

    let raw = cookie.value;
    if (raw.startsWith("base64-")) {
      raw = raw.slice("base64-".length);
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        const normalized = normalizeBase64(raw);
        const decoded = Buffer.from(normalized, "base64").toString("utf8");
        parsed = JSON.parse(decoded);
      } catch {
        parsed = null;
      }
    }

    if (!parsed) return null;
    if (Array.isArray(parsed)) {
      const [access_token] = parsed;
      return typeof access_token === "string" ? access_token : null;
    }
    if (typeof parsed === "object") {
      return typeof parsed?.access_token === "string" ? parsed.access_token : null;
    }
    return null;
  } catch (err) {
    console.warn("[payment-link] extractAccessToken failed:", err);
    return null;
  }
}

function normalizeBase64(input: string): string {
  const replaced = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = replaced.length % 4;
  if (padding === 0) return replaced;
  return replaced.padEnd(replaced.length + (4 - padding), "=");
}


