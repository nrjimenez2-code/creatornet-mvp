// lib/stripeClient.ts — Stripe client built on first use, not at import.
//
// `new Stripe(undefined)` throws. Several routes constructed the client at
// module scope, so any build environment without STRIPE_SECRET_KEY (Vercel
// Preview, where only Production has the key) failed at "Collecting page
// data" before a single request was served. Constructing lazily moves that
// failure to the request that actually needs Stripe, with a clear message.

import Stripe from "stripe";

let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set in this environment.");
  }
  client = new Stripe(key, { apiVersion: undefined });
  return client;
}
