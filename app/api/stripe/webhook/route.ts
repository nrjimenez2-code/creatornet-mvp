// app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { trackServerEvent } from "@/lib/posthogServer";
import { claimStripeEvent, releaseStripeEvent } from "@/lib/stripeEvents";
import { splitFee } from "@/lib/money";
import { ORDER_OPEN_STATUSES, ORDER_REFUNDABLE_STATUSES } from "@/lib/orderStatus";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { updatePostMetrics } from "@/lib/updatePostMetrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- ENV ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// --- Clients ---
// NOTE: do NOT pin apiVersion to avoid TS literal mismatches with installed types.
const stripe = new Stripe(STRIPE_SECRET_KEY);
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- helpers ----------
function jerr(stage: string, msg: string, status = 400) {
  console.error(`[webhook] ${stage}: ${msg}`);
  return NextResponse.json({ ok: false, stage, error: msg }, { status });
}

async function fetchCreatorIdIfMissing(
  post_id: string | null,
  creator_id: string | null
) {
  if (creator_id || !post_id) return creator_id || null;
  const { data, error } = await admin
    .from("posts")
    .select("creator_id")
    .eq("id", post_id)
    .maybeSingle();
  if (error) {
    console.warn("[webhook] fetchCreatorIdIfMissing error:", error.message);
    return null;
  }
  return (data?.creator_id as string | undefined) ?? null;
}

/** Link newest unlinked booking to a purchase (soft-fail if column missing). */
async function linkBookingIfAny(opts: {
  buyer_id: string | null;
  creator_id: string | null;
  post_id: string | null;
  purchase_id: string;
  lookbackDays?: number;
}) {
  const { buyer_id, creator_id, post_id, purchase_id, lookbackDays = 14 } = opts;
  if (!buyer_id || !creator_id) return;

  const { data: rows, error: findErr } = await admin
    .from("bookings")
    .select("id, created_at, post_id")
    .eq("buyer_id", buyer_id)
    .eq("creator_id", creator_id)
    .is("linked_order_id", null)
    .order("created_at", { ascending: false })
    .limit(8);

  if (findErr || !rows?.length) return;

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const candidate =
    (post_id &&
      rows.find(
        (b) => b.post_id === post_id && new Date(b.created_at).getTime() >= cutoff
      )) ||
    rows.find((b) => new Date(b.created_at).getTime() >= cutoff) ||
    null;

  if (!candidate) return;

  try {
    await admin.from("purchases").update({ booking_id: candidate.id as any }).eq("id", purchase_id);
  } catch (e: any) {
    if (!/column .*booking_id.* does not exist/i.test(String(e?.message))) {
      console.warn("[webhook] purchases.booking_id update warning:", e?.message || e);
    }
  }

  const { error: updBookingErr } = await admin
    .from("bookings")
    .update({ linked_order_id: purchase_id, status: "completed" })
    .eq("id", candidate.id);
  if (updBookingErr) {
    console.warn("[webhook] bookings.linked_order_id update failed:", updBookingErr.message);
  }
}

// ---------- fulfillment helpers ----------
async function getProductLinks(product_id: string | null) {
  if (!product_id) return null;
  const { data, error } = await admin
    .from("products")
    .select("product_id, title, price_cents, amount_cents, discord_invite_url, whop_listing_url")
    .eq("product_id", product_id)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function attachFulfillmentIfEmpty(purchaseId: string, productId: string | null) {
  if (!productId) return;

  // fetch current purchase; avoid double-setting
  const { data: existing, error: exErr } = await admin
    .from("purchases")
    .select("id, fulfillment, fulfillment_url")
    .eq("id", purchaseId)
    .maybeSingle();
  if (exErr) {
    console.warn("[webhook] attachFulfillmentIfEmpty fetch purchase error:", exErr.message);
    return;
  }
  if (existing?.fulfillment_url) return; // already set

  const product = await getProductLinks(productId);
  if (!product) return;

  let fulfillment: "discord" | "whop" | null = null;
  let fulfillment_url: string | null = null;

  if (product.discord_invite_url) {
    fulfillment = "discord";
    fulfillment_url = product.discord_invite_url;
  } else if (product.whop_listing_url) {
    fulfillment = "whop";
    fulfillment_url = product.whop_listing_url;
  } else {
    return; // no links configured; skip quietly
  }

  const payload = {
    source: "product",
    product_id: product.product_id,
    title: product.title,
    price_cents: product.price_cents ?? product.amount_cents ?? null,
    note: "creator-supplied fulfillment link",
  };

  const { error: updErr } = await admin
    .from("purchases")
    .update({
      fulfillment,
      fulfillment_url,
      fulfillment_payload: payload,
      first_access_at: new Date().toISOString(),
    })
    .eq("id", purchaseId);

  if (updErr) {
    console.warn("[webhook] attachFulfillmentIfEmpty update error:", updErr.message);
  }
}

async function finalizeOrderFromCheckoutSession(session: Stripe.Checkout.Session) {
  const orderId = (session.metadata?.order_id as string) || null;
  if (!orderId) return;
  const amount = typeof session.amount_total === "number" ? session.amount_total : 0;
  const { feeCents: fee, creatorCents: creatorAmt } = splitFee(amount);
  const pi =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;
  const paid = session.payment_status === "paid";
  // Status only ever moves forward. A checkout.session.completed that arrives
  // late (Stripe retries, out-of-order delivery) must not drag an order that
  // is already paid, refunded or canceled back to "created" or "paid".
  const { error } = await admin
    .from("orders")
    .update({
      status: paid ? "paid" : "created",
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: pi,
      stripe_payment_id: pi,
      gross_amount: amount,
      platform_fee: fee,
      creator_amount: creatorAmt,
      currency: session.currency || "usd",
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .in("status", paid ? ORDER_OPEN_STATUSES : ["created", "pending"]);
  if (error) console.warn("[webhook] finalizeOrderFromCheckoutSession:", error.message);
}

async function bumpCreatorEarningsAndPostPurchase(opts: {
  creator_id: string | null;
  post_id: string | null;
  creator_amount_cents: number;
}) {
  const { creator_id, post_id, creator_amount_cents } = opts;
  if (creator_id && creator_amount_cents > 0) {
    const { data: prof, error: selErr } = await admin
      .from("profiles")
      .select("total_earnings_cents")
      .eq("id", creator_id)
      .maybeSingle();
    if (
      !selErr &&
      prof &&
      typeof (prof as { total_earnings_cents?: unknown }).total_earnings_cents === "number"
    ) {
      const cur = Number((prof as { total_earnings_cents: number }).total_earnings_cents) || 0;
      const { error } = await admin
        .from("profiles")
        .update({ total_earnings_cents: cur + creator_amount_cents })
        .eq("id", creator_id);
      if (error && !/column|does not exist/i.test(error.message)) {
        console.warn("[webhook] bumpCreatorEarnings:", error.message);
      }
    }
  }
  if (post_id) {
    const { data: row, error: pErr } = await admin
      .from("posts")
      .select("purchase_count")
      .eq("id", post_id)
      .maybeSingle();
    if (!pErr && row && typeof (row as { purchase_count?: number }).purchase_count === "number") {
      const cur = Number((row as { purchase_count: number }).purchase_count) || 0;
      const { error } = await admin
        .from("posts")
        .update({ purchase_count: cur + 1 })
        .eq("id", post_id);
      if (error && !/column|does not exist/i.test(error.message)) {
        console.warn("[webhook] bumpPostPurchaseCount:", error.message);
      }
    }
  }
}

// ---------- legacy (post/booking) flow ----------
async function insertBookingFromSession(session: Stripe.Checkout.Session) {
  // For setup sessions, get buyer_id from customer email or metadata
  let buyer_id = (session.metadata?.buyer_id as string) || null;
  
  // If no buyer_id in metadata, try to get from customer
  if (!buyer_id && session.customer) {
    try {
      const customer = typeof session.customer === "string" 
        ? await stripe.customers.retrieve(session.customer)
        : session.customer;
      
      if (customer && !customer.deleted && customer.email) {
        // Try to find user by email
        const { data: profile } = await admin
          .from("profiles")
          .select("id")
          .eq("email", customer.email)
          .maybeSingle();
        if (profile?.id) {
          buyer_id = profile.id;
        }
      }
    } catch (err) {
      console.warn("[webhook] failed to get buyer from customer:", err);
    }
  }
  
  const post_id = (session.metadata?.post_id as string) || null;
  const creator_id_meta = (session.metadata?.creator_id as string) || null;
  const creator_id = await fetchCreatorIdIfMissing(post_id, creator_id_meta);

  // Fetch post/product details for logging
  let postDetails: any = null;
  let productDetails: any = null;
  if (post_id) {
    const { data: postData } = await admin
      .from("posts")
      .select("id, title, product_id")
      .eq("id", post_id)
      .maybeSingle();
    postDetails = postData;
    
    if (postData?.product_id) {
      const { data: prodData } = await admin
        .from("products")
        .select("product_id, title, amount_cents")
        .eq("product_id", postData.product_id)
        .maybeSingle();
      productDetails = prodData;
    }
  }

  console.log("[webhook] insertBookingFromSession - DETAILS:", {
    buyer_id,
    creator_id,
    post_id,
    session_id: session.id,
    mode: session.mode,
    post_title: postDetails?.title || "N/A",
    product_id: postDetails?.product_id || "N/A",
    product_title: productDetails?.title || "N/A",
    product_amount: productDetails?.amount_cents || "N/A",
  });

  if (!buyer_id || !creator_id) {
    console.error("[webhook] ❌ NOT INSERTED - missing buyer_id/creator_id", {
      reason: !buyer_id ? "buyer_id missing" : "creator_id missing",
      buyer_id,
      creator_id,
      post_id,
      post_title: postDetails?.title || "N/A",
      product_title: productDetails?.title || "N/A",
      session_id: session.id,
      note: "Seed endpoint should handle this via client-side",
    });
    // For setup sessions without buyer_id, the seed endpoint should handle it
    // Don't fail here, just log and let the client-side seed handle it
    return;
  }

  // Avoid duplicates if booking already seeded client-side
  const { data: existingBooking } = await admin
    .from("bookings")
    .select("id")
    .eq("buyer_id", buyer_id)
    .eq("creator_id", creator_id)
    .eq("post_id", post_id)
    .eq("status", "booked")
    .maybeSingle();
  if (existingBooking?.id) {
    console.log("[webhook] ✅ ALREADY EXISTS - booking not inserted (duplicate)", {
      booking_id: existingBooking.id,
      post_id,
      post_title: postDetails?.title || "N/A",
      product_title: productDetails?.title || "N/A",
      buyer_id,
      creator_id,
    });
    return;
  }

  const { data: inserted, error: insertErr } = await admin
    .from("bookings")
    .insert({
      post_id,
      buyer_id,
      creator_id,
      status: "booked",
    })
    .select("id")
    .maybeSingle();
  
  if (insertErr) {
    console.error("[webhook] ❌ NOT INSERTED - database error", {
      reason: insertErr.message,
      post_id,
      post_title: postDetails?.title || "N/A",
      product_title: productDetails?.title || "N/A",
      product_amount: productDetails?.amount_cents || "N/A",
      buyer_id,
      creator_id,
      error_code: (insertErr as any)?.code,
      error_details: (insertErr as any)?.details,
    });
  } else {
    console.log("[webhook] ✅ INSERTED - booking created successfully", {
      booking_id: inserted?.id,
      post_id,
      post_title: postDetails?.title || "N/A",
      product_title: productDetails?.title || "N/A",
      product_amount: productDetails?.amount_cents || "N/A",
      buyer_id,
      creator_id,
      status: "booked",
    });
  }
}

async function upsertPurchaseFromSession(session: Stripe.Checkout.Session) {
  const buyer_id = (session.metadata?.buyer_id as string) || null;
  const post_id = (session.metadata?.post_id as string) || null;
  const creator_id_meta = (session.metadata?.creator_id as string) || null;
  const creator_id = await fetchCreatorIdIfMissing(post_id, creator_id_meta);

  const payment_intent_id =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as any)?.id;

  const amount_cents =
    typeof session.amount_total === "number" ? session.amount_total : 0;

  const currency = session.currency || "usd";

  // If purchase already recorded by session_id → done
  {
    const { data, error } = await admin
      .from("purchases")
      .select("id")
      .eq("session_id", session.id)
      .maybeSingle();
    if (error) throw new Error(`select by session_id: ${error.message}`);
    if (data) return data.id as string;
  }

  // Update existing purchase by payment_intent, else insert fresh
  if (payment_intent_id) {
    const { data, error } = await admin
      .from("purchases")
      .select("id")
      .eq("payment_intent_id", payment_intent_id)
      .maybeSingle();
    if (error) throw new Error(`select by payment_intent_id: ${error.message}`);

    if (data) {
      const { error: updErr } = await admin
        .from("purchases")
        .update({
          buyer_id,
          creator_id,
          post_id,
          session_id: session.id,
          status: "paid",
          amount_cents,
          currency,
        })
        .eq("id", data.id);
      if (updErr) throw new Error(`update purchase: ${updErr.message}`);

      await linkBookingIfAny({ buyer_id, creator_id, post_id, purchase_id: data.id });
      return data.id as string;
    }
  }

  const { data: ins, error: insErr } = await admin
    .from("purchases")
    .insert({
      buyer_id,
      creator_id,
      post_id,
      session_id: session.id,
      payment_intent_id,
      amount_cents,
      currency,
      status: "paid",
    })
    .select("id")
    .maybeSingle();

  if (insErr && !/duplicate|unique/i.test(insErr.message)) {
    throw new Error(`insert purchase failed: ${insErr.message}`);
  }

  if (ins?.id) {
    await linkBookingIfAny({ buyer_id, creator_id, post_id, purchase_id: ins.id });
    return ins.id as string;
  }
  return null;
}

// ---------- product (course/mentorship) flow ----------
function safeJson(val: any) {
  try {
    return JSON.parse(JSON.stringify(val ?? null));
  } catch {
    return null;
  }
}

/** Seed/attach purchase rows for product checkouts (one-time or subscription). Returns purchase id if available. */
async function seedPurchaseFromProductSession(session: Stripe.Checkout.Session): Promise<string | null> {
  const buyer_id =
    (session.metadata?.buyer_user_id as string) ||
    (session.metadata?.buyer_id as string) ||
    null;
  const product_id = (session.metadata?.product_id as string) || null;
  const post_id = (session.metadata?.post_id as string) || null;
  const creator_id = (session.metadata?.creator_id as string) || null;
  const order_id = (session.metadata?.order_id as string) || null;

  const target_months =
    Number((session.metadata?.plan_months as string) || "1") > 0
      ? Number(session.metadata?.plan_months as string)
      : 1;

  const payment_intent_id =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as any)?.id || null;

  const subscription_id = (session.subscription as string) || null;
  const amount_cents = typeof session.amount_total === "number" ? session.amount_total : null;
  const currency = session.currency || "usd";

  const oneTimePaid =
    session.mode === "payment" && session.payment_status === "paid" && !subscription_id;

  if (!buyer_id || !product_id) {
    console.warn("[webhook] product seed skipped (missing buyer_id/product_id)", {
      session_id: session.id,
      buyer_id,
      product_id,
    });
    return null;
  }

  // Prefer to find by subscription for subs; else by session_id
  const findBy = subscription_id ? { subscription_id } : { session_id: session.id };

  const { data: existing, error: findErr } = await admin
    .from("purchases")
    .select("id")
    .match(findBy)
    .maybeSingle();
  if (findErr) throw new Error(`seed find error: ${findErr.message}`);

  if (existing?.id) {
    const { data: upd, error: updErr } = await admin
      .from("purchases")
      .update({
        buyer_id,
        buyer_user_id: buyer_id,
        user_id: buyer_id,
        product_id,
        post_id,
        creator_id,
        order_id,
        session_id: session.id,
        subscription_id,
        payment_intent_id,
        amount_cents,
        currency,
        target_months,
        access_granted: oneTimePaid,
        status: subscription_id ? "processing" : session.mode === "payment" ? "paid" : "processing",
      })
      .eq("id", existing.id)
      .select("id")
      .maybeSingle();
    if (updErr) throw new Error(`seed update error: ${updErr.message}`);
    return upd?.id ?? existing.id;
  }

  const { data: ins, error: insErr } = await admin
    .from("purchases")
    .insert({
      buyer_id,
      buyer_user_id: buyer_id,
      user_id: buyer_id,
      product_id,
      post_id,
      creator_id,
      order_id,
      session_id: session.id,
      subscription_id,
      payment_intent_id,
      amount_cents,
      currency,
      target_months,
      paid_count: subscription_id ? 0 : 1,
      access_granted: oneTimePaid,
      status: subscription_id ? "processing" : session.mode === "payment" ? "paid" : "processing",
      fulfillment_payload: safeJson({ note: "seeded" }),
    })
    .select("id")
    .maybeSingle();

  if (insErr && !/duplicate|unique/i.test(insErr.message)) {
    throw new Error(`seed insert error: ${insErr.message}`);
  }

  return ins?.id ?? null;
}

async function handleBookingPaymentSession(session: Stripe.Checkout.Session): Promise<boolean> {
  const bookingPaymentId = (session.metadata?.booking_payment_id as string) || null;
  if (!bookingPaymentId) return false;

  // Ensure purchase row exists for this session if product metadata is provided
  let purchaseId: string | null = null;
  if (session.metadata?.product_id) {
    try {
      purchaseId = await seedPurchaseFromProductSession(session);
      if (
        purchaseId &&
        session.mode === "payment" &&
        session.payment_status === "paid"
      ) {
        const product_id = (session.metadata?.product_id as string) || null;
        await attachFulfillmentIfEmpty(purchaseId, product_id);
      }
    } catch (err: any) {
      console.warn("[webhook] seed purchase for booking payment failed:", err?.message || err);
    }
  }

  const planType = (session.metadata?.plan_type as string) || "full";
  const bookingId = (session.metadata?.booking_id as string) || null;

  const payment_intent_id =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as any)?.id ?? null;

  const subscription_id =
    typeof session.subscription === "string" ? session.subscription : null;

  const amount_total_cents =
    typeof session.amount_total === "number" ? session.amount_total : null;

  const nowIso = new Date().toISOString();
  const updates: Record<string, any> = {
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: payment_intent_id,
    stripe_subscription_id: subscription_id,
    currency: session.currency || "usd",
    updated_at: nowIso,
  };

  if (planType === "installment" && amount_total_cents != null) {
    updates.installment_amount_cents = amount_total_cents;
  } else if (planType === "full" && amount_total_cents != null) {
    updates.amount_total_cents = amount_total_cents;
  }

  if (session.url) {
    updates.link_url = session.url;
  }

  if (session.payment_status === "paid") {
    updates.status = "completed";
    updates.completed_at = nowIso;
  }

  const { error } = await admin
    .from("booking_payments")
    .update(updates)
    .eq("id", bookingPaymentId);

  if (error) {
    console.warn("[webhook] booking payment update failed:", error.message);
  }

  if (bookingId && session.payment_status === "paid") {
    const { error: bookingError } = await admin
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", bookingId);
    if (bookingError) {
      console.warn("[webhook] booking status update failed:", bookingError.message);
    }
  }

  return true;
}

/** Advance subscription / record payment for invoice events. Also attach fulfillment on first success. */
async function handleInvoicePaymentSucceeded(inv: any) {
  const payment_intent_id =
    typeof inv?.payment_intent === "string"
      ? inv.payment_intent
      : inv?.payment_intent?.id ?? null;

  const subscription_id =
    typeof inv?.subscription === "string" ? inv.subscription : null;

  let purchase: any = null;

  if (subscription_id) {
    const { data } = await admin
      .from("purchases")
      .select("id, product_id, paid_count, target_months, fulfillment_url")
      .eq("subscription_id", subscription_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    purchase = data || null;
  }

  if (!purchase && payment_intent_id) {
    const { data } = await admin
      .from("purchases")
      .select("id, product_id, paid_count, target_months, fulfillment_url")
      .eq("payment_intent_id", payment_intent_id)
      .maybeSingle();
    purchase = data || null;
  }

  if (!purchase) {
    console.warn("[webhook] invoice.payment_succeeded: no purchase found", {
      subscription_id,
      payment_intent_id,
    });
    return;
  }

  const paid_count = (purchase.paid_count || 0) + 1;
  const target = purchase.target_months || 1;

  await admin
    .from("purchases")
    .update({
      paid_count,
      status: paid_count >= target ? "complete" : "active",
    })
    .eq("id", purchase.id);

  const bookingPaymentId =
    (inv?.metadata?.booking_payment_id as string) ||
    (inv?.lines?.data?.[0]?.price?.metadata?.booking_payment_id as string) ||
    null;

  if (bookingPaymentId) {
    const nowIso = new Date().toISOString();
    const updates: Record<string, any> = {
      stripe_payment_intent_id: payment_intent_id,
      updated_at: nowIso,
      status: "completed",
      completed_at: nowIso,
    };
    if (subscription_id) {
      updates.stripe_subscription_id = subscription_id;
    }
    if (typeof inv?.amount_paid === "number") {
      updates.installment_amount_cents = inv.amount_paid;
    }

    const { error: bpError } = await admin
      .from("booking_payments")
      .update(updates)
      .eq("id", bookingPaymentId);
    if (bpError) {
      console.warn(
        "[webhook] booking_payment update (invoice) failed:",
        bpError.message
      );
    }

    const bookingIdMeta = (inv?.metadata?.booking_id as string) || null;
    if (bookingIdMeta) {
      const { error: bookingErr } = await admin
        .from("bookings")
        .update({ status: "completed" })
        .eq("id", bookingIdMeta);
      if (bookingErr) {
        console.warn("[webhook] booking status update failed:", bookingErr.message);
      }
    }
  }

  // Attach fulfillment link if not yet set (first successful payment)
  if (!purchase.fulfillment_url) {
    await attachFulfillmentIfEmpty(purchase.id, purchase.product_id);
  }
}

async function markRefunded(payment_intent_id: string | null) {
  if (!payment_intent_id) return;
  const now = new Date().toISOString();
  const { error: oErr } = await admin
    .from("orders")
    .update({ status: "refunded", updated_at: now })
    .eq("stripe_payment_intent_id", payment_intent_id)
    .in("status", ORDER_REFUNDABLE_STATUSES);
  if (oErr && !/column|does not exist/i.test(oErr.message)) {
    console.warn("[webhook] markRefunded orders:", oErr.message);
  }
  const { error } = await admin
    .from("purchases")
    .update({ status: "refunded", access_granted: false })
    .eq("payment_intent_id", payment_intent_id);
  if (error) console.warn("[webhook] markRefunded error:", error.message);
}

async function reconcilePaymentIntentSucceeded(pi: Stripe.PaymentIntent) {
  const orderId = (pi.metadata?.order_id as string) || null;
  if (orderId) {
    const { data: ord } = await admin.from("orders").select("status").eq("id", orderId).maybeSingle();
    if (ord && ["pending", "created"].includes((ord as { status?: string }).status ?? "")) {
      const amount = typeof pi.amount_received === "number" ? pi.amount_received : pi.amount || 0;
      const { feeCents: fee, creatorCents: creatorAmt } = splitFee(amount);
      await admin
        .from("orders")
        .update({
          status: "paid",
          stripe_payment_intent_id: pi.id,
          stripe_payment_id: pi.id,
          gross_amount: amount,
          platform_fee: fee,
          creator_amount: creatorAmt,
          currency: (pi.currency as string) || "usd",
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId);
    }
  }
  const buyer =
    (pi.metadata?.buyer_user_id as string) || (pi.metadata?.buyer_id as string) || null;
  const patch: Record<string, unknown> = {
    status: "paid",
    access_granted: true,
  };
  if (buyer) {
    patch.buyer_user_id = buyer;
    patch.user_id = buyer;
    patch.buyer_id = buyer;
  }
  const { error } = await admin.from("purchases").update(patch).eq("payment_intent_id", pi.id);
  if (error && !/0 rows|No rows/i.test(error.message)) {
    console.warn("[webhook] reconcilePaymentIntentSucceeded purchases:", error.message);
  }
}

async function reconcilePaymentIntentFailed(pi: Stripe.PaymentIntent) {
  const orderId = (pi.metadata?.order_id as string) || null;
  const now = new Date().toISOString();
  if (orderId) {
    await admin
      .from("orders")
      .update({ status: "canceled", updated_at: now })
      .eq("id", orderId)
      .in("status", ORDER_OPEN_STATUSES);
  }
  await admin
    .from("orders")
    .update({ status: "canceled", updated_at: now })
    .eq("stripe_payment_intent_id", pi.id)
    .in("status", ORDER_OPEN_STATUSES);
  await admin
    .from("purchases")
    .update({ status: "failed", access_granted: false })
    .eq("payment_intent_id", pi.id);
}

// ---------- route ----------
export async function POST(req: NextRequest) {
  console.log("[webhook] 🔔 WEBHOOK REQUEST RECEIVED - Starting webhook handler");
  
  if (!STRIPE_SECRET_KEY) {
    console.error("[webhook] ❌ Missing STRIPE_SECRET_KEY");
    return jerr("env", "Missing STRIPE_SECRET_KEY", 500);
  }
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error("[webhook] ❌ Missing STRIPE_WEBHOOK_SECRET");
    return jerr("env", "Missing STRIPE_WEBHOOK_SECRET", 500);
  }
  if (!SUPABASE_URL) {
    console.error("[webhook] ❌ Missing NEXT_PUBLIC_SUPABASE_URL");
    return jerr("env", "Missing NEXT_PUBLIC_SUPABASE_URL", 500);
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[webhook] ❌ Missing SUPABASE_SERVICE_ROLE_KEY");
    return jerr("env", "Missing SUPABASE_SERVICE_ROLE_KEY", 500);
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    console.error("[webhook] ❌ Missing stripe-signature header");
    return jerr("verify", "Missing stripe-signature header", 400);
  }

  console.log("[webhook] 📝 Verifying webhook signature...");
  let event: Stripe.Event;
  try {
    const rawBody = await req.text(); // IMPORTANT: raw body for signature verification
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    console.log("[webhook] ✅ Signature verified successfully");
  } catch (e: any) {
    console.error("[webhook] ❌ Signature verification failed:", e?.message);
    return jerr("verify", e?.message || "Invalid signature", 400);
  }

  console.log("[webhook] 🎯 Processing event type:", event.type, "Event ID:", event.id);

  // Idempotency. Must be after signature verification (never record an event we
  // have not authenticated) and before any side effect. Stripe retries until it
  // gets a 2xx, and can deliver the same event to more than one endpoint.
  // Namespaced per handler. Both routes verify against the SAME signing secret,
  // so if Stripe is configured with both endpoints registered they would both
  // legitimately accept the same event. Sharing one claim key would let whichever
  // arrived first make the other skip its work entirely — and the two handlers do
  // DIFFERENT work, so that would silently drop purchases, earnings and access
  // grants. Which endpoint(s) Stripe delivers to is not visible from the code.
  const claimKey = `stripe:${event.id}`;
  const claim = await claimStripeEvent(claimKey, event.type);
  if (claim === "duplicate") {
    console.log("[webhook] ⏭️ Already processed, acknowledging without re-running:", event.id);
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        
        console.log("[webhook] ✅ SAVE BUTTON CLICKED - checkout.session.completed", {
          session_id: session.id,
          mode: session.mode,
          payment_status: session.payment_status,
        });

        // Free booking flow (setup mode)
        if (session.mode === "setup") {
          console.log("[webhook] 🎯 Processing setup session for booking");
          await insertBookingFromSession(session);
          break;
        }

        const handledBookingPayment = await handleBookingPaymentSession(session);
        if (handledBookingPayment) {
          break;
        }

        // Product flow (one-time or subscription start)
        if (session.metadata?.product_id) {
          await finalizeOrderFromCheckoutSession(session);
          const purchaseId = await seedPurchaseFromProductSession(session);

          if (
            purchaseId &&
            session.mode === "payment" &&
            session.payment_status === "paid"
          ) {
            const product_id = (session.metadata?.product_id as string) || null;
            await attachFulfillmentIfEmpty(purchaseId, product_id);

            const amount = typeof session.amount_total === "number" ? session.amount_total : 0;
            const { feeCents: fee, creatorCents: creatorAmt } = splitFee(amount);

            const buyerId =
              (session.metadata?.buyer_user_id as string) ||
              (session.metadata?.buyer_id as string) ||
              null;
            const postId = (session.metadata?.post_id as string) || null;

            await trackServerEvent("purchase_completed", buyerId, {
              order_id: session.metadata?.order_id,
              post_id: postId,
              product_id: session.metadata?.product_id || null,
              creator_id: session.metadata?.creator_id || null,
              price: amount / 100,
              purchase_id: purchaseId,
              session_id: session.id,
            });

            if (buyerId && postId) {
              const { data: post } = await admin
                .from("posts")
                .select("interests")
                .eq("id", postId)
                .maybeSingle();
              const category = Array.isArray(post?.interests)
                ? ((post.interests[0] as string) ?? null)
                : null;
              updateInterestScore(buyerId, category, 25);
            }

            updatePostMetrics(postId ?? null, { purchases: 1 });

            await bumpCreatorEarningsAndPostPurchase({
              creator_id: (session.metadata?.creator_id as string) || null,
              post_id: postId,
              creator_amount_cents: creatorAmt,
            });
          }

          break;
        }

        // Legacy post purchase flow
        if (session.mode === "payment" && session.payment_status === "paid") {
          const id = await upsertPurchaseFromSession(session);
          // (No product_id here; legacy flow stays unchanged)
          void id; // noop
        }
        break;
      }

      case "invoice.payment_succeeded": {
        await handleInvoicePaymentSucceeded(event.data.object);
        break;
      }

      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        await reconcilePaymentIntentSucceeded(pi);
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        await reconcilePaymentIntentFailed(pi);
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const pi =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent as any)?.id || null;
        await markRefunded(pi);
        break;
      }

      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        const complete = !!(account.charges_enabled && account.payouts_enabled);
        const { error: acctErr } = await admin
          .from("profiles")
          .update({
            charges_enabled: !!account.charges_enabled,
            payouts_enabled: !!account.payouts_enabled,
            // Always write the truth, including false. Stripe sends
            // account.updated when it restricts an account too, and a creator
            // whose charges are disabled must stop being sellable.
            stripe_onboarding_complete: complete,
            onboarding_complete: complete,
          })
          .eq("stripe_account_id", account.id);
        if (acctErr) {
          console.warn("[webhook] account.updated profile sync error:", acctErr.message);
        } else {
          console.log("[webhook] account.updated:", account.id, { complete });
        }
        break;
      }

      default: {
        console.log("[webhook] ⚠️ Unhandled event type:", event.type, "Event ID:", event.id);
      }
    }

    console.log("[webhook] ✅ Event processed successfully, returning ACK");
    // ACK
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[webhook] ❌ Handler error:", e?.message || e, "Stack:", e?.stack);
    // We are asking Stripe to retry, so the claim taken above has to go back.
    // Leaving it would make the retry look like a duplicate, and the payment
    // would never be recorded.
    if (claim === "new") {
      await releaseStripeEvent(claimKey);
    }
    return NextResponse.json({ ok: false, error: "handler error" }, { status: 500 });
  }
}
