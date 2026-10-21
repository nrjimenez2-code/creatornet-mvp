import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { GET } from "@/app/api/library/creators/route";

let db: MockClient;
jest.mock("@/lib/admin/server", () => ({ adminClient: () => db }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: jest.fn() }));
const creator = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const call = (ids = `${creator},${other}`) => GET(new NextRequest(`https://site.test/api/library/creators?ids=${ids}`));
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getAuthenticatedUser).mockResolvedValue({ id: "buyer" } as never);
  db = createMockClient(op => op.table === "purchases"
    ? { data: [{ posts: { creator_id: creator } }], error: null }
    : { data: [{ id: creator, username: "creator", full_name: "Creator" }], error: null });
});

test("creator names are restricted to the authenticated buyer's saved purchases", async () => {
  const response = await call();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ profiles: [{ id: creator, username: "creator", full_name: "Creator" }] });
  expect(db.opsFor("purchases")[0]).toMatchObject({ filters: { buyer_id: "buyer" }, inFilters: [{ column: "posts.creator_id", values: [creator, other] }] });
  expect(db.opsFor("profiles")[0]).toMatchObject({ columns: "id,username,full_name", inFilters: [{ column: "id", values: [creator] }] });
});

test("no purchase ownership means no profile lookup", async () => {
  db = createMockClient(() => ({ data: [], error: null }));
  expect(await (await call()).json()).toEqual({ profiles: [] });
  expect(db.opsFor("profiles")).toHaveLength(0);
});

test("authentication and valid bounded IDs are required before data access", async () => {
  expect((await call("malformed")).status).toBe(400);
  expect((await call(Array(101).fill(creator).join(","))).status).toBe(400);
  jest.mocked(getAuthenticatedUser).mockResolvedValue(null);
  expect((await call()).status).toBe(401);
  expect(db.ops).toHaveLength(0);
});

test("a failed ownership lookup fails closed", async () => {
  db = createMockClient(() => ({ data: null, error: { message: "unavailable" } }));
  expect((await call()).status).toBe(503);
  expect(db.opsFor("profiles")).toHaveLength(0);
});
