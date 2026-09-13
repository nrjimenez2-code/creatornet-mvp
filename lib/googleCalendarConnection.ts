import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { schedulingOrigin } from "@/lib/schedulingConfig";
import { openSchedulingSecret, sealSchedulingSecret } from "@/lib/schedulingSecrets";
import { exchangeGoogleCalendarToken, GoogleCalendarError } from "@/lib/googleCalendarProvider";
import type { SchedulingTokens } from "@/lib/schedulingProvider";

export function googleCalendarConfig() {
  if (process.env.GOOGLE_CALENDAR_ENABLED !== "true" || !process.env.GOOGLE_CALENDAR_CLIENT_ID || !process.env.GOOGLE_CALENDAR_CLIENT_SECRET ||
      !/^[a-f0-9]{64}$/i.test(process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY ?? "")) throw new Error("Google Calendar is not configured");
  return { clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    redirectUri: `${schedulingOrigin()}/api/scheduling/oauth/callback/google` };
}

/** Serialize refresh-token writes across requests and instances. */
export async function googleConnectionAccessToken(connectionId: string): Promise<string> {
  const config = googleCalendarConfig();
  const leaseId = randomUUID();
  const { data: connection, error } = await db.from("scheduling_connections_v1")
    .update({ lease_id: leaseId, lease_until: new Date(Date.now() + 60_000).toISOString() })
    .eq("id", connectionId).eq("provider", "google").in("status", ["connected", "pending", "disconnecting"])
    .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).select("creator_id,credentials_ciphertext").maybeSingle();
  if (error || !connection) throw new Error("Google connection is unavailable or updating");
  try {
    if (!connection.credentials_ciphertext) throw new Error("Google connection credentials unavailable");
    const context = `${connection.creator_id}:google:tokens`;
    const tokens = JSON.parse(openSchedulingSecret(connection.credentials_ciphertext, context)) as SchedulingTokens;
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    const fresh = await exchangeGoogleCalendarToken(config, { refreshToken: tokens.refreshToken });
    const saved = await db.from("scheduling_connections_v1").update({
      credentials_ciphertext: sealSchedulingSecret(JSON.stringify(fresh), context), token_expires_at: new Date(fresh.expiresAt).toISOString(),
    }).eq("id", connectionId).eq("lease_id", leaseId).gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
    if (saved.error || !saved.data) throw new Error("Could not save Google authorization");
    return fresh.accessToken;
  } catch (cause) {
    if (cause instanceof GoogleCalendarError && [400, 401].includes(cause.status))
      await db.from("scheduling_connections_v1").update({ status: "reconnect_required", last_error_code: "google_authorization_expired" }).eq("id", connectionId).eq("lease_id", leaseId);
    throw cause;
  } finally {
    await db.from("scheduling_connections_v1").update({ lease_id: null, lease_until: null }).eq("id", connectionId).eq("lease_id", leaseId);
  }
}
