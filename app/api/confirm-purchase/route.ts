// app/api/confirm-purchase/route.ts
import Stripe from "stripe";
import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Use bundled version
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: undefined });
const supabase = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function upsertPaidBySession(sessionId: string, session: Stripe.Checkout.Session) {
  const payment_intent_id =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as any)?.id ?? null;

  const amount_cents = typeof session.amount_total === "number" ? session.amount_total : null;
  const currency = session.currency ?? null;
  const meta = (session.metadata || {}) as Record<string, string | undefined>;
  const product_id = meta.product_id ?? null;
  const post_id = meta.post_id ?? null;
  const creator_id = meta.creator_id ?? null;

  // find existing purchase by session or PI
  let purchaseId: string | null = null;

  const bySession = await supabase
    .from("purchases")
    .select("id")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (!bySession.error && bySession.data?.id) purchaseId = bySession.data.id;

  if (!purchaseId && payment_intent_id) {
    const byPi = await supabase
      .from("purchases")
      .select("id")
      .eq("payment_intent_id", payment_intent_id)
      .maybeSingle();
    if (!byPi.error && byPi.data?.id) {
      purchaseId = byPi.data.id;
      await supabase.from("purchases").update({ session_id: sessionId }).eq("id", byPi.data.id);
    }
  }

  const updateFields: Record<string, any> = {
    status: "paid",
    paid_at: new Date().toISOString(),
    amount_cents,
    currency,
    product_id,
    post_id,
    creator_id,
    payment_intent_id,
  };

  if (purchaseId) {
    await supabase.from("purchases").update(updateFields).eq("id", purchaseId);
  } else {
    await supabase
      .from("purchases")
      .insert({ session_id: sessionId, ...updateFields })
      .select("id")
      .single();
  }

  return { post_id, product_id, creator_id };
}

// Manual confirm (client calls this on /success)
export async function POST(req: Request) {
  try {
    const { session_id } = await req.json();
    if (!session_id) return NextResponse.json({ error: "Missing session_id" }, { status: 400 });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!(session.status === "complete" || session.payment_status === "paid")) {
      return NextResponse.json(
        { error: `Session not paid. status=${session.status}, payment_status=${session.payment_status}` },
        { status: 409 }
      );
    }

    const meta = await upsertPaidBySession(session_id, session);
    return NextResponse.json({ ok: true, session_id, ...meta }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to confirm purchase" }, { status: 500 });
  }
}
