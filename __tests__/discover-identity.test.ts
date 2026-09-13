import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
let user: string | null = "viewer";
let claimed = false;
const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
const query = {
  select: () => query,
  eq: () => query,
  maybeSingle: async () => ({
    data: claimed ? { anonymous_id: "claimed" } : null,
    error: null,
  }),
};
jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: () => query,
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: user ? { id: user } : null },
        error: null,
      }),
    },
  }),
}));
import { discoverIdentity } from "@/lib/discoverServer";
const anonymous = "11111111-1111-4111-8111-111111111111";
const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const token = () =>
  anonymous +
  "." +
  createHmac("sha256", "identity-test-key")
    .update("discover-actor:" + anonymous)
    .digest("hex");
const request = (value: string) =>
  new NextRequest("https://example.test/api/feed", {
    headers: { cookie: "cn_discover_actor=" + value },
  });
beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "identity-test-key";
  user = "viewer";
  claimed = false;
  rpc.mockClear();
});
afterAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
});
test("sign-in links only a valid signed anonymous identity to the verified account", async () => {
  expect((await discoverIdentity(request(token()))).actor).toBe("user:viewer");
  expect(rpc).toHaveBeenCalledWith("link_discover_identity_v1", {
    p_anonymous: anonymous,
    p_user: "viewer",
  });
  rpc.mockClear();
  await discoverIdentity(request(anonymous + "." + "0".repeat(64)));
  expect(rpc).not.toHaveBeenCalled();
});
test("sign-out rotates a previously claimed browser identity instead of sharing future activity", async () => {
  user = null;
  expect((await discoverIdentity(request(token()))).actor).toBe(
    "anon:" + anonymous,
  );
  claimed = true;
  const next = await discoverIdentity(request(token()));
  expect(next.actor).not.toBe("anon:" + anonymous);
  expect(next.cookie).toBeTruthy();
  expect(rpc).not.toHaveBeenCalled();
});
