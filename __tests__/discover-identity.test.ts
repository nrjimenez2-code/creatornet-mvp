import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
let user: string | null = "viewer";
let claimed = false;
let authError: {name:string} | null = null;
const linkRead = jest.fn();
const authRead = jest.fn();
const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
const query = {
  select: () => query,
  eq: () => query,
  maybeSingle: async () => { linkRead(); return ({
    data: claimed ? { anonymous_id: "claimed" } : null,
    error: null,
  }); },
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
      getUser: async () => { authRead(); return ({
        data: { user: user ? { id: user } : null },
        error: authError,
      }); },
    },
  }),
}));
import { discoverIdentity, discoverEventIdentity } from "@/lib/discoverServer";
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
  authError = null;
  delete process.env.DISCOVER_EVENT_CONTEXT_ENABLED;
  linkRead.mockClear();
  authRead.mockClear();
  rpc.mockClear();
});
afterEach(() => { delete process.env.DISCOVER_EVENT_CONTEXT_ENABLED; });
afterAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
});
test("sign-in links only a valid signed anonymous identity to the verified account", async () => {
  const signedIn=await discoverIdentity(request(token()));
  expect(signedIn.actor).toBe("user:viewer");
  expect(signedIn.newAnonymous).toBe(false);
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
  const returning=await discoverIdentity(request(token()));
  expect(returning.actor).toBe("anon:" + anonymous);
  expect(returning.newAnonymous).toBe(false);
  claimed = true;
  const next = await discoverIdentity(request(token()));
  expect(next.actor).not.toBe("anon:" + anonymous);
  expect(next.cookie).toBeTruthy();
  expect(next.newAnonymous).toBe(true);
  expect(rpc).not.toHaveBeenCalled();
});

test('only event candidates defer the anonymous claim read to enabled private context', async()=>{
  user=null;claimed=true;process.env.DISCOVER_EVENT_CONTEXT_ENABLED='true';
  const candidate=await discoverEventIdentity(request(token()));
  expect(candidate).toEqual({actorCandidate:'anon:'+anonymous,userId:null,anonymousClaimCheck:'context'});
  expect(candidate).not.toHaveProperty('actor');
  expect(authRead).toHaveBeenCalledTimes(1);
  expect(linkRead).not.toHaveBeenCalled();
  // GET/session identity still rotates the same claimed token with the flag on.
  const normal=await discoverIdentity(request(token()));
  expect(normal.actor).not.toBe('anon:'+anonymous);
  expect(linkRead).toHaveBeenCalledTimes(1);
  delete process.env.DISCOVER_EVENT_CONTEXT_ENABLED;
  expect((await discoverEventIdentity(request(token()))).anonymousClaimCheck).toBe('complete');
  expect(linkRead).toHaveBeenCalledTimes(2);
});

test('event candidates still verify auth, reject forged tokens and preserve signed-in claims',async()=>{
  process.env.DISCOVER_EVENT_CONTEXT_ENABLED='true';
  expect(await discoverEventIdentity(request(token()))).toEqual({actorCandidate:'user:viewer',userId:'viewer',anonymousClaimCheck:'context'});
  expect(rpc).toHaveBeenCalledWith('link_discover_identity_v1',{p_anonymous:anonymous,p_user:'viewer'});
  user=null;
  const forged=await discoverEventIdentity(request(anonymous+'.'+'0'.repeat(64)));
  expect(forged.actorCandidate).not.toBe('anon:'+anonymous);
  expect(linkRead).not.toHaveBeenCalled();
  authError={name:'AuthRetryableFetchError'};
  await expect(discoverEventIdentity(request(token()))).rejects.toThrow('Could not verify feed identity');
});
