// /lib/stripe.ts
import Stripe from 'stripe';

// Cast the apiVersion to `any` so TS doesn't force a specific union like "2025-10-29.clover"
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: '2024-06-20' as any,
});
