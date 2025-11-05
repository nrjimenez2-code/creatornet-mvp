// app/api/checkout/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import Stripe from "stripe";

// Stripe must run on the Node runtime (not edge)
export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  // @ts-ignore – exact literal may differ by minor version
  apiVersion: "2024-06-20",
});

function resolveBaseUrl(req: Request): string {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  const origin = req.headers.get("origin");
  if (origin) return origin.replace(/\/$/, "");
  return "http://localhost:3000";
}

function cleanTitle(s: unknown): string {
  const str = (typeof s === "string" ? s : "CreatorNet Video").trim();
  return str.slice(0, 120) || "CreatorNet Video";
}

export async function POST(req: Request) {
  try {
    // ✅ FIX: await cookies()
    const store = await cookies();

    // Supabase SSR cookie adapter
    const cookieAdapter: any = {
      get: (n: string) => store.get(n)?.value,
      set: (n: string, v: string, o?: any) => store.set(n, v, o as any),
      remove: (n: string, o?: any) => store.set(n, "", { ...(o || {}), maxAge: 0 }),
    };

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: cookieAdapter }
    );

    // auth
    const { data: auth } = await supabase.auth.getUser();
    const user = auth?.user;
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // body + validation
    const body = await req.json().catch(() => ({} as any));
    const postId =
      typeof body?.postId === "string" && body.postId.trim() ? body.postId.trim() : null;
    const amountRaw = Number.isFinite(body?.amountCents) ? Number(body.amountCents) : NaN;
    const amountCents =
      Number.isInteger(amountRaw) && amountRaw >= 50 && amountRaw <= 1_000_000
        ? amountRaw
        : 2900; // default $29
    const title = cleanTitle(body?.title);

    if (!postId) {
      return NextResponse.json({ error: "postId is required" }, { status: 400 });
    }

    const baseUrl = resolveBaseUrl(req);
    const success_url = `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}&post_id=${encodeURIComponent(
      postId
    )}`;
    const cancel_url = `${baseUrl}/watch/${encodeURIComponent(postId)}`;

    // create checkout session
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
      },
      success_url,
      cancel_url,
    });

    return NextResponse.json({ url: session.url, id: session.id });
  } catch (err: any) {
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
