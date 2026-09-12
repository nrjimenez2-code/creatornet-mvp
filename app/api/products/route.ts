// app/api/products/route.ts
import { publicMessage } from "@/lib/apiError";
import { NextResponse } from "next/server";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { createSupabaseServer } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { stripe } from "@/lib/stripe";
import { paidCallsReady, validPaidCallTarget } from "@/lib/paidCalls";
import { isCreatorSellReady } from "@/lib/creatorStripeConnect";
import { fixedServiceSchemaReady, fixedServiceOffersReady, readFixedServiceOfferMonths } from "@/lib/fixedServiceOffers";
import { readMonthlyMentorshipTerms, membershipCommitment, type MonthlyMentorshipTerms } from "@/lib/membershipTerms";
const membershipSchemaReady = () => process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY === "true";
const membershipOffersReady = () => membershipSchemaReady() && process.env.CREATOR_MONTHLY_MENTORSHIPS_READY === "true";
function dollarsToCents(d: unknown): number | null {
  const s = String(d ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.round(n * 100));
}

type Fulfillment = "FILE" | "DISCORD" | "WHOP";
type ProductType = "video" | "course" | "mentorship" | "call";

type ProductRow = {
  id: string;
  creator_id: string;
  title: string;
  description: string | null;
  type: ProductType;
  price_cents: number | null;
  plan_months: number;
  membership_terms?: MonthlyMentorshipTerms | null;
  fixed_service_months?: number | null;
  stripe_price_id: string | null;
  fulfillment: Fulfillment;
  discord_channel_id: string | null;
  whop_listing_id: string | null;
  external_url: string | null;
  active: boolean | null;
  created_at: string;
};

// ---------------- GET ----------------
export const runtime = "nodejs";
// POST creates a Stripe product then a price — two sequential calls on the
// shared 20s-timeout/2-retry client (lib/stripeClient.ts). Without maxDuration
// Vercel's 10s plan default can kill the function between them.
export const maxDuration = 60;

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
      ...(membershipSchemaReady() ? ["membership_terms"] : []),
      ...(fixedServiceSchemaReady() ? ["fixed_service_months"] : []),
    ].join(", ");

    const { data, error } = await supabase
      .from("products")
      .select(sel)
      .eq("creator_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ success: false, error: publicMessage("products", error, "Could not load products.") }, { status: 400 });
    }

    // Ensure each item has `id` (alias product_id:id may not apply in all Supabase versions)
    const raw = (data ?? []) as unknown as (ProductRow & { product_id?: string })[];
    const items = raw.map((row) => ({
      ...row,
      id: row.id ?? row.product_id,
    }));
    return NextResponse.json({ success: true, items, capabilities: { monthlyMemberships: membershipOffersReady(), paidCalls: paidCallsReady(), fixedServiceDuration: fixedServiceOffersReady() } });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: publicMessage("products", e, "Server error") }, { status: 500 });
  }
}

// ---------------- POST ----------------
// Creating a product is a deliberate, infrequent act; 20/min is far above
// honest use and well below what a script would want.
const PRODUCT_RATE = { limit: 20, windowMs: 60_000 };

export async function POST(req: Request) {
  if (!allowRequest(clientKey(req), PRODUCT_RATE)) {
    return tooManyRequests();
  }


  try {
    const supabase = await createSupabaseServer();

    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    if (!(await isCreatorSellReady(user.id))) {
      return NextResponse.json(
        {
          success: false,
          error: "Connect Stripe in the dashboard before creating products.",
          code: "STRIPE_CONNECT_REQUIRED",
        },
        { status: 403 }
      );
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
    let membershipTerms: MonthlyMentorshipTerms | null;
    try {
      membershipTerms = readMonthlyMentorshipTerms(body?.membership_terms, type);
      if (membershipTerms) {
        if (!membershipOffersReady()) return NextResponse.json({ success: false, error: "Monthly mentorships are not enabled yet." }, { status: 409 });
        membershipCommitment(price_cents as number, membershipTerms);
        if (stripe_price_id || plan_months !== 1) throw Error("Use monthly service terms, not an existing price or installment plan.");
      }
    } catch {
      return NextResponse.json({ success: false, error: "Choose valid monthly mentorship terms and a monthly USD price." }, { status: 400 });
    }

    let fixedServiceMonths: number | null;
    try {
      fixedServiceMonths = readFixedServiceOfferMonths(body?.fixed_service_months, type, !!membershipTerms);
      if (fixedServiceMonths !== null && (!Number.isSafeInteger(price_cents) || (price_cents ?? 0) < 50 ||
        (price_cents ?? 0) > 99999999 || !Number.isSafeInteger(plan_months) || plan_months < 1 || plan_months > 24)) {
        throw Error("Invalid fixed purchase price or payment count.");
      }
    } catch {
      return NextResponse.json({ success: false, error: "Choose valid fixed-purchase service months, a total USD price, and a separate payment count." }, { status: 400 });
    }
    if (fixedServiceMonths !== null && !fixedServiceOffersReady()) {
      return NextResponse.json({ success: false, error: "Timed fixed-purchase offers are not enabled yet.", code: "FIXED_SERVICE_HELD" }, { status: 409 });
    }

    if (!title) {
      return NextResponse.json({ success: false, error: "Title is required" }, { status: 400 });
    }

    if (!["video", "course", "mentorship", "call"].includes(type)) {
      return NextResponse.json({ success: false, error: "Choose a supported product type." }, { status: 400 });
    }
    if (type === "call") {
      if (!paidCallsReady()) return NextResponse.json({ success: false, error: "Paid calls are not enabled yet." }, { status: 409 });
      const target = typeof body?.scheduling_url === "string" ? body.scheduling_url.trim() : "";
      if (!validPaidCallTarget(target) || !Number.isSafeInteger(price_cents) || (price_cents ?? 0) < 50 ||
        (price_cents ?? 0) > 99999999 || plan_months !== 1 || membershipTerms || stripe_price_id) {
        return NextResponse.json({ success: false, error: "A paid call needs one USD price and a private https scheduling link." }, { status: 400 });
      }
      const { data, error } = await supabaseAdmin.rpc("create_paid_call_product_v1", {
        p_creator_id: user.id, p_title: title, p_description: description,
        p_price_cents: price_cents, p_scheduling_url: target,
      });
      if (error || !data?.id) throw Error("Paid-call product could not be created.");
      return NextResponse.json({ success: true, id: data.id, product: { ...data, product_id: data.id } });
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
    if (!membershipTerms && (type === "course" || type === "mentorship" || type === "video") && !resolvedStripePriceId) {
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
          { success: false, error: publicMessage("products", e, "Failed to create Stripe price") },
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
      ...(membershipSchemaReady() ? { membership_terms: membershipTerms } : {}),
      ...(fixedServiceSchemaReady() ? { fixed_service_months: fixedServiceMonths } : {}),
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
      ...(membershipSchemaReady() ? ["membership_terms"] : []),
      ...(fixedServiceSchemaReady() ? ["fixed_service_months"] : []),
    ].join(", ");

    const insertRes = await supabase.from("products").insert([insertRow]).select(sel).single();

    if (insertRes.error) {
      return NextResponse.json({ success: false, error: publicMessage("products", insertRes.error, "Could not create the product.") }, { status: 400 });
    }
    // Ensure response has both id and product_id so composer/checkout can use it
    const row = insertRes.data as unknown as ProductRow & { product_id?: string };
    const productIdValue = row.product_id ?? row.id;
    const product = { ...row, id: productIdValue, product_id: productIdValue };
    return NextResponse.json({ success: true, id: productIdValue, product });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: publicMessage("products", e, "Server error") }, { status: 500 });
  }
}
