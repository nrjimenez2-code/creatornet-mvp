import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStripe } from "@/lib/stripeClient";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { allowRequest } from "@/lib/rateLimit";
import { tippingEnabled } from "@/lib/tips";
import { expireOpenTipSessions } from "@/lib/tipCheckout";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  if (!tippingEnabled()) return NextResponse.json({ error: "Tipping is not available yet." }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (!allowRequest(`post-tips:${user.id}`, { limit: 20, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Please wait a moment and try again." }, { status: 429 });
  }
  const { postId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const enabled = (body as { enabled?: unknown })?.enabled;
  if (typeof enabled !== "boolean") return NextResponse.json({ error: "Enabled must be true or false." }, { status: 400 });
  const { data: post, error } = await supabaseAdmin.from("posts").select(
    "id,video_url,creator_id,product_id,offering_id,premium_path,price_cents,allow_booking,booking_url,cta_type,fulfillment_url,display_price,booking_url_override,active,hidden_at,removed_at",
  ).eq("id", postId).eq("creator_id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: "Video could not be loaded." }, { status: 500 });
  if (!post || post.removed_at) return NextResponse.json({ error: "Video not found." }, { status: 404 });

  if (enabled) {
    if (typeof post.video_url !== "string" || !post.video_url.trim()) {
      return NextResponse.json({ error: "Only videos can receive tips." }, { status: 409 });
    }
    if (post.active === false || post.hidden_at) {
      return NextResponse.json({ error: "Only visible videos can receive tips." }, { status: 409 });
    }
    const monetized = Boolean(post.product_id || post.offering_id || post.premium_path || Number(post.price_cents || 0) !== 0 ||
      post.allow_booking || post.booking_url || (post.cta_type && post.cta_type !== "none") || post.fulfillment_url ||
      post.display_price || post.booking_url_override);
    if (monetized) return NextResponse.json({ error: "Tips can only be enabled on a completely free video." }, { status: 409 });
    const profile = await supabaseAdmin.from("profiles")
      .select("banned_at,stripe_account_id,stripe_onboarding_complete").eq("id", user.id).maybeSingle();
    const accountId = profile.data?.stripe_account_id;
    if (profile.error || profile.data?.banned_at || !profile.data?.stripe_onboarding_complete ||
        typeof accountId !== "string" || !/^acct_[A-Za-z0-9]+$/.test(accountId)) {
      return NextResponse.json({ error: "Connect Stripe before enabling tips.", code: "CONNECT_UNAVAILABLE" }, { status: 409 });
    }
    const account = await getStripe().accounts.retrieve(accountId);
    if (!account.charges_enabled || !account.payouts_enabled) {
      return NextResponse.json({ error: "Your Stripe account cannot receive tips right now.", code: "CONNECT_UNAVAILABLE" }, { status: 409 });
    }
  }

  const updated = await supabaseAdmin.from("posts").update({ tips_enabled: enabled })
    .eq("id", postId).eq("creator_id", user.id).select("id,tips_enabled").maybeSingle();
  if (updated.error || !updated.data) return NextResponse.json({ error: "Tip setting could not be updated." }, { status: 500 });

  if (!enabled) {
    try { await expireOpenTipSessions(supabaseAdmin, { postId }); }
    catch (expiryError) { console.error("[tips:toggle] open Session expiry failed:", { postId, expiryError }); }
  }
  return NextResponse.json({ postId, tipsEnabled: enabled });
}
