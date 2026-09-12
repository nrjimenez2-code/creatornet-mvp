import { NextRequest } from "next/server";
import { membershipTestContext as context } from "../test-support/membership-fixtures";
const buyer = "16000000-0000-4000-8000-000000000003";
let mockUser: { id: string } | null = { id: buyer }, mockReady = true;
const mockList = jest.fn(), mockClients = jest.fn(() => ({ admin: { synthetic: true }, context }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => mockUser }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerClients: () => mockClients() }));
jest.mock("@/lib/membershipManagement", () => ({ ...jest.requireActual("@/lib/membershipManagement"),
  membershipManagementReady: () => mockReady, listManagedMemberships: (...args: unknown[]) => mockList(...args) }));
import { GET } from "@/app/api/memberships/route";
const request = (query = "") => new NextRequest(context.siteOrigin + "/api/memberships" + query);
beforeEach(() => { jest.clearAllMocks(); mockUser = { id: buyer }; mockReady = true; mockList.mockResolvedValue({ view: "buyer", items: [], nextCursor: null }); });
test("step 5: buyer view uses only authenticated identity", async () => {
  const result = await GET(request()); expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(mockList).toHaveBeenCalledWith({ synthetic: true }, context, buyer, "buyer", null);
});
test("step 5: creator view is a projection for the same authenticated actor, not an owner override", async () => {
  expect((await GET(request("?view=creator"))).status).toBe(200);
  expect(mockList).toHaveBeenCalledWith({ synthetic: true }, context, buyer, "creator", null);
});
test("step 5: signed-out request never reads membership data", async () => {
  mockUser = null; expect((await GET(request())).status).toBe(401); expect(mockClients).not.toHaveBeenCalled();
});
test("step 10: disabled management never loads private clients", async () => {
  mockReady = false; expect((await GET(request())).status).toBe(503); expect(mockClients).not.toHaveBeenCalled();
});
test.each(["?buyer_id=x", "?actor_id=x", "?limit=100", "?view=admin", "?view=buyer&view=creator", "?cursor=x&cursor=y"])(
  "step 5: unapproved selector %s is refused", async query => {
    expect((await GET(request(query))).status).toBe(400); expect(mockList).not.toHaveBeenCalled();
  });
test("step 5: malformed cursor fails before private client construction", async () => {
  expect((await GET(request("?cursor=bad"))).status).toBe(409); expect(mockClients).not.toHaveBeenCalled();
});
test("step 8: management failure is not returned as an empty account or private error detail", async () => {
  mockList.mockRejectedValueOnce(Error("private database details")); const result = await GET(request());
  expect(result.status).toBe(409); expect(await result.text()).not.toContain("private database");
});
