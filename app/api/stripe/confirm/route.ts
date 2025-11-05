import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// ✅ Initialize Stripe (with correct API version + type fix)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20" as any, // Fixes TS version type issue
});

export async function POST(req: Request) {
  try {
    const { session_id } = await req.json();

    if (!session_id) {
      return NextResponse.json(
        { success: false, error: "Missing session_id" },
        { status: 400 }
      );
    }

    // ✅ Retrieve the Stripe checkout session
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (!session) {
      console.error("❌ Invalid Stripe session ID");
      return NextResponse.json(
        { success: false, error: "Invalid Stripe session" },
        { status: 400 }
      );
    }

    if (session.payment_status !== "paid") {
      console.warn("⚠️ Payment not marked as paid:", session.payment_status);
      return NextResponse.json(
        { success: false, error: "Payment not completed" },
        { status: 400 }
      );
    }

    // ✅ Create Supabase client with SERVICE ROLE key (bypasses RLS)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Extract metadata
    const buyer_id = session.metadata?.buyer_id;
    const post_id = session.metadata?.post_id;

    if (!buyer_id || !post_id) {
      console.error("⚠️ Missing metadata in Stripe session:", session.metadata);
      return NextResponse.json(
        { success: false, error: "Missing buyer_id or post_id metadata" },
        { status: 400 }
      );
    }

    // ✅ Insert or update the purchase record (safe against duplicates)
    const { error: insertErr } = await supabase
      .from("purchases")
      .upsert(
        {
          buyer_id,
          post_id,
          session_id: session.id,
          amount_cents: session.amount_total ?? 0,
          status: "paid",
        },
        { onConflict: "buyer_id,post_id" }
      );

    if (insertErr) {
      console.error("❌ Supabase insert error:", insertErr);
      return NextResponse.json(
        {
          success: false,
          error:
            insertErr.message || "Failed to record purchase (Supabase error)",
        },
        { status: 500 }
      );
    }

    console.log(`✅ Purchase recorded for buyer ${buyer_id} and post ${post_id}`);

    return NextResponse.json({
      success: true,
      session,
    });
  } catch (err) {
    console.error("🔥 Unexpected error confirming payment:", err);
    return NextResponse.json(
      { success: false, error: "Unexpected error confirming payment" },
      { status: 500 }
    );
  }
}
