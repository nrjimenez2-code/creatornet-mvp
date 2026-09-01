// app/api/confirm-purchase/route.ts
import { publicMessage } from "@/lib/apiError";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabaseServer";
import { splitFee } from "@/lib/money";
import { ORDER_OPEN_STATUSES, purchaseTerminalFilter } from "@/lib/orderStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe calls are capped at 20s with 2 retries (lib/stripeClient.ts); without
// maxDuration Vercel's 10s plan default can kill the function mid-call. 60s
// covers the worst legitimate case and is allowed on every Vercel plan.
export const maxDuration = 60;

// Use bundled version
const supabase = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function upsertPaidBySession(
  sessionId: string,
  session: Stripe.Checkout.Session,
  callerId: string
) {
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

  const buyer_id = callerId;
  const order_id = meta.order_id ?? null;

  // Finalize the order too.
  //
  // Every financial figure the admin dashboard shows — gross, platform fee,
  // creator payout (lib/admin/commerce-data.ts) — is computed from `orders`
  // rows with status='paid'. Only the webhook ever moved an order to paid, and
  // it has never run for a checkout, so the dashboard read $0 while purchases
  // recorded real sales. Guarded with the same .in(ORDER_OPEN_STATUSES) the
  // webhook uses so this can never drag a refunded order back to paid.
  if (order_id) {
    const amount = amount_cents ?? 0;
    const { feeCents, creatorCents } = splitFee(amount);
    const { error: orderErr } = await supabase
      .from("orders")
      .update({
        status: "paid",
        stripe_checkout_session_id: sessionId,
        stripe_payment_intent_id: payment_intent_id,
        stripe_payment_id: payment_intent_id,
        gross_amount: amount,
        platform_fee: feeCents,
        creator_amount: creatorCents,
        currency: currency ?? "usd",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order_id)
      .in("status", ORDER_OPEN_STATUSES);
    if (orderErr) {
      // Never fail the buyer's confirmation over bookkeeping.
      console.warn("[confirm-purchase] order finalize failed:", orderErr.message);
    }
  }

  // find existing purchase by session or PI
  let purchaseId: string | null = null;
  let status: string | null = null;

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

  // A one-time payment that Stripe reports as paid. Subscriptions are advanced
  // by invoice.payment_succeeded instead and must not be granted here.
  const oneTimePaid =
    session.mode === "payment" && session.payment_status === "paid" && !session.subscription;

  const updateFields: Record<string, any> = {
    status: "paid",
    paid_at: new Date().toISOString(),
    amount_cents,
    currency,
    product_id,
    post_id,
    creator_id,
    buyer_id,
    payment_intent_id,
    // This route is the ONLY post-payment path the browser actually triggers
    // (/success calls it as soon as Stripe redirects back). It used to set
    // status='paid' and stop there — but both premium gates
    // (/api/premium/access and GET /api/watch/[postId]) require
    // access_granted, which only the webhook ever set. So a buyer whose
    // payment was confirmed here still got a 402 when they tried to download
    // the file they had just paid for. Granting here makes delivery work
    // without depending on a webhook that has never fired in production.
    access_granted: oneTimePaid,
  };

  if (purchaseId) {
    const { data: updRow, error: updErr } = await supabase
      .from("purchases")
      .update(updateFields)
      .eq("id", purchaseId)
      // Because this route now grants access, it also has to carry the same
      // terminal-status guard the webhook does — otherwise a refunded buyer
      // could re-open /success and hand themselves the file back.
      .not("status", "in", purchaseTerminalFilter())
      .select("id,status")
      .maybeSingle();
    if (updErr) throw new Error(updErr.message);
    status = updRow?.status ?? "paid";
  } else {
    const { data: ins, error: insErr } = await supabase
      .from("purchases")
      .insert({ session_id: sessionId, ...updateFields })
      .select("id,status")
      .single();
    if (insErr) throw new Error(insErr.message);
    purchaseId = ins?.id ?? null;
    status = ins?.status ?? "paid";
  }

  return { purchase_id: purchaseId, status: status ?? "paid", post_id, product_id, creator_id };
}

// Manual confirm (client calls this on /success)
export async function POST(req: Request) {
  try {
    const { session_id } = await req.json();
    if (!session_id) return NextResponse.json({ error: "Missing session_id" }, { status: 400 });

    // The success page calls this right after Stripe redirects back, in the
    // buyer's own browser, so their session cookie is present. A caller who
    // only knows a session id (they appear in URLs) must not be able to get
    // someone else's purchase written to themselves, or read its details.
    const auth = createServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Please sign in to confirm your purchase." }, { status: 401 });
    }

    const session = await getStripe().checkout.sessions.retrieve(session_id);
    const sessionBuyer =
      (session.metadata?.buyer_user_id as string) ||
      (session.metadata?.buyer_id as string) ||
      null;
    // Fail closed. Both live session-creation paths write the buyer into the
    // metadata; a session without one is not something this route should
    // attach to whoever happens to be signed in.
    if (!sessionBuyer || sessionBuyer !== user.id) {
      return NextResponse.json({ error: "This purchase belongs to another account." }, { status: 403 });
    }
    console.log("[confirm-purchase] ✅ Session retrieved:", {
      session_id,
      mode: session.mode,
      payment_status: session.payment_status,
      status: session.status,
      kind: session.metadata?.kind,
    });
    if (
      session.mode === "setup" ||
      session.payment_status === "no_payment_required" ||
      session.metadata?.kind === "booking"
    ) {
      const redirectUrl =
        (session.metadata?.booking_redirect_url as string) ||
        (session.metadata?.bookingRedirectUrl as string) ||
        "";
      const postIdMeta =
        (session.metadata?.post_id as string) || (session.metadata?.postId as string) || "";
      const creatorIdMeta =
        (session.metadata?.creator_id as string) || (session.metadata?.creatorId as string) || "";
      
      // Validate post_id is not empty
      const postId = postIdMeta.trim() || null;
      const creatorId = creatorIdMeta.trim() || null;
      
      console.log("[confirm-purchase] booking detected, returning:", {
        post_id: postId,
        creator_id: creatorId,
        redirect_url: redirectUrl,
      });
      
      if (!postId) {
        console.error("[confirm-purchase] ⚠️ WARNING: post_id is empty in metadata", {
          session_id: session.id,
        });
      }
      
      return NextResponse.json(
        {
          ok: true,
          session_id,
          kind: "booking",
          booking_redirect_url: redirectUrl,
          post_id: postId,
          creator_id: creatorId,
        },
        { status: 200 }
      );
    }

    if (!(session.status === "complete" || session.payment_status === "paid")) {
      return NextResponse.json(
        { error: `Session not paid. status=${session.status}, payment_status=${session.payment_status}` },
        { status: 409 }
      );
    }

    const meta = await upsertPaidBySession(session_id, session, user.id);
    let product: Record<string, any> | null = null;
    if (meta.product_id) {
      const { data: prodRow } = await supabase
        .from("products")
        .select("product_id, type, discord_invite_url, whop_listing_url, title")
        .eq("product_id", meta.product_id)
        .maybeSingle();
      if (prodRow) {
        product = {
          id: prodRow.product_id,
          type: prodRow.type,
          discord_invite_url: prodRow.discord_invite_url,
          whop_listing_url: prodRow.whop_listing_url,
          title: prodRow.title,
        };
      }
    }

    // return NextResponse.json({ ok: true, session_id, ...meta }, { status: 200 });
    return NextResponse.json({ ok: true, session_id, ...meta, product }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: publicMessage("confirm-purchase", e, "Failed to confirm purchase") }, { status: 500 });
  }
}
