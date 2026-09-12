import "server-only";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { purchasePoliciesActive } from "./purchasePolicies";
import type { MembershipPaymentContext } from "./membershipAgreement";

export function membershipCheckoutReady(env: Record<string, string | undefined> = process.env) {
  return purchasePoliciesActive(env) && ["CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_OPERATIONS_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_CHECKOUT_READY", "CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_COLLECTION_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_RENEWALS_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_WORKER_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_WORKER_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_EXIT_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_EXIT_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_MANAGEMENT_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_MANAGEMENT_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_CHECKOUT_RECOVERY_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_CHECKOUT_RECOVERY_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_INITIAL_ABANDONMENT_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_INITIAL_ABANDONMENT_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_ACTIVATION_RECOVERY_SCHEMA_READY"].every(key => env[key] === "true");
}
export function membershipServerContext(env: Record<string, string | undefined> = process.env): MembershipPaymentContext {
  try {
    const c = JSON.parse(env.CREATOR_MONTHLY_MENTORSHIPS_CONTEXT || "") as MembershipPaymentContext;
    if (!c || Object.keys(c).sort().join(",") !== "apiVersion,mode,siteOrigin,stripeAccountId,supabaseProjectRef" ||
        !/^acct_[A-Za-z0-9]+$/.test(c.stripeAccountId) || c.apiVersion !== "2025-10-29.clover" ||
        env.NEXT_PUBLIC_SUPABASE_URL !== `https://${c.supabaseProjectRef}.supabase.co` || env.NEXT_PUBLIC_SITE_URL !== c.siteOrigin ||
        (env.SUPABASE_URL && env.SUPABASE_URL !== env.NEXT_PUBLIC_SUPABASE_URL) || !env.SUPABASE_SERVICE_ROLE_KEY ||
        !(new RegExp(`^(sk|rk)_${c.mode}_[A-Za-z0-9]+$`)).test(env.STRIPE_SECRET_KEY || "") ||
        !(new RegExp(`^pk_${c.mode}_[A-Za-z0-9]+$`)).test(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "")) throw Error();
    const site = new URL(c.siteOrigin);
    if (site.origin !== c.siteOrigin || site.protocol !== "https:") throw Error();
    if (env.VERCEL_ENV === "preview") {
      if (c.mode !== "test" || c.supabaseProjectRef !== "nwqfofezfzljhxolkycz" || !site.hostname.endsWith(".vercel.app")) throw Error();
    } else if (env.VERCEL_ENV === "production") {
      if (c.mode !== "live" || c.supabaseProjectRef !== "rvkqxgghqitkwzdsuclz" || c.siteOrigin !== "https://www.creatornet.net") throw Error();
    } else throw Error();
    return Object.freeze({ ...c });
  } catch { throw Error("Monthly membership server context requires approval and matching configuration"); }
}
export function membershipServerClients(env: Record<string, string | undefined> = process.env) {
  const context = membershipServerContext(env);
  return { context, stripe: new Stripe(env.STRIPE_SECRET_KEY!, { apiVersion: "2025-10-29.clover", timeout: 10000, maxNetworkRetries: 0 }),
    admin: createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } }) };
}
