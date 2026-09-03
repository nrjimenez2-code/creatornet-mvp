import { NextRequest, NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { eitherIdFilter } from "@/lib/ids";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { randomUUID } from "crypto";
import { getSiteUrl } from "@/lib/siteUrl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe calls are capped at 20s with 2 retries (lib/stripeClient.ts); without
// maxDuration Vercel's 10s plan default can kill the function mid-call. 60s
// covers the worst legitimate case and is allowed on every Vercel plan.
export const maxDuration = 60;

import {
  calculateCreatorFees,
  creatorFeeMetadata,
  getSubscriptionProcessingFeeSchedule,
  PLATFORM_FEE_PERCENT,
} from "@/lib/money";
const SUPABASE_URL: string =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  (process.env as any).NEXT_PUBLIC_SUPABASE_UR;
const SERVICE_ROLE_KEY: string = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// See the note in app/api/stripe/connect/onboard/route.ts: a local fallback
// to localhost poisons success/cancel URLs on the Vercel projects that do not
// set NEXT_PUBLIC_SITE_URL.
const SITE_URL = getSiteUrl();

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
      .maybeSingle<{
        id: string;
        post_id: string;
        buyer_id: string;
        creator_id: string;
        status: string;
      }>();

    if (bookingError) throw bookingError;
    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    if (booking.creator_id !== user.id) {
      return NextResponse.json({ error: "You do not own this booking" }, { status: 403 });
    }

    if (booking.status === "completed") {
      return NextResponse.json(
        { error: "This booking has already been paid.", code: "BOOKING_ALREADY_PAID" },
        { status: 409 }
      );
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
      .select("id, product_id, title, amount_cents, currency")
      .or(eitherIdFilter(["product_id", "id"], post.product_id))
      .maybeSingle<{
        id: string;
        product_id: string | null;
        title: string | null;
        amount_cents: number;
        currency: string | null;
      }>();

    if (productError) throw productError;
    if (!product) {
      return NextResponse.json(
        { error: "Product not found for this booking" },
        { status: 400 }
      );
    }

    const productIdForPayload = product.id ?? product.product_id ?? post.product_id;

    const totalCents = Number(product.amount_cents ?? 0);
    if (!Number.isFinite(totalCents) || totalCents < 50) {
      return NextResponse.json({ error: "Product amount must be at least 50 cents" }, { status: 400 });
    }

    const { data: creatorProfile, error: creatorProfileErr } = await admin
      .from("profiles")
      .select("stripe_account_id, stripe_onboarding_complete")
      .eq("id", booking.creator_id)
      .maybeSingle();

    if (creatorProfileErr) throw creatorProfileErr;

    if (!creatorProfile?.stripe_account_id || !creatorProfile.stripe_onboarding_complete) {
      return NextResponse.json(
        {
          error: "Creator must finish Stripe Connect before sending payment links.",
          code: "STRIPE_CONNECT_REQUIRED",
        },
        { status: 403 }
      );
    }

    const creatorStripeAccountId = creatorProfile.stripe_account_id;

    const currency = product.currency || "usd";
    const nowIso = new Date().toISOString();

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

    // A full payment has one charge for the product total. An installment
    // subscription has one charge per invoice, so its fixed processing
    // component must be calculated from the monthly amount each time.
    const chargeGrossCents =
      planType === "installment" ? installmentAmountCents! : totalCents;
    const fees =
      planType === "installment"
        ? calculateCreatorFees(
            chargeGrossCents,
            getSubscriptionProcessingFeeSchedule()
          )
        : calculateCreatorFees(chargeGrossCents);

    type ActiveBookingPayment = {
      id: string;
      booking_id: string;
      plan_type: "full" | "installment";
      installment_months: number | null;
      status: string;
      link_url: string | null;
      stripe_checkout_session_id: string | null;
      stripe_payment_intent_id: string | null;
      stripe_subscription_id: string | null;
      amount_total_cents: number | null;
      installment_amount_cents: number | null;
      platform_fee_cents: number | null;
      processing_fee_cents: number | null;
      total_creator_deduction_cents: number | null;
      creator_net_cents: number | null;
      fee_schedule_version: string | null;
      currency: string | null;
      created_at: string;
      completed_at: string | null;
      link_sent_at: string | null;
      closer_user_id: string | null;
    };

    const activePaymentColumns =
      "id, booking_id, plan_type, installment_months, status, link_url, stripe_checkout_session_id, stripe_payment_intent_id, stripe_subscription_id, amount_total_cents, installment_amount_cents, platform_fee_cents, processing_fee_cents, total_creator_deduction_cents, creator_net_cents, fee_schedule_version, currency, created_at, completed_at, link_sent_at, closer_user_id";
    const loadActivePayment = async () => {
      const { data, error } = await admin
        .from("booking_payments")
        .select(activePaymentColumns)
        .eq("booking_id", booking.id)
        .in("status", ["pending", "link_sent", "completed"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<ActiveBookingPayment>();
      if (error) throw new Error(`Failed to check existing payment link: ${error.message}`);
      return data;
    };

    const existingMatchesRequest = (payment: ActiveBookingPayment) =>
      payment.plan_type === planType &&
      Number(payment.installment_months ?? 0) === Number(installmentMonths ?? 0) &&
      Number(payment.amount_total_cents) === totalCents &&
      Number(payment.installment_amount_cents ?? 0) === Number(installmentAmountCents ?? 0) &&
      Number(payment.platform_fee_cents) === fees.platformFeeCents &&
      Number(payment.processing_fee_cents ?? 0) === fees.processingFeeCents &&
      Number(payment.total_creator_deduction_cents ?? payment.platform_fee_cents) ===
        fees.totalCreatorDeductionCents &&
      Number(payment.creator_net_cents) === fees.creatorNetCents &&
      payment.fee_schedule_version === fees.feeScheduleVersion &&
      String(payment.currency || "").trim().toLowerCase() === currency.trim().toLowerCase();

    const existingPaymentResponse = (payment: ActiveBookingPayment): NextResponse | null => {
      if (payment.status === "completed") {
        return NextResponse.json(
          { error: "This booking has already been paid.", code: "BOOKING_ALREADY_PAID" },
          { status: 409 }
        );
      }
      if (!existingMatchesRequest(payment)) {
        return NextResponse.json(
          {
            error:
              "This booking already has an active payment link with different terms. Let it expire before creating another.",
            code: "BOOKING_PAYMENT_LINK_EXISTS",
          },
          { status: 409 }
        );
      }
      if (payment.link_url) {
        return NextResponse.json({ url: payment.link_url, payment, reused: true });
      }
      return null;
    };

    let activePayment = await loadActivePayment();
    if (activePayment) {
      const response = existingPaymentResponse(activePayment);
      if (response) return response;
    }

    let paymentId = activePayment?.id || randomUUID();

    // Seed the booking_payments row upfront so we can reference the id in metadata
    if (!activePayment) {
      const { error: insertError } = await admin.from("booking_payments").insert({
        id: paymentId,
        booking_id: booking.id,
        product_id: product.id,
        closer_user_id: user.id,
        buyer_id: booking.buyer_id,
        plan_type: planType,
        installment_months: installmentMonths,
        status: "pending",
        amount_total_cents: totalCents,
        installment_amount_cents: installmentAmountCents,
        platform_fee_cents: fees.platformFeeCents,
        processing_fee_cents: fees.processingFeeCents,
        total_creator_deduction_cents: fees.totalCreatorDeductionCents,
        creator_net_cents: fees.creatorNetCents,
        fee_schedule_version: fees.feeScheduleVersion,
        currency,
        created_at: nowIso,
        updated_at: nowIso,
      });

      if (insertError) {
        if (!/duplicate|unique|23505/i.test(`${insertError.code || ""} ${insertError.message}`)) {
          throw insertError;
        }
        // A concurrent request won the one-live-link constraint. Reuse its row
        // and the same Stripe idempotency key instead of minting a second charge path.
        activePayment = await loadActivePayment();
        if (!activePayment) throw insertError;
        const response = existingPaymentResponse(activePayment);
        if (response) return response;
        paymentId = activePayment.id;
      }
    }

    const metadataBase = {
      booking_id: booking.id,
      booking_payment_id: paymentId,
      product_id: productIdForPayload,
      creator_id: booking.creator_id,
      buyer_id: booking.buyer_id,
      plan_type: planType,
      plan_months: String(installmentMonths ?? 1),
      closer_user_id: user.id,
      creator_stripe_account_id: creatorStripeAccountId,
      ...creatorFeeMetadata(fees),
    };

    let session: Stripe.Checkout.Session;

    if (planType === "full") {
      session = await getStripe().checkout.sessions.create(
        {
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
          payment_intent_data: {
            application_fee_amount: fees.totalCreatorDeductionCents,
            transfer_data: { destination: creatorStripeAccountId },
            metadata: metadataBase,
          },
          metadata: metadataBase,
          success_url: `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${SITE_URL}/dashboard`,
        },
        { idempotencyKey: `booking-payment:${paymentId}` }
      );
    } else {
      // installment flow using subscription
      session = await getStripe().checkout.sessions.create(
        {
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
            // This 12% value is a safe fallback while the feature is disabled.
            // When creator-funded processing is enabled, invoice.created replaces
            // it with the exact per-invoice application_fee_amount before payment.
            application_fee_percent: PLATFORM_FEE_PERCENT,
            transfer_data: { destination: creatorStripeAccountId },
            metadata: metadataBase,
          },
          metadata: metadataBase,
          success_url: `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${SITE_URL}/dashboard`,
        },
        { idempotencyKey: `booking-payment:${paymentId}` }
      );
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

    if (updateError || !updated) {
      throw updateError || new Error("Failed to save the generated payment link");
    }

    return NextResponse.json({
      url: session.url,
      payment: updated,
    });
  } catch (error: any) {
    console.error("[payment-link] error:", error?.message || error);
    return NextResponse.json(
      { error: publicMessage("payment-link", error, "Failed to generate payment link") },
      { status: 500 }
    );
  }
}

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


