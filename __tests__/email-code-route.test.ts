import { handleEmailCode, type EmailCodeDependencies } from "@/lib/emailCode";
const req = (body: unknown, origin = "https://creatornet.net") => new Request("https://creatornet.net/api/auth/email-code", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const input = { action: "verify", email: " Person@Example.test ", code: "123456" };
let rpc: jest.Mock;
let provider: jest.Mock;
let sendCode: jest.Mock;
let deps: EmailCodeDependencies;
beforeEach(() => {
  rpc = jest.fn().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ verified: true });
  provider = jest.fn().mockResolvedValue(Response.json({ access_token: "access", refresh_token: "refresh" }));
  sendCode = jest.fn().mockResolvedValue(undefined);
  deps = { rpc: (name, args) => name === "email_code_ip_admit" ? Promise.resolve({ allowed: true }) : rpc(name, args), createSession: provider, sendCode, secret: "synthetic-not-a-secret".repeat(3), clientIp: "192.0.2.1" };
});
test("successful admission forwards only the session and never the server nonce", async () => {
  const response = await handleEmailCode(req(input), deps);
  expect(await response.json()).toEqual({ access_token: "access", refresh_token: "refresh" });
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(provider).toHaveBeenCalledWith("person@example.test", expect.stringMatching(/^CreatorNetEmailCode\/[a-f0-9]{64}$/));
  expect(rpc.mock.calls[0][1].p_email_key).toMatch(/^[a-f0-9]{64}$/);
});
test("locked accounts never call Auth", async () => {
  rpc.mockReset().mockResolvedValue({ allowed: false, reason: "locked", retry_after: 899 });
  const response = await handleEmailCode(req(input), deps);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("899");
  expect(provider).not.toHaveBeenCalled();
});
test("disabled hook or failed finish cannot leak issued tokens", async () => {
  rpc.mockReset().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ verified: false });
  const response = await handleEmailCode(req(input), deps);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('"access"');
});
test("a provider failure finishes the reservation and returns a lockout", async () => {
  provider.mockResolvedValue(Response.json({ error: "invalid" }, { status: 403 }));
  rpc.mockReset().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ verified: false, retry_after: 900 });
  const response = await handleEmailCode(req(input), deps);
  expect(response.status).toBe(429);
  expect(rpc).toHaveBeenCalledTimes(2);
});
test("provider timeout never refunds the reserved attempt", async () => {
  provider.mockRejectedValue(new Error("timeout"));
  expect((await handleEmailCode(req(input), deps)).status).toBe(503);
  expect(rpc).toHaveBeenCalledTimes(1);
});
test("unavailable counter fails closed", async () => {
  rpc.mockReset().mockRejectedValue(new Error("unavailable"));
  expect((await handleEmailCode(req(input), deps)).status).toBe(503);
  expect(provider).not.toHaveBeenCalled();
});
test("email sending supports new users and returns cooldown", async () => {
  const response = await handleEmailCode(req({ email: input.email, action: "send" }), deps);
  expect(await response.json()).toEqual({ sent: true, retryAfter: 60 });
  expect(sendCode).toHaveBeenCalledWith("person@example.test", expect.stringMatching(/^\d{6}$/));
  expect(provider).not.toHaveBeenCalled();
});
test("wrong application codes never reach Supabase, even if a native OTP is guessed", async () => {
  rpc.mockReset().mockResolvedValue({ allowed: false, reason: "invalid" });
  expect((await handleEmailCode(req(input), deps)).status).toBe(400);
  expect(provider).not.toHaveBeenCalled();
  expect(sendCode).not.toHaveBeenCalled();
});
test("IP limits stop requests before an account record or email is created", async () => {
  deps.rpc = jest.fn().mockResolvedValue({ allowed: false, retry_after: 300 });
  expect((await handleEmailCode(req({ action: "send", email: input.email }), deps)).status).toBe(429);
  expect(deps.rpc).toHaveBeenCalledTimes(1);
  expect(provider).not.toHaveBeenCalled();
  expect(sendCode).not.toHaveBeenCalled();
});
test("cross-origin and malformed requests do not reach the counter", async () => {
  expect((await handleEmailCode(req(input, "https://elsewhere.test"), deps)).status).toBe(403);
  expect((await handleEmailCode(req({ ...input, code: "12345" }), deps)).status).toBe(400);
  expect((await handleEmailCode(req(null), deps)).status).toBe(400);
  expect((await handleEmailCode(req({ padding: "x".repeat(5000) }), deps)).status).toBe(413);
  expect(rpc).not.toHaveBeenCalled();
});
