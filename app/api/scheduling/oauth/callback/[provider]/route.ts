import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { schedulingOrigin } from "@/lib/schedulingConfig";
import { isBookingProvider } from "@/lib/schedulingConnectionTypes";
import { finishGoogleCalendarConnection } from "@/lib/googleCalendarConnection";
import { openSchedulingSecret } from "@/lib/schedulingSecrets";
import { finishSchedulingConnection } from "@/lib/schedulingConnections";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isBookingProvider(provider)) return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  let outcome = "failed";
  let stage = "session";
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) throw new Error("Missing session");
    stage = "state";
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const cookie = req.cookies.get(`cn-scheduling-${provider}`)?.value ?? "";
    if (!/^[a-f0-9]{64}$/.test(state) || cookie.length !== state.length ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) throw new Error("Invalid OAuth state");
    const hash = createHash("sha256").update(state).digest("hex");
    stage = "attempt";
    const { data: attempt, error } = await db.from("scheduling_oauth_attempts_v1").delete()
      .eq("state_hash", hash).eq("creator_id", user.id).eq("provider", provider)
      .gt("expires_at", new Date().toISOString()).select("verifier_ciphertext").maybeSingle();
    if (error || !attempt) throw new Error("Expired OAuth state");
    if (req.nextUrl.searchParams.has("error")) outcome = "canceled";
    else {
      stage = "code";
      const code = req.nextUrl.searchParams.get("code");
      if (!code || code.length > 4096) throw new Error("Missing authorization code");
      stage = "verifier";
      const verifier = openSchedulingSecret(attempt.verifier_ciphertext, `${user.id}:${provider}:${hash}`);
      stage = "provision";
      if (provider === "google") await finishGoogleCalendarConnection(user.id, code, verifier);
      else await finishSchedulingConnection(user.id, provider, code, verifier);
      outcome = "connected";
    }
  } catch {
    // Fixed stages only: no tokens, states, codes, user data or provider response bodies.
    console.info("scheduling_oauth_failed", { provider, stage });
  }
  const destination = provider === "google" && outcome === "connected" ? "/scheduling/google" : `/scheduling/complete?result=${outcome}`;
  const response = NextResponse.redirect(`${schedulingOrigin()}${destination}`, 303);
  response.cookies.set(`cn-scheduling-${provider}`, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/scheduling/oauth", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
