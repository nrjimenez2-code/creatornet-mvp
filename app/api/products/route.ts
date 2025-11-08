// app/api/products/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabaseServer";

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
      "id",
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

    // Cast only after confirming no error
    const items = (data ?? []) as unknown as ProductRow[];
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

    // Require a Stripe price for sellable products
    if ((type === "course" || type === "mentorship" || type === "video") && !stripe_price_id) {
      return NextResponse.json(
        { success: false, error: "stripe_price_id is required for sellable products" },
        { status: 400 }
      );
    }

    const insertRow = {
      creator_id: user.id,
      title,
      description,
      type,
      price_cents,
      plan_months: Number.isFinite(plan_months) && plan_months > 0 ? plan_months : 1,
      fulfillment,
      discord_channel_id,
      whop_listing_id,
      stripe_price_id,
      external_url: null as string | null,
    };

    const sel = [
      "id",
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

    // Cast only after confirming no error
    const product = insertRes.data as unknown as ProductRow;
    return NextResponse.json({ success: true, id: product.id, product });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "Server error" }, { status: 500 });
  }
}
