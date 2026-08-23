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
      const account = await getStripe().accounts.create({
        type: "express",
        email: user.email ?? undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      stripeAccountId = account.id;

      const { data: updatedRows, error: saveErr } = await db
        .from("profiles")
        .update({ stripe_account_id: stripeAccountId, stripe_onboarding_complete: false })
        .eq("id", user.id)
        .select("id");

      if (saveErr) {
        console.error("[connect/onboard] save account id error:", saveErr.message);
        return NextResponse.json({ error: "Failed to save Stripe account" }, { status: 500 });
      }

      if (!updatedRows?.length) {
        const { error: insErr } = await db.from("profiles").insert({
          id: user.id,
          stripe_account_id: stripeAccountId,
          stripe_onboarding_complete: false,
        });
        if (insErr) {
          console.error("[connect/onboard] insert profile for stripe failed:", insErr.message);
          return NextResponse.json(
            {
              error:
                "Stripe account was created but could not be linked to your profile. Add a profile row for your user or run onboarding in the app first.",
            },
            { status: 500 }
          );
        }
      }
    } catch (e: unknown) {
      console.error("[connect/onboard] accounts.create:", e);
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
          { error: e.message || "Stripe could not create a connected account." },
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
        { error: e.message || "Could not start onboarding link." },
        { status: 502 }
      );
    }
    return NextResponse.json({ error: "Could not start onboarding." }, { status: 500 });
  }
}
