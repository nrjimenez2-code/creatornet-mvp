import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { schedulingConfig, schedulingOrigin, googleCalendarConfig } from "@/lib/schedulingConfig";
import { schedulingAuthorizationUrl } from "@/lib/schedulingProvider";
import { isBookingProvider } from "@/lib/schedulingConnectionTypes";
import { googleCalendarAuthorizationUrl } from "@/lib/googleCalendarProvider";
import { sealSchedulingSecret } from "@/lib/schedulingSecrets";
import { allowRequest } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in before connecting" }, { status: 401 });
  if (!allowRequest(`scheduling-start:${user.id}`, { limit: 10, windowMs: 60_000 })) return NextResponse.json({ error: "Please wait before trying again" }, { status: 429 });
  try {
    if (req.headers.get("origin") !== schedulingOrigin()) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    const { provider } = await req.json();
    if (!isBookingProvider(provider)) return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    const config = provider === "google" ? googleCalendarConfig() : schedulingConfig(provider);
    const state = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(state).digest("hex");
    const verifier = randomBytes(48).toString("base64url");
    // Bound the stored state lifetime and remove expired attempts for this creator.
    const cleanup = await db.from("scheduling_oauth_attempts_v1").delete().eq("creator_id", user.id).lt("expires_at", new Date().toISOString());
    if (cleanup.error) throw cleanup.error;
    const { error } = await db.from("scheduling_oauth_attempts_v1").insert({
      state_hash: hash, creator_id: user.id, provider,
      verifier_ciphertext: sealSchedulingSecret(verifier, `${user.id}:${provider}:${hash}`),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (error) throw error;
    const response = NextResponse.json({ url: provider === "google" ? googleCalendarAuthorizationUrl(config, state, verifier) : schedulingAuthorizationUrl(provider, config, state, verifier) }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(`cn-scheduling-${provider}`, state, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/scheduling/oauth", maxAge: 600 });
    return response;
  } catch { return NextResponse.json({ error: "Booking connection setup is unavailable. Your draft is preserved." }, { status: 503 }); }
}
