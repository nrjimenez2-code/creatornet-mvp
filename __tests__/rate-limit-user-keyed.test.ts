/**
 * The user-keyed limits, and specifically the thing that makes them user-keyed.
 *
 * rate-limit-coverage.test.ts proves IP-keyed routes call the limiter. These
 * routes deliberately key on user.id INSTEAD of the client address, because the
 * people who hit them hardest are several closers working from one office IP.
 * An IP key there would let one busy closer lock out their colleagues.
 *
 * That distinction is invisible in a diff — `clientKey(req)` and `user.id` look
 * equally plausible — so it is asserted here: exceeding the limit as one user
 * must NOT affect a different user arriving from the SAME address.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { NextRequest } from "next/server";
import { _resetRateLimits } from "@/lib/rateLimit";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let authUser: { id: string } | null = { id: "closer_1" };

jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseClient", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser }, error: null }) },
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimits();
  db = createMockClient(() => undefined);
  authUser = { id: "closer_1" };
});

/** Every request in this file comes from the SAME address on purpose. */
const SHARED_OFFICE_IP = "198.51.100.7";

function req() {
  return new NextRequest("https://x/api/bookings/list", {
    method: "GET",
    headers: { "x-forwarded-for": SHARED_OFFICE_IP },
  });
}

describe("/api/bookings/list is rate limited per USER, not per address", () => {
  // Matches the limit in the route.
  const LIMIT = 60;

  const call = async () => {
    const { GET } = await import("@/app/api/bookings/list/route");
    return GET(req());
  };

  it("answers 429 once one user passes the limit", async () => {
    for (let i = 0; i < LIMIT; i++) {
      expect((await call()).status).not.toBe(429);
    }
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("does not throttle a DIFFERENT closer at the same address", async () => {
    // closer_1 burns their whole budget.
    for (let i = 0; i < LIMIT + 5; i++) await call();
    expect((await call()).status).toBe(429);

    // closer_2 walks up to the next desk on the same office connection.
    authUser = { id: "closer_2" };
    expect((await call()).status).not.toBe(429);
  });

  it("refuses before doing any database work", async () => {
    for (let i = 0; i < LIMIT; i++) await call();
    const opsBefore = db.ops.length;
    expect((await call()).status).toBe(429);
    expect(db.ops.length).toBe(opsBefore);
  });
});
