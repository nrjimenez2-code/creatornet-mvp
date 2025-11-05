// app/api/checkout/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import Stripe from "stripe";

export const runtime = "nodejs"; // Stripe requires the Node runtime

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  // @ts-ignore: exact literal can vary by patchlevel
  apiVersion: "2024-06-20",
});

/* ----------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

function resolveBaseUrl(req: Request): string {
  const envBase =
    process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  const origin = req.headers.get("origin");
  if (origin) return origin.replace(/\/$/, "");
  return "http://localhost:3000";
}

/** If `raw` is relative (e.g. "/api/book?..."), prefix with `base`. */
function absolutizeMaybe(
  raw: string | undefined | null,
  base: string
): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s; // already absolute
  if (s.startsWith("/")) return `${base}${s}`; // relative path
  return undefined; // anything else = invalid for Stripe
}

function cleanTitle(s: unknown): string {
  const str = (typeof s === "string" ? s : "CreatorNet Video").trim();
  return str.slice(0, 120) || "CreatorNet Video";
}

/* ----------------------------------------------------------------------------
 * Route
 * --------------------------------------------------------------------------*/

export async function POST(req: Request) {
  try {
    // --- Supabase SSR auth (cookie adapter that can read/write) ---
    const store = await cookies();
    const cookieAdapter: any = {
      get: (n: string) => store.get(n)?.value,
      set: (n: string, v: string, o?: any) => store.set(n, v, o as any),
      remove: (n: string, o?: any) =>
        store.set(n, "", { ...(o || {}), maxAge: 0 }),
    };

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: cookieAdapter }
    );

    const { data: auth } = await supabase.auth.getUser();
    const user = auth?.user;
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // --- Parse body ---
    const body = (await req.json().catch(() => ({}))) as any;

    const type = body?.type as "purchase" | "booking" | undefined;
    const postId: string | null =
      typeof body?.postId === "string" && body.postId.trim()
        ? body.postId.trim()
        : null;

    if (!type || !postId) {
      return NextResponse.json(
        { error: "type and postId are required" },
        { status: 400 }
      );
    }

    const baseUrl = resolveBaseUrl(req);

    /* ----------------------------------------------------------------------
     * PURCHASE (paid)
     * --------------------------------------------------------------------*/
    if (type === "purchase") {
      const amountRaw = Number(body?.amountCents);
      const amountCents =
        Number.isInteger(amountRaw) && amountRaw >= 50 && amountRaw <= 1_000_000
          ? amountRaw
          : 2900; // sensible default

      const title = cleanTitle(body?.title);
      const creatorId: string | undefined =
        typeof body?.creatorId === "string" && body.creatorId
          ? body.creatorId
          : undefined;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: title },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        customer_email: user.email || undefined,
        metadata: {
          buyer_id: user.id,
          post_id: postId,
          creator_id: creatorId || "",
          flow: "purchase",
        },
        success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}&post_id=${encodeURIComponent(
          postId
        )}`,
        cancel_url: `${baseUrl}/watch/${encodeURIComponent(postId)}`,
      });

      // Stripe should always return a URL for Checkout; still guard just in case.
      if (!session?.url) {
        return NextResponse.json(
          { error: "Stripe did not return a checkout URL." },
          { status: 502 }
        );
      }

      return NextResponse.json({ url: session.url, id: session.id });
    }

    /* ----------------------------------------------------------------------
     * BOOKING (free; setup mode)
     * --------------------------------------------------------------------*/
    if (type === "booking") {
      const creatorId: string | undefined =
        typeof body?.creatorId === "string" && body.creatorId
          ? body.creatorId
          : undefined;

      // Client may pass a relative "/api/book?..."; make absolute for Stripe.
      const provided =
        typeof body?.bookingRedirectUrl === "string"
          ? body.bookingRedirectUrl
          : "";

      const absoluteRedirect =
        absolutizeMaybe(provided, baseUrl) ||
        `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}&post_id=${encodeURIComponent(
          postId
        )}&flow=booking`;

      const session = await stripe.checkout.sessions.create({
        mode: "setup",
        payment_method_types: ["card"],
        customer_email: user.email || undefined,
        metadata: {
          buyer_id: user.id,
          post_id: postId,
          creator_id: creatorId || "",
          flow: "booking",
          booking_redirect_url: absoluteRedirect,
        },
        success_url: absoluteRedirect,
        cancel_url: `${baseUrl}/watch/${encodeURIComponent(postId)}`,
      });

      if (!session?.url) {
        return NextResponse.json(
          { error: "Stripe did not return a checkout URL." },
          { status: 502 }
        );
      }

      return NextResponse.json({ url: session.url, id: session.id });
    }

    return NextResponse.json({ error: "Unsupported checkout type" }, { status: 400 });
  } catch (err: any) {
    // Surface Stripe 4xx errors transparently; everything else => 500
    console.error("[checkout] error:", {
      message: err?.message,
      type: err?.type,
      code: err?.code,
      statusCode: err?.statusCode,
    });

    if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return NextResponse.json(
        { error: err.message || "Invalid Stripe request" },
        { status: err.statusCode }
      );
    }

    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}

/** Optional: 405 for other methods to make failures clearer in dev. */
export async function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405 });
}
