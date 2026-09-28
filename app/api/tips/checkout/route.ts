import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStripe } from "@/lib/stripeClient";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { publicMessage } from "@/lib/apiError";
import {
  TIP_CURRENCY, TipAdmissionError, newTipInsert, requireTipEligibility,
  tippingEnabled, tipMetadata, validTipAmount, validTipRequestKey, type TipRow,
} from "@/lib/tips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function siteOrigin(req: NextRequest): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const vercelHost = (process.env.VERCEL_URL || "").trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9.-]*\.vercel\.app$/.test(vercelHost)) return `https://${vercelHost}`;
  const url = new URL(req.url);
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname) ? `${url.protocol}//${url.host}` : "";
}

export async function POST(req: NextRequest) {
  if (!tippingEnabled()) return NextResponse.json({ error: "Tipping is not available yet.", code: "TIPPING_UNAVAILABLE" }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in to send a tip.", code: "SIGN_IN_REQUIRED" }, { status: 401 });
  if (!allowRequest(`tip-user:${user.id}`, { limit: 8, windowMs: 60_000 }) ||
      !allowRequest(`tip-ip:${clientKey(req)}`, { limit: 20, windowMs: 60_000 })) {
    return tooManyRequests("Please wait a moment before trying another tip.");
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const postId = typeof body.postId === "string" ? body.postId : "";
  const amountCents = body.amountCents;
  const requestKey = body.requestKey;
  if (!validTipAmount(amountCents)) return NextResponse.json({ error: "Tip must be between $5 and $500.", code: "INVALID_AMOUNT" }, { status: 400 });
  if (!validTipRequestKey(requestKey)) return NextResponse.json({ error: "Invalid tip request." }, { status: 400 });

  try {
    const eligibility = await requireTipEligibility(supabaseAdmin, user, postId);
    const existingAttempt = await supabaseAdmin.from("tips").select("*")
      .eq("tipper_id", user.id).eq("client_request_key", requestKey).maybeSingle();
    if (existingAttempt.error && !/0 rows|No rows/i.test(existingAttempt.error.message)) {
      throw new Error(`Tip attempt lookup failed: ${existingAttempt.error.message}`);
    }
    let tip = existingAttempt.data as unknown as TipRow | null;
    if (!tip) {
      const openAttempts = await supabaseAdmin.from("tips").select("id", { count: "exact", head: true })
        .eq("tipper_id", user.id).eq("post_id", postId)
        .in("status", ["creating", "open", "processing"]);
      if (openAttempts.error) throw new Error(`Open tip count failed: ${openAttempts.error.message}`);
      if ((openAttempts.count ?? 0) >= 3) {
        return NextResponse.json({
          error: "Finish or close an active tip before starting another.", code: "TOO_MANY_OPEN_TIPS",
        }, { status: 409 });
      }
      const tipId = randomUUID();
      const insert = newTipInsert({ id: tipId, user, requestKey, eligibility, amountCents });
      const origin = siteOrigin(req);
      if (!origin) throw new Error("CreatorNet site origin is not configured.");
      const metadata = tipMetadata(insert as TipRow);
      const checkoutParams: Stripe.Checkout.SessionCreateParams = {
        mode: "payment",
        ui_mode: "custom",
        client_reference_id: insert.id,
        customer_email: user.email || undefined,
        line_items: [{
          price_data: {
            currency: TIP_CURRENCY,
            product_data: { name: `Tip to @${eligibility.creatorUsername}` },
            unit_amount: Number(insert.gross_amount_cents),
          },
          quantity: 1,
        }],
        payment_intent_data: {
          application_fee_amount: Number(insert.total_creator_deduction_cents),
          transfer_data: { destination: insert.stripe_destination_account_id },
          metadata,
        },
        metadata,
        return_url: `${origin}/dashboard?postId=${encodeURIComponent(insert.post_id)}&tipId=${encodeURIComponent(insert.id)}`,
        // Freeze this with the attempt so an uncertain Stripe response can be retried unchanged.
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      };
      const created = await supabaseAdmin.rpc("create_or_get_video_tip", {
        p_id: insert.id,
        p_tipper_id: insert.tipper_id,
        p_creator_id: insert.creator_id,
        p_post_id: insert.post_id,
        p_client_request_key: insert.client_request_key,
        p_terms_fingerprint: insert.terms_fingerprint,
        p_gross_amount_cents: insert.gross_amount_cents,
        p_platform_fee_cents: insert.platform_fee_cents,
        p_processing_fee_cents: insert.processing_fee_cents,
        p_total_creator_deduction_cents: insert.total_creator_deduction_cents,
        p_creator_net_cents: insert.creator_net_cents,
        p_processing_fee_enabled: insert.processing_fee_enabled,
        p_processing_fee_basis_points: insert.processing_fee_basis_points,
        p_processing_fee_fixed_cents: insert.processing_fee_fixed_cents,
        p_fee_schedule_version: insert.fee_schedule_version,
        p_currency: insert.currency,
        p_destination_account_id: insert.stripe_destination_account_id,
        p_checkout_params: checkoutParams,
      });
      if (created.error?.code === "CN021") {
        return NextResponse.json({
          error: "Finish or close an active tip before starting another.", code: "TOO_MANY_OPEN_TIPS",
        }, { status: 409 });
      }
      if (created.error) throw new Error(`Tip attempt creation failed: ${created.error.message}`);
      tip = created.data as unknown as TipRow | null;
    }
    if (!tip) throw new Error("Tip attempt was not created.");
    if (tip.tipper_id !== user.id || tip.post_id !== postId ||
        tip.creator_id !== eligibility.creatorId ||
        tip.stripe_destination_account_id !== eligibility.destinationAccountId ||
        Number(tip.gross_amount_cents) !== amountCents || tip.currency !== TIP_CURRENCY) {
      return NextResponse.json({ error: "This tip request was already used with different terms.", code: "REQUEST_KEY_REUSED" }, { status: 409 });
    }
    if (!tip.stripe_checkout_params || tip.stripe_checkout_params.client_reference_id !== tip.id) {
      throw new Error(`Tip checkout parameters missing or invalid for ${tip.id}.`);
    }

    const stripe = getStripe();
    if (tip.stripe_checkout_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(tip.stripe_checkout_session_id);
      if (existing.status === "open" && existing.client_secret) {
        return NextResponse.json({ tipId: tip.id, clientSecret: existing.client_secret });
      }
      return NextResponse.json({ error: "This tip attempt is no longer active. Please try again.", code: "ATTEMPT_CLOSED" }, { status: 409 });
    }

    const currentEligibility = await requireTipEligibility(supabaseAdmin, user, postId);
    if (currentEligibility.creatorId !== tip.creator_id ||
        currentEligibility.destinationAccountId !== tip.stripe_destination_account_id) {
      throw new TipAdmissionError(409, "TIP_TERMS_CHANGED", "This creator's tip settings changed. Please try again.");
    }
    const session = await stripe.checkout.sessions.create(tip.stripe_checkout_params,
      { idempotencyKey: `creatornet-video-tip:${tip.id}` });
    if (!session.client_secret) throw new Error("Stripe did not return a Checkout client secret.");
    const bound = await supabaseAdmin.rpc("bind_video_tip_checkout", { p_tip_id: tip.id, p_session_id: session.id });
    if (bound.error || bound.data !== true) {
      try { await stripe.checkout.sessions.expire(session.id); } catch { /* best effort */ }
      throw new Error(`Tip checkout binding failed: ${bound.error?.message || "conflict"}`);
    }
    try {
      const finalEligibility = await requireTipEligibility(supabaseAdmin, user, postId);
      if (finalEligibility.creatorId !== tip.creator_id ||
          finalEligibility.destinationAccountId !== tip.stripe_destination_account_id) {
        throw new TipAdmissionError(409, "TIP_TERMS_CHANGED", "This creator's tip settings changed. Please try again.");
      }
    } catch (admissionError) {
      let expired = false;
      try { await stripe.checkout.sessions.expire(session.id); expired = true; } catch { /* payment may already be processing */ }
      if (expired) {
        const { error: cancelError } = await supabaseAdmin.from("tips").update({
          status: "canceled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", tip.id).in("status", ["creating", "open"]);
        if (cancelError) console.error("[tips:checkout] post-bind cancellation failed:", { tipId: tip.id, cancelError });
      }
      throw admissionError;
    }
    return NextResponse.json({ tipId: tip.id, clientSecret: session.client_secret });
  } catch (error) {
    if (error instanceof TipAdmissionError) {
      return NextResponse.json({
        error: publicMessage("tips:checkout", error, "Tip checkout could not be started."),
        code: error.code,
      }, { status: error.status });
    }
    console.error("[tips:checkout] failed:", error);
    return NextResponse.json({ error: "Tip checkout could not be started. Please try again." }, { status: 500 });
  }
}
