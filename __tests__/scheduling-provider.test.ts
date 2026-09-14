import { createSchedulingWebhook, deleteSchedulingWebhook, exchangeSchedulingToken,
  schedulingAuthorizationUrl, schedulingApi, SchedulingProviderError } from "@/lib/schedulingProvider";

const config = { clientId: "client", clientSecret: "secret", redirectUri: "https://staging.example/api/scheduling/oauth/callback" };
const originalFetch = global.fetch;
const fetchMock = jest.fn();
beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock; });
afterAll(() => { global.fetch = originalFetch; });
const reply = (body: unknown, status = 200) => fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });

test.each(["calcom", "calendly"] as const)("%s authorization includes state and never client secret", provider => {
  const url = new URL(schedulingAuthorizationUrl(provider, config, "random-state", "pkce-verifier"));
  expect(url.searchParams.get("state")).toBe("random-state");
  expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
  expect(url.searchParams.get("scope")).toContain(provider === "calcom" ? "WEBHOOK_WRITE" : "webhooks:write");
  expect(url.toString()).not.toContain("secret");
  if (provider === "calendly") {
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBe("pkce-verifier");
  }
});

test.each(["calcom", "calendly"] as const)("%s exchanges and rotates tokens", async provider => {
  reply({ access_token: "access", refresh_token: "rotated", expires_in: 1800 });
  expect(await exchangeSchedulingToken(provider, config, { refreshToken: "old" }, 1000))
    .toEqual({ accessToken: "access", refreshToken: "rotated", expiresAt: 1801000 });
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toMatch(/^https:\/\/(api.cal.com\/v2\/auth\/oauth2|auth.calendly.com\/oauth)\/token$/);
  expect(options.body.get("refresh_token")).toBe("old");
  expect(options.redirect).toBe("error");
  expect(options.cache).toBe("no-store");
  if (provider === "calendly") expect(options.headers.Authorization).toBe("Basic " + Buffer.from("client:secret").toString("base64"));
  else expect(options.body.get("client_secret")).toBe("secret");
});

test("Cal.com webhook registers all supported scheduling lifecycle events and secret", async () => {
  reply({ data: { id: 12 } });
  expect(await createSchedulingWebhook("calcom", "token", { id: "42", name: "Creator" }, "https://example.test/callback", "signing" )).toBe("12");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ secret: "signing", active: true,
    triggers: ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"] });
});

test("Calendly webhook is user scoped and uses application signing key", async () => {
  reply({ resource: { uri: "https://api.calendly.com/webhook_subscriptions/abc" } });
  await createSchedulingWebhook("calendly", "token", { id: "user-uri", name: "Creator", organization: "org-uri" }, "https://example.test/callback", "app-key");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ url: "https://example.test/callback", events: ["invitee.created", "invitee.canceled"],
    organization: "org-uri", user: "user-uri", scope: "user" });
});

test("provider errors redact body and distinguish auth failure from outage", async () => {
  reply({ secret: "must-not-leak" }, 401);
  await expect(schedulingApi("calcom", "token", "/me")).rejects.toThrow("Scheduling provider request failed (401)");
  expect(new SchedulingProviderError(401).requiresReconnect).toBe(true);
  expect(new SchedulingProviderError(503).requiresReconnect).toBe(false);
});

test.each(["https://evil.test/webhook_subscriptions/abc", "https://api.calendly.com/users/abc", "https://user@api.calendly.com/webhook_subscriptions/abc"])("disconnect rejects untrusted resource %s before sending token", async uri => {
  await expect(deleteSchedulingWebhook("calendly", "token", uri)).rejects.toThrow("Invalid webhook identifier");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("disconnect treats already removed webhook as success", async () => {
  reply({}, 404);
  await expect(deleteSchedulingWebhook("calcom", "token", "12")).resolves.toBeUndefined();
});

test("Cal.com disconnect deletes UUID webhook identifiers returned by the provider", async () => {
  const id = "82249e26-637f-4ce2-bd77-69b2a222f919";
  reply({ data: { id } });
  const created = await createSchedulingWebhook("calcom", "token", { id: "42", name: "Creator" }, "https://example.test/callback", "signing");
  reply(null, 204);
  await expect(deleteSchedulingWebhook("calcom", "token", created)).resolves.toBeUndefined();
  expect(fetchMock.mock.calls[1][0]).toBe(`https://api.cal.com/v2/webhooks/${id}`);
  expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
});

test.each(["", "../me", "12/../me", "12?other=1", "12#fragment", "https://evil.test/12", "%2e%2e%2fme"])(
  "Cal.com disconnect rejects unsafe webhook identifier %s before sending token", async id => {
    await expect(deleteSchedulingWebhook("calcom", "token", id)).rejects.toThrow("Invalid webhook identifier");
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

test("malformed token response cannot be persisted as connected", async () => {
  reply({ access_token: "access", expires_in: 1800 });
  await expect(exchangeSchedulingToken("calcom", config, { code: "code", verifier: "verifier" })).rejects.toThrow("Incomplete scheduling token response");
});
