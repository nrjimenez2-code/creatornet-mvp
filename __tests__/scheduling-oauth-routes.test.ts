import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
const getUser = jest.fn();
const insert = jest.fn();
const finish = jest.fn();
const finishGoogle = jest.fn();
let attempt: { verifier_ciphertext: string } | null;
const filters: [string, unknown][] = [];
const chain: any = {
  delete: () => chain,
  eq: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
  lt: () => Promise.resolve({ error: null }),
  gt: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
  select: () => chain,
  maybeSingle: async () => { const data = attempt; attempt = null; return { data, error: null }; },
  insert: (...args: unknown[]) => insert(...args),
};
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: () => chain } }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: (...args: unknown[]) => getUser(...args) }));
jest.mock("@/lib/schedulingConnections", () => ({ finishSchedulingConnection: (...args: unknown[]) => finish(...args) }));
jest.mock("@/lib/googleCalendarConnection", () => ({ finishGoogleCalendarConnection: (...args: unknown[]) => finishGoogle(...args) }));
import { POST } from "@/app/api/scheduling/oauth/start/route";
import { GET } from "@/app/api/scheduling/oauth/callback/[provider]/route";
import { sealSchedulingSecret } from "@/lib/schedulingSecrets";
import { _resetRateLimits } from "@/lib/rateLimit";
const originalEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks(); filters.length = 0; attempt = null; _resetRateLimits();
  getUser.mockResolvedValue({ id: "creator" }); insert.mockResolvedValue({ error: null }); finish.mockResolvedValue(undefined);
  Object.assign(process.env, { SCHEDULING_OAUTH_ENABLED: "true", SCHEDULING_OAUTH_ORIGIN: "https://staging.example",
    CALCOM_CLIENT_ID: "client", CALCOM_CLIENT_SECRET: "secret", SCHEDULING_TOKEN_ENCRYPTION_KEY: "ab".repeat(32) });
});
afterAll(() => { process.env = originalEnv; });
function start(origin = "https://staging.example", provider = "calcom") {
  return POST(new NextRequest("https://staging.example/api/scheduling/oauth/start", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ provider }) }));
}
test("start requires an authenticated creator and exact configured origin", async () => {
  getUser.mockResolvedValueOnce(null);
  expect((await start()).status).toBe(401);
  expect((await start("https://attacker.example")).status).toBe(403);
  expect(insert).not.toHaveBeenCalled();
});
test("start stores a hashed expiring state and encrypted verifier without exposing secrets", async () => {
  const response = await start();
  expect(response.status).toBe(200);
  const body = await response.json();
  const url = new URL(body.url);
  const state = url.searchParams.get("state")!;
  const saved = insert.mock.calls[0][0];
  expect(saved.creator_id).toBe("creator");
  expect(saved.state_hash).toBe(createHash("sha256").update(state).digest("hex"));
  expect(saved.verifier_ciphertext).toMatch(/^v1\./);
  expect(body.url).not.toContain("secret");
  expect(response.cookies.get("cn-scheduling-calcom")?.value).toBe(state);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
});
function callback(state: string, cookie = state, denied = false) {
  return GET(new NextRequest(`https://staging.example/api/scheduling/oauth/callback/calcom?state=${state}&${denied ? "error=access_denied" : "code=code"}`, {
    headers: { cookie: `cn-scheduling-calcom=${cookie}` },
  }), { params: Promise.resolve({ provider: "calcom" }) });
}
function seed(state: string) {
  const hash = createHash("sha256").update(state).digest("hex");
  attempt = { verifier_ciphertext: sealSchedulingSecret("verifier", `creator:calcom:${hash}`) };
}
test("callback binds cookie, creator, provider, state and expiry before provisioning", async () => {
  const state = "a".repeat(64); seed(state);
  const response = await callback(state);
  expect(response.headers.get("location")).toBe("https://staging.example/scheduling/complete?result=connected");
  expect(filters).toContainEqual(["creator_id", "creator"]);
  expect(filters).toContainEqual(["provider", "calcom"]);
  expect(filters.some(([key]) => key === "expires_at")).toBe(true);
  expect(finish).toHaveBeenCalledWith("creator", "calcom", "code", "verifier");
  await callback(state);
  expect(finish).toHaveBeenCalledTimes(1);
});
test("mismatched cookie and provider denial never provision a connection", async () => {
  const state = "a".repeat(64); seed(state);
  expect((await callback(state, "b".repeat(64))).headers.get("location")).toContain("result=failed");
  expect((await callback(state, state, true)).headers.get("location")).toContain("result=canceled");
  expect(finish).not.toHaveBeenCalled();
});


test("Google start requests offline authorization and callback continues to calendar setup",async()=>{
  Object.assign(process.env,{GOOGLE_CALENDAR_ENABLED:'true',GOOGLE_CALENDAR_CLIENT_ID:'google-client',GOOGLE_CALENDAR_CLIENT_SECRET:'google-secret'});
  const response=await start('https://staging.example','google');expect(response.status).toBe(200);
  const url=new URL((await response.json()).url);expect(url.origin).toBe('https://accounts.google.com');expect(url.searchParams.get('access_type')).toBe('offline');
  const state=url.searchParams.get('state')!;const hash=createHash('sha256').update(state).digest('hex');
  attempt={verifier_ciphertext:sealSchedulingSecret('google-verifier',`creator:google:${hash}`)};
  const callbackResponse=await GET(new NextRequest(`https://staging.example/api/scheduling/oauth/callback/google?state=${state}&code=google-code`,{headers:{cookie:`cn-scheduling-google=${state}`}}),{params:Promise.resolve({provider:'google'})});
  expect(finishGoogle).toHaveBeenCalledWith('creator','google-code','google-verifier');
  expect(finish).not.toHaveBeenCalled();expect(callbackResponse.headers.get('location')).toBe('https://staging.example/scheduling/google');
});
