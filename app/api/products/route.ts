// app/api/products/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { stripe } from "@/lib/stripe";
function dollarsToCents(d: unknown): number | null {
  const s = String(d ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.round(n * 100));
}

type Fulfillment = "FILE" | "DISCORD" | "WHOP";
type ProductType = "video" | "course" | "mentorship";

type ProductRow = {
  id: string;
  creator_id: string;
  title: string;
  description: string | null;
  type: ProductType;
  price_cents: number | null;
  plan_months: number;
  stripe_price_id: string | null;
  fulfillment: Fulfillment;
  discord_channel_id: string | null;
  whop_listing_id: string | null;
  external_url: string | null;
  active: boolean | null;
  created_at: string;
};

// ---------------- GET ----------------
export async function GET() {
  try {
    const supabase = await createSupabaseServer();

    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const sel = [
      "product_id:id",
      "title",
      "type",
      "price_cents",
      "plan_months",
      "stripe_price_id",
      "fulfillment",
      "discord_channel_id",
      "whop_listing_id",
      "external_url",
      "active",
      "created_at",
    ].join(", ");

    const { data, error } = await supabase
      .from("products")
      .select(sel)
      .eq("creator_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    // Ensure each item has `id` (alias product_id:id may not apply in all Supabase versions)
    const raw = (data ?? []) as unknown as (ProductRow & { product_id?: string })[];
    const items = raw.map((row) => ({
      ...row,
      id: row.id ?? row.product_id,
    }));
    return NextResponse.json({ success: true, items });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "Server error" }, { status: 500 });
  }
}

// ---------------- POST ----------------
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServer();

    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));

    const title = String(body?.title ?? "").trim();
    const description = (String(body?.description ?? "").trim() || null) as string | null;
    const type: ProductType = (body?.type as ProductType) ?? "video";

    const price_cents: number | null =
      typeof body?.price_cents === "number" ? body.price_cents : dollarsToCents(body?.priceDollars);

    const plan_months = Number(body?.plan_months ?? 1);
    const fulfillment: Fulfillment = (body?.fulfillment as Fulfillment) ?? "FILE";
    const discord_channel_id = (body?.discord_channel_id ?? null) as string | null;
    const whop_listing_id = (body?.whop_listing_id ?? null) as string | null;
    const stripe_price_id = (body?.stripe_price_id ?? null) as string | null;

    if (!title) {
      return NextResponse.json({ success: false, error: "Title is required" }, { status: 400 });
    }

    // Ensure a profile row exists so products.creator_id FK is satisfied (insert only; do not overwrite)
    const fallbackUsername =
      (user.email?.split("@")[0]?.replace(/[^a-zA-Z0-9_-]/g, "_")?.slice(0, 30)) ||
      `user_${user.id.slice(0, 8)}`;
    await supabaseAdmin
      .from("profiles")
      .upsert(
        { id: user.id, username: fallbackUsername },
        { onConflict: "id", ignoreDuplicates: true }
      );

    let resolvedStripePriceId = stripe_price_id;

    // For sellable products without stripe_price_id: create Stripe Product + Price and use that ID
    if ((type === "course" || type === "mentorship" || type === "video") && !resolvedStripePriceId) {
      const cents = price_cents ?? 0;
      if (!Number.isFinite(cents) || cents < 50) {
        return NextResponse.json(
          { success: false, error: "A price of at least $0.50 is required for sellable products" },
          { status: 400 }
        );
      }
      try {
        const stripeProduct = await stripe.products.create({
          name: title,
          description: description ?? undefined,
        });
        const stripePrice = await stripe.prices.create({
          product: stripeProduct.id,
          unit_amount: cents,
          currency: "usd",
        });
        resolvedStripePriceId = stripePrice.id;
      } catch (e: any) {
        return NextResponse.json(
          { success: false, error: e?.message ?? "Failed to create Stripe price" },
          { status: 500 }
        );
      }
    }

    const insertRow = {
      creator_id: user.id,
      title,
      description,
      type,
      price_cents,
      amount_cents: price_cents ?? 0,
      plan_months: Number.isFinite(plan_months) && plan_months > 0 ? plan_months : 1,
      fulfillment,
      discord_channel_id,
      whop_listing_id,
      stripe_price_id: resolvedStripePriceId,
      external_url: null as string | null,
    };

    const sel = [
      "product_id:id",
      "title",
      "type",
      "price_cents",
      "plan_months",
      "stripe_price_id",
      "fulfillment",
      "discord_channel_id",
      "whop_listing_id",
      "external_url",
      "active",
      "created_at",
    ].join(", ");

    const insertRes = await supabase.from("products").insert([insertRow]).select(sel).single();

    if (insertRes.error) {
      return NextResponse.json({ success: false, error: insertRes.error.message }, { status: 400 });
    }
    // Ensure response has both id and product_id so composer/checkout can use it
    const row = insertRes.data as unknown as ProductRow & { product_id?: string };
    const productIdValue = row.product_id ?? row.id;
    const product = { ...row, id: productIdValue, product_id: productIdValue };
    return NextResponse.json({ success: true, id: productIdValue, product });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "Server error" }, { status: 500 });
  }
}
