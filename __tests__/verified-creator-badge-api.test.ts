/**
 * GET /api/profiles must expose `is_verified_seller` (derived server-side via
 * lib/sellReady.ts) and must NEVER return the raw stripe_* columns.
 *
 * Drives the REAL handler (node env: next/server needs the Request global).
 * Split from verified-creator-badge.test.ts, which runs under jsdom for the
 * badge render tests.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { NextRequest } from "next/server";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { GET } from "@/app/api/profiles/route";

let db: MockClient;
let authUser: { id: string } | null = { id: "viewer_1" };

jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
  createSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  authUser = { id: "viewer_1" };
  db = createMockClient(() => undefined);
});

const callRoute = () => GET(new NextRequest("https://x/api/profiles?ids=c1,c2"));

describe("GET /api/profiles", () => {
  it("derives is_verified_seller server-side and strips the raw stripe columns", async () => {
    db = createMockClient((op: Op) =>
      op.table === "profiles" && op.kind === "select"
        ? {
            data: [
              { id: "c1", full_name: "Ready", username: "ready", avatar_url: null, stripe_account_id: "acct_1", stripe_onboarding_complete: true },
              { id: "c2", full_name: "Not", username: "not", avatar_url: null, stripe_account_id: "acct_2", stripe_onboarding_complete: false },
            ],
            error: null,
          }
        : undefined
    );

    const res = await callRoute();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.profiles).toEqual([
      { id: "c1", full_name: "Ready", username: "ready", avatar_url: null, is_verified_seller: true },
      { id: "c2", full_name: "Not", username: "not", avatar_url: null, is_verified_seller: false },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/stripe_/);
  });

  it("asks the database for the two Stripe columns it needs", async () => {
    await callRoute();
    const [op] = db.opsFor("profiles");
    expect(op.columns).toContain("stripe_account_id");
    expect(op.columns).toContain("stripe_onboarding_complete");
    expect(op.inFilters).toEqual([{ column: "id", values: ["c1", "c2"] }]);
  });

  it("still requires a signed-in viewer", async () => {
    authUser = null;
    const res = await callRoute();
    expect(res.status).toBe(401);
  });
});
