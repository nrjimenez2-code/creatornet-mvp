import "server-only";
import type Stripe from "stripe";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { discoverEnabled, recordDiscoverEvent } from "@/lib/discoverServer";
import { getSiteUrl } from "@/lib/siteUrl";
export async function recordBookingSetup(
  session: Stripe.Checkout.Session,
): Promise<string | null> {
  if (!discoverEnabled()) return null;
  if (
    session.mode !== "setup" ||
    session.status !== "complete" ||
    session.metadata?.kind !== "booking"
  )
    return null;
  const userId = session.metadata.buyer_user_id ?? session.metadata.buyer_id;
  const postId = session.metadata.post_id,
    creatorId = session.metadata.creator_id;
  if (!userId || !postId || !creatorId)
    throw new Error("Missing booking attribution");
  const { data: post, error: postError } = await admin
    .from("posts")
    .select("creator_id")
    .eq("id", postId)
    .single();
  if (postError || post?.creator_id !== creatorId)
    throw new Error("Booking source mismatch");
  const { error } = await admin
    .from("discover_booking_attribution_v1")
    .upsert(
      {
        setup_session_id: session.id,
        user_id: userId,
        creator_id: creatorId,
        post_id: postId,
      },
      { onConflict: "setup_session_id", ignoreDuplicates: true },
    );
  if (error) throw error;
  const { data, error: readError } = await admin
    .from("discover_booking_attribution_v1")
    .select("id")
    .eq("setup_session_id", session.id)
    .single();
  if (readError) throw readError;
  await recordDiscoverEvent({
    actor: "user:" + userId,
    userId,
    postId,
    kind: "booking_setup_complete",
    entityKey: session.id,
  });
  return data.id;
}
export function attributedBookingUrl(
  raw: string,
  attributionId: string | null,
): string {
  if (!attributionId) return raw;
  const origin = new URL(getSiteUrl()).origin;
  const url = new URL(raw, origin);
  if (url.hostname === "calendly.com" || url.hostname.endsWith(".calendly.com"))
    url.searchParams.set("utm_content", "cn_" + attributionId);
  if (url.hostname === "cal.com" || url.hostname.endsWith(".cal.com"))
    url.searchParams.set("metadata[cn_attribution]", attributionId);
  if (url.origin === origin && url.pathname === "/api/book")
    url.searchParams.set("cn_attribution", attributionId);
  return url.toString();
}
