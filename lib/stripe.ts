// /lib/stripe.ts
//
// Kept for the two routes that import `{ stripe }` from here. The client is
// now created on first use (see lib/stripeClient.ts) instead of at import,
// so a build environment without STRIPE_SECRET_KEY no longer crashes at
// "Collecting page data". The Proxy keeps `stripe.checkout.sessions...`
// call sites working unchanged.
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";

export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const real = getStripe() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});
