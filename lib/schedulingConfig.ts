import "server-only";
import type { SchedulingOAuthConfig, SchedulingProvider } from "@/lib/schedulingProvider";

export function schedulingOrigin(): string {
  const raw = process.env.SCHEDULING_OAUTH_ORIGIN ?? "";
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Scheduling origin is not configured");
  return url.origin;
}

export function schedulingConfig(provider: SchedulingProvider): SchedulingOAuthConfig {
  if (process.env.SCHEDULING_OAUTH_ENABLED !== "true") throw new Error("Scheduling connections are not enabled");
  const prefix = provider === "calcom" ? "CALCOM" : "CALENDLY";
  if ((process.env[`${prefix}_OAUTH_ENABLED`] ?? "true") !== "true")
    throw new Error("Scheduling provider is not enabled");
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret || !/^[a-f0-9]{64}$/i.test(process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY ?? "") ||
      (provider === "calendly" && !process.env.CALENDLY_WEBHOOK_SIGNING_KEY))
    throw new Error("Scheduling provider is not configured");
  return { clientId, clientSecret, redirectUri: `${schedulingOrigin()}/api/scheduling/oauth/callback/${provider}` };
}

export function schedulingAvailable(provider: SchedulingProvider): boolean {
  try { schedulingConfig(provider); return true; } catch { return false; }
}

export function googleCalendarConfig(): SchedulingOAuthConfig {
  if (process.env.GOOGLE_CALENDAR_ENABLED !== "true" || !process.env.GOOGLE_CALENDAR_CLIENT_ID || !process.env.GOOGLE_CALENDAR_CLIENT_SECRET ||
      !/^[a-f0-9]{64}$/i.test(process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY ?? "")) throw new Error("Google Calendar is not configured");
  return { clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    redirectUri: schedulingOrigin() + "/api/scheduling/oauth/callback/google" };
}
export function googleCalendarAvailable(): boolean { try { googleCalendarConfig(); return true; } catch { return false; } }
