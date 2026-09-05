process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-placeholder";

import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let user: { id: string } | null;
let accessGranted: boolean;
let purchaseError: boolean;
let premiumPath: string;
const sign = jest.fn();
const bucket = jest.fn();

jest.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  from: (table: string) => db.from(table),
  storage: { from: (name: string) => { bucket(name); return { createSignedUrl: sign }; } },
}) }));
jest.mock("@/lib/supabaseClient", () => ({ createServerSupabase: async () => ({
  auth: { getUser: async () => ({ data: { user } }) },
}) }));

beforeEach(() => {
  jest.resetModules();
  user = { id: "buyer-one" };
  accessGranted = false;
  purchaseError = false;
  premiumPath = "creator-one/private-file.pdf";
  sign.mockReset().mockResolvedValue({ data: { signedUrl: "https://example.invalid/test-download" }, error: null });
  bucket.mockClear();
  db = createMockClient((op) => {
    if (op.table === "posts") return { data: { id: "post-one", creator_id: "creator-one", premium_path: premiumPath }, error: null };
    if (op.table === "purchases") return {
      data: accessGranted && op.filters.buyer_id === "buyer-one" && op.filters.post_id === "post-one" && op.filters.access_granted === true ? { id: "purchase-one" } : null,
      error: purchaseError ? { message: "lookup failed" } : null,
    };
    return undefined;
  });
});

async function download() {
  const { GET } = await import("@/app/api/watch/[postId]/route");
  return GET(new NextRequest("https://example.invalid/api/watch/post-one?buyer_id=buyer-one"), { params: Promise.resolve({ postId: "post-one" }) });
}

test("signed-out callers receive no private URL", async () => {
  user = null;
  expect((await download()).status).toBe(401);
  expect(db.ops).toHaveLength(0);
  expect(sign).not.toHaveBeenCalled();
});

test("a fully refunded buyer cannot mint another link after access is revoked", async () => {
  const response = await download();
  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({ error: "Payment required" });
  expect(db.opsFor("purchases")[0].filters).toEqual({ post_id: "post-one", buyer_id: "buyer-one", access_granted: true });
  expect(sign).not.toHaveBeenCalled();
});

test("another account cannot borrow the buyer ID in the URL", async () => {
  user = { id: "other-user" };
  accessGranted = true;
  expect((await download()).status).toBe(402);
  expect(sign).not.toHaveBeenCalled();
});

test("a lookup error fails closed even if a row is present", async () => {
  accessGranted = true;
  purchaseError = true;
  expect((await download()).status).toBe(402);
  expect(sign).not.toHaveBeenCalled();
});

test("a paid or partially refunded buyer with retained access gets the private-bucket link", async () => {
  accessGranted = true;
  expect((await download()).status).toBe(200);
  expect(bucket).toHaveBeenCalledWith("premium");
  expect(sign).toHaveBeenCalledWith("creator-one/private-file.pdf", 3600);
});

test("the owner may preview only their own premium path", async () => {
  user = { id: "creator-one" };
  expect((await download()).status).toBe(200);
  sign.mockClear();
  premiumPath = "other-creator/private-file.pdf";
  expect((await download()).status).toBe(402);
  expect(sign).not.toHaveBeenCalled();
});

test("storage signing failures never return a successful download", async () => {
  accessGranted = true;
  sign.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
  expect((await download()).status).toBe(500);
});

test.each([
  [null, false, 401],
  ["buyer-one", false, 403],
  ["other-user", true, 403],
  ["buyer-one", true, 200],
] as const)("the alternative premium endpoint also enforces user=%s access=%s", async (id, access, status) => {
  user = id ? { id } : null;
  accessGranted = access;
  const { POST } = await import("@/app/api/premium/access/route");
  const response = await POST(new NextRequest("https://example.invalid/api/premium/access", {
    method: "POST", body: JSON.stringify({ post_id: "post-one", buyer_id: "buyer-one" }),
  }));
  expect(response.status).toBe(status);
  if (status === 200) expect(sign).toHaveBeenCalledWith("creator-one/private-file.pdf", 3600);
  else expect(sign).not.toHaveBeenCalled();
});
