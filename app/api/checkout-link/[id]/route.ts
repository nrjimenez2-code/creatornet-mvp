import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { getStripe } from "@/lib/stripeClient";
import { discoverEnabled, recordDiscoverEvent } from "@/lib/discoverServer";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!/^[a-f0-9-]{36}$/.test(id))
      return NextResponse.json({ error: "Link unavailable" }, { status: 404 });
    const { data: link, error } = await admin
      .from("discover_checkout_links_v1")
      .select("provider_session_id,buyer_id,post_id,destination")
      .eq("id", id)
      .single();
    if (error || !link)
      return NextResponse.json({ error: "Link unavailable" }, { status: 404 });
    const target = new URL(link.destination);
    if (target.origin !== "https://checkout.stripe.com")
      throw new Error("Invalid checkout origin");
    const {
      data: { user },
      error: authError,
    } = await createServerClient().auth.getUser();
    if (authError && authError.name !== "AuthSessionMissingError")
      throw authError;
    // An anonymous recipient or creator preview can still open the original
    // provider link, but cannot award another buyer a ranking signal.
    if (discoverEnabled() && user && user.id === link.buyer_id) {
      const session = await getStripe().checkout.sessions.retrieve(
        link.provider_session_id,
      );
      if (
        session.status === "open" &&
        session.payment_status === "unpaid" &&
        session.url === link.destination
      ) {
        await recordDiscoverEvent({
          actor: "user:" + user.id,
          userId: user.id,
          postId: link.post_id,
          kind: "checkout_start",
          entityKey: session.id,
        });
      }
    }
    const response = NextResponse.redirect(target, 302);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return NextResponse.json(
      { error: "Checkout link unavailable. Please try again." },
      { status: 503 },
    );
  }
}
