import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { schedulingOrigin } from "@/lib/schedulingConfig";
import { isSchedulingProvider } from "@/lib/schedulingProvider";
import { openSchedulingSecret } from "@/lib/schedulingSecrets";
import { finishSchedulingConnection } from "@/lib/schedulingConnections";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isSchedulingProvider(provider)) return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  let outcome = "failed";
  try {
    const user = await getAuthenticatedUser(req);
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const cookie = req.cookies.get(`cn-scheduling-${provider}`)?.value ?? "";
    if (!user || !/^[a-f0-9]{64}$/.test(state) || cookie.length !== state.length ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) throw new Error("Invalid OAuth state");
    const hash = createHash("sha256").update(state).digest("hex");
    const { data: attempt, error } = await db.from("scheduling_oauth_attempts_v1").delete()
      .eq("state_hash", hash).eq("creator_id", user.id).eq("provider", provider)
      .gt("expires_at", new Date().toISOString()).select("verifier_ciphertext").maybeSingle();
    if (error || !attempt) throw new Error("Expired OAuth state");
    if (req.nextUrl.searchParams.has("error")) outcome = "canceled";
    else {
      const code = req.nextUrl.searchParams.get("code");
      if (!code || code.length > 4096) throw new Error("Missing authorization code");
      await finishSchedulingConnection(user.id, provider, code, openSchedulingSecret(attempt.verifier_ciphertext, `${user.id}:${provider}:${hash}`));
      outcome = "connected";
    }
  } catch { /* No provider tokens, authorization codes or private response bodies are logged. */ }
  const response = NextResponse.redirect(`${schedulingOrigin()}/scheduling/complete?result=${outcome}`, 303);
  response.cookies.set(`cn-scheduling-${provider}`, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/scheduling/oauth", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
