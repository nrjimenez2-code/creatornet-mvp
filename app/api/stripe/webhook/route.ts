// app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs"; // raw body required for Stripe verify

// --- ENV ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// --- Clients ---
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" as any });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- utils ----------
function jerr(stage: string, msg: string, status = 400) {
  console.error(`[webhook] ${stage}: ${msg}`);
  return NextResponse.json({ ok: false, stage, error: msg }, { status });
}

async function fetchCreatorIdIfMissing(post_id: string | null, creator_id: string | null) {
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

/**
 * Link the newest unmatched booking (within 14 days) to a paid purchase.
 * - Updates BOTH sides if `purchases.booking_id` column exists.
 * - If that column doesn't exist, we still mark the booking side (non-fatal).
 */
async function linkBookingIfAny(opts: {
  buyer_id: string | null;
  creator_id: string | null;
  post_id: string | null;
  purchase_id: string;
  lookbackDays?: number;
}) {
  const { buyer_id, creator_id, post_id, purchase_id, lookbackDays = 14 } = opts;
  if (!buyer_id || !creator_id) return;

  // Find recent, unmatched bookings for this buyer/creator (prefer same post)
  const { data: rows, error: findErr } = await admin
    .from("bookings")
    .select("id, created_at, post_id")
    .eq("buyer_id", buyer_id)
    .eq("creator_id", creator_id)
    .is("linked_order_id", null) // column name from our schema; we store the purchase id here
    .order("created_at", { ascending: false })
    .limit(8);

  if (findErr || !rows?.length) return;

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  // prefer same post; otherwise the newest within window
  const candidate =
    (post_id && rows.find(b => b.post_id === post_id && new Date(b.created_at).getTime() >= cutoff)) ||
    rows.find(b => new Date(b.created_at).getTime() >= cutoff) ||
    null;

  if (!candidate) return;

  // Try to set purchases.booking_id if the column exists (ignore if it doesn't)
  try {
    await admin.from("purchases").update({ booking_id: candidate.id as any }).eq("id", purchase_id);
  } catch (e: any) {
    // Non-fatal if the project doesn't have purchases.booking_id column
    if (!/column .*booking_id.* does not exist/i.test(String(e?.message))) {
      console.warn("[webhook] purchases.booking_id update warning:", e?.message || e);
    }
  }

  // Always mark the booking as linked → store the purchase id in linked_order_id
  const { error: updBookingErr } = await admin
    .from("bookings")
    .update({ linked_order_id: purchase_id, status: "completed" })
    .eq("id", candidate.id);
  if (updBookingErr) {
    console.warn("[webhook] bookings.linked_order_id update failed:", updBookingErr.message);
  }
}

// ---------- business logic ----------
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

  const { error } = await admin.from("bookings").insert({
    post_id,
    buyer_id,
    creator_id,
    status: "booked",
  });
  if (error) console.error("[webhook] insert booking failed:", error.message);
}

async function upsertPurchaseFromSession(session: Stripe.Checkout.Session) {
  // pull metadata
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

  if (!buyer_id || !post_id) {
    // don’t throw—just log (bad metadata shouldn’t crash retries)
    console.warn("[webhook] missing metadata buyer_id/post_id on session", {
      session_id: session.id,
      buyer_id,
      post_id,
    });
  }

  // 1) If row exists by session_id → done
  {
    const { data, error } = await admin
      .from("purchases")
      .select("id")
      .eq("session_id", session.id)
      .maybeSingle();
    if (error) throw new Error(`select by session_id: ${error.message}`);
    if (data) return; // already recorded
  }

  // 2) If row exists by payment_intent_id → update session_id and status
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
          session_id: session.id,
          status: "paid",
          amount_cents,
          currency,
        })
        .eq("id", data.id);
      if (updErr) throw new Error(`update existing purchase: ${updErr.message}`);

      // Link booking → purchase (existing row)
      await linkBookingIfAny({
        buyer_id,
        creator_id,
        post_id,
        purchase_id: data.id,
      });
      return;
    }
  }

  // 3) Insert a fresh row
  const { data: ins, error: insErr } = await admin
    .from("purchases")
    .insert({
      buyer_id,
      creator_id,           // will be null if unknown; ok
      post_id,
      session_id: session.id,
      payment_intent_id,
      amount_cents,
      currency,
      status: "paid",
    })
    .select("id")
    .maybeSingle();

  if (insErr) {
    // In case of race/idempotency, safe to ignore unique violation
    if (!/duplicate|unique/i.test(insErr.message)) {
      throw new Error(`insert purchase failed: ${insErr.message}`);
    }
  }

  // Link booking → purchase (new row)
  if (ins?.id) {
    await linkBookingIfAny({
      buyer_id,
      creator_id,
      post_id,
      purchase_id: ins.id,
    });
  }
}

async function markRefunded(payment_intent_id: string | null) {
  if (!payment_intent_id) return;
  const { error } = await admin
    .from("purchases")
    .update({ status: "refunded" })
    .eq("payment_intent_id", payment_intent_id);
  if (error) {
    // non-fatal
    console.warn("[webhook] markRefunded error:", error.message);
  }
}

// ---------- route ----------
export async function POST(req: NextRequest) {
  // Ensure envs exist
  if (!STRIPE_SECRET_KEY) return jerr("env", "Missing STRIPE_SECRET_KEY", 500);
  if (!STRIPE_WEBHOOK_SECRET) return jerr("env", "Missing STRIPE_WEBHOOK_SECRET", 500);
  if (!SUPABASE_URL) return jerr("env", "Missing NEXT_PUBLIC_SUPABASE_URL", 500);
  if (!SUPABASE_SERVICE_ROLE_KEY) return jerr("env", "Missing SUPABASE_SERVICE_ROLE_KEY", 500);

  // Stripe requires the raw body to verify the signature
  const sig = req.headers.get("stripe-signature");
  if (!sig) return jerr("verify", "Missing stripe-signature header");

  let event: Stripe.Event;

  try {
    // App Router: req.text() preserves the raw bytes for signature verification
    const raw = await req.text();
    event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e: any) {
    return jerr("verify", e?.message || "Invalid signature", 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        // $0 verified booking → insert booking record on completion
        if (session.mode === "setup") {
          await insertBookingFromSession(session);
        }

        // Paid purchase → upsert purchase + link to recent booking
        if (session.mode === "payment" && session.payment_status === "paid") {
          await upsertPurchaseFromSession(session);
        }
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const pi =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent as any)?.id;
        await markRefunded(pi || null);
        break;
      }

      default: {
        // No-op for other events (but keep log for observability)
        console.log("[webhook] unhandled event:", event.type);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[webhook] handler error:", e?.message || e);
    // Respond 200 so Stripe doesn’t hammer retries forever if it’s a data issue.
    // If you want Stripe to retry on server errors, return 500 instead.
    return NextResponse.json({ ok: false, error: "handler error" }, { status: 200 });
  }
}
