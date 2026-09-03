// app/api/confirm-purchase/route.ts
import { publicMessage } from "@/lib/apiError";
import { eitherIdFilter } from "@/lib/ids";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabaseServer";
import { creatorFeesFromMetadata } from "@/lib/money";
import { ORDER_OPEN_STATUSES, purchaseTerminalFilter } from "@/lib/orderStatus";
import { creditPurchaseEarnings } from "@/lib/creatorEarnings";
import {
  assertConfiguredApplicationFee,
  recordPaymentFeeLedger,
  retrieveStripeFeeDetails,
} from "@/lib/paymentFeeLedger";
import { reconcileKnownPaymentRefund } from "@/lib/paymentRefunds";

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

type FulfillmentProduct = {
  id: string | null;
  title: string | null;
  type: string | null;
  discord_invite_url: string | null;
  whop_listing_url: string | null;
};

async function loadFulfillmentProduct(
  productId: string | null | undefined
): Promise<FulfillmentProduct | null> {
  if (!productId) return null;
  const { data: prodRow, error } = await supabase
    .from("products")
    .select("id, product_id, type, discord_invite_url, whop_listing_url, title")
    .or(eitherIdFilter(["product_id", "id"], productId))
    .maybeSingle();
  if (error) throw new Error(`Product fulfillment lookup failed: ${error.message}`);
  if (!prodRow) return null;
  return {
    id: prodRow.product_id ?? prodRow.id ?? null,
    type: prodRow.type ?? null,
    discord_invite_url: prodRow.discord_invite_url ?? null,
    whop_listing_url: prodRow.whop_listing_url ?? null,
    title: prodRow.title ?? null,
  };
}

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
  const fees = creatorFeesFromMetadata(session.metadata, amount_cents ?? 0);
  // A one-time payment that Stripe reports as paid. Subscriptions are advanced
  // by invoice.payment_succeeded instead and must not be granted here.
  const oneTimePaid =
    session.mode === "payment" && session.payment_status === "paid" && !session.subscription;
  const stripeFee = oneTimePaid
    ? await retrieveStripeFeeDetails(payment_intent_id, fees.processingFeeEnabled)
    : null;
  if (oneTimePaid) {
    assertConfiguredApplicationFee(`checkout ${sessionId}`, fees, stripeFee);
  }

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
    const { error: orderErr } = await supabase
      .from("orders")
      .update({
        status: "paid",
        stripe_checkout_session_id: sessionId,
        stripe_payment_intent_id: payment_intent_id,
        stripe_payment_id: payment_intent_id,
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
  /** Did we actually write the purchase row? False means a terminal-status guard blocked it. */
  let wrote = false;

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
    platform_fee_cents: fees.platformFeeCents,
    processing_fee_cents: fees.processingFeeCents,
    total_creator_deduction_cents: fees.totalCreatorDeductionCents,
    creator_net_cents: fees.creatorNetCents,
    fee_schedule_version: fees.feeScheduleVersion,
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

  // Last resort: find the row by the (buyer_id, post_id) pair.
  //
  // This is the same fallback the webhook's seedPurchaseFromProductSession
  // does, and it belongs here far more urgently: /success calls this route in
  // the buyer's own browser the instant Stripe redirects back, and the webhook
  // has never once fired for a checkout in production.
  //
  // `purchases` carries UNIQUE (buyer_id, post_id). /api/checkout writes a
  // pending row on EVERY checkout start and swallows the resulting duplicate on
  // the second, so a buyer who abandons checkout once and pays on the retry has
  // a pending row keyed to the FIRST session id, carrying no payment intent,
  // and nothing at all for the session that actually paid. Both lookups above
  // then miss, the insert below violates that unique constraint and throws, and
  // the buyer gets a 500 from the page whose entire job is to confirm their
  // purchase — after the order finalize above has already booked the revenue.
  // Six orders in production have exactly this shape.
  let attachedToAnotherPayment = false;
  if (!purchaseId && post_id) {
    const byPair = await supabase
      .from("purchases")
      .select("id, payment_intent_id")
      .eq("buyer_id", buyer_id)
      .eq("post_id", post_id)
      .maybeSingle();
    const pairRow = byPair.data as { id?: string; payment_intent_id?: string | null } | null;
    if (!byPair.error && pairRow?.id) {
      purchaseId = pairRow.id;
      // One row per (buyer, post) is a database constraint, so a SECOND
      // purchase of the same post necessarily lands on the row the first one
      // already owns. Leave that row's payment references alone in that case:
      // payment_intent_id is itself UNIQUE, and the first charge's reference is
      // the one worth keeping. Access was already granted, so the buyer still
      // gets what they paid for and no longer sees a 500.
      attachedToAnotherPayment =
        Boolean(pairRow.payment_intent_id) && pairRow.payment_intent_id !== payment_intent_id;
      if (attachedToAnotherPayment) {
        delete updateFields.payment_intent_id;
      } else {
        // Point the row at the session that actually paid.
        updateFields.session_id = sessionId;
      }
    }
  }

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
    // A null row means the terminal-status guard above matched nothing, i.e.
    // this purchase is refunded. Remember that: it must not be paid out.
    wrote = Boolean(updRow?.id);
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
    wrote = Boolean(ins?.id);
  }

  // Pay the creator.
  //
  // This route is the only post-payment path the browser actually triggers, and
  // it never did this — only the webhook did, and the webhook has never fired
  // for a checkout in production. The result was that a real sale delivered the
  // file and showed revenue on the admin dashboard while the creator's balance
  // stayed at zero.
  //
  // Crediting is exactly-once in the database (migration 018), so the webhook
  // arriving later for the same purchase cannot pay the creator a second time.
  // Bookkeeping never blocks delivery: a failure here is logged loudly and the
  // buyer still gets their file.
  if (oneTimePaid && wrote && purchaseId) {
    if (creator_id) {
      await recordPaymentFeeLedger(supabase, {
        breakdown: fees,
        currency: currency ?? "usd",
        creatorId: creator_id,
        purchaseId,
        orderId: order_id,
        checkoutSessionId: sessionId,
        paymentIntentId: payment_intent_id,
        stripeFee,
        status: "paid",
      });
    }
    await creditPurchaseEarnings(
      supabase,
      purchaseId,
      amount_cents,
      fees.creatorNetCents
    );
    // Stripe can deliver charge.refunded before this browser fallback has
    // linked the purchase. Reapply any durable refund state immediately after
    // writing and crediting the sale so late event order cannot restore access
    // or creator earnings.
    await reconcileKnownPaymentRefund(supabase, payment_intent_id);
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

    // Subscription checkout completion is not proof that CreatorNet applied
    // the exact per-invoice fee or credited the installment. The signed
    // invoice.payment_succeeded webhook owns those mutations. This browser
    // route only polls the resulting purchase state; it must never regress an
    // active/complete subscription to the one-time "paid" state.
    if (session.mode === "subscription") {
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null;
      const columns =
        "id, status, access_granted, product_id, post_id, creator_id";
      let purchaseResult = await supabase
        .from("purchases")
        .select(columns)
        .eq("session_id", session.id)
        .maybeSingle();
      if (purchaseResult.error) {
        throw new Error(`Subscription purchase lookup failed: ${purchaseResult.error.message}`);
      }
      if (!purchaseResult.data && subscriptionId) {
        purchaseResult = await supabase
          .from("purchases")
          .select(columns)
          .eq("subscription_id", subscriptionId)
          .maybeSingle();
        if (purchaseResult.error) {
          throw new Error(
            `Subscription purchase lookup failed: ${purchaseResult.error.message}`
          );
        }
      }

      const purchase = purchaseResult.data as {
        id: string;
        status: string | null;
        access_granted: boolean | null;
        product_id: string | null;
        post_id: string | null;
        creator_id: string | null;
      } | null;
      if (!purchase) {
        return NextResponse.json(
          { ok: true, session_id, status: "pending" },
          { status: 202 }
        );
      }
      if (purchase.status === "refunded") {
        return NextResponse.json(
          { error: "This installment purchase was refunded." },
          { status: 409 }
        );
      }

      const accessReady =
        purchase.access_granted === true &&
        ["active", "complete", "paid"].includes(purchase.status || "");
      if (!accessReady) {
        return NextResponse.json(
          {
            ok: true,
            session_id,
            purchase_id: purchase.id,
            status: "pending",
          },
          { status: 202 }
        );
      }

      return NextResponse.json({
        ok: true,
        session_id,
        purchase_id: purchase.id,
        status: "paid",
        post_id: purchase.post_id,
        product_id: purchase.product_id,
        creator_id: purchase.creator_id,
        product: await loadFulfillmentProduct(purchase.product_id),
      });
    }

    if (!(session.status === "complete" || session.payment_status === "paid")) {
      return NextResponse.json(
        { error: `Session not paid. status=${session.status}, payment_status=${session.payment_status}` },
        { status: 409 }
      );
    }

    const meta = await upsertPaidBySession(session_id, session, user.id);
    const product = await loadFulfillmentProduct(meta.product_id);

    // return NextResponse.json({ ok: true, session_id, ...meta }, { status: 200 });
    return NextResponse.json({ ok: true, session_id, ...meta, product }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: publicMessage("confirm-purchase", e, "Failed to confirm purchase") }, { status: 500 });
  }
}
