// app/api/checkout/route.ts
import "server-only";
import type { NextRequest } from "next/server";
import Stripe from "stripe";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { trackServerEvent } from "@/lib/posthogServer";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { updatePostMetrics } from "@/lib/updatePostMetrics";
import { isCreatorSellReady } from "@/lib/creatorStripeConnect";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";

export const runtime = "nodejs";

const PLATFORM_FEE_RATE = 0.12;
const PLATFORM_FEE_PERCENT_STR = String(Math.round(PLATFORM_FEE_RATE * 100));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: undefined });

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

type BodyBase = {
  post_id?: string;
  creator_id?: string;
  titleForCheckout?: string;
  buyer_id?: string;
  /** Optional; included in Stripe metadata */
  category?: string;
};

type ProductPayload = BodyBase & {
  type: "product";
  product_id: string;
};

type PlanPayload = BodyBase & {
  type: "installments";
  product_id: string;
  plan_months: number;
  plan_price_cents: number;
};

type BookingPayload = BodyBase & {
  type: "booking";
  bookingRedirectUrl: string;
};

type Payload = ProductPayload | PlanPayload | BookingPayload;

function stripeMetadataStrings(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = v.length > 500 ? v.slice(0, 500) : v;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const supabase = supabaseAdmin();
  const authUser = await getAuthenticatedUser(req);

  let site = "http://localhost:3000";
  try {
    const requestUrl = new URL(req.url);
    let hostname = requestUrl.hostname;
    const port = requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80");
    if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::1") {
      hostname = "localhost";
    }
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      site = `http://localhost:3000`;
    } else {
      site = `${requestUrl.protocol}//${hostname}${port && port !== "80" && port !== "443" ? `:${port}` : ""}`;
    }
  } catch {
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        const url = new URL(origin);
        let hostname = url.hostname;
        if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::1") {
          hostname = "localhost";
        }
        if (hostname === "localhost" || hostname === "127.0.0.1") {
          site = `http://localhost:3000`;
        } else {
          site = `${url.protocol}//${url.host}`;
        }
      } catch {
        site = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
      }
    } else {
      site = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
    }
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const b = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!b.type && b.productId) {
    b.type = "product";
    b.product_id = String(b.productId);
  }

  const body = b as Payload;
  if (!body?.type) return new Response("Missing type", { status: 400 });

  // Identity comes from the verified session ONLY. This used to be
  //   (body as BodyBase).buyer_id ?? authUser?.id
  // which let a caller attribute a checkout — and the purchases row the webhook
  // later writes from this session's metadata — to any user id they chose.
  // The browser does send buyer_id (components/VideoCard.tsx:735); it is now
  // ignored, and for a legitimate user it was already equal to the session id.
  const resolvedBuyerId = authUser?.id ?? null;
  if ((body.type === "product" || body.type === "installments") && !resolvedBuyerId) {
    return Response.json({ error: "Sign in required to checkout." }, { status: 401 });
  }

  async function writePending(
    session_id: string,
    amount_cents: number,
    currency: string,
    order_id: string | null,
    creatorId: string | null
  ) {
    const buyerId = resolvedBuyerId;
    const insert: Record<string, unknown> = {
      session_id,
      status: "pending",
      product_id: (body as ProductPayload | PlanPayload).product_id ?? null,
      post_id: body.post_id ?? null,
      creator_id: creatorId ?? body.creator_id ?? null,
      buyer_id: buyerId,
      amount_cents,
      currency,
    };
    if (order_id) insert.order_id = order_id;
    if (buyerId) {
      insert.buyer_user_id = buyerId;
    }
    const { error } = await supabase.from("purchases").insert(insert).select("id").single();
    if (error && !`${error.message}`.toLowerCase().includes("duplicate")) {
      throw new Error(`Failed to write pending purchase: ${error.message}`);
    }
  }

  try {
    if (body.type === "product") {
      if (!body.product_id) return new Response("Missing product_id", { status: 400 });

      const { data: prod, error } = await supabase
        .from("products")
        .select("id, product_id, title, type, amount_cents, price_cents, currency, creator_id")
        .or(`product_id.eq.${body.product_id},id.eq.${body.product_id}`)
        .maybeSingle();
      if (error) throw new Error(`Load product failed: ${error.message}`);
      if (!prod) throw new Error("Product not found");

      const amount_cents = Number(prod.amount_cents ?? prod.price_cents ?? 0);
      const currency = (prod.currency as string) ?? "usd";
      if (!Number.isFinite(amount_cents) || amount_cents < 50) {
        throw new Error("Invalid amount (Stripe min 50¢)");
      }

      const creatorId =
        body.creator_id || (prod as { creator_id?: string }).creator_id || null;
      if (!creatorId || !(await isCreatorSellReady(creatorId))) {
        return Response.json(
          {
            error: "This creator is not accepting payments yet.",
            code: "STRIPE_CONNECT_REQUIRED",
          },
          { status: 403 }
        );
      }
      const applicationFeeCents = Math.round(amount_cents * PLATFORM_FEE_RATE);
      const creatorAmountCents = amount_cents - applicationFeeCents;

      const { data: profile } = await supabase
        .from("profiles")
        .select("stripe_account_id")
        .eq("id", creatorId)
        .maybeSingle();
      const destination = profile?.stripe_account_id as string | undefined;
      if (!destination) {
        return Response.json(
          { error: "This creator is not accepting payments yet.", code: "STRIPE_CONNECT_REQUIRED" },
          { status: 403 }
        );
      }

      const productType = String((prod as { type?: string }).type ?? "product");
      const category = (body.category ?? "").trim();

      const { data: orderRow, error: orderErr } = await supabase
        .from("orders")
        .insert({
          buyer_id: resolvedBuyerId,
          buyer_user_id: resolvedBuyerId,
          creator_id: creatorId,
          post_id: body.post_id ?? null,
          amount_cents,
          gross_amount: amount_cents,
          platform_fee: applicationFeeCents,
          creator_amount: creatorAmountCents,
          status: "created",
          currency,
        })
        .select("id")
        .single();

      if (orderErr || !orderRow?.id) {
        throw new Error(`Failed to create order: ${orderErr?.message ?? "unknown"}`);
      }
      const orderId = orderRow.id as string;

      const meta = stripeMetadataStrings({
        order_id: orderId,
        creator_id: creatorId,
        post_id: body.post_id || "",
        buyer_id: resolvedBuyerId || "",
        buyer_user_id: resolvedBuyerId || "",
        product_id: body.product_id,
        product_type: productType,
        category,
        platform_fee_percent: PLATFORM_FEE_PERCENT_STR,
      });

      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency,
                product_data: { name: body.titleForCheckout || prod.title || "Purchase" },
                unit_amount: amount_cents,
              },
              quantity: 1,
            },
          ],
          payment_intent_data: {
            application_fee_amount: applicationFeeCents,
            transfer_data: { destination },
            metadata: meta,
          },
          metadata: meta,
          success_url: `${site}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${site}/dashboard`,
        });
      } catch (e) {
        await supabase.from("orders").update({ status: "canceled" }).eq("id", orderId);
        throw e;
      }

      const piId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

      await supabase
        .from("orders")
        .update({
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: piId,
        })
        .eq("id", orderId);

      await writePending(session.id, amount_cents, currency, orderId, creatorId);

      await trackServerEvent("checkout_started", resolvedBuyerId, {
        post_id: body.post_id,
        product_id: body.product_id,
        creator_id: creatorId,
        price: amount_cents / 100,
        product_type: "product",
        order_id: orderId,
      });

      if (resolvedBuyerId && body.post_id) {
        const { data: post } = await supabase
          .from("posts")
          .select("interests")
          .eq("id", body.post_id)
          .maybeSingle();
        const interestCat = Array.isArray(post?.interests)
          ? ((post.interests[0] as string) ?? null)
          : null;
        updateInterestScore(resolvedBuyerId, interestCat, 15);
      }

      updatePostMetrics(body.post_id ?? null, { checkout_starts: 1 }, undefined, resolvedBuyerId ?? null);

      return Response.json({
        url: session.url,
        session_id: session.id,
        order_id: orderId,
      });
    }

    if (body.type === "installments") {
      const months = Number(body.plan_months);
      const per_cents = Number(body.plan_price_cents);
      if (!Number.isFinite(months) || months < 1) throw new Error("plan_months invalid");
      if (!Number.isFinite(per_cents) || per_cents < 50) throw new Error("plan_price_cents invalid (>=50)");

      const { data: prod, error } = await supabase
        .from("products")
        .select("id, product_id, title, type, currency, creator_id, price_cents")
        .or(`product_id.eq.${body.product_id},id.eq.${body.product_id}`)
        .maybeSingle();
      if (error) throw new Error(`Load product failed: ${error.message}`);

      const currency = (prod?.currency as string) ?? "usd";
      const instCreatorId =
        body.creator_id || (prod as { creator_id?: string } | null)?.creator_id || null;
      if (!instCreatorId || !(await isCreatorSellReady(instCreatorId))) {
        return Response.json(
          {
            error: "This creator is not accepting payments yet.",
            code: "STRIPE_CONNECT_REQUIRED",
          },
          { status: 403 }
        );
      }
      const { data: instProfile } = await supabase
        .from("profiles")
        .select("stripe_account_id")
        .eq("id", instCreatorId)
        .maybeSingle();
      const instDest = instProfile?.stripe_account_id as string | undefined;
      if (!instDest) {
        return Response.json(
          { error: "This creator is not accepting payments yet.", code: "STRIPE_CONNECT_REQUIRED" },
          { status: 403 }
        );
      }
      // The buyer must not be able to name their own price. plan_price_cents
      // arrives in the request body and was previously validated only as ">= 50",
      // then used directly as the Stripe unit_amount — so any product could be
      // bought for 50 cents a month by calling this endpoint directly.
      //
      // The invariant enforced here is deliberately the weakest one that is
      // certainly correct: the TOTAL collected across the plan must be at least
      // the product's stored price. That holds whether price_cents is meant as
      // the total (per_cents * months == price) or as a per-period amount
      // (per_cents == price, so the product is comfortably over). It blocks
      // underpayment without guessing at the pricing model.
      const productPriceCents = Number(
        (prod as { price_cents?: number } | null)?.price_cents ?? 0
      );
      if (productPriceCents > 0 && per_cents * months < productPriceCents) {
        console.error("[checkout] installment underpayment rejected", {
          product_id: body.product_id,
          months,
          per_cents,
          product_price_cents: productPriceCents,
        });
        return Response.json(
          { error: "Installment plan does not cover the product price." },
          { status: 400 }
        );
      }

      const instFeeCents = Math.round(per_cents * PLATFORM_FEE_RATE);
      const instCreatorAmount = per_cents - instFeeCents;
      const productType = String((prod as { type?: string } | null)?.type ?? "installment");
      const category = (body.category ?? "").trim();

      const { data: orderRow, error: orderErr } = await supabase
        .from("orders")
        .insert({
          buyer_id: resolvedBuyerId,
          buyer_user_id: resolvedBuyerId,
          creator_id: instCreatorId,
          post_id: body.post_id ?? null,
          amount_cents: per_cents,
          gross_amount: per_cents,
          platform_fee: instFeeCents,
          creator_amount: instCreatorAmount,
          status: "created",
          currency,
        })
        .select("id")
        .single();

      if (orderErr || !orderRow?.id) {
        throw new Error(`Failed to create order: ${orderErr?.message ?? "unknown"}`);
      }
      const orderId = orderRow.id as string;

      const meta = stripeMetadataStrings({
        order_id: orderId,
        creator_id: instCreatorId,
        post_id: body.post_id || "",
        buyer_id: resolvedBuyerId || "",
        buyer_user_id: resolvedBuyerId || "",
        product_id: body.product_id,
        product_type: productType,
        category,
        platform_fee_percent: PLATFORM_FEE_PERCENT_STR,
        plan_months: String(months),
        plan_price_cents: String(per_cents),
      });

      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency,
                product_data: { name: body.titleForCheckout || prod?.title || "Installment" },
                unit_amount: per_cents,
              },
              quantity: 1,
            },
          ],
          payment_intent_data: {
            application_fee_amount: instFeeCents,
            transfer_data: { destination: instDest },
            metadata: meta,
          },
          metadata: meta,
          success_url: `${site}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${site}/dashboard`,
        });
      } catch (e) {
        await supabase.from("orders").update({ status: "canceled" }).eq("id", orderId);
        throw e;
      }

      const piId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

      await supabase
        .from("orders")
        .update({
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: piId,
        })
        .eq("id", orderId);

      await writePending(session.id, per_cents, currency, orderId, instCreatorId);

      await trackServerEvent("checkout_started", resolvedBuyerId, {
        post_id: body.post_id,
        product_id: body.product_id,
        creator_id: instCreatorId,
        price: per_cents / 100,
        product_type: "installment",
        order_id: orderId,
      });

      updatePostMetrics(body.post_id ?? null, { checkout_starts: 1 }, undefined, resolvedBuyerId ?? null);

      return Response.json({ url: session.url, session_id: session.id, order_id: orderId });
    }

    if (body.type === "booking") {
      if (!body.bookingRedirectUrl) throw new Error("bookingRedirectUrl required");
      if (!body.post_id) throw new Error("post_id is required for booking");

      let creator_id = body.creator_id;
      if (!creator_id || !body.post_id) {
        const { data: post, error: postErr } = await supabase
          .from("posts")
          .select("id, creator_id")
          .eq("id", body.post_id)
          .single();
        if (postErr || !post) {
          throw new Error(`Post not found: ${postErr?.message || "Invalid post_id"}`);
        }
        if (!creator_id) {
          creator_id = post.creator_id;
        }
      }

      const rawUrl = body.bookingRedirectUrl.trim();
      let bookingUrl: string;
      try {
        const parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
        if (parsed.protocol !== "https:") throw new Error("bookingRedirectUrl must be https");
        bookingUrl = parsed.toString();
      } catch {
        throw new Error("bookingRedirectUrl must be a valid https URL");
      }

      const session = await stripe.checkout.sessions.create({
        mode: "setup",
        payment_method_types: ["card"],
        metadata: {
          kind: "booking",
          booking_redirect_url: bookingUrl,
          post_id: String(body.post_id),
          creator_id: String(creator_id),
        },
        success_url: `${site}/success?session_id={CHECKOUT_SESSION_ID}&kind=booking`,
        cancel_url: `${site}/dashboard`,
      });

      return Response.json({ url: session.url, session_id: session.id });
    }

    return new Response("Unsupported type", { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Checkout error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
