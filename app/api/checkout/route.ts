// app/api/checkout/route.ts
import "server-only";
import Stripe from "stripe";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Let SDK use its bundled API version (avoids TS mismatch errors)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: undefined });

// Admin Supabase client (bypasses RLS for server routes)
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
};

type ProductPayload = BodyBase & {
  type: "product";
  product_id: string;
};

type PlanPayload = BodyBase & {
  type: "installments";
  product_id: string;
  plan_months: number;
  plan_price_cents: number; // cents per installment
};

type BookingPayload = BodyBase & {
  type: "booking";
  bookingRedirectUrl: string;
};

type Payload = ProductPayload | PlanPayload | BookingPayload;

export async function POST(req: Request) {
  const supabase = supabaseAdmin();
  
  // CRITICAL: Detect site URL from request URL to support localhost testing
  // This ensures Stripe redirects back to the same origin (localhost or Vercel)
  let site = "http://localhost:3000"; // Default to localhost
  
  try {
    // Use the request URL to determine the origin
    const requestUrl = new URL(req.url);
    let hostname = requestUrl.hostname;
    const port = requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80");
    
    // Normalize 0.0.0.0 to localhost (browsers can't access 0.0.0.0)
    if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::1") {
      hostname = "localhost";
    }
    
    // Build the site URL
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      site = `http://localhost:3000`;
    } else {
      // For other hosts (like Vercel), use the actual host
      site = `${requestUrl.protocol}//${hostname}${port && port !== "80" && port !== "443" ? `:${port}` : ""}`;
    }
  } catch {
    // Fallback: try origin header
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        const url = new URL(origin);
        let hostname = url.hostname;
        
        // Normalize 0.0.0.0 to localhost
        if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::1") {
          hostname = "localhost";
        }
        
        if (hostname === "localhost" || hostname === "127.0.0.1") {
          site = `http://localhost:3000`;
        } else {
          site = `${url.protocol}//${url.host}`;
        }
      } catch {
        // If all else fails, use env or default
        site = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
      }
    } else {
      site = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
    }
  }
  
  console.log("[checkout] 🔧 Using site URL:", site, { 
    requestUrl: req.url,
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    hasEnv: !!process.env.NEXT_PUBLIC_SITE_URL 
  });

  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body?.type) return new Response("Missing type", { status: 400 });

  async function writePending(session_id: string, amount_cents: number, currency: string) {
    const insert = {
      session_id,
      status: "pending",
      product_id: (body as any).product_id ?? null,
      post_id: body.post_id ?? null,
      creator_id: body.creator_id ?? null,
      amount_cents,
      currency,
    };
    const { error } = await supabase.from("purchases").insert(insert).select("id").single();
    if (error && !`${error.message}`.toLowerCase().includes("duplicate")) {
      throw new Error(`Failed to write pending purchase: ${error.message}`);
    }
  }

  try {
    // ---- ONE-TIME PRODUCT ----
    if (body.type === "product") {
      const { data: prod, error } = await supabase
        .from("products")
        .select("product_id,title,amount_cents,currency")
        .eq("product_id", body.product_id)
        .single();
      if (error) throw new Error(`Load product failed: ${error.message}`);
      if (!prod) throw new Error("Product not found");

      const amount_cents = Number(prod.amount_cents ?? 0);
      const currency = (prod.currency as string) ?? "usd";
      if (!Number.isFinite(amount_cents) || amount_cents < 50) {
        throw new Error("Invalid amount (Stripe min 50¢)");
      }

      const session = await stripe.checkout.sessions.create({
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
        // **add metadata so /success can route to unlocked content**
        metadata: {
          product_id: body.product_id,
          post_id: body.post_id || "",
          creator_id: body.creator_id || "",
        },
        success_url: `${site}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${site}/`,
      });

      await writePending(session.id, amount_cents, currency);
      return Response.json({ url: session.url, session_id: session.id });
    }

    // ---- INSTALLMENTS (temporary: single payment until subs are ready) ----
    if (body.type === "installments") {
      const months = Number(body.plan_months);
      const per_cents = Number(body.plan_price_cents);
      if (!Number.isFinite(months) || months < 1) throw new Error("plan_months invalid");
      if (!Number.isFinite(per_cents) || per_cents < 50) throw new Error("plan_price_cents invalid (>=50)");

      const { data: prod, error } = await supabase
        .from("products")
        .select("product_id,title,currency")
        .eq("product_id", body.product_id)
        .single();
      if (error) throw new Error(`Load product failed: ${error.message}`);

      const currency = (prod?.currency as string) ?? "usd";

      const session = await stripe.checkout.sessions.create({
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
        metadata: {
          product_id: body.product_id,
          post_id: body.post_id || "",
          creator_id: body.creator_id || "",
          plan_months: String(months),
          plan_price_cents: String(per_cents),
        },
        success_url: `${site}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${site}/`,
      });

      await writePending(session.id, per_cents, currency);
      return Response.json({ url: session.url, session_id: session.id });
    }

    // ---- BOOKING (no Stripe) ----
    if (body.type === "booking") {
      if (!body.bookingRedirectUrl) throw new Error("bookingRedirectUrl required");
      if (!body.post_id) throw new Error("post_id is required for booking");

      // Validate post exists and get creator_id if not provided
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

      const raw = body.bookingRedirectUrl.trim();
      let bookingUrl: string;
      try {
        const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (parsed.protocol !== "https:") throw new Error("bookingRedirectUrl must be https");
        bookingUrl = parsed.toString();
      } catch {
        throw new Error("bookingRedirectUrl must be a valid https URL");
      }

      console.log("[checkout] creating booking session with:", {
        post_id: body.post_id,
        creator_id: creator_id,
        booking_redirect_url: bookingUrl,
      });
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
        cancel_url: `${site}/`,
      });
      console.log("[checkout] booking session created:", { session_id: session.id, metadata: session.metadata });

      return Response.json({ url: session.url, session_id: session.id });
    }

    return new Response("Unsupported type", { status: 400 });
  } catch (e: any) {
    const msg = e?.message || "Checkout error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
