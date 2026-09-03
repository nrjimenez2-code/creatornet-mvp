// app/api/checkout/route.ts
import { publicMessage } from "@/lib/apiError";
import { eitherIdFilter, isSafeId } from "@/lib/ids";
import { resolvePostForProduct, INVALID_POST } from "@/lib/checkoutGuards";
import { isSafeBookingTarget } from "@/lib/bookingUrl";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { trackServerEvent } from "@/lib/posthogServer";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { updatePostMetrics } from "@/lib/updatePostMetrics";
import { isCreatorSellReady } from "@/lib/creatorStripeConnect";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import {
  calculateCreatorFees,
  creatorFeeMetadata,
  PLATFORM_FEE_PERCENT_STR,
} from "@/lib/money";

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

type ProductCheckoutAttempt = {
  id: string;
  buyer_id: string;
  purchase_identity: string;
  creator_id: string;
  product_id: string;
  post_id: string | null;
  attempt_key: string;
  order_id: string;
  terms_fingerprint: string;
  stripe_checkout_session_id: string | null;
  stripe_checkout_url: string | null;
  status: "creating" | "open" | "complete";
};

const PRODUCT_CHECKOUT_ATTEMPT_COLUMNS =
  "id, buyer_id, purchase_identity, creator_id, product_id, post_id, attempt_key, order_id, terms_fingerprint, stripe_checkout_session_id, stripe_checkout_url, status";

function productCheckoutFingerprint(value: Record<string, string | number | null>): string {
  const canonical = Object.keys(value)
    .sort()
    .map((key) => `${key}=${String(value[key] ?? "")}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505"
  );
}

function isMissingStripeResource(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const stripeError = error as { code?: unknown; statusCode?: unknown };
  return stripeError.code === "resource_missing" || stripeError.statusCode === 404;
}

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
    postId: string | null,
    productId: string,
    reusablePurchaseId: string | null,
    expectedPriorSessionId: string | null
  ): Promise<boolean> {
    const buyerId = resolvedBuyerId;
    const insert: Record<string, unknown> = {
      session_id,
      status: "pending",
      product_id: productId,
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

    const loadWinner = async () => {
      const identityColumn = postId ? "post_id" : "product_id";
      const identityValue = postId || productId;
      const { data, error } = await supabase
        .from("purchases")
        .select("id, status, session_id, order_id")
        .eq("buyer_id", buyerId)
        .eq(identityColumn, identityValue)
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to verify checkout winner: ${error.message}`);
      }
      return data as
        | { id: string; status: string; session_id: string | null; order_id: string | null }
        | null;
    };

    if (reusablePurchaseId) {
      let update = supabase
        .from("purchases")
        .update(insert)
        .eq("id", reusablePurchaseId)
        .in("status", ["pending", "processing", "failed"]);
      update = expectedPriorSessionId
        ? update.eq("session_id", expectedPriorSessionId)
        : update.is("session_id", null);
      const { data, error } = await update
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(
          `Failed to reuse pending purchase: ${error.message}`
        );
      }
      if (data?.id) return true;

      const winner = await loadWinner();
      return Boolean(winner && winner.session_id === session_id && winner.order_id === order_id);
    }

    const { error } = await supabase.from("purchases").insert(insert).select("id").single();
    if (!error) return true;
    if (!isUniqueViolation(error)) {
      throw new Error(`Failed to write pending purchase: ${error.message}`);
    }

    // A simultaneous request can win the buyer/product uniqueness constraint.
    // It is safe only when Stripe returned the same idempotent session to both.
    const winner = await loadWinner();
    return Boolean(winner && winner.session_id === session_id && winner.order_id === order_id);
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
      // This is calculated entirely from the server-owned product price and
      // server environment. The browser cannot select or alter either fee.
      const fees = calculateCreatorFees(amount_cents);

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

      // The current schema intentionally has one purchase row per buyer/post
      // (and per buyer/product). Reusing an abandoned, unfulfilled attempt is
      // safe; charging against a paid, active, complete, or refunded row is not.
      // A refunded row has already consumed its exactly-once earnings claim, so
      // accepting a second payment into it would charge without new access or
      // creator earnings. Reject that case before creating a Stripe session.
      const purchaseIdentityColumn = postId ? "post_id" : "product_id";
      const resolvedProductId = String(prod.id);
      const purchaseIdentityValue = postId || resolvedProductId;
      const { data: priorPurchase, error: priorPurchaseError } = await supabase
        .from("purchases")
        .select("id, status, access_granted, session_id, order_id")
        .eq("buyer_id", resolvedBuyerId)
        .eq(purchaseIdentityColumn, purchaseIdentityValue)
        .maybeSingle();
      if (priorPurchaseError) {
        throw new Error(`Failed to check prior purchase: ${priorPurchaseError.message}`);
      }
      const reusablePurchaseId =
        priorPurchase && ["pending", "processing", "failed"].includes(priorPurchase.status)
          ? String(priorPurchase.id)
          : null;
      if (priorPurchase && !reusablePurchaseId) {
        return Response.json(
          {
            error: priorPurchase.access_granted
              ? "You already own this product."
              : "This product cannot be purchased again automatically. Contact support if you need help.",
            code: "PURCHASE_ALREADY_EXISTS",
          },
          { status: 409 }
        );
      }

      const stripe = getStripe();
      const feeMeta = creatorFeeMetadata(fees);
      // A browser-supplied display title would make otherwise identical Stripe
      // requests differ and defeat idempotency. Checkout always uses the
      // server-owned product title.
      const checkoutTitle = String(prod.title || "Purchase");
      const purchaseIdentity = postId ? `post:${postId}` : `product:${resolvedProductId}`;
      const termsFingerprint = productCheckoutFingerprint({
        version: "creatornet-product-checkout-v1",
        buyer_id: resolvedBuyerId,
        creator_id: creatorId,
        product_id: resolvedProductId,
        post_id: postId,
        amount_cents,
        currency,
        destination,
        checkout_title: checkoutTitle,
        site,
        category,
        platform_fee_cents: fees.platformFeeCents,
        processing_fee_cents: fees.processingFeeCents,
        total_creator_deduction_cents: fees.totalCreatorDeductionCents,
        creator_net_cents: fees.creatorNetCents,
        fee_schedule_version: fees.feeScheduleVersion,
      });

      const loadAttempt = async (): Promise<ProductCheckoutAttempt | null> => {
        const { data, error } = await supabase
          .from("product_checkout_attempts")
          .select(PRODUCT_CHECKOUT_ATTEMPT_COLUMNS)
          .eq("buyer_id", resolvedBuyerId)
          .eq("purchase_identity", purchaseIdentity)
          .maybeSingle();
        if (error) throw new Error(`Failed to load checkout attempt: ${error.message}`);
        return (data as ProductCheckoutAttempt | null) ?? null;
      };

      const claimAttempt = async (): Promise<ProductCheckoutAttempt> => {
        const candidate = {
          buyer_id: resolvedBuyerId,
          purchase_identity: purchaseIdentity,
          creator_id: creatorId,
          product_id: resolvedProductId,
          post_id: postId,
          attempt_key: randomUUID(),
          // An existing order is reusable only while its recorded Stripe
          // session is the attempt being recovered. Failed/partial rows with no
          // session may point at a canceled order, which must not be revived.
          order_id:
            priorPurchase?.session_id && priorPurchase?.order_id
              ? priorPurchase.order_id
              : randomUUID(),
          terms_fingerprint: termsFingerprint,
          stripe_checkout_session_id: priorPurchase?.session_id || null,
          stripe_checkout_url: null,
          status: priorPurchase?.session_id ? "open" : "creating",
        };
        const { data, error } = await supabase
          .from("product_checkout_attempts")
          .insert(candidate)
          .select(PRODUCT_CHECKOUT_ATTEMPT_COLUMNS)
          .maybeSingle();
        if (!error && data) return data as ProductCheckoutAttempt;
        if (error && !isUniqueViolation(error)) {
          throw new Error(`Failed to claim checkout attempt: ${error.message}`);
        }
        const winner = await loadAttempt();
        if (!winner) throw new Error("Checkout attempt could not be claimed safely.");
        return winner;
      };

      const rotateAttempt = async (
        current: ProductCheckoutAttempt
      ): Promise<ProductCheckoutAttempt> => {
        const replacement = {
          creator_id: creatorId,
          product_id: resolvedProductId,
          post_id: postId,
          attempt_key: randomUUID(),
          order_id: randomUUID(),
          terms_fingerprint: termsFingerprint,
          stripe_checkout_session_id: null,
          stripe_checkout_url: null,
          status: "creating",
          updated_at: new Date().toISOString(),
        };
        const { data, error } = await supabase
          .from("product_checkout_attempts")
          .update(replacement)
          .eq("id", current.id)
          .eq("attempt_key", current.attempt_key)
          .select(PRODUCT_CHECKOUT_ATTEMPT_COLUMNS)
          .maybeSingle();
        if (error) throw new Error(`Failed to rotate checkout attempt: ${error.message}`);
        if (data) {
          const { error: cancelError } = await supabase
            .from("orders")
            .update({ status: "canceled" })
            .eq("id", current.order_id)
            .eq("status", "created");
          if (cancelError) {
            throw new Error(`Failed to retire prior checkout order: ${cancelError.message}`);
          }
          return data as ProductCheckoutAttempt;
        }
        const winner = await loadAttempt();
        if (!winner) throw new Error("Replacement checkout attempt was lost.");
        return winner;
      };

      const ensureOrder = async (attempt: ProductCheckoutAttempt): Promise<void> => {
        const order = {
          id: attempt.order_id,
          buyer_id: resolvedBuyerId,
          buyer_user_id: resolvedBuyerId,
          creator_id: creatorId,
          post_id: postId,
          amount_cents,
          gross_amount: amount_cents,
          platform_fee: fees.platformFeeCents,
          processing_fee: fees.processingFeeCents,
          total_creator_deduction: fees.totalCreatorDeductionCents,
          creator_amount: fees.creatorNetCents,
          fee_schedule_version: fees.feeScheduleVersion,
          status: "created",
          currency,
        };
        const { error } = await supabase.from("orders").insert(order);
        if (!error) return;
        if (!isUniqueViolation(error)) {
          throw new Error(`Failed to create order: ${error.message}`);
        }

        const { data: existing, error: loadError } = await supabase
          .from("orders")
          .select(
            "id, buyer_id, creator_id, post_id, amount_cents, gross_amount, platform_fee, processing_fee, total_creator_deduction, creator_amount, fee_schedule_version, status, currency"
          )
          .eq("id", attempt.order_id)
          .maybeSingle();
        if (loadError || !existing) {
          throw new Error(`Failed to verify existing order: ${loadError?.message ?? "missing"}`);
        }
        const matches =
          existing.buyer_id === resolvedBuyerId &&
          existing.creator_id === creatorId &&
          (existing.post_id ?? null) === postId &&
          Number(existing.amount_cents) === amount_cents &&
          Number(existing.gross_amount) === amount_cents &&
          Number(existing.platform_fee) === fees.platformFeeCents &&
          Number(existing.processing_fee) === fees.processingFeeCents &&
          Number(existing.total_creator_deduction) === fees.totalCreatorDeductionCents &&
          Number(existing.creator_amount) === fees.creatorNetCents &&
          existing.fee_schedule_version === fees.feeScheduleVersion &&
          existing.status === "created" &&
          String(existing.currency).toLowerCase() === currency.toLowerCase();
        if (!matches) throw new Error("Existing checkout order does not match current terms.");
      };

      const retrieveSession = async (sessionId: string): Promise<Stripe.Checkout.Session | null> => {
        try {
          return await stripe.checkout.sessions.retrieve(sessionId);
        } catch (error) {
          if (isMissingStripeResource(error)) return null;
          // Unknown/network failures are deliberately not treated as absence:
          // the session could still be payable, so creating another would be unsafe.
          throw error;
        }
      };

      const sessionMatchesCurrentTerms = (session: Stripe.Checkout.Session): boolean => {
        const meta = session.metadata || {};
        const productMatches =
          meta.product_id === resolvedProductId ||
          meta.product_id === body.product_id ||
          (prod.product_id && meta.product_id === String(prod.product_id));
        const immutableFeesMatch = Object.entries(feeMeta).every(
          ([key, value]) => meta[key] === value
        );
        const modernAttemptMatches = meta.checkout_attempt_key
          ? meta.checkout_attempt_key === attempt.attempt_key &&
            meta.checkout_terms_fingerprint === termsFingerprint
          : true;
        return (
          session.mode === "payment" &&
          session.amount_total === amount_cents &&
          String(session.currency || "").toLowerCase() === currency.toLowerCase() &&
          meta.buyer_id === resolvedBuyerId &&
          meta.creator_id === creatorId &&
          meta.post_id === (postId || "") &&
          Boolean(productMatches) &&
          immutableFeesMatch &&
          modernAttemptMatches
        );
      };

      const expirePayableSession = async (
        session: Stripe.Checkout.Session
      ): Promise<"expired" | "complete"> => {
        if (session.status === "complete" || session.payment_status === "paid") return "complete";
        if (session.status === "expired") return "expired";
        try {
          const expired = await stripe.checkout.sessions.expire(session.id);
          return expired.status === "complete" || expired.payment_status === "paid"
            ? "complete"
            : "expired";
        } catch {
          // Another request may have expired or completed it between retrieve
          // and expire. Re-read it; only an explicit terminal state is safe.
          const current = await retrieveSession(session.id);
          if (!current || current.status === "expired") return "expired";
          if (current.status === "complete" || current.payment_status === "paid") return "complete";
          throw new Error("Prior Stripe Checkout Session could not be retired safely.");
        }
      };

      const retireOpenOrder = async (orderId: string): Promise<void> => {
        const { error } = await supabase
          .from("orders")
          .update({ status: "canceled" })
          .eq("id", orderId)
          .eq("status", "created");
        if (error) throw new Error(`Failed to retire checkout order: ${error.message}`);
      };

      const completedCheckoutResponse = (attempt: ProductCheckoutAttempt, sessionId: string) =>
        Response.json({
          url: `${site}/success?session_id=${encodeURIComponent(sessionId)}`,
          session_id: sessionId,
          order_id: attempt.order_id,
          reused: true,
        });

      let attempt = await claimAttempt();
      // CAS rotation can lose to another request. Re-evaluate the winning row a
      // bounded number of times instead of ever creating from stale state.
      for (let pass = 0; pass < 4; pass += 1) {
        if (attempt.stripe_checkout_session_id) {
          const existingSession = await retrieveSession(attempt.stripe_checkout_session_id);
          if (existingSession?.status === "complete" || existingSession?.payment_status === "paid") {
            await supabase
              .from("product_checkout_attempts")
              .update({ status: "complete", updated_at: new Date().toISOString() })
              .eq("id", attempt.id)
              .eq("attempt_key", attempt.attempt_key);
            return completedCheckoutResponse(attempt, attempt.stripe_checkout_session_id);
          }

          if (
            attempt.terms_fingerprint === termsFingerprint &&
            existingSession?.status === "open" &&
            existingSession.payment_status === "unpaid" &&
            existingSession.url &&
            sessionMatchesCurrentTerms(existingSession)
          ) {
            await ensureOrder(attempt);
            const pendingWon = await writePending(
              existingSession.id,
              amount_cents,
              currency,
              attempt.order_id,
              creatorId,
              postId,
              resolvedProductId,
              reusablePurchaseId,
              priorPurchase?.session_id || null
            );
            if (!pendingWon) throw new Error("Another checkout attempt became authoritative.");
            return Response.json({
              url: existingSession.url,
              session_id: existingSession.id,
              order_id: attempt.order_id,
              reused: true,
            });
          }

          if (existingSession?.status === "open") {
            const retired = await expirePayableSession(existingSession);
            if (retired === "complete") {
              return completedCheckoutResponse(attempt, existingSession.id);
            }
          } else if (existingSession && existingSession.status !== "expired") {
            throw new Error("Prior Stripe Checkout Session is in an unknown state.");
          }
        }

        if (
          attempt.terms_fingerprint !== termsFingerprint ||
          Boolean(attempt.stripe_checkout_session_id)
        ) {
          attempt = await rotateAttempt(attempt);
          continue;
        }
        break;
      }

      if (
        attempt.terms_fingerprint !== termsFingerprint ||
        attempt.stripe_checkout_session_id
      ) {
        throw new Error("Checkout attempt could not be stabilized safely.");
      }

      await ensureOrder(attempt);
      const orderId = attempt.order_id;
      const meta = stripeMetadataStrings({
        order_id: orderId,
        creator_id: creatorId,
        post_id: postId || "",
        buyer_id: resolvedBuyerId || "",
        buyer_user_id: resolvedBuyerId || "",
        product_id: resolvedProductId,
        product_type: productType,
        category,
        platform_fee_percent: PLATFORM_FEE_PERCENT_STR,
        checkout_attempt_key: attempt.attempt_key,
        checkout_terms_fingerprint: termsFingerprint,
        ...feeMeta,
      });

      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            payment_method_types: ["card"],
            line_items: [
              {
                price_data: {
                  currency,
                  product_data: { name: checkoutTitle },
                  unit_amount: amount_cents,
                },
                quantity: 1,
              },
            ],
            payment_intent_data: {
              // Stripe receives one application fee, while CreatorNet stores and
              // displays its 12% fee and payment processing as separate amounts.
              application_fee_amount: fees.totalCreatorDeductionCents,
              transfer_data: { destination },
              metadata: meta,
            },
            metadata: meta,
            success_url: `${site}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${site}/dashboard`,
          },
          { idempotencyKey: `creatornet-product-checkout:${attempt.attempt_key}` }
        );
      } catch (e) {
        // Do not cancel the stable order here: an ambiguous network error can
        // still have created the session, and the next request must retry with
        // the same key and exact parameters to recover it.
        throw e;
      }

      if (!session.url) {
        const retired = await expirePayableSession(session);
        if (retired === "expired") await retireOpenOrder(orderId);
        throw new Error("Stripe did not return a Checkout URL.");
      }

      const { data: savedAttempt, error: saveAttemptError } = await supabase
        .from("product_checkout_attempts")
        .update({
          stripe_checkout_session_id: session.id,
          stripe_checkout_url: session.url,
          status: "open",
          updated_at: new Date().toISOString(),
        })
        .eq("id", attempt.id)
        .eq("attempt_key", attempt.attempt_key)
        .eq("terms_fingerprint", termsFingerprint)
        .select(PRODUCT_CHECKOUT_ATTEMPT_COLUMNS)
        .maybeSingle();
      if (saveAttemptError) {
        const retired = await expirePayableSession(session);
        if (retired === "expired") await retireOpenOrder(orderId);
        throw new Error(`Failed to save checkout attempt: ${saveAttemptError.message}`);
      }
      if (!savedAttempt) {
        const winner = await loadAttempt();
        if (winner?.stripe_checkout_session_id !== session.id) {
          const retired = await expirePayableSession(session);
          if (retired === "expired") await retireOpenOrder(orderId);
          throw new Error("Another checkout attempt won while Stripe was creating the session.");
        }
        attempt = winner;
      } else {
        attempt = savedAttempt as ProductCheckoutAttempt;
      }

      const piId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

      const { error: orderUpdateError } = await supabase
        .from("orders")
        .update({
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: piId,
        })
        .eq("id", orderId);
      if (orderUpdateError) {
        const retired = await expirePayableSession(session);
        if (retired === "expired") await retireOpenOrder(orderId);
        throw new Error(`Failed to attach Stripe session to order: ${orderUpdateError.message}`);
      }

      const pendingWon = await writePending(
        session.id,
        amount_cents,
        currency,
        orderId,
        creatorId,
        postId,
        resolvedProductId,
        reusablePurchaseId,
        priorPurchase?.session_id || null
      );
      if (!pendingWon) {
        const retired = await expirePayableSession(session);
        if (retired === "expired") await retireOpenOrder(orderId);
        throw new Error("Another checkout attempt became authoritative.");
      }

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
