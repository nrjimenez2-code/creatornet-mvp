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
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set in this environment.");
  }
  // Vercel Preview is the payment acceptance sandbox. Refuse a live or
  // unrecognized key before any Stripe request, even if configuration drifts.
  // Production keeps its existing key handling unchanged.
  if (
    process.env.VERCEL_ENV === "preview" &&
    !/^(?:sk|rk)_test_/.test(key)
  ) {
    throw new Error("Stripe Preview deployments require a test-mode key.");
  }
  if (client) return client;
  client = new Stripe(key, {
    apiVersion: undefined,
    // Cap each Stripe request at 20s (the SDK default is 80s). Without this a
    // hung Stripe call holds a serverless slot for over a minute — the exact
    // "servers hit their ceiling" failure mode under launch traffic. The SDK
    // retries transient network/5xx errors on its own up to maxNetworkRetries.
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
  return client;
}
