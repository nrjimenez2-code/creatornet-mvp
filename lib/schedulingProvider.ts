import "server-only";
import { createHash } from "node:crypto";
import { bookingProviderForUrl } from "@/lib/schedulingConnectionTypes";

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
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
      ...(provider === "calcom" && path.startsWith("/event-types") ? { "cal-api-version": "2024-06-14" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export type SchedulingAccount = { id: string; name: string; organization?: string; username?: string };
export async function getSchedulingAccount(provider: SchedulingProvider, token: string): Promise<SchedulingAccount> {
  const result = await schedulingApi(provider, token, provider === "calcom" ? "/me" : "/users/me");
  const account = provider === "calcom" ? result.data : result.resource;
  const id = provider === "calcom" ? account?.id : account?.uri;
  if ((typeof id !== "string" && typeof id !== "number") || !String(id))
    throw new Error("Missing scheduling account");
  if (provider === "calendly" && typeof account.current_organization !== "string")
    throw new Error("Missing scheduling organization");
  return { id: String(id), name: String(account.name ?? ""),
    ...(provider === "calendly" ? { organization: account.current_organization } : { username: account.username }) };
}

export type ProviderEventType = { id: string; title: string; bookingUrl: string };
export async function listSchedulingEventTypes(provider: SchedulingProvider, token: string, account: SchedulingAccount): Promise<ProviderEventType[]> {
  const events: ProviderEventType[] = [];
  const deadline = Date.now() + 40_000;
  if (provider === "calcom") {
    if (!account.username) throw new Error("Missing scheduling username");
    const result = await schedulingApi(provider, token, `/event-types?username=${encodeURIComponent(account.username)}`);
    if (!Array.isArray(result.data)) throw new Error("Invalid event type response");
    for (const event of result.data) {
      if (!Number.isInteger(event.id) || event.id <= 0 || typeof event.title !== "string") throw new Error("Invalid event type response");
      if (String(event.ownerId) !== account.id && !event.users?.some((user: { id: number }) => String(user.id) === account.id)) continue;
      if (bookingProviderForUrl(event.bookingUrl) !== provider) continue;
      events.push({ id: String(event.id), title: String(event.title), bookingUrl: event.bookingUrl });
    }
    return events;
  }
  let cursor = "";
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    if (Date.now() > deadline) throw new Error("Scheduling event listing timed out");
    const query = new URLSearchParams({ user: account.id, active: "true", count: "100", ...(cursor ? { page_token: cursor } : {}) });
    const result = await schedulingApi(provider, token, `/event_types?${query}`);
    if (!Array.isArray(result.collection)) throw new Error("Invalid event type response");
    for (const event of result.collection) {
      if (typeof event.uri !== "string" || !/^https:\/\/api\.calendly\.com\/event_types\/[a-zA-Z0-9-]+$/.test(event.uri) || typeof event.name !== "string") throw new Error("Invalid event type response");
      if (event.active !== true || bookingProviderForUrl(event.scheduling_url) !== provider) continue;
      events.push({ id: event.uri, title: event.name, bookingUrl: event.scheduling_url });
    }
    cursor = result.pagination?.next_page_token ?? "";
    if (!cursor) return events;
    if (seen.has(cursor)) throw new Error("Repeated scheduling cursor");
    seen.add(cursor);
  }
  throw new Error("Scheduling event list too large");
}

export type ProviderWebhook = { id: string; callbackUrl: string; active: boolean; events: string[]; secret?: string };
export async function listSchedulingWebhooks(provider: SchedulingProvider, token: string, account: SchedulingAccount): Promise<ProviderWebhook[]> {
  const hooks: ProviderWebhook[] = [];
  const deadline = Date.now() + 40_000;
  let cursor = "";
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    if (Date.now() > deadline) throw new Error("Scheduling webhook listing timed out");
    const query = provider === "calcom" ? new URLSearchParams({ take: "250", skip: String(page * 250) })
      : new URLSearchParams({ organization: account.organization!, user: account.id, scope: "user", count: "100", ...(cursor ? { page_token: cursor } : {}) });
    const result = await schedulingApi(provider, token, `${provider === "calcom" ? "/webhooks" : "/webhook_subscriptions"}?${query}`);
    const rows = provider === "calcom" ? result.data : result.collection;
    if (!Array.isArray(rows)) throw new Error("Invalid webhook list response");
    for (const hook of rows) {
      hooks.push(provider === "calcom" ? { id: String(hook.id), callbackUrl: hook.subscriberUrl, active: hook.active === true, events: hook.triggers ?? [], secret: hook.secret }
        : { id: hook.uri, callbackUrl: hook.callback_url, active: hook.state === "active", events: hook.events ?? [] });
    }
    if (provider === "calcom") { if (rows.length < 250) return hooks; }
    else {
      cursor = result.pagination?.next_page_token ?? "";
      if (!cursor) return hooks;
      if (seen.has(cursor)) throw new Error("Repeated scheduling cursor");
      seen.add(cursor);
    }
  }
  throw new Error("Scheduling webhook list too large");
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
    if (!/^(?:\d+|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.test(id))
      throw new Error("Invalid webhook identifier");
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
