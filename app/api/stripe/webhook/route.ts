// app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- ENV ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PLATFORM_FEE_RATE = 0.12;

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

// ---------- legacy (post/booking) flow ----------
async function insertBookingFromSession(session: Stripe.Checkout.Session) {
  const buyer_id = (session.metadata?.buyer_id as string) || null;
  const post_id = (session.metadata?.post_id as string) || null;
  const creator_id_meta = (session.metadata?.creator_id as string) || null;
  const creator_id = await fetchCreatorIdIfMissing(post_id, creator_id_meta);

  if (!buyer_id || !creator_id) {
    console.warn("[webhook] booking insert skipped: missing buyer_id/creator_id", {
      buyer_id,
      creator_id,
      post_id,
      session_id: session.id,
    });
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
    return;
  }

const { data: existing } = await admin
    .from("bookings")
    .select("id")
    .eq("buyer_id", buyer_id)
    .eq("creator_id", creator_id)
    .eq("post_id", post_id)
    .eq("status", "booked")
    .maybeSingle();
  if (!existing?.id) {
    const { error } = await admin
      .from("bookings")
      .insert({
        post_id,
        buyer_id,
        creator_id,
        status: "booked",
      })
      .select("id")
      .maybeSingle();
    if (error) console.error("[webhook] insert booking failed:", error.message);
  }
  
  if (error) console.error("[webhook] insert booking failed:", error.message);
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
  const buyer_id = (session.metadata?.buyer_id as string) || null;
  const product_id = (session.metadata?.product_id as string) || null;
  const post_id = (session.metadata?.post_id as string) || null;
  const creator_id = (session.metadata?.creator_id as string) || null;

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
        product_id,
        post_id,
        creator_id,
        session_id: session.id,
        subscription_id,
        payment_intent_id,
        amount_cents,
        currency,
        target_months,
        // status: set below according to mode
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
      product_id,
      post_id,
      creator_id,
      session_id: session.id,
      subscription_id,
      payment_intent_id,
      amount_cents,
      currency,
      target_months,
      paid_count: subscription_id ? 0 : 1,
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
  const { error } = await admin
    .from("purchases")
    .update({ status: "refunded" })
    .eq("payment_intent_id", payment_intent_id);
  if (error) console.warn("[webhook] markRefunded error:", error.message);
}

// ---------- route ----------
export async function POST(req: NextRequest) {
  if (!STRIPE_SECRET_KEY) return jerr("env", "Missing STRIPE_SECRET_KEY", 500);
  if (!STRIPE_WEBHOOK_SECRET) return jerr("env", "Missing STRIPE_WEBHOOK_SECRET", 500);
  if (!SUPABASE_URL) return jerr("env", "Missing NEXT_PUBLIC_SUPABASE_URL", 500);
  if (!SUPABASE_SERVICE_ROLE_KEY) return jerr("env", "Missing SUPABASE_SERVICE_ROLE_KEY", 500);

  const sig = req.headers.get("stripe-signature");
  if (!sig) return jerr("verify", "Missing stripe-signature header");

  let event: Stripe.Event;
  try {
    const rawBody = await req.text(); // IMPORTANT: raw body for signature verification
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e: any) {
    return jerr("verify", e?.message || "Invalid signature", 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        // Free booking flow (setup mode)
        if (session.mode === "setup") {
          await insertBookingFromSession(session);
          break;
        }

        const handledBookingPayment = await handleBookingPaymentSession(session);
        if (handledBookingPayment) {
          break;
        }

        // Product flow (one-time or subscription start)
        if (session.metadata?.product_id) {
          const purchaseId = await seedPurchaseFromProductSession(session);

          // One-time payments become active immediately - attach fulfillment now
          if (
            purchaseId &&
            session.mode === "payment" &&
            session.payment_status === "paid"
          ) {
            const product_id = (session.metadata?.product_id as string) || null;
            await attachFulfillmentIfEmpty(purchaseId, product_id);
          }

          // For subscriptions, fulfillment attaches on first invoice.payment_succeeded
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

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const pi =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent as any)?.id || null;
        await markRefunded(pi);
        break;
      }

      default: {
        console.log("[webhook] unhandled event:", event.type);
      }
    }

    // ACK
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[webhook] handler error:", e?.message || e);
    // Return 200 so Stripe doesn't retry forever if we had a data issue.
    return NextResponse.json({ ok: false, error: "handler error" }, { status: 200 });
  }
}
