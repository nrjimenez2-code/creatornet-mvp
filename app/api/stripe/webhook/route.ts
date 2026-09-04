// app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { createClient } from "@supabase/supabase-js";
import { trackServerEvent } from "@/lib/posthogServer";
import {
  claimStripeEvent,
  completeStripeEvent,
  releaseStripeEvent,
} from "@/lib/stripeEvents";
import {
  calculateCreatorFeesFromMetadataSchedule,
  creatorFeeMetadata,
  creatorFeesFromMetadata,
} from "@/lib/money";
import {
  ORDER_OPEN_STATUSES,
  purchaseTerminalFilter,
} from "@/lib/orderStatus";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { updatePostMetrics } from "@/lib/updatePostMetrics";
import { creditPurchaseEarnings } from "@/lib/creatorEarnings";
import {
  assertConfiguredApplicationFee,
  creditLedgerEarnings,
  recordPaymentFeeLedger,
  retrieveStripeFeeDetails,
  type StripeFeeDetails,
} from "@/lib/paymentFeeLedger";
import {
  applyPaymentRefundState,
  confirmAdminRefundWebhookDelivery,
  reconcileKnownPaymentRefund,
  recordPaymentRefundState,
} from "@/lib/paymentRefunds";
import {
  applyPaymentDisputeState,
  reconcileKnownPaymentDispute,
  recordPaymentDisputeState,
} from "@/lib/paymentDisputes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe calls are capped at 20s with 2 retries (lib/stripeClient.ts); without
// maxDuration Vercel's 10s plan default can kill the function mid-call. 60s
// covers the worst legitimate case and is allowed on every Vercel plan.
export const maxDuration = 60;

// --- ENV ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
// Stripe sends platform payment events and connected-account lifecycle events
// through different event destinations. Each destination has its own signing
// secret, so accept the optional Connect secret without changing the existing
// single-destination setup. The Connect destination should subscribe only to
// connected-account events such as account.updated.
const STRIPE_CONNECT_WEBHOOK_SECRET =
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// --- Clients ---
// NOTE: do NOT pin apiVersion to avoid TS literal mismatches with installed types.
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- helpers ----------
function jerr(stage: string, msg: string, status = 400) {
  console.error(`[webhook] ${stage}: ${msg}`);
  // The response body is visible in the Stripe dashboard and to anyone who
  // posts to this URL; the stage is enough to debug from, the message is not
  // needed there.
  return NextResponse.json({ ok: false, stage }, { status });
}

function verifyStripeEvent(rawBody: string, signature: string): Stripe.Event {
  let lastError: unknown = new Error("Invalid Stripe webhook signature");
  const secrets = Array.from(
    new Set(
      [STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET].filter(
        (secret): secret is string => Boolean(secret),
      ),
    ),
  );

  for (const secret of secrets) {
    try {
      return getStripe().webhooks.constructEvent(rawBody, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
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
  const fees = creatorFeesFromMetadata(session.metadata, amount);
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
      platform_fee: fees.platformFeeCents,
      processing_fee: fees.processingFeeCents,
      total_creator_deduction: fees.totalCreatorDeductionCents,
      creator_amount: fees.creatorNetCents,
      fee_schedule_version: fees.feeScheduleVersion,
      currency: session.currency || "usd",
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .in("status", ORDER_OPEN_STATUSES);
  if (error) {
    throw new Error(`checkout order finalization failed: ${error.message}`);
  }
}


// ---------- legacy (post/booking) flow ----------
async function insertBookingFromSession(session: Stripe.Checkout.Session) {
  // The buyer is whoever checkout put in the metadata, and only them. The
  // old fallback matched the Stripe customer email against profiles, which
  // let anyone attach a booking to another account by typing that email on
  // the card form (and profiles has no email column, so it never worked).
  const buyer_id =
    (session.metadata?.buyer_user_id as string) ||
    (session.metadata?.buyer_id as string) ||
    null;
  if (!buyer_id) {
    console.warn("[webhook] booking session without buyer metadata; skipping", session.id);
    return;
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

/** Seed/attach the purchase row for a product checkout, or fail so Stripe retries. */
async function seedPurchaseFromProductSession(session: Stripe.Checkout.Session): Promise<string> {
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
  const fees = creatorFeesFromMetadata(session.metadata, amount_cents ?? 0);

  const oneTimePaid =
    session.mode === "payment" && session.payment_status === "paid" && !subscription_id;

  if (!buyer_id || !product_id) {
    throw new Error(
      `product session ${session.id} is missing buyer/product linkage`
    );
  }

  // Prefer to find by subscription for subs; else by session_id
  const findBy = subscription_id ? { subscription_id } : { session_id: session.id };

  const { data: existing, error: findErr } = await admin
    .from("purchases")
    .select("id")
    .match(findBy)
    .maybeSingle();
  if (findErr) throw new Error(`seed find error: ${findErr.message}`);

  // Fall back to the (buyer_id, post_id) pair before giving up.
  //
  // `purchases` carries UNIQUE (buyer_id, post_id). /api/checkout writes a
  // pending row on EVERY checkout start, and swallows the resulting duplicate
  // error on the second start for the same post. So a buyer who abandons
  // checkout once and completes it on a retry has a pending row keyed to the
  // FIRST session id and nothing at all for the session that actually paid.
  //
  // Looking up by session_id alone missed that row, fell through to the insert
  // below, hit the same unique constraint, swallowed it, and returned null —
  // which made the caller skip fulfillment entirely: no access grant, no
  // creator earnings, no purchase_completed event. The buyer was charged and
  // got nothing. This lookup is what closes that path.
  let resolved = existing;
  if (!resolved && buyer_id && post_id) {
    const { data: byPair, error: pairErr } = await admin
      .from("purchases")
      .select("id")
      .eq("buyer_id", buyer_id)
      .eq("post_id", post_id)
      .maybeSingle();
    if (pairErr) throw new Error(`seed pair-find error: ${pairErr.message}`);
    if (byPair?.id) resolved = byPair;
  }

  if (resolved?.id) {
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
        platform_fee_cents: fees.platformFeeCents,
        processing_fee_cents: fees.processingFeeCents,
        total_creator_deduction_cents: fees.totalCreatorDeductionCents,
        creator_net_cents: fees.creatorNetCents,
        fee_schedule_version: fees.feeScheduleVersion,
        target_months,
        access_granted: oneTimePaid,
        status: subscription_id ? "processing" : session.mode === "payment" ? "paid" : "processing",
      })
      .eq("id", resolved.id)
      // Same terminal-status guard as reconcilePaymentIntentSucceeded: a
      // checkout.session.completed that arrives (or is retried) after a refund
      // must not put the row back to paid and re-grant the file.
      .not("status", "in", purchaseTerminalFilter())
      .select("id")
      .maybeSingle();
    if (updErr) throw new Error(`seed update error: ${updErr.message}`);
    if (!upd?.id) {
      throw new Error(
        `paid session ${session.id} cannot replace terminal purchase ${resolved.id}`
      );
    }
    return upd.id;
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
      platform_fee_cents: fees.platformFeeCents,
      processing_fee_cents: fees.processingFeeCents,
      total_creator_deduction_cents: fees.totalCreatorDeductionCents,
      creator_net_cents: fees.creatorNetCents,
      fee_schedule_version: fees.feeScheduleVersion,
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

  if (ins?.id) return ins.id;

  // The insert lost a race against a concurrent delivery (or against a pending
  // row written between the lookup above and here). Returning null used to make
  // the caller skip fulfillment altogether, which is the worst possible outcome
  // for a payment that has already been captured. Re-read the row the
  // constraint is protecting and finish the job against it.
  if (buyer_id && post_id) {
    const { data: raced } = await admin
      .from("purchases")
      .select("id")
      .eq("buyer_id", buyer_id)
      .eq("post_id", post_id)
      .maybeSingle();
    if (raced?.id) {
      const { data: raceUpdated, error: raceUpdErr } = await admin
        .from("purchases")
        .update({
          session_id: session.id,
          payment_intent_id,
          subscription_id,
          order_id,
          amount_cents,
          currency,
          platform_fee_cents: fees.platformFeeCents,
          processing_fee_cents: fees.processingFeeCents,
          total_creator_deduction_cents: fees.totalCreatorDeductionCents,
          creator_net_cents: fees.creatorNetCents,
          fee_schedule_version: fees.feeScheduleVersion,
          access_granted: oneTimePaid,
          status: subscription_id ? "processing" : session.mode === "payment" ? "paid" : "processing",
        })
        .eq("id", raced.id)
        .not("status", "in", purchaseTerminalFilter())
        .select("id")
        .maybeSingle();
      if (raceUpdErr) {
        throw new Error(`seed race-update error: ${raceUpdErr.message}`);
      }
      if (!raceUpdated?.id) {
        throw new Error(
          `paid session ${session.id} cannot replace terminal raced purchase ${raced.id}`
        );
      }
      return raceUpdated.id;
    }
  }

  // Nothing to attach the payment to. Throw rather than return null so the
  // claim is released and Stripe retries, instead of silently acknowledging a
  // payment we never recorded.
  throw new Error(
    `seed could not resolve a purchases row for session ${session.id} (buyer=${buyer_id}, post=${post_id})`
  );
}

async function handleBookingPaymentSession(session: Stripe.Checkout.Session): Promise<boolean> {
  const bookingPaymentId = (session.metadata?.booking_payment_id as string) || null;
  if (!bookingPaymentId) return false;

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
  const fees = creatorFeesFromMetadata(session.metadata, amount_total_cents ?? 0);
  const capturedOneTimePayment =
    session.mode === "payment" && session.payment_status === "paid";
  const stripeFee =
    capturedOneTimePayment
      ? await retrieveStripeFeeDetails(
          payment_intent_id,
          fees.processingFeeEnabled
        )
      : null;
  if (capturedOneTimePayment) {
    assertConfiguredApplicationFee(
      `booking checkout ${session.id}`,
      fees,
      stripeFee
    );
  }

  // Validate the captured Stripe split before granting access or mutating the
  // purchase. Then ensure a purchase row exists for product-backed bookings.
  let purchaseId: string | null = null;
  if (session.metadata?.product_id) {
    purchaseId = await seedPurchaseFromProductSession(session);
    if (
      purchaseId &&
      session.mode === "payment" &&
      session.payment_status === "paid"
    ) {
      const product_id = (session.metadata?.product_id as string) || null;
      await attachFulfillmentIfEmpty(purchaseId, product_id);
    }
  }

  const nowIso = new Date().toISOString();
  const updates: Record<string, any> = {
    stripe_checkout_session_id: session.id,
    ...(payment_intent_id ? { stripe_payment_intent_id: payment_intent_id } : {}),
    ...(subscription_id ? { stripe_subscription_id: subscription_id } : {}),
    currency: session.currency || "usd",
    platform_fee_cents: fees.platformFeeCents,
    processing_fee_cents: fees.processingFeeCents,
    total_creator_deduction_cents: fees.totalCreatorDeductionCents,
    creator_net_cents: fees.creatorNetCents,
    fee_schedule_version: fees.feeScheduleVersion,
    ...(stripeFee
      ? {
          stripe_charge_id: stripeFee.chargeId,
          stripe_balance_transaction_id: stripeFee.balanceTransactionId,
          actual_stripe_fee_cents: stripeFee.actualStripeFeeCents,
          processing_fee_variance_cents:
            fees.processingFeeCents - stripeFee.actualStripeFeeCents,
        }
      : {}),
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

  if (capturedOneTimePayment) {
    updates.status = "completed";
    updates.completed_at = nowIso;
  }

  const { error } = await admin
    .from("booking_payments")
    .update(updates)
    .eq("id", bookingPaymentId);

  if (error) {
    if (session.payment_status === "paid") {
      throw new Error(`paid booking payment update failed: ${error.message}`);
    }
    console.warn("[webhook] booking payment update failed:", error.message);
  }

  if (bookingId && capturedOneTimePayment) {
    const { error: bookingError } = await admin
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", bookingId);
    if (bookingError) {
      console.warn("[webhook] booking status update failed:", bookingError.message);
    }
  }

  if (
    capturedOneTimePayment &&
    (!purchaseId || !session.metadata?.creator_id || !payment_intent_id)
  ) {
    throw new Error(
      `paid booking session ${session.id} is missing purchase, creator, or PaymentIntent linkage`
    );
  }

  if (
    capturedOneTimePayment &&
    purchaseId &&
    session.metadata?.creator_id
  ) {
    await recordPaymentFeeLedger(admin, {
      breakdown: fees,
      currency: session.currency || "usd",
      creatorId: session.metadata.creator_id,
      purchaseId,
      bookingPaymentId,
      checkoutSessionId: session.id,
      paymentIntentId: payment_intent_id,
      stripeFee,
      status: "paid",
    }, true);
    await creditPurchaseEarnings(
      admin,
      purchaseId,
      amount_total_cents,
      fees.creatorNetCents,
      true
    );
    await reconcileKnownPaymentRefund(admin, payment_intent_id);
  }

  return true;
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function invoicePaymentIntentFromPayments(inv: any): string | null {
  const payments = Array.isArray(inv?.payments?.data) ? inv.payments.data : [];
  const preferred =
    payments.find((entry: any) => entry?.status === "paid") ||
    payments.find((entry: any) => entry?.is_default) ||
    payments[0];
  return stripeObjectId(preferred?.payment?.payment_intent);
}

/** Support both pre-Basil invoice.payment_intent and current invoice.payments. */
async function invoicePaymentIntentId(inv: any): Promise<string | null> {
  const embedded =
    stripeObjectId(inv?.payment_intent) || invoicePaymentIntentFromPayments(inv);
  if (embedded || !inv?.id) return embedded;

  try {
    const stripe = getStripe();
    if (!stripe.invoices?.retrieve) return null;
    const expanded = await stripe.invoices.retrieve(inv.id, {
      expand: ["payments.data.payment.payment_intent"],
    });
    return invoicePaymentIntentFromPayments(expanded);
  } catch (error: unknown) {
    console.warn(
      "[webhook] invoice PaymentIntent lookup failed:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

async function invoiceFeeContext(inv: any): Promise<{
  metadata: Record<string, string>;
  subscriptionId: string | null;
  destination: string | null;
}> {
  const subscriptionId =
    stripeObjectId(inv?.subscription) ||
    stripeObjectId(inv?.parent?.subscription_details?.subscription);
  const parentMetadataSource =
    inv?.parent?.subscription_details?.metadata || inv?.subscription_details?.metadata;
  const parentMetadata =
    parentMetadataSource && typeof parentMetadataSource === "object"
      ? parentMetadataSource
      : {};
  let subscriptionMetadata: Record<string, string> = {};
  let destination = stripeObjectId(inv?.transfer_data?.destination);

  if (subscriptionId) {
    try {
      const stripe = getStripe();
      if (!stripe.subscriptions?.retrieve) {
        throw new Error("Stripe subscription retrieval is unavailable");
      }
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      subscriptionMetadata = (subscription.metadata || {}) as Record<string, string>;
      destination =
        destination || stripeObjectId(subscription.transfer_data?.destination);
    } catch (error: unknown) {
      // A transient lookup failure must not turn an enabled installment into a
      // silently acknowledged 12%-only invoice. Returning 500 lets Stripe retry
      // invoice.created once its API is reachable again.
      throw new Error(
        `subscription metadata lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const metadata = {
    ...subscriptionMetadata,
    ...(parentMetadata as Record<string, string>),
    ...((inv?.metadata || {}) as Record<string, string>),
  };

  return {
    metadata,
    subscriptionId,
    destination:
      destination || metadata.creator_stripe_account_id || null,
  };
}

/** Set the fixed + percentage creator deduction before each installment invoice is paid. */
async function handleInvoiceCreated(inv: any) {
  const { metadata, destination } = await invoiceFeeContext(inv);
  if (metadata.processing_fee_enabled !== "true") return;
  if (!metadata.booking_payment_id || metadata.plan_type !== "installment") return;

  const gross = typeof inv?.amount_due === "number" ? inv.amount_due : inv?.total;
  if (!Number.isSafeInteger(gross) || gross < 0) {
    throw new Error(`invoice ${inv?.id || "unknown"} has no valid amount_due`);
  }

  // Use the immutable schedule, not the first invoice's dollar split. Future
  // invoice totals can change because of discounts, credits, or adjustments.
  const fees = calculateCreatorFeesFromMetadataSchedule(metadata, gross);
  if (!destination) {
    throw new Error(`invoice ${inv.id} has no connected-account destination`);
  }

  await getStripe().invoices.update(inv.id, {
    application_fee_amount: fees.totalCreatorDeductionCents,
    transfer_data: { destination },
    metadata: {
      ...metadata,
      ...creatorFeeMetadata(fees),
    },
  });
}

/** Advance subscription / record payment for invoice events. Also attach fulfillment on first success. */
async function handleInvoicePaymentSucceeded(inv: any) {
  const payment_intent_id = await invoicePaymentIntentId(inv);

  const invoiceContext = await invoiceFeeContext(inv);
  const subscription_id = invoiceContext.subscriptionId;

  let purchase: any = null;

  if (subscription_id) {
    const { data } = await admin
      .from("purchases")
      .select("id, product_id, creator_id, paid_count, target_months, fulfillment_url")
      .eq("subscription_id", subscription_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    purchase = data || null;
  }

  if (!purchase && payment_intent_id) {
    const { data } = await admin
      .from("purchases")
      .select("id, product_id, creator_id, paid_count, target_months, fulfillment_url")
      .eq("payment_intent_id", payment_intent_id)
      .maybeSingle();
    purchase = data || null;
  }

  if (!purchase) {
    console.warn("[webhook] invoice.payment_succeeded: no purchase found", {
      subscription_id,
      payment_intent_id,
    });
    // CreatorNet installment invoices must not be acknowledged without an
    // internal purchase to receive fulfillment and earnings. Event delivery
    // order is not guaranteed, so ask Stripe to retry after checkout.completed
    // has seeded the purchase.
    if (invoiceContext.metadata.booking_payment_id) {
      throw new Error(`invoice ${inv?.id || "unknown"} arrived before its purchase row`);
    }
    return;
  }

  const paidGrossCents =
    typeof inv?.amount_paid === "number" ? inv.amount_paid : 0;
  const fees = creatorFeesFromMetadata(invoiceContext.metadata, paidGrossCents);
  let stripeFee: StripeFeeDetails | null = null;
  if (paidGrossCents > 0) {
    if (!payment_intent_id) {
      throw new Error(
        `paid invoice ${inv?.id || "unknown"} has no PaymentIntent linkage`
      );
    }
    stripeFee = await retrieveStripeFeeDetails(
      payment_intent_id,
      fees.processingFeeEnabled
    );
    // A paid invoice cannot be repaired after the fact. Do not book fictional
    // creator-funded processing or credit overstated earnings if invoice.created
    // was not applied. The retryable failure keeps the incident visible for
    // reconciliation instead of silently making CreatorNet absorb the cost.
    assertConfiguredApplicationFee(
      `invoice ${inv?.id || "unknown"}`,
      fees,
      stripeFee
    );
  } else {
    // A fully discounted or credit-covered invoice legitimately has no charge,
    // PaymentIntent, balance transaction, or processing fee. It still represents
    // a completed installment cycle, so record it by invoice id and let the
    // ledger RPC advance paid_count exactly once.
    const invoiceApplicationFee =
      typeof inv?.application_fee_amount === "number"
        ? inv.application_fee_amount
        : 0;
    if (fees.totalCreatorDeductionCents !== 0 || invoiceApplicationFee !== 0) {
      throw new Error(
        `zero-dollar invoice ${inv?.id || "unknown"} has a nonzero application fee`
      );
    }
  }
  const creatorId =
    (purchase.creator_id as string | null) ||
    invoiceContext.metadata.creator_id ||
    null;
  const bookingPaymentId = invoiceContext.metadata.booking_payment_id || null;

  const { error: purchaseUpdateError } = await admin
    .from("purchases")
    .update({
      ...(payment_intent_id ? { payment_intent_id } : {}),
      amount_cents: paidGrossCents,
      platform_fee_cents: fees.platformFeeCents,
      processing_fee_cents: fees.processingFeeCents,
      total_creator_deduction_cents: fees.totalCreatorDeductionCents,
      creator_net_cents: fees.creatorNetCents,
      fee_schedule_version: fees.feeScheduleVersion,
    })
    .eq("id", purchase.id);
  if (purchaseUpdateError) {
    throw new Error(`invoice purchase update failed: ${purchaseUpdateError.message}`);
  }

  const resolvedBookingPaymentId =
    bookingPaymentId ||
    (inv?.metadata?.booking_payment_id as string) ||
    (inv?.lines?.data?.[0]?.price?.metadata?.booking_payment_id as string) ||
    null;

  if (resolvedBookingPaymentId) {
    const nowIso = new Date().toISOString();
    const updates: Record<string, any> = {
      ...(payment_intent_id ? { stripe_payment_intent_id: payment_intent_id } : {}),
      updated_at: nowIso,
      status: "completed",
      completed_at: nowIso,
      platform_fee_cents: fees.platformFeeCents,
      processing_fee_cents: fees.processingFeeCents,
      total_creator_deduction_cents: fees.totalCreatorDeductionCents,
      creator_net_cents: fees.creatorNetCents,
      fee_schedule_version: fees.feeScheduleVersion,
      ...(stripeFee
        ? {
            stripe_charge_id: stripeFee.chargeId,
            stripe_balance_transaction_id: stripeFee.balanceTransactionId,
            actual_stripe_fee_cents: stripeFee.actualStripeFeeCents,
            processing_fee_variance_cents:
              fees.processingFeeCents - stripeFee.actualStripeFeeCents,
          }
        : {}),
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
      .eq("id", resolvedBookingPaymentId);
    if (bpError) {
      throw new Error(`invoice booking payment update failed: ${bpError.message}`);
    }

    const bookingIdMeta = invoiceContext.metadata.booking_id || null;
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

  if (
    invoiceContext.metadata.booking_payment_id &&
    (!creatorId || (paidGrossCents > 0 && !payment_intent_id))
  ) {
    throw new Error(
      `invoice ${inv?.id || "unknown"} is missing creator or PaymentIntent linkage`
    );
  }

  if (creatorId && (payment_intent_id || inv?.id)) {
    const ledgerId = await recordPaymentFeeLedger(admin, {
      breakdown: fees,
      currency: inv?.currency || "usd",
      creatorId,
      purchaseId: purchase.id,
      bookingPaymentId: resolvedBookingPaymentId,
      paymentIntentId: payment_intent_id,
      invoiceId: inv?.id || null,
      stripeFee,
      status: "paid",
    }, true);
    await creditLedgerEarnings(admin, ledgerId, true);
  }

  // credit_payment_fee_ledger_earnings advances paid_count in the same atomic
  // claim as the recurring earnings credit. Read the committed result instead
  // of doing a retry-sensitive read+1 in this webhook.
  const { data: progress, error: progressError } = await admin
    .from("purchases")
    .select("paid_count, target_months, status")
    .eq("id", purchase.id)
    .maybeSingle();
  if (progressError) {
    throw new Error(`installment progress lookup failed: ${progressError.message}`);
  }
  const paidCount = Number(progress?.paid_count || 0);
  const targetMonths = Math.max(1, Number(progress?.target_months || 1));
  const planComplete = progress?.status === "complete" || paidCount >= targetMonths;

  // An installment plan is an open-ended monthly subscription. Once the
  // atomic progress claim reaches its target, tell Stripe to stop after the
  // paid period. Financial bookkeeping above is now idempotent, so a temporary
  // cancellation failure can safely return 500 and let Stripe retry instead of
  // leaving the buyer on an open-ended subscription.
  if (planComplete && subscription_id) {
    try {
      await getStripe().subscriptions.update(subscription_id, {
        cancel_at_period_end: true,
      });
      console.log("[webhook] installment plan complete, subscription set to cancel:", subscription_id);
    } catch (e: any) {
      throw new Error(
        `failed to cancel completed installment subscription ${subscription_id}: ${
          e?.message || String(e)
        }`
      );
    }
  }
  await reconcileKnownPaymentRefund(admin, payment_intent_id);
}

async function reconcilePaymentIntentSucceeded(pi: Stripe.PaymentIntent) {
  // Subscription invoices have their own handler, immutable invoice fee
  // metadata, ledger credit, and installment progress. A later generic
  // payment_intent.succeeded must not overwrite an active/complete plan back
  // to the one-time "paid" state or replace its per-invoice fee breakdown.
  if (pi.metadata?.plan_type === "installment") {
    await reconcileKnownPaymentRefund(admin, pi.id);
    return;
  }
  const { data: invoiceLedger, error: invoiceLedgerError } = await admin
    .from("payment_fee_ledger")
    .select("stripe_invoice_id")
    .eq("stripe_payment_intent_id", pi.id)
    .maybeSingle();
  if (invoiceLedgerError) {
    throw new Error(`PaymentIntent ledger classification failed: ${invoiceLedgerError.message}`);
  }
  const { data: subscriptionPurchase, error: subscriptionPurchaseError } = await admin
    .from("purchases")
    .select("subscription_id")
    .eq("payment_intent_id", pi.id)
    .maybeSingle();
  if (subscriptionPurchaseError) {
    throw new Error(
      `PaymentIntent purchase classification failed: ${subscriptionPurchaseError.message}`
    );
  }
  if (invoiceLedger?.stripe_invoice_id || subscriptionPurchase?.subscription_id) {
    await reconcileKnownPaymentRefund(admin, pi.id);
    return;
  }

  const orderId = (pi.metadata?.order_id as string) || null;
  const amount = typeof pi.amount_received === "number" ? pi.amount_received : pi.amount || 0;
  const fees = creatorFeesFromMetadata(pi.metadata, amount);
  const stripeFee = await retrieveStripeFeeDetails(
    pi.id,
    fees.processingFeeEnabled
  );
  assertConfiguredApplicationFee(
    `PaymentIntent ${pi.id}`,
    fees,
    stripeFee
  );
  if (orderId) {
    // Guard on the UPDATE itself, not on a prior SELECT: a charge.refunded
    // landing between a read and this write must not be flipped back to paid.
    const { error: orderUpdateError } = await admin
      .from("orders")
      .update({
        status: "paid",
        stripe_payment_intent_id: pi.id,
        stripe_payment_id: pi.id,
        gross_amount: amount,
        platform_fee: fees.platformFeeCents,
        processing_fee: fees.processingFeeCents,
        total_creator_deduction: fees.totalCreatorDeductionCents,
        creator_amount: fees.creatorNetCents,
        fee_schedule_version: fees.feeScheduleVersion,
        ...(stripeFee
          ? {
              stripe_charge_id: stripeFee.chargeId,
              stripe_balance_transaction_id: stripeFee.balanceTransactionId,
              actual_stripe_fee: stripeFee.actualStripeFeeCents,
              processing_fee_variance:
                fees.processingFeeCents - stripeFee.actualStripeFeeCents,
            }
          : {}),
        currency: (pi.currency as string) || "usd",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
      .in("status", ORDER_OPEN_STATUSES);
    if (orderUpdateError) {
      throw new Error(`PaymentIntent order update failed: ${orderUpdateError.message}`);
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
  // Guard on the UPDATE itself, exactly as the orders write above does. Without
  // this, a charge.refunded that already recorded status='refunded' and
  // access_granted=false was undone by a later or retried
  // payment_intent.succeeded: the row went back to paid with access_granted
  // true, and the refunded buyer kept the file. lib/orderStatus.ts states the
  // invariant that every status write carries a guard; purchases was the one
  // table where that was not true.
  const { data: paidPurchase, error } = await admin
    .from("purchases")
    .update(patch)
    .eq("payment_intent_id", pi.id)
    .not("status", "in", purchaseTerminalFilter())
    .select("id")
    .maybeSingle();
  if (error && !/0 rows|No rows/i.test(error.message)) {
    throw new Error(`PaymentIntent purchase update failed: ${error.message}`);
  }

  const creatorId = (pi.metadata?.creator_id as string) || null;
  if (creatorId) {
    await recordPaymentFeeLedger(admin, {
      breakdown: fees,
      currency: pi.currency || "usd",
      creatorId,
      purchaseId: (paidPurchase?.id as string | undefined) || null,
      orderId,
      bookingPaymentId: (pi.metadata?.booking_payment_id as string) || null,
      paymentIntentId: pi.id,
      stripeFee,
      status: "paid",
    }, true);
  }
  if (paidPurchase?.id) {
    await creditPurchaseEarnings(
      admin,
      paidPurchase.id as string,
      amount,
      fees.creatorNetCents,
      true
    );
  }
  await reconcileKnownPaymentRefund(admin, pi.id);
}

async function reconcilePaymentIntentFailed(pi: Stripe.PaymentIntent) {
  // payment_intent.payment_failed is an unsuccessful attempt, not a terminal
  // cancellation: the same PaymentIntent can later succeed after the customer
  // changes payment method. Leave the order open and only mark an unfulfilled
  // purchase failed. A stale failure can never revoke an active/paid purchase.
  const { error } = await admin
    .from("purchases")
    .update({ status: "failed", access_granted: false })
    .eq("payment_intent_id", pi.id)
    .in("status", ["pending", "processing", "failed"]);
  if (error) {
    throw new Error(`failed PaymentIntent purchase update failed: ${error.message}`);
  }
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
    event = verifyStripeEvent(rawBody, sig);
    console.log("[webhook] ✅ Signature verified successfully");
  } catch (e: any) {
    console.error("[webhook] ❌ Signature verification failed:", e?.message);
    return jerr("verify", e?.message || "Invalid signature", 400);
  }

  console.log("[webhook] 🎯 Processing event type:", event.type, "Event ID:", event.id);

  // Idempotency. Must be after signature verification (never record an event we
  // have not authenticated) and before any side effect. Stripe retries until it
  // gets a 2xx, and can deliver the same event to more than one endpoint.
  // Both supported webhook URLs delegate to this same canonical handler, so one
  // shared namespace prevents duplicate work even if both endpoints receive the
  // event during a migration.
  const claimKey = `stripe:${event.id}`;
  const claim = await claimStripeEvent(claimKey, event.type);
  if (claim.status === "duplicate") {
    console.log("[webhook] ⏭️ Already processed, acknowledging without re-running:", event.id);
    return NextResponse.json({ ok: true, duplicate: true });
  }
  if (claim.status === "unrecorded") {
    // Financial side effects must not run without the event-id lock. Asking
    // Stripe to retry is safer than potentially incrementing installments or
    // earnings twice while the idempotency store is unavailable.
    return jerr("idempotency", "Could not claim Stripe event", 500);
  }
  if (claim.status === "busy") {
    // Another worker is still processing this event. Never acknowledge it as a
    // completed duplicate: if that worker fails, Stripe must deliver it again.
    return jerr("idempotency-busy", "Stripe event is already processing", 500);
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
          let verifiedStripeFee: StripeFeeDetails | null = null;
          if (
            session.mode === "payment" &&
            session.payment_status === "paid"
          ) {
            const paidAmount =
              typeof session.amount_total === "number" ? session.amount_total : 0;
            const paidFees = creatorFeesFromMetadata(session.metadata, paidAmount);
            const paidPaymentIntentId = stripeObjectId(session.payment_intent);
            verifiedStripeFee = await retrieveStripeFeeDetails(
              paidPaymentIntentId,
              paidFees.processingFeeEnabled
            );
            assertConfiguredApplicationFee(
              `checkout ${session.id}`,
              paidFees,
              verifiedStripeFee
            );
          }

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
            const fees = creatorFeesFromMetadata(session.metadata, amount);
            const paymentIntentId = stripeObjectId(session.payment_intent);
            const stripeFee = verifiedStripeFee;
            const creatorId = (session.metadata?.creator_id as string) || null;
            if (!creatorId || !paymentIntentId) {
              throw new Error(
                `paid product session ${session.id} is missing creator or PaymentIntent linkage`
              );
            }

            await recordPaymentFeeLedger(admin, {
              breakdown: fees,
              currency: session.currency || "usd",
              creatorId,
              purchaseId,
              orderId: (session.metadata?.order_id as string) || null,
              checkoutSessionId: session.id,
              paymentIntentId,
              stripeFee,
              status: "paid",
            }, true);

            // Exactly-once in the database (migration 018), so /api/confirm-purchase
            // having already credited this same purchase from the browser cannot
            // pay the creator twice.
            await creditPurchaseEarnings(
              admin,
              purchaseId,
              amount,
              fees.creatorNetCents,
              true
            );
            await reconcileKnownPaymentRefund(admin, paymentIntentId);

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
              void updateInterestScore(buyerId, category, 25)?.catch?.((e: unknown) =>
                console.warn("[webhook] updateInterestScore failed:", e)
              );
            }

            void updatePostMetrics(postId ?? null, { purchases: 1 })?.catch?.((e: unknown) =>
              console.warn("[webhook] updatePostMetrics failed:", e)
            );

          }

          break;
        }

        // Legacy post purchase flow
        if (session.mode === "payment" && session.payment_status === "paid") {
          const id = await upsertPurchaseFromSession(session);
          await reconcileKnownPaymentRefund(
            admin,
            stripeObjectId(session.payment_intent)
          );
          // (No product_id here; legacy flow stays unchanged)
          void id; // noop
        }
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = (session.metadata?.order_id as string) || null;
        const expiredAt = new Date().toISOString();
        if (orderId) {
          const { error } = await admin
            .from("orders")
            .update({ status: "canceled", updated_at: expiredAt })
            .eq("id", orderId)
            .in("status", ORDER_OPEN_STATUSES);
          if (error) throw new Error(`expired order update failed: ${error.message}`);
        }
        const { error: sessionOrderError } = await admin
          .from("orders")
          .update({ status: "canceled", updated_at: expiredAt })
          .eq("stripe_checkout_session_id", session.id)
          .in("status", ORDER_OPEN_STATUSES);
        if (sessionOrderError) {
          throw new Error(`expired session order update failed: ${sessionOrderError.message}`);
        }
        const { error: purchaseExpiryError } = await admin
          .from("purchases")
          .update({ status: "failed", access_granted: false })
          .eq("session_id", session.id)
          .in("status", ["pending", "processing", "failed"]);
        if (purchaseExpiryError) {
          throw new Error(`expired purchase update failed: ${purchaseExpiryError.message}`);
        }

        const bookingPaymentId = session.metadata?.booking_payment_id || null;
        if (bookingPaymentId) {
          const { error } = await admin
            .from("booking_payments")
            .update({ status: "expired", updated_at: expiredAt })
            .eq("id", bookingPaymentId)
            .in("status", ["pending", "link_sent"]);
          if (error) {
            throw new Error(`expired booking payment update failed: ${error.message}`);
          }
        }
        break;
      }

      case "invoice.created": {
        await handleInvoiceCreated(event.data.object);
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

      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed": {
        const deliveredDispute = event.data.object as Stripe.Dispute;
        // Fetch the current Stripe object instead of trusting the delivered
        // snapshot. If an older event arrives after a newer one, this still
        // records/applies Stripe's latest dispute status.
        const dispute = await getStripe().disputes.retrieve(deliveredDispute.id);
        const chargeId = stripeObjectId(dispute.charge);
        let paymentIntentId = stripeObjectId(dispute.payment_intent);
        if (!paymentIntentId && chargeId) {
          const charge = await getStripe().charges.retrieve(chargeId);
          paymentIntentId = stripeObjectId(charge.payment_intent);
        }
        if (!chargeId || !paymentIntentId) {
          throw new Error(`dispute ${dispute.id} has no charge/PaymentIntent linkage`);
        }

        const state = {
          disputeId: dispute.id,
          paymentIntentId,
          chargeId,
          disputedAmountCents: dispute.amount,
          currency: dispute.currency,
          status: dispute.status,
          eventCreated: event.created,
        };
        const recorded = await recordPaymentDisputeState(admin, state);
        if (recorded) {
          await applyPaymentDisputeState(admin, state);
        } else {
          // A newer event already won the database comparison. Apply that
          // canonical row rather than regressing the ledger with this delivery.
          await reconcileKnownPaymentDispute(admin, paymentIntentId);
        }
        // This is deliberately audit-only. No creator earnings, access, or plan
        // status changes until CreatorNet approves a dispute-responsibility policy.
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const pi =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent as any)?.id || null;
        if (!pi) {
          console.warn("[webhook] charge.refunded has no PaymentIntent", charge.id);
          break;
        }
        const refundState = await recordPaymentRefundState(admin, {
          paymentIntentId: pi,
          chargeId: charge.id,
          chargeAmountCents: charge.amount || 0,
          refundedAmountCents: charge.amount_refunded || 0,
        });
        await applyPaymentRefundState(admin, refundState);
        await confirmAdminRefundWebhookDelivery(
          admin,
          (charge.refunds?.data ?? []).map((refund) => refund.id),
        );
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

    await completeStripeEvent(claimKey, claim.claimToken);
    console.log("[webhook] ✅ Event processed successfully, returning ACK");
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[webhook] ❌ Handler error:", e?.message || e, "Stack:", e?.stack);
    // We are asking Stripe to retry, so the claim taken above has to go back.
    // Leaving it would make the retry look like a duplicate, and the payment
    // would never be recorded.
    if (claim.status === "new") {
      await releaseStripeEvent(claimKey, claim.claimToken);
    }
    return NextResponse.json({ ok: false, error: "handler error" }, { status: 500 });
  }
}
