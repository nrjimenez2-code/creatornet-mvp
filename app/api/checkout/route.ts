// app/api/checkout/route.ts
import { publicMessage } from "@/lib/apiError";
import { eitherIdFilter, isSafeId } from "@/lib/ids";
import { resolvePostForProduct, INVALID_POST } from "@/lib/checkoutGuards";
import { isSafeBookingTarget } from "@/lib/bookingUrl";
import "server-only";
import type { NextRequest } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { trackServerEvent } from "@/lib/posthogServer";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { updatePostMetrics } from "@/lib/updatePostMetrics";
import { isCreatorSellReady } from "@/lib/creatorStripeConnect";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { splitFee, PLATFORM_FEE_PERCENT_STR } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe calls are capped at 20s with 2 retries (lib/stripeClient.ts); without
// maxDuration Vercel's 10s plan default can kill the function mid-call. 60s
// covers the worst legitimate case and is allowed on every Vercel plan.
export const maxDuration = 60;



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

  // Stripe success/cancel URLs. Configured origin first; the request's own
  // host is only a fallback for local development, never the Host header a
  // caller can set on an arbitrary request (that let a forged checkout land
  // the buyer, and the session id, on a domain of the attacker's choosing).
  const configuredSite = (process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  let site = configuredSite;
  if (!site) {
    try {
      const u = new URL(req.url);
      const local = ["localhost", "127.0.0.1", "0.0.0.0", "::", "::1"].includes(u.hostname);
      site = local ? "http://localhost:3000" : `${u.protocol}//${u.host}`;
    } catch {
      site = "http://localhost:3000";
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
    creatorId: string | null,
    postId: string | null
  ) {
    const buyerId = resolvedBuyerId;
    const insert: Record<string, unknown> = {
      session_id,
      status: "pending",
      product_id: (body as ProductPayload | PlanPayload).product_id ?? null,
      post_id: postId,
      creator_id: creatorId,
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
      if (!isSafeId(body.product_id)) return new Response("Invalid product_id", { status: 400 });

      const { data: prod, error } = await supabase
        .from("products")
        .select(
          "id, product_id, title, type, amount_cents, price_cents, currency, creator_id, discord_invite_url, whop_listing_url, deliver_url"
        )
        .or(eitherIdFilter(["product_id", "id"], body.product_id))
        .maybeSingle();
      if (error) throw new Error(`Load product failed: ${error.message}`);
      if (!prod) throw new Error("Product not found");

      const amount_cents = Number(prod.amount_cents ?? prod.price_cents ?? 0);
      const currency = (prod.currency as string) ?? "usd";
      if (!Number.isFinite(amount_cents) || amount_cents < 50) {
        throw new Error("Invalid amount (Stripe min 50¢)");
      }

      // The creator who gets paid is the product's owner. The browser still
      // sends creator_id (components/VideoCard.tsx) and it used to win over
      // the product row, which let anyone with a Connect account point the
      // destination transfer at themselves. It is ignored now.
      const creatorId = (prod as { creator_id?: string }).creator_id || null;
      if (!creatorId || !(await isCreatorSellReady(creatorId))) {
        return Response.json(
          {
            error: "This creator is not accepting payments yet.",
            code: "STRIPE_CONNECT_REQUIRED",
          },
          { status: 403 }
        );
      }
      const { feeCents: applicationFeeCents, creatorCents: creatorAmountCents } = splitFee(amount_cents);

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

      // The post a purchase unlocks must be one that actually sells this
      // product, by this creator. post_id used to be copied from the body,
      // so buying the cheapest product on the site with post_id set to any
      // premium post unlocked that post.
      const postId = await resolvePostForProduct(supabase, body.post_id, String(prod.id), creatorId);
      if (postId === INVALID_POST) {
        return Response.json(
          { error: "This post does not sell that product." },
          { status: 400 }
        );
      }

      // Refuse to take money for a digital product that has nothing to hand
      // over.
      //
      // A "video" or "course" promises a file. The buyer gets it from
      // posts.premium_path (signed by GET /api/watch/[postId]) or from a
      // fulfillment link on the product. When a product of those types has
      // NEITHER, the buyer pays and receives a 404 — the charge-and-deliver-
      // nothing case. As of this commit that describes 16 live posts.
      //
      // Deliberately narrow: only the two types that promise a file are
      // checked. Service products ("mentorship") and any type this code does
      // not recognise are left alone, because for them the transaction is the
      // booking or a conversation, not a download. Blocking those would cost
      // the creator a legitimate sale.
      const DIGITAL_GOOD_TYPES = new Set(["video", "course"]);
      if (DIGITAL_GOOD_TYPES.has(productType)) {
        const p = prod as {
          discord_invite_url?: string | null;
          whop_listing_url?: string | null;
          deliver_url?: string | null;
        };
        const hasLink = Boolean(p.discord_invite_url || p.whop_listing_url || p.deliver_url);

        let hasFile = false;
        if (!hasLink && postId) {
          const { data: postFile } = await supabase
            .from("posts")
            .select("premium_path")
            .eq("id", postId)
            .maybeSingle();
          hasFile = Boolean(postFile?.premium_path);
        }

        if (!hasLink && !hasFile) {
          return Response.json(
            {
              error:
                "This creator hasn't attached the file yet, so it can't be purchased right now.",
              code: "NO_DELIVERABLE",
            },
            { status: 409 }
          );
        }
      }

      const { data: orderRow, error: orderErr } = await supabase
        .from("orders")
        .insert({
          buyer_id: resolvedBuyerId,
          buyer_user_id: resolvedBuyerId,
          creator_id: creatorId,
          post_id: postId,
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
        post_id: postId || "",
        buyer_id: resolvedBuyerId || "",
        buyer_user_id: resolvedBuyerId || "",
        product_id: body.product_id,
        product_type: productType,
        category,
        platform_fee_percent: PLATFORM_FEE_PERCENT_STR,
      });

      let session: Stripe.Checkout.Session;
      try {
        session = await getStripe().checkout.sessions.create({
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

      await writePending(session.id, amount_cents, currency, orderId, creatorId, postId);

      await trackServerEvent("checkout_started", resolvedBuyerId, {
        post_id: postId,
        product_id: body.product_id,
        creator_id: creatorId,
        price: amount_cents / 100,
        product_type: "product",
        order_id: orderId,
      });

      if (resolvedBuyerId && postId) {
        const { data: post } = await supabase
          .from("posts")
          .select("interests")
          .eq("id", postId)
          .maybeSingle();
        const interestCat = Array.isArray(post?.interests)
          ? ((post.interests[0] as string) ?? null)
          : null;
        // Fire-and-forget analytics: attach a catch so a rejected promise can
        // never surface as an unhandled rejection and take down the invocation
        // that is in the middle of returning a live Stripe checkout URL.
        void updateInterestScore(resolvedBuyerId, interestCat, 15)?.catch?.((e: unknown) =>
          console.warn("[checkout] updateInterestScore failed:", e)
        );
      }

      void updatePostMetrics(postId, { checkout_starts: 1 }, undefined, resolvedBuyerId ?? null)?.catch?.(
        (e: unknown) => console.warn("[checkout] updatePostMetrics failed:", e)
      );

      return Response.json({
        url: session.url,
        session_id: session.id,
        order_id: orderId,
      });
    }

    if (body.type === "installments") {
      // Installment checkout charged a browser-supplied plan_price_cents once
      // (mode: "payment"), so any product could be bought for 50 cents. No
      // page in the app offers this flow (the buy button only sends
      // type: "product"), so it is closed rather than patched. Real
      // installments exist on the booking side (payment-link, Stripe
      // subscriptions with the price derived from the product).
      return Response.json(
        { error: "Installment checkout is not available." },
        { status: 410 }
      );
    }

    if (body.type === "booking") {
      // Booking used to be the one checkout type with no login and with the
      // redirect target and creator taken from the request body. Anyone could
      // mint Stripe sessions, send buyers to any https URL after "booking",
      // and have the webhook attach the booking to whichever account it
      // guessed from the card email. Now: signed-in buyer, post from the
      // body, everything else from the post row.
      if (!resolvedBuyerId) {
        return Response.json({ error: "Sign in required to book." }, { status: 401 });
      }
      if (!body.post_id || !isSafeId(body.post_id)) {
        return Response.json({ error: "post_id is required for booking" }, { status: 400 });
      }

      const { data: post, error: postErr } = await supabase
        .from("posts")
        .select("id, creator_id, booking_url, allow_booking")
        .eq("id", body.post_id)
        .maybeSingle();
      if (postErr || !post) {
        return Response.json({ error: "Post not found" }, { status: 404 });
      }
      const creator_id = String(post.creator_id ?? "");
      if (!creator_id) {
        return Response.json({ error: "Post has no creator" }, { status: 400 });
      }
      if (post.allow_booking === false) {
        return Response.json({ error: "This post does not accept bookings." }, { status: 400 });
      }

      // The browser sends bookingRedirectUrl, which it read from the same post
      // row; the stored value is what we trust. A site-relative default such
      // as /api/book?creator_id=... becomes absolute on our own origin.
      const stored = typeof post.booking_url === "string" ? post.booking_url.trim() : "";
      const target = stored || `/api/book?creator_id=${creator_id}&post_id=${post.id}`;
      if (!isSafeBookingTarget(target)) {
        return Response.json({ error: "This creator has no valid booking link." }, { status: 400 });
      }
      const bookingUrl = target.startsWith("/") ? `${site}${target}` : target;

      const session = await getStripe().checkout.sessions.create({
        mode: "setup",
        payment_method_types: ["card"],
        metadata: {
          kind: "booking",
          booking_redirect_url: bookingUrl,
          post_id: String(post.id),
          creator_id,
          buyer_id: resolvedBuyerId,
          buyer_user_id: resolvedBuyerId,
        },
        success_url: `${site}/success?session_id={CHECKOUT_SESSION_ID}&kind=booking`,
        cancel_url: `${site}/dashboard`,
      });

      return Response.json({ url: session.url, session_id: session.id });
    }

    return new Response("Unsupported type", { status: 400 });
  } catch (e: unknown) {
    return Response.json({ error: publicMessage("checkout", e, "Checkout could not be started. Please try again.") }, { status: 500 });
  }
}
