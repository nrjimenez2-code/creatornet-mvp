import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SchedulingOAuthConfig, SchedulingTokens } from "@/lib/schedulingProvider";

const API = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_CALENDAR_SCOPES = [
  "openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned", "https://www.googleapis.com/auth/calendar.freebusy",
];

export class GoogleCalendarError extends Error {
  constructor(public readonly status: number) { super(`Google Calendar request failed (${status})`); }
  get requiresReconnect() { return this.status === 401; }
  get requiresFullSync() { return this.status === 410; }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new GoogleCalendarError(response.status);
  return response.status === 204 ? undefined as T : response.json();
}

function calendarRequest<T>(token: string, path: string, method = "GET", body?: unknown, etag?: string): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) throw new Error("Invalid calendar API path");
  return request<T>(API + path, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function googleCalendarAuthorizationUrl(config: SchedulingOAuthConfig, state: string, verifier: string): string {
  const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: "code", state, scope: GOOGLE_CALENDAR_SCOPES.join(" "), access_type: "offline",
    prompt: "consent", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

export async function exchangeGoogleCalendarToken(config: SchedulingOAuthConfig,
  grant: { code: string; verifier: string } | { refreshToken: string }, now = Date.now()): Promise<SchedulingTokens> {
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
    ...("code" in grant ? { grant_type: "authorization_code", code: grant.code, code_verifier: grant.verifier, redirect_uri: config.redirectUri }
      : { grant_type: "refresh_token", refresh_token: grant.refreshToken }) });
  const result = await request<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
    "https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  // Google normally omits refresh_token during refresh: preserve the existing token.
  const refreshToken = result.refresh_token || ("refreshToken" in grant ? grant.refreshToken : "");
  if (!result.access_token || !refreshToken || !Number.isFinite(result.expires_in) || result.expires_in <= 0)
    throw new Error("Incomplete Google Calendar authorization");
  if ("code" in grant && !GOOGLE_CALENDAR_SCOPES.every(scope => (result.scope ?? "").split(" ").includes(scope)))
    throw new Error("Required Google Calendar permissions were not granted");
  return { accessToken: result.access_token, refreshToken, expiresAt: now + result.expires_in * 1000 };
}

export async function getGoogleCalendarAccount(token: string): Promise<{ id: string; email: string }> {
  const result = await request<{ sub: string; email: string; email_verified: boolean }>("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  if (!result.sub || !result.email || result.email_verified !== true) throw new Error("Google account identity was not verified");
  return { id: result.sub, email: result.email };
}

export type GoogleCalendar = { id: string; summary: string; timeZone: string; accessRole: string; primary?: boolean; deleted?: boolean };
export async function listGoogleCalendars(token: string): Promise<GoogleCalendar[]> {
  const calendars: GoogleCalendar[] = [];
  const seen = new Set<string>();
  let cursor = "";
  const deadline = Date.now() + 40_000;
  for (let page = 0; page < 100; page++) {
    if (Date.now() > deadline) throw new Error("Calendar list timed out");
    const query = new URLSearchParams({ maxResults: "250", ...(cursor ? { pageToken: cursor } : {}) });
    const result = await calendarRequest<{ items?: GoogleCalendar[]; nextPageToken?: string }>(token, `/users/me/calendarList?${query}`);
    calendars.push(...(result.items ?? []).filter(calendar => !calendar.deleted && calendar.accessRole === "owner"));
    cursor = result.nextPageToken ?? "";
    if (!cursor) return calendars;
    if (seen.has(cursor)) throw new Error("Repeated calendar cursor");
    seen.add(cursor);
  }
  throw new Error("Calendar list too large");
}

export type CalendarInterval = { start: string; end: string };
function validateInterval(interval: CalendarInterval) {
  if (!Number.isFinite(Date.parse(interval.start)) || !Number.isFinite(Date.parse(interval.end)) || Date.parse(interval.end) <= Date.parse(interval.start))
    throw new Error("Invalid calendar interval");
}

export async function getGoogleBusyIntervals(token: string, calendarIds: string[], interval: CalendarInterval): Promise<CalendarInterval[]> {
  validateInterval(interval);
  if (!calendarIds.length || calendarIds.length > 50 || new Set(calendarIds).size !== calendarIds.length) throw new Error("Invalid calendar selection");
  const result = await calendarRequest<{ calendars?: Record<string, { errors?: unknown[]; busy?: CalendarInterval[] }> }>(token, "/freeBusy", "POST", {
    timeMin: interval.start, timeMax: interval.end, items: calendarIds.map(id => ({ id })),
  });
  return calendarIds.flatMap(id => {
    const calendar = result.calendars?.[id];
    // Missing permissions or an unavailable calendar must never look like a free slot.
    if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) throw new Error("Could not verify calendar availability");
    calendar.busy.forEach(validateInterval);
    return calendar.busy;
  });
}

export type GoogleBookingEvent = {
  id: string; etag: string; status: string; summary?: string;
  start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
};

/** Persist the returned sync token only after every page has been reconciled. */
export async function readGoogleCalendarChanges(token: string, calendar: string,
  cursor: { syncToken?: string; pageToken?: string } = {}): Promise<{
    events: GoogleBookingEvent[]; nextPageToken: string | null; nextSyncToken: string | null;
  }> {
  const query = new URLSearchParams({ maxResults: "250", showDeleted: "true", singleEvents: "false",
    ...(cursor.syncToken ? { syncToken: cursor.syncToken } : {}),
    ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}),
  });
  // Incremental sync cannot use privateExtendedProperty or date-window filters.
  // Match returned IDs to CreatorNet reservations after the authenticated read.
  const result = await calendarRequest<{ items?: GoogleBookingEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
    token, `/calendars/${encodeURIComponent(calendar)}/events?${query}`);
  if ((!result.nextPageToken && !result.nextSyncToken) || (result.nextPageToken && result.nextSyncToken))
    throw new Error("Incomplete calendar synchronization response");
  if (result.items && (!Array.isArray(result.items) || result.items.some(event => typeof event.id !== "string" || !event.id)))
    throw new Error("Invalid calendar synchronization event");
  return { events: result.items ?? [], nextPageToken: result.nextPageToken ?? null, nextSyncToken: result.nextSyncToken ?? null };
}
const eventPath = (calendar: string, event: string) => `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(event)}`;

export function googleBookingEventId(bookingId: string): string {
  // Caller-supplied stable UUID hashes to Google's base32hex-compatible event-ID alphabet.
  if (!/^[a-f0-9-]{36}$/i.test(bookingId)) throw new Error("Invalid booking ID");
  return createHash("sha256").update(`creatornet-booking:${bookingId}`).digest("hex");
}

export async function getGoogleBookingEvent(token: string, calendar: string, bookingId: string): Promise<GoogleBookingEvent> {
  const event = await calendarRequest<GoogleBookingEvent>(token, eventPath(calendar, googleBookingEventId(bookingId)));
  if (event.id !== googleBookingEventId(bookingId) || event.extendedProperties?.private?.cn_booking_id !== bookingId)
    throw new Error("Calendar booking attribution mismatch");
  return event;
}

export async function createGoogleBookingEvent(token: string, calendar: string, input: {
  bookingId: string; creatorId: string; attributionId: string; summary: string; attendeeEmail: string;
  start: string; end: string; timeZone: string;
}): Promise<GoogleBookingEvent> {
  validateInterval(input);
  const id = googleBookingEventId(input.bookingId);
  const body = { id, summary: input.summary,
    start: { dateTime: input.start, timeZone: input.timeZone }, end: { dateTime: input.end, timeZone: input.timeZone },
    attendees: [{ email: input.attendeeEmail }],
    extendedProperties: { private: { cn_booking_id: input.bookingId, cn_creator_id: input.creatorId, cn_attribution: input.attributionId } },
  };
  try { return await calendarRequest<GoogleBookingEvent>(token, `/calendars/${encodeURIComponent(calendar)}/events?sendUpdates=all`, "POST", body); }
  catch (error) {
    if (!(error instanceof GoogleCalendarError) || error.status !== 409) throw error;
    const existing = await getGoogleBookingEvent(token, calendar, input.bookingId);
    if (existing.extendedProperties?.private?.cn_creator_id !== input.creatorId || existing.extendedProperties?.private?.cn_attribution !== input.attributionId ||
        existing.status === "cancelled" || Date.parse(existing.start?.dateTime ?? "") !== Date.parse(input.start) || Date.parse(existing.end?.dateTime ?? "") !== Date.parse(input.end))
      throw new Error("Existing calendar booking differs from the requested reservation");
    return existing;
  }
}

export async function changeGoogleBookingEvent(token: string, calendar: string, bookingId: string,
  interval: CalendarInterval & { timeZone: string }): Promise<GoogleBookingEvent> {
  validateInterval(interval);
  const event = await getGoogleBookingEvent(token, calendar, bookingId);
  if (!event.etag || event.status === "cancelled") throw new Error("Calendar booking is not editable");
  return calendarRequest<GoogleBookingEvent>(token, `${eventPath(calendar, event.id)}?sendUpdates=all`, "PATCH", {
    start: { dateTime: interval.start, timeZone: interval.timeZone }, end: { dateTime: interval.end, timeZone: interval.timeZone },
  }, event.etag);
}

export async function cancelGoogleBookingEvent(token: string, calendar: string, bookingId: string): Promise<void> {
  let event: GoogleBookingEvent;
  try { event = await getGoogleBookingEvent(token, calendar, bookingId); }
  catch (error) { if (error instanceof GoogleCalendarError && [404, 410].includes(error.status)) return; throw error; }
  if (event.status === "cancelled") return;
  if (!event.etag) throw new Error("Missing calendar version");
  await calendarRequest<void>(token, `${eventPath(calendar, event.id)}?sendUpdates=all`, "DELETE", undefined, event.etag);
}

export type GoogleWatch = { id: string; resourceId: string; expiration: string };
export async function startGoogleCalendarWatch(token: string, calendar: string, channel: { id: string; token: string; address: string }): Promise<GoogleWatch> {
  const address = new URL(channel.address);
  if (address.protocol !== "https:" || address.username || address.password || address.hash || !channel.id || channel.token.length < 32)
    throw new Error("Invalid calendar notification channel");
  const result = await calendarRequest<GoogleWatch>(token, `/calendars/${encodeURIComponent(calendar)}/events/watch`, "POST", {
    ...channel, type: "web_hook", params: { ttl: "604800" },
  });
  if (result.id !== channel.id || !result.resourceId || !Number.isFinite(Number(result.expiration)) || Number(result.expiration) <= Date.now())
    throw new Error("Invalid calendar notification response");
  return result;
}

export async function stopGoogleCalendarWatch(token: string, watch: GoogleWatch): Promise<void> {
  try { await calendarRequest<void>(token, "/channels/stop", "POST", { id: watch.id, resourceId: watch.resourceId }); }
  catch (error) { if (!(error instanceof GoogleCalendarError) || ![404, 410].includes(error.status)) throw error; }
}

export function verifyGoogleCalendarNotification(headers: Headers, watch: GoogleWatch & { token: string }, now = Date.now()): boolean {
  const supplied = headers.get("x-goog-channel-token") ?? "";
  const expected = Buffer.from(watch.token);
  const actual = Buffer.from(supplied);
  return expected.length >= 32 && expected.length === actual.length && timingSafeEqual(expected, actual) &&
    headers.get("x-goog-channel-id") === watch.id && headers.get("x-goog-resource-id") === watch.resourceId &&
    Number(watch.expiration) > now && ["sync", "exists", "not_exists"].includes(headers.get("x-goog-resource-state") ?? "");
}
