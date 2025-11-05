// app/api/confirm-purchase/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

/**
 * ENV REQUIRED:
 *  - STRIPE_SECRET_KEY=sk_...
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY   (service role, not anon)
 */

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!STRIPE_SECRET_KEY || STRIPE_SECRET_KEY.startsWith("pk_")) {
  throw new Error("STRIPE_SECRET_KEY missing or not a secret key.");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase URL / SERVICE ROLE key missing.");
}

// IMPORTANT: do NOT pass apiVersion to avoid TS literal mismatches
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Service-role client (bypasses RLS for server-side writes)
const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export async function POST(req: Request) {
  try {
    const { session_id } = (await req.json()) as { session_id?: string };
    if (!session_id) {
      return NextResponse.json({ ok: false, error: "Missing session_id" }, { status: 400 });
    }

    // Fetch the Checkout Session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);

    // Pull metadata (set during checkout) and payment info
    const meta = (session.metadata ?? {}) as {
      post_id?: string;
      buyer_id?: string;
      creator_id?: string;
    };

    const amount_total = session.amount_total ?? null;
    const currency = (session.currency ?? "usd").toLowerCase();

    const stripe_session_id = session.id;
    const stripe_payment_intent =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;

    // Coerce post_id if your schema uses numeric ids
    const post_id =
      meta.post_id && !Number.isNaN(Number(meta.post_id))
        ? Number(meta.post_id)
        : meta.post_id ?? null;

    // Idempotent upsert in case webhook races this request
    const { error } = await svc
      .from("purchases")
      .upsert(
        {
          post_id,
          buyer_id: meta.buyer_id ?? null,
          creator_id: meta.creator_id ?? null,
          amount_cents: amount_total ?? null,
          currency,
          stripe_session_id,
          stripe_payment_intent,
          status: "paid",
        },
        {
          // prefer PI; otherwise fall back to session id
          onConflict: stripe_payment_intent ? "stripe_payment_intent" : "stripe_session_id",
          ignoreDuplicates: false,
        }
      );

    if (error) {
      console.error("confirm-purchase upsert error:", error);
      // still respond ok=false so UI can retry/backoff
      return NextResponse.json({ ok: false, error: "Upsert failed" }, { status: 200 });
    }

    return NextResponse.json(
      {
        ok: true,
        session_id: stripe_session_id,
        amount_total,
        currency,
        post_id: post_id ?? null,
        creator_id: meta.creator_id ?? null,
        buyer_id: meta.buyer_id ?? null,
      },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("confirm-purchase error:", e?.message || e);
    return NextResponse.json({ ok: false, error: "Failed to confirm" }, { status: 500 });
  }
}
