import { POST } from "@/app/api/auth/email-code/route";
import { handleEmailCode, type EmailCodeDependencies } from "@/lib/emailCode";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

jest.mock("@/lib/emailCode", () => ({ handleEmailCode: jest.fn() }));
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { rpc: jest.fn(), auth: { admin: { generateLink: jest.fn() } } } }));
const handler = jest.mocked(handleEmailCode);
const generate = jest.mocked(supabaseAdmin.auth.admin.generateLink);
const oldEnv = process.env;
const oldFetch = global.fetch;
const request = () => new Request("https://creatornet.net/api/auth/email-code", { method: "POST", headers: { origin: "https://creatornet.net", "x-vercel-forwarded-for": "192.0.2.5" } });
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...oldEnv, VERCEL: "1", RESEND_API_KEY: "synthetic-resend", EMAIL_CODE_FROM: "CreatorNet <login@example.test>", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_synthetic-existing-server-key", NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid" };
  delete process.env.SUPABASE_AUTH_SECRET_KEY;
  handler.mockResolvedValue(Response.json({ ok: true }));
  global.fetch = jest.fn().mockResolvedValue(Response.json({ ok: true }));
});
afterEach(() => { process.env = oldEnv; global.fetch = oldFetch; });
async function dependencies(): Promise<EmailCodeDependencies> {
  expect((await POST(request())).status).toBe(200);
  return handler.mock.calls[0][1];
}
test("reuses the existing modern server key without requiring a duplicate", async () => {
  const deps = await dependencies();
  expect(deps.clientIp).toBe("192.0.2.5");
  generate.mockResolvedValue({ data: { properties: { hashed_token: "synthetic-native-token", verification_type: "signup" } }, error: null } as Awaited<ReturnType<typeof generate>>);
  await deps.createSession("new@example.test", "server-only-nonce");
  expect(generate).toHaveBeenCalledWith({ type: "magiclink", email: "new@example.test" });
  expect(global.fetch).toHaveBeenCalledWith("https://example.invalid/auth/v1/verify", expect.objectContaining({
    headers: expect.objectContaining({ apikey: "sb_secret_synthetic-existing-server-key", "Sb-Forwarded-For": "192.0.2.5", "User-Agent": "server-only-nonce" }),
    body: JSON.stringify({ token_hash: "synthetic-native-token", type: "signup" }),
  }));
});
test("legacy keys require a compatible forwarding key without replacing the original", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJ-synthetic-legacy";
  expect((await POST(request())).status).toBe(503);
  expect(handler).not.toHaveBeenCalled();
  process.env.SUPABASE_AUTH_SECRET_KEY = "sb_secret_synthetic-forwarding-key";
  expect((await POST(request())).status).toBe(200);
  expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe("eyJ-synthetic-legacy");
});
test("sends only the application code, with no sign-in link", async () => {
  const deps = await dependencies();
  await deps.sendCode("test@example.test", "012345");
  const call = jest.mocked(global.fetch).mock.calls[0];
  expect(call[0]).toBe("https://api.resend.com/emails");
  const body = JSON.parse(call[1]!.body as string);
  expect(body.to).toEqual(["test@example.test"]);
  expect(body.text).toContain("012345");
  expect(body.text).toContain("10 minutes");
  expect(body.text).not.toMatch(/https?:|href|token_hash/);
});
test("missing sending credentials and untrusted IPs fail before processing codes", async () => {
  delete process.env.RESEND_API_KEY;
  expect((await POST(request())).status).toBe(503);
  process.env.RESEND_API_KEY = "synthetic";
  delete process.env.VERCEL;
  expect((await POST(request())).status).toBe(503);
  expect(handler).not.toHaveBeenCalled();
});
