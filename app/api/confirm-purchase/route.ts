// app/api/confirm-purchase/route.ts
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  };

  if (purchaseId) {
    const { data: updRow, error: updErr } = await supabase
      .from("purchases")
      .update(updateFields)
      .eq("id", purchaseId)
      .select("id,status")
      .single();
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
    if (sessionBuyer && sessionBuyer !== user.id) {
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
    return NextResponse.json({ error: e?.message || "Failed to confirm purchase" }, { status: 500 });
  }
}
