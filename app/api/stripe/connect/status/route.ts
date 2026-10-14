import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripeClient";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { allowRequest, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe calls are capped at 20s with 2 retries (lib/stripeClient.ts); without
// maxDuration Vercel's 10s plan default can kill the function mid-call. 60s
// covers the worst legitimate case and is allowed on every Vercel plan.
export const maxDuration = 60;

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

  // Deliberately very generous. PostComposer reads this without checking res.ok,
  // so a 429 body makes ready=false and tells a creator who IS connected to
  // "connect Stripe", with no error and no retry path. The banner also remounts
  // on every 1024px viewport crossing, which fires extra calls nobody counts.
  if (!allowRequest(`connect-status:${user.id}`, { limit: 240, windowMs: 60_000 })) return tooManyRequests();

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
      tipping_enabled: process.env.CREATOR_TIPPING_ENABLED === "true",
      connected: false,
      charges_enabled: false,
      payouts_enabled: false,
      onboarding_complete: false,
    });
  }

  // A stored true flag can be stale after restrictions or a failed webhook sync.
  // Always observe Stripe; never infer current capability from completed onboarding.
  try {
    const account = await getStripe().accounts.retrieve(profile.stripe_account_id);
    const isComplete = !!(account.charges_enabled && account.payouts_enabled);

    // Write every flag together so the two "complete" columns and the
    // two capability columns never disagree (see supabase/schema/007).
    const { data: saved, error: saveError } = await db
      .from("profiles")
      .update({
        stripe_onboarding_complete: isComplete,
        onboarding_complete: isComplete,
        charges_enabled: !!account.charges_enabled,
        payouts_enabled: !!account.payouts_enabled,
      })
      .eq("id", user.id)
      .eq("stripe_account_id", account.id)
      .select("id");
    if (saveError || !saved?.length) throw new Error("Could not persist current Stripe capabilities");

    return NextResponse.json({
      tipping_enabled: process.env.CREATOR_TIPPING_ENABLED === "true",
      connected: true,
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      onboarding_complete: isComplete,
      stripe_account_id: profile.stripe_account_id,
    });
  } catch (e: unknown) {
    console.error("[connect/status] sync error:", (e as Error)?.message);
    return NextResponse.json({
      tipping_enabled: process.env.CREATOR_TIPPING_ENABLED === "true",
      connected: true,
      charges_enabled: false,
      payouts_enabled: false,
      onboarding_complete: false,
      stripe_account_id: profile.stripe_account_id,
    }, { status: 503 });
  }
}
