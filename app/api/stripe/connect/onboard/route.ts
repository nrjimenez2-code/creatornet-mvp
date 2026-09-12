import { NextRequest, NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { getSiteUrl } from "@/lib/siteUrl";
import { ConnectAccountReconciliationError, createOrRecoverConnectAccount } from "@/lib/connectAccountCreation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe calls are capped at 20s with 2 retries (lib/stripeClient.ts); without
// maxDuration Vercel's 10s plan default can kill the function mid-call. 60s
// covers the worst legitimate case and is allowed on every Vercel plan.
export const maxDuration = 60;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// getSiteUrl(), not a local fallback chain. Two of the three Vercel projects
// do not set NEXT_PUBLIC_SITE_URL, and the local chain here ended at
// "http://localhost:3000" — so on those deployments Stripe Connect onboarding
// handed the creator return/refresh URLs pointing at their own machine and
// onboarding could never complete. lib/siteUrl.ts exists for exactly this.
const SITE_URL = getSiteUrl();

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(req: NextRequest) {
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
    console.error("[connect/onboard] profile fetch error:", profileErr.message);
    return NextResponse.json({ error: "Failed to load profile" }, { status: 500 });
  }

  let stripeAccountId = profile?.stripe_account_id ?? "";

  if (!stripeAccountId) {
    try {
      // Establish the profile before a provider side effect. A concurrent insert
      // is harmless; it must never replace another request's linked account.
      if (!profile) {
        const { error } = await db.from("profiles").insert({
          id: user.id, stripe_onboarding_complete: false, onboarding_complete: false,
          charges_enabled: false, payouts_enabled: false,
        });
        if (error && error.code !== "23505") throw Error("Could not create profile for Stripe account");
      }
      const { data: current, error: currentError } = await db.from("profiles")
        .select("stripe_account_id").eq("id", user.id).single();
      if (currentError || !current) throw Error("Could not reload profile for Stripe account");
      stripeAccountId = current.stripe_account_id || await createOrRecoverConnectAccount(db, getStripe(), user);

      if (!current.stripe_account_id) {
        const link = db
          .from("profiles")
          .update({ stripe_account_id: stripeAccountId, stripe_onboarding_complete: false,
            onboarding_complete: false, charges_enabled: false, payouts_enabled: false })
          .eq("id", user.id);
        const { data: updatedRows, error: saveErr } = await (current.stripe_account_id === ""
          ? link.eq("stripe_account_id", "") : link.is("stripe_account_id", null)).select("id");

        if (saveErr) {
          console.error("[connect/onboard] save account id error:", saveErr.message);
          return NextResponse.json({ error: "Failed to save Stripe account" }, { status: 500 });
        }

        if (!updatedRows?.length) {
          const { data: winner, error } = await db.from("profiles")
            .select("stripe_account_id").eq("id", user.id).single();
          if (error || !winner?.stripe_account_id) throw Error("Could not link Stripe account to profile");
          stripeAccountId = winner.stripe_account_id;
        }
      }
    } catch (e: unknown) {
      console.error("[connect/onboard] accounts.create:", e);
      if (e instanceof ConnectAccountReconciliationError) {
        return NextResponse.json({ error: "Your previous Stripe account setup needs support review before it can continue.",
          code: "CONNECT_ACCOUNT_RECONCILIATION_REQUIRED" }, { status: 409 });
      }
      if (e instanceof Stripe.errors.StripeError) {
        const m = e.message.toLowerCase();
        if (m.includes("connect") || m.includes("signed up")) {
          return NextResponse.json(
            {
              error:
                "Stripe Connect is not enabled on this platform. In the Stripe Dashboard, open Connect and complete setup (or use test keys from a Connect-enabled account).",
            },
            { status: 503 }
          );
        }
        return NextResponse.json(
          { error: publicMessage("connect-onboard", e, "Stripe could not create a connected account.") },
          { status: 502 }
        );
      }
      return NextResponse.json({ error: "Unexpected error creating Stripe account." }, { status: 500 });
    }
  }

  try {
    const accountLink = await getStripe().accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${SITE_URL}/api/stripe/connect/refresh`,
      return_url: `${SITE_URL}/api/stripe/connect/return`,
      type: "account_onboarding",
    });
    return NextResponse.json({ url: accountLink.url });
  } catch (e: unknown) {
    console.error("[connect/onboard] accountLinks.create:", e);
    if (e instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: publicMessage("connect-onboard", e, "Could not start onboarding link.") },
        { status: 502 }
      );
    }
    return NextResponse.json({ error: "Could not start onboarding." }, { status: 500 });
  }
}
