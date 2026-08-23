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
    console.error("[connect/return] no stripe_account_id on profile", {
      userId: user.id,
      profileErr: profileErr?.message,
    });
    return NextResponse.redirect(`${SITE_URL}/dashboard?connect=error`);
  }

  try {
    const account = await getStripe().accounts.retrieve(profile.stripe_account_id);
    const isComplete = !!(account.charges_enabled && account.payouts_enabled);

    await db
      .from("profiles")
      .update({
        stripe_onboarding_complete: isComplete,
        charges_enabled: !!account.charges_enabled,
        payouts_enabled: !!account.payouts_enabled,
        onboarding_complete: isComplete,
      })
      .eq("id", user.id);

    const status = isComplete ? "success" : "pending";
    return NextResponse.redirect(`${SITE_URL}/dashboard?connect=${status}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[connect/return] getStripe().accounts.retrieve error:", msg, {
      userId: user.id,
      stripe_account_id: profile.stripe_account_id,
    });
    return NextResponse.redirect(`${SITE_URL}/dashboard?connect=error`);
  }
}
