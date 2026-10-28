import { createHmac } from "node:crypto";

const mockRpc = jest.fn();
const mockGenerate = jest.fn();
jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: { admin: { generateLink: (...args: unknown[]) => mockGenerate(...args) } },
  },
}));
jest.mock("@/lib/release/server", () => ({ loadReleaseSettings: async () => null }));
jest.mock("@/lib/emailCodeMessage", () => ({
  emailCodeMessage: (code: string) => ({ subject: "Synthetic test code", text: code }),
}));

import { POST } from "@/app/api/auth/email-code/route";

const legacyKey = "synthetic-legacy-api-key-for-email-codes";
const freshHmacKey = "synthetic-independent-email-code-hmac-key";
const forwardingKey = "sb_secret_synthetic-auth-forwarding-key";
const accountId = "11111111-1111-4111-8111-111111111111";
const email = "owner@example.test";
const savedFetch = global.fetch;
let envReplacement: ReturnType<typeof jest.replaceProperty>;
let storedHash: string | undefined;
let deliveredCode: string;

const request = (action: "send" | "verify", code?: string) => new Request("https://example.test/api/auth/email-code", {
  method: "POST",
  headers: { origin: "https://example.test", "x-vercel-forwarded-for": "192.0.2.5", "Content-Type": "application/json" },
  body: JSON.stringify({ email, action, ...(code === undefined ? {} : { code }) }),
});
const hash = (key: string) => createHmac("sha256", key).update(`CreatorNetEmailCode:v1:${email}:${deliveredCode}`).digest("hex");
const codeAdmissions = () => mockRpc.mock.calls.filter(([name]) => name === "email_code_admit");

beforeEach(() => {
  envReplacement = jest.replaceProperty(process, "env", {
    NODE_ENV: "test", VERCEL: "1", RESEND_API_KEY: "synthetic-resend",
    EMAIL_CODE_FROM: "CreatorNet <login@example.test>",
    SUPABASE_SERVICE_ROLE_KEY: legacyKey, SUPABASE_AUTH_SECRET_KEY: forwardingKey,
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
  });
  storedHash = undefined;
  deliveredCode = "";
  mockRpc.mockReset().mockImplementation(async (name: string, args: Record<string, string>) => {
    if (name === "website_existing_email_v1") return { data: accountId, error: null };
    if (name === "email_code_ip_admit") return { data: { allowed: true }, error: null };
    if (name === "email_code_admit") {
      if (args.p_action === "send") storedHash = args.p_code_hash;
      return { data: { allowed: args.p_code_hash === storedHash, reason: "invalid" }, error: null };
    }
    if (name === "email_code_finish") return { data: { verified: true }, error: null };
    throw new Error("Unexpected RPC");
  });
  mockGenerate.mockReset().mockResolvedValue({
    data: { user: { id: accountId }, properties: { hashed_token: "synthetic-native-token", verification_type: "magiclink" } }, error: null,
  });
  global.fetch = jest.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url === "https://api.resend.com/emails") {
      deliveredCode = JSON.parse(String(options.body)).text;
      return Response.json({ id: "synthetic-delivery" });
    }
    if (url === "https://supabase.invalid/auth/v1/verify") return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
    throw new Error("Unexpected fetch");
  });
});
afterEach(() => { envReplacement.restore(); global.fetch = savedFetch; });

test("unset HMAC setting preserves the legacy code hash and one admission per send", async () => {
  const response = await POST(request("send"));
  expect(response.status).toBe(200);
  expect(deliveredCode).toMatch(/^\d{6}$/);
  expect(storedHash).toBe(hash(legacyKey));
  expect(codeAdmissions()).toHaveLength(1);
  expect(await response.json()).toEqual({ sent: true, retryAfter: 60 });
});

test("a pending code survives API-key rotation with HMAC continuity and no fallback verification", async () => {
  process.env.EMAIL_CODE_HMAC_KEY = legacyKey;
  expect((await POST(request("send"))).status).toBe(200);
  const pendingHash = storedHash;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_synthetic-replacement-api-key";
  process.env.ABUSE_HMAC_KEY = "unrelated-abuse-key-for-isolation-test";
  process.env.DISCOVER_ACTOR_HMAC_KEY = "unrelated-discover-key-for-isolation-test";
  const response = await POST(request("verify", deliveredCode));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
  expect(codeAdmissions().map(([, args]) => args.p_code_hash)).toEqual([pendingHash, pendingHash]);
  expect(codeAdmissions().map(([, args]) => args.p_action)).toEqual(["send", "verify"]);
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockRpc.mock.calls.filter(([name]) => name === "email_code_finish")).toHaveLength(1);
  expect(global.fetch).toHaveBeenLastCalledWith("https://supabase.invalid/auth/v1/verify", expect.objectContaining({
    headers: expect.objectContaining({ apikey: forwardingKey }),
  }));
});

test("retiring the old HMAC rejects its pending code without trying another key or reaching Auth", async () => {
  expect((await POST(request("send"))).status).toBe(200);
  const oldHash = storedHash;
  process.env.EMAIL_CODE_HMAC_KEY = freshHmacKey;
  const response = await POST(request("verify", deliveredCode));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "That code is invalid or expired. Please try again." });
  expect(codeAdmissions()).toHaveLength(2);
  expect(codeAdmissions()[1][1].p_code_hash).toBe(hash(freshHmacKey));
  expect(codeAdmissions()[1][1].p_code_hash).not.toBe(oldHash);
  expect(mockGenerate).not.toHaveBeenCalled();
  expect(mockRpc.mock.calls.filter(([name]) => name === "email_code_finish")).toHaveLength(0);
});

test("fresh independent HMAC material signs and verifies new codes using its exact bytes", async () => {
  process.env.EMAIL_CODE_HMAC_KEY = ` ${freshHmacKey} `;
  expect((await POST(request("send"))).status).toBe(200);
  expect(storedHash).toBe(hash(` ${freshHmacKey} `));
  expect(storedHash).not.toBe(hash(legacyKey));
  expect((await POST(request("verify", deliveredCode))).status).toBe(200);
  expect(codeAdmissions()).toHaveLength(2);
});

test.each(["", "short", "x".repeat(31)])("invalid explicit HMAC setting fails closed without using the valid API-key fallback: %p", async key => {
  process.env.EMAIL_CODE_HMAC_KEY = key;
  const response = await POST(request("send"));
  expect(response.status).toBe(503);
  expect(mockRpc).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockGenerate).not.toHaveBeenCalled();
});
