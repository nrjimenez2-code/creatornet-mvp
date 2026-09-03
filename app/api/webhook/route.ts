// Backward-compatible alias for CreatorNet's canonical Stripe webhook.
//
// Older environments may still point Stripe at /api/webhook. Keeping a second
// implementation here caused the same payment event to follow different
// fulfillment, fee, refund, and idempotency rules depending on which URL was
// configured. Both URLs now execute the single audited handler and therefore
// share the same `stripe:${event.id}` database claim.
import type { NextRequest } from "next/server";
import { POST as handleStripeWebhook } from "@/app/api/stripe/webhook/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return handleStripeWebhook(req);
}
