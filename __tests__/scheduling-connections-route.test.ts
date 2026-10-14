import { NextRequest } from "next/server";

type ConnectionRow = { id: string; provider: string; status: string; account_name: string; last_checked_at: string | null };
type QueryResult = { data: unknown; error: unknown };
const getUser = jest.fn();
const refreshProvider = jest.fn();
const refreshGoogle = jest.fn();
let rows: ConnectionRow[] = [];
let databaseError: Error | null = null;
const from = jest.fn((table: string) => {
  let columns = "";
  const filters = new Map<string, unknown>();
  const read = (): QueryResult => {
    if (databaseError) return { data: null, error: databaseError };
    if (table === "scheduling_connections_v1") {
      if (columns === "status") {
        const row = rows.find(value => value.id === filters.get("id"));
        return { data: row ? { status: row.status } : null, error: null };
      }
      return { data: rows, error: null };
    }
    if (table === "google_booking_settings_v1") return { data: { title: "QA Google call" }, error: null };
    if (table === "scheduling_event_types_v1") return { data: [{ provider_event_id: "calendly-event", title: "QA Calendly call", booking_url: "https://calendly.example/qa" }], error: null };
    throw new Error(`Unexpected table: ${table}`);
  };
  const query = {
    select(value: string) { columns = value; return query; },
    eq(key: string, value: unknown) { filters.set(key, value); return query; },
    order() { return query; },
    maybeSingle: async () => read(),
    then(resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(read()).then(resolve, reject);
    },
  };
  return query;
});
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (...args: [string]) => from(...args) } }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: (...args: unknown[]) => getUser(...args) }));
jest.mock("@/lib/schedulingConfig", () => ({ schedulingAvailable: () => true, googleCalendarAvailable: () => true, schedulingOrigin: () => "https://qa.example" }));
jest.mock("@/lib/schedulingProvider", () => ({ isSchedulingProvider: (value: string) => ["calcom", "calendly"].includes(value) }));
jest.mock("@/lib/schedulingConnections", () => ({ refreshSchedulingConnection: (...args: unknown[]) => refreshProvider(...args), disconnectSchedulingConnection: jest.fn() }));
jest.mock("@/lib/googleCalendarConnection", () => ({ refreshGoogleCalendarConnection: (...args: unknown[]) => refreshGoogle(...args), disconnectGoogleCalendar: jest.fn() }));

import { GET } from "@/app/api/scheduling/connections/route";
import { _resetRateLimits } from "@/lib/rateLimit";
const originalEnabled = process.env.SCHEDULING_OAUTH_ENABLED;
beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimits();
  process.env.SCHEDULING_OAUTH_ENABLED = "true";
  databaseError = null;
  rows = [
    { id: "calendly-id", provider: "calendly", status: "connected", account_name: "Calendly host", last_checked_at: null },
    { id: "google-id", provider: "google", status: "connected", account_name: "Google host", last_checked_at: new Date().toISOString() },
  ];
  getUser.mockResolvedValue({ id: "creator" });
  refreshProvider.mockResolvedValue(undefined);
  refreshGoogle.mockResolvedValue(undefined);
});
afterAll(() => {
  if (originalEnabled === undefined) delete process.env.SCHEDULING_OAUTH_ENABLED;
  else process.env.SCHEDULING_OAUTH_ENABLED = originalEnabled;
});
function list() { return GET(new NextRequest("https://qa.example/api/scheduling/connections")); }

test.each(["error", "connected"])("unhealthy Calendly (%s) does not hide a healthy Google booking option", async status => {
  rows[0].status = status;
  refreshProvider.mockRejectedValue(new Error("Provider setup failed"));
  const response = await list();
  expect(response.status).toBe(200);
  const { connections } = await response.json();
  expect(connections.find((value: { provider: string }) => value.provider === "calendly")).toMatchObject({ status: "error", eventTypes: [] });
  expect(connections.find((value: { provider: string }) => value.provider === "google")).toMatchObject({ status: "connected", eventTypes: [{ id: "google-id", title: "QA Google call", bookingUrl: "https://qa.example/scheduling/book/google-id" }] });
  expect(refreshProvider).toHaveBeenCalledTimes(status === "connected" ? 1 : 0);
});

test("listing an incomplete setup does not retry provider provisioning", async () => {
  rows[0].status = "pending";
  const response = await list();
  expect(response.status).toBe(200);
  const { connections } = await response.json();
  expect(connections.find((value: { provider: string }) => value.provider === "calendly")).toMatchObject({ status: "pending", eventTypes: [] });
  expect(refreshProvider).not.toHaveBeenCalled();
});

test("a failed Google health check hides its booking option while Calendly remains selectable", async () => {
  rows[1].last_checked_at = null;
  refreshGoogle.mockRejectedValue(new Error("Could not verify calendar"));
  const response = await list();
  expect(response.status).toBe(200);
  const { connections } = await response.json();
  expect(connections.find((value: { provider: string }) => value.provider === "google")).toMatchObject({ status: "error", eventTypes: [] });
  expect(connections.find((value: { provider: string }) => value.provider === "calendly")).toMatchObject({ status: "connected", eventTypes: [{ id: "calendly-event" }] });
});

test("a persisted reconnect requirement remains visible and has no booking option", async () => {
  refreshProvider.mockImplementation(async () => {
    rows[0].status = "reconnect_required";
    throw new Error("Authorization expired");
  });
  const response = await list();
  expect(response.status).toBe(200);
  const { connections } = await response.json();
  expect(connections.find((value: { provider: string }) => value.provider === "calendly")).toMatchObject({ status: "reconnect_required", eventTypes: [] });
});

test("database failures still fail the list closed", async () => {
  databaseError = new Error("Database unavailable");
  expect((await list()).status).toBe(503);
  expect(refreshProvider).not.toHaveBeenCalled();
  expect(refreshGoogle).not.toHaveBeenCalled();
});

test("unauthenticated requests cannot read or refresh provider connections", async () => {
  getUser.mockResolvedValue(null);
  expect((await list()).status).toBe(401);
  expect(from).not.toHaveBeenCalled();
  expect(refreshProvider).not.toHaveBeenCalled();
});
