import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_BASE_URL ||
  "http://localhost:3000";

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.redirect(`${SITE_URL}/auth`);
  }

  const db = admin();

  const { data: profile, error: profileErr } = await db
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr || !profile?.stripe_account_id) {
    return NextResponse.redirect(`${SITE_URL}/dashboard?connect=restart`);
  }

  try {
    const accountLink = await getStripe().accountLinks.create({
      account: profile.stripe_account_id,
      refresh_url: `${SITE_URL}/api/stripe/connect/refresh`,
      return_url: `${SITE_URL}/api/stripe/connect/return`,
      type: "account_onboarding",
    });
    return NextResponse.redirect(accountLink.url);
  } catch (e: unknown) {
    console.error("[connect/refresh] accountLinks.create error:", (e as Error)?.message);
    return NextResponse.redirect(`${SITE_URL}/dashboard?connect=error`);
  }
}
