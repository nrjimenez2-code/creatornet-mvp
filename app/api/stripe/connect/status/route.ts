import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = admin();

  const { data: profile, error: profileErr } = await db
    .from("profiles")
    .select("stripe_account_id, stripe_onboarding_complete")
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr) {
    return NextResponse.json({ error: "Failed to load profile" }, { status: 500 });
  }

  if (!profile?.stripe_account_id) {
    return NextResponse.json({
      connected: false,
      charges_enabled: false,
      payouts_enabled: false,
      onboarding_complete: false,
    });
  }

  if (!profile.stripe_onboarding_complete) {
    try {
      const account = await stripe.accounts.retrieve(profile.stripe_account_id);
      const isComplete = !!(account.charges_enabled && account.payouts_enabled);

      if (isComplete) {
        await db
          .from("profiles")
          .update({ stripe_onboarding_complete: true })
          .eq("id", user.id);
      }

      return NextResponse.json({
        connected: true,
        charges_enabled: !!account.charges_enabled,
        payouts_enabled: !!account.payouts_enabled,
        onboarding_complete: isComplete,
        stripe_account_id: profile.stripe_account_id,
      });
    } catch (e: unknown) {
      console.error("[connect/status] retrieve error:", (e as Error)?.message);
      return NextResponse.json({
        connected: true,
        charges_enabled: false,
        payouts_enabled: false,
        onboarding_complete: false,
        stripe_account_id: profile.stripe_account_id,
      });
    }
  }

  return NextResponse.json({
    connected: true,
    charges_enabled: true,
    payouts_enabled: true,
    onboarding_complete: true,
    stripe_account_id: profile.stripe_account_id,
  });
}
