import { GoogleCalendarError, GOOGLE_CALENDAR_SCOPES, googleCalendarAuthorizationUrl, exchangeGoogleCalendarToken,
  getGoogleBusyIntervals, googleBookingEventId, createGoogleBookingEvent, changeGoogleBookingEvent,
  cancelGoogleBookingEvent, verifyGoogleCalendarNotification, startGoogleCalendarWatch, listGoogleCalendars,
  readGoogleCalendarChanges,
} from "@/lib/googleCalendarProvider";
const originalFetch = global.fetch;
const fetchMock = jest.fn();
const config = { clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/callback" };
const bookingId = "11111111-1111-4111-8111-111111111111";
const interval = { start: "2026-10-01T10:00:00Z", end: "2026-10-01T10:30:00Z" };
beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock; });
afterAll(() => { global.fetch = originalFetch; });
const reply = (data: unknown, status = 200) => fetchMock.mockResolvedValueOnce({ status, ok: status < 400, json: async () => data });
const booking = () => ({ id: googleBookingEventId(bookingId), etag: '"version1"', status: "confirmed",
  start: { dateTime: interval.start }, end: { dateTime: interval.end },
  extendedProperties: { private: { cn_booking_id: bookingId, cn_creator_id: "creator", cn_attribution: "origin-video-attribution" } } });

test("Google authorization requests offline access with PKCE and no client secret", () => {
  const url = new URL(googleCalendarAuthorizationUrl(config, "state", "verifier"));
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("state")).toBe("state");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.toString()).not.toContain("secret");
});

test("Google refresh preserves its refresh token when the response omits it", async () => {
  reply({ access_token: "fresh", expires_in: 3600 });
  expect(await exchangeGoogleCalendarToken(config, { refreshToken: "retained" }, 1000))
    .toEqual({ accessToken: "fresh", refreshToken: "retained", expiresAt: 3601000 });
});

test("declining calendar permissions cannot produce a reusable connection", async () => {
  reply({ access_token: "fresh", refresh_token: "refresh", expires_in: 3600, scope: "openid" });
  await expect(exchangeGoogleCalendarToken(config, { code: "code", verifier: "verifier" })).rejects.toThrow("permissions were not granted");
  reply({ access_token: "fresh", refresh_token: "refresh", expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(" ") });
  await expect(exchangeGoogleCalendarToken(config, { code: "code", verifier: "verifier" })).resolves.toHaveProperty("refreshToken", "refresh");
});

test.each([{ calendars: {} }, { calendars: { primary: { errors: [{ reason: "notFound" }] } } }, { calendars: { primary: {} } }])(
  "unavailable calendar data is never treated as free time", async data => {
    reply(data);
    await expect(getGoogleBusyIntervals("token", ["primary"], interval)).rejects.toThrow("Could not verify calendar availability");
  });

test("busy intervals from every chosen calendar are included", async () => {
  reply({ calendars: { primary: { busy: [interval] }, other: { busy: [] } } });
  expect(await getGoogleBusyIntervals("token", ["primary", "other"], interval)).toEqual([interval]);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
  expect(init.redirect).toBe("error");
});

test("retried event creation reuses the same event and originating attribution", async () => {
  reply({}, 409); reply(booking());
  const result = await createGoogleBookingEvent("token", "creator@example.test", {
    bookingId, creatorId: "creator", attributionId: "origin-video-attribution", summary: "Session", attendeeEmail: "buyer@example.test", ...interval, timeZone: "UTC",
  });
  expect(result.id).toBe(googleBookingEventId(bookingId));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).extendedProperties.private.cn_attribution).toBe("origin-video-attribution");
  expect(fetchMock.mock.calls[1][0]).toContain("creator%40example.test/events/");
});

test("event ID conflict with a different booking cannot be treated as success", async () => {
  reply({}, 409); reply({ ...booking(), extendedProperties: { private: { cn_booking_id: "another" } } });
  await expect(createGoogleBookingEvent("token", "primary", {
    bookingId, creatorId: "creator", attributionId: "origin-video-attribution", summary: "Session", attendeeEmail: "buyer@example.test", ...interval, timeZone: "UTC",
  })).rejects.toThrow("attribution mismatch");
});

test("reschedule uses conditional update and preserves attribution fields", async () => {
  reply(booking()); reply(booking());
  await changeGoogleBookingEvent("token", "primary", bookingId, { ...interval, timeZone: "UTC" });
  const init = fetchMock.mock.calls[1][1];
  expect(init.method).toBe("PATCH");
  expect(init.headers["If-Match"]).toBe('"version1"');
  expect(JSON.parse(init.body)).not.toHaveProperty("extendedProperties");
});

test("calendar edit conflict propagates rather than overwriting concurrent changes", async () => {
  reply(booking()); reply({}, 412);
  await expect(changeGoogleBookingEvent("token", "primary", bookingId, { ...interval, timeZone: "UTC" })).rejects.toMatchObject({ status: 412 });
});

test("cancel is conditional and already-deleted events are idempotent", async () => {
  reply(booking()); reply(null, 204);
  await cancelGoogleBookingEvent("token", "primary", bookingId);
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "DELETE", headers: { "If-Match": '"version1"' } });
  reply({}, 404);
  await expect(cancelGoogleBookingEvent("token", "primary", bookingId)).resolves.toBeUndefined();
});

test("notification token, channel, resource and expiry must all match", () => {
  const watch = { id: "channel", resourceId: "resource", token: "a".repeat(64), expiration: "10000" };
  const headers = new Headers({ "x-goog-channel-id": watch.id, "x-goog-resource-id": watch.resourceId,
    "x-goog-channel-token": watch.token, "x-goog-resource-state": "exists" });
  expect(verifyGoogleCalendarNotification(headers, watch, 1000)).toBe(true);
  expect(verifyGoogleCalendarNotification(headers, watch, 10000)).toBe(false);
  headers.set("x-goog-resource-id", "other");
  expect(verifyGoogleCalendarNotification(headers, watch, 1000)).toBe(false);
  headers.set("x-goog-resource-id", "resource"); headers.set("x-goog-channel-token", "b".repeat(64));
  expect(verifyGoogleCalendarNotification(headers, watch, 1000)).toBe(false);
});

test("watch retains server-returned expiry for renewal and rejects missing expiry", async () => {
  const expiration = String(Date.now() + 60000);
  reply({ id: "channel", resourceId: "resource", expiration });
  expect(await startGoogleCalendarWatch("token", "primary", { id: "channel", token: "a".repeat(64), address: "https://example.test/notify" })).toEqual({ id: "channel", resourceId: "resource", expiration });
  reply({ id: "channel", resourceId: "resource" });
  await expect(startGoogleCalendarWatch("token", "primary", { id: "channel", token: "a".repeat(64), address: "https://example.test/notify" })).rejects.toThrow("notification response");
});

test("calendar chooser follows pagination and excludes non-owned calendars", async () => {
  const calendar = { id: "primary", summary: "Personal", timeZone: "UTC", accessRole: "owner" };
  reply({ items: [{ ...calendar, accessRole: "reader" }], nextPageToken: "next" });
  reply({ items: [calendar] });
  expect(await listGoogleCalendars("token")).toEqual([calendar]);
  expect(fetchMock.mock.calls[1][0]).toContain("pageToken=next");
});

test("expired sync state requires a full sync, not an empty successful result", async () => {
  reply({}, 410);
  await expect(readGoogleCalendarChanges("token", "primary", { syncToken: "expired" })).rejects.toMatchObject({ requiresFullSync: true });
});

test("incremental sync includes tombstones and exposes final cursor only after last page", async () => {
  reply({ items: [{ id: "deleted-event", status: "cancelled" }], nextPageToken: "page2" });
  const first = await readGoogleCalendarChanges("token", "primary", { syncToken: "sync1" });
  expect(first.nextSyncToken).toBeNull();
  expect(first.events[0].status).toBe("cancelled");
  reply({ items: [], nextSyncToken: "sync2" });
  const last = await readGoogleCalendarChanges("token", "primary", { syncToken: "sync1", pageToken: first.nextPageToken! });
  expect(last.nextSyncToken).toBe("sync2");
  const query = new URL(fetchMock.mock.calls[1][0]).searchParams;
  expect(query.get("syncToken")).toBe("sync1");
  expect(query.get("pageToken")).toBe("page2");
  expect(query.get("showDeleted")).toBe("true");
  expect(query.has("privateExtendedProperty")).toBe(false);
  expect(query.has("timeMin")).toBe(false);
});
