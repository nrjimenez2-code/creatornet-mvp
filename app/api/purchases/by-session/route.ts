// app/api/purchases/by-session/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabaseServer";

const SUPABASE_URL: string =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "";
const SERVICE_KEY: string = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

  // Session ids show up in success URLs and browser history. Fulfillment
  // links (Discord invites, Whop listings, file URLs) are what the buyer
  // paid for, so only the buyer gets them.
  const auth = createServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Look up purchase by session
  const { data: purchase, error: purchaseErr } = await admin
    .from("purchases")
    .select("id, status, product_id, buyer_id, buyer_user_id")
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

  // Fail closed: a purchase row with no recorded buyer is not "anyone's",
  // it is nobody's until the webhook fills it in.
  const owner = purchase.buyer_user_id ?? purchase.buyer_id ?? null;
  if (!owner || owner !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // checkout writes a "pending" row the moment a session is created, before
  // any money moves. Fulfillment links are for paid purchases only.
  if (purchase.status !== "paid") {
    return NextResponse.json({ error: "Not paid", status: purchase.status }, { status: 402 });
  }

  // Resolve the product
  const { data: product, error: productErr } = await admin
    .from("products")
    .select("fulfillment, discord_channel_id, whop_listing_id, external_url")
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
