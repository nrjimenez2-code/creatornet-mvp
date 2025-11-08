// app/api/webhook/route.ts
import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { createSupabaseServer } from "@/lib/supabaseServer";
import type Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "Missing STRIPE_WEBHOOK_SECRET" },
      { status: 500 }
    );
  }

  // Stripe requires the raw body for signature verification
  const sig = req.headers.get("stripe-signature") ?? "";
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    // Signature / parsing failure
    return NextResponse.json(
      { error: `Invalid Stripe signature: ${err?.message || "unknown"}` },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const sessionId = session.id;

        // Metadata set when you created the Checkout session
        const buyerId = (session.metadata?.buyer_id as string) || null;
        const productId = (session.metadata?.product_id as string) || null;
        const planMonths = Number(session.metadata?.plan_months || 1);

        const supabase = await createSupabaseServer();

        // Resolve deliver URL (URL fulfillment is default; fall back to /library)
        let deliverUrl: string | null = null;
        if (productId) {
          const { data: product } = await supabase
            .from("products")
            .select("deliver_url")
            .eq("id", productId)
            .single();
          deliverUrl = product?.deliver_url ?? null;
        }
        if (!deliverUrl) deliverUrl = "/library";

        // Amount total from Stripe is already in cents
        const amountCents = session.amount_total ?? null;

        // Try updating an existing pending purchase (created during /api/checkout)
        const { data: updated, error: updErr } = await supabase
          .from("purchases")
          .update({
            status: "complete",
            deliver_url: deliverUrl,
            amount_cents: amountCents,
            target_months: planMonths,
          })
          .eq("session_id", sessionId)
          .select("id");

        // If nothing to update, insert a fresh row
        if (updErr || !updated || updated.length === 0) {
          await supabase.from("purchases").insert([
            {
              buyer_id: buyerId,
              product_id: productId,
              session_id: sessionId,
              status: "complete",
              amount_cents: amountCents,
              target_months: planMonths,
              deliver_url: deliverUrl,
            },
          ]);
        }
        break;
      }

      case "checkout.session.async_payment_succeeded": {
        // Optional: treat as completed for async payment methods
        const session = event.data.object as Stripe.Checkout.Session;
        const supabase = await createSupabaseServer();
        await supabase
          .from("purchases")
          .update({ status: "complete" })
          .eq("session_id", session.id);
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const supabase = await createSupabaseServer();
        await supabase
          .from("purchases")
          .update({ status: "expired" })
          .eq("session_id", session.id);
        break;
      }

      default:
        // Ignore other events for now
        break;
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err: any) {
    console.error("[webhook] handler error:", err);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}
