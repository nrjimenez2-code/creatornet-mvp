import "server-only";
import { getSiteUrl } from "@/lib/siteUrl";

// The creator publishes a link; only the buyer opening the verified provider
// session records checkout_start. Stored provider URLs remain unchanged.
export async function withBuyerCheckoutLink<T extends Record<string, unknown>>(
  body: T,
  booking: { buyer_id: string; creator_id: string; post_id: string },
): Promise<T> {
  if (
    process.env.DISCOVER_V4_ENABLED !== "true" ||
    typeof body.url !== "string"
  )
    return body;
  const { supabaseAdmin: admin } = await import("@/lib/supabaseAdmin");
  const payment = body.payment as Record<string, unknown> | undefined;
  const session = payment?.stripe_checkout_session_id;
  if (typeof session !== "string" || !session.startsWith("cs_")) return body;
  const destination = new URL(body.url);
  if (destination.origin !== "https://checkout.stripe.com") return body;
  const { error } = await admin.from("discover_checkout_links_v1").upsert(
    {
      provider_session_id: session,
      buyer_id: booking.buyer_id,
      creator_id: booking.creator_id,
      post_id: booking.post_id,
      destination: destination.toString(),
    },
    { onConflict: "provider_session_id", ignoreDuplicates: true },
  );
  if (error) throw error;
  const { data: link, error: readError } = await admin
    .from("discover_checkout_links_v1")
    .select("id")
    .eq("provider_session_id", session)
    .eq("buyer_id", booking.buyer_id)
    .eq("creator_id", booking.creator_id)
    .single();
  if (readError) throw readError;
  const url = new URL("/api/checkout-link/" + link.id, getSiteUrl()).toString();
  return { ...body, url, payment: { ...payment, buyer_checkout_url: url } };
}
