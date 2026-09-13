import "server-only";
import { createHash } from "node:crypto";

export type SchedulingProvider = "calcom" | "calendly";
export type SchedulingOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};
export type SchedulingTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const endpoints = {
  calcom: {
    authorize: "https://app.cal.com/auth/oauth2/authorize",
    token: "https://api.cal.com/v2/auth/oauth2/token",
    api: "https://api.cal.com/v2",
    scope: "PROFILE_READ EVENT_TYPE_READ WEBHOOK_READ WEBHOOK_WRITE BOOKING_READ",
  },
  calendly: {
    authorize: "https://auth.calendly.com/oauth/authorize",
    token: "https://auth.calendly.com/oauth/token",
    api: "https://api.calendly.com",
    scope: "users:read event_types:read scheduled_events:read webhooks:read webhooks:write",
  },
} as const;

export function isSchedulingProvider(value: unknown): value is SchedulingProvider {
  return value === "calcom" || value === "calendly";
}

export class SchedulingProviderError extends Error {
  constructor(public readonly status: number) {
    // Never include provider response bodies: they may contain tokens or PII.
    super(`Scheduling provider request failed (${status})`);
  }
  get requiresReconnect() { return this.status === 401; }
}

async function request(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new SchedulingProviderError(response.status);
  if (response.status === 204) return null;
  return response.json();
}

export function schedulingAuthorizationUrl(
  provider: SchedulingProvider, config: SchedulingOAuthConfig, state: string, verifier: string,
): string {
  const url = new URL(endpoints[provider].authorize);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", endpoints[provider].scope);
  if (provider === "calendly") {
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export async function exchangeSchedulingToken(
  provider: SchedulingProvider, config: SchedulingOAuthConfig,
  grant: { code: string; verifier: string } | { refreshToken: string },
  now = Date.now(),
): Promise<SchedulingTokens> {
  const body = new URLSearchParams("refreshToken" in grant
    ? { grant_type: "refresh_token", refresh_token: grant.refreshToken }
    : { grant_type: "authorization_code", code: grant.code, redirect_uri: config.redirectUri });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (provider === "calendly") {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    if ("code" in grant) body.set("code_verifier", grant.verifier);
  } else {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }
  const data = await request(endpoints[provider].token, { method: "POST", headers, body });
  if (typeof data.access_token !== "string" || !data.access_token ||
      typeof data.refresh_token !== "string" || !data.refresh_token ||
      typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0)
    throw new Error("Incomplete scheduling token response");
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: now + data.expires_in * 1000 };
}

export async function schedulingApi(
  provider: SchedulingProvider, accessToken: string, path: string,
  method = "GET", body?: unknown,
): Promise<any> {
  // Only a relative path is accepted, including for provider-returned resource IDs.
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#"))
    throw new Error("Invalid scheduling API path");
  return request(endpoints[provider].api + path, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export type SchedulingAccount = { id: string; name: string; organization?: string };
export async function getSchedulingAccount(provider: SchedulingProvider, token: string): Promise<SchedulingAccount> {
  const result = await schedulingApi(provider, token, provider === "calcom" ? "/me" : "/users/me");
  const account = provider === "calcom" ? result.data : result.resource;
  const id = provider === "calcom" ? account?.id : account?.uri;
  if ((typeof id !== "string" && typeof id !== "number") || !String(id))
    throw new Error("Missing scheduling account");
  if (provider === "calendly" && typeof account.current_organization !== "string")
    throw new Error("Missing scheduling organization");
  return { id: String(id), name: String(account.name ?? ""),
    ...(provider === "calendly" ? { organization: account.current_organization } : {}) };
}

export async function createSchedulingWebhook(
  provider: SchedulingProvider, token: string, account: SchedulingAccount,
  callbackUrl: string, signingSecret: string,
): Promise<string> {
  if (!signingSecret || new URL(callbackUrl).protocol !== "https:")
    throw new Error("Invalid webhook configuration");
  const result = await schedulingApi(provider, token,
    provider === "calcom" ? "/webhooks" : "/webhook_subscriptions", "POST",
    provider === "calcom" ? {
      active: true, subscriberUrl: callbackUrl, secret: signingSecret,
      triggers: ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"],
      version: "2021-10-20",
    } : {
      url: callbackUrl, events: ["invitee.created", "invitee.canceled"],
      organization: account.organization, user: account.id, scope: "user",
      // OAuth webhooks use Calendly's application signing key, not a per-user override.
    });
  const id = provider === "calcom" ? result.data?.id : result.resource?.uri;
  if ((typeof id !== "string" && typeof id !== "number") || !String(id))
    throw new Error("Missing scheduling webhook identifier");
  return String(id);
}

export async function deleteSchedulingWebhook(provider: SchedulingProvider, token: string, id: string): Promise<void> {
  let path: string;
  if (provider === "calcom") {
    if (!/^\d+$/.test(id)) throw new Error("Invalid webhook identifier");
    path = `/webhooks/${id}`;
  } else {
    const url = new URL(id);
    if (url.origin !== endpoints.calendly.api || url.username || url.password || url.search || url.hash ||
        !/^\/webhook_subscriptions\/[a-zA-Z0-9-]+$/.test(url.pathname))
      throw new Error("Invalid webhook identifier");
    path = url.pathname;
  }
  try { await schedulingApi(provider, token, path, "DELETE"); }
  catch (error) {
    if (!(error instanceof SchedulingProviderError) || error.status !== 404) throw error;
  }
}
