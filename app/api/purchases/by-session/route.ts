// app/api/purchases/by-session/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL: string =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  (process.env as any).NEXT_PUBLIC_SUPABASE_UR;
const SERVICE_KEY: string | undefined = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) environment variable.");
}
if (!SERVICE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const session_id = searchParams.get("session_id");

  if (!session_id) {
    return NextResponse.json(
      { error: "Missing session_id" },
      { status: 400 }
    );
  }

  // Look up purchase by session
  const { data: purchase, error: purchaseErr } = await admin
    .from("purchases")
    .select("*")
    .eq("session_id", session_id)
    .maybeSingle();

  if (purchaseErr) {
    return NextResponse.json(
      { error: purchaseErr.message },
      { status: 500 }
    );
  }

  if (!purchase) {
    return NextResponse.json(
      { error: "Purchase not found yet" },
      { status: 404 }
    );
  }

  // Resolve the product
  const { data: product, error: productErr } = await admin
    .from("products")
    .select("*")
    .eq("product_id", purchase.product_id)
    .maybeSingle();

  if (productErr) {
    return NextResponse.json(
      { error: productErr.message },
      { status: 500 }
    );
  }

  // Choose correct fulfillment
  let fulfillment_url: string | null = null;

  if (product) {
    if (product.fulfillment === "DISCORD") {
      fulfillment_url = product.discord_channel_id || null;
    }

    if (product.fulfillment === "WHOP") {
      fulfillment_url = product.whop_listing_id || null;
    }

    if (product.fulfillment === "FILE") {
      fulfillment_url = product.external_url || null;
    }
  }

  return NextResponse.json({
    fulfillment_url,
    status: purchase.status,
  });
}

export function POST() {
  return NextResponse.json(
    { error: "Method not allowed" },
    { status: 405 }
  );
}
