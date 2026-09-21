import "server-only";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { isIP } from "node:net";

type Admission = { allowed?: boolean; verified?: boolean; retry_after?: number; reason?: string };
export type EmailCodeDependencies = {
  rpc: (name: string, args: Record<string, string>) => Promise<Admission>;
  secret: string;
  clientIp: string;
  sendCode: (email: string, code: string) => Promise<void>;
  createSession: (email: string, agent: string) => Promise<Response>;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function reply(status: number, body: Record<string, unknown>, retry = 0) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store, private",
    ...(retry > 0 ? { "Retry-After": String(retry) } : {}),
  } });
}

export async function handleEmailCode(req: Request, deps: EmailCodeDependencies) {
  if (req.headers.get("origin") !== new URL(req.url).origin) return reply(403, { error: "Please sign in on CreatorNet." });
  let input: { email?: unknown; action?: unknown; code?: unknown };
  try {
    const reader = req.body?.getReader();
    if (!reader) return reply(400, { error: "Enter your email address." });
    let text = "";
    let size = 0;
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); return reply(413, { error: "Request too large." }); }
      text += decoder.decode(value, { stream: true });
    }
    input = JSON.parse(text + decoder.decode());
    if (!input || typeof input !== "object") throw new Error("Invalid body");
  } catch { return reply(400, { error: "Enter your email address." }); }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["send", "verify"].includes(String(input.action))) {
    return reply(400, { error: "Enter a valid email address." });
  }
  const verify = input.action === "verify";
  if (verify && (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))) return reply(400, { error: "Enter the complete six-digit code." });
  const key = digest(email);
  const code = verify ? input.code as string : String(randomInt(0, 1_000_000)).padStart(6, "0");
  if (deps.secret.length < 32 || !isIP(deps.clientIp)) return reply(503, { error: "Sign-in is temporarily unavailable." });
  // This code is independent of Supabase's public OTP endpoint. Native OTP
  // guesses cannot reveal the code that this server checks before Auth is called.
  const codeHash = createHmac("sha256", deps.secret).update(`CreatorNetEmailCode:v1:${email}:${code}`).digest("hex");
  const agent = `CreatorNetEmailCode/${randomBytes(32).toString("hex")}`;
  const admissionHash = digest(agent);
  try {
    const ipAdmission = await deps.rpc("email_code_ip_admit", { p_ip_key: digest(deps.clientIp) });
    if (ipAdmission.allowed !== true) {
      const retry = Math.max(1, ipAdmission.retry_after ?? 300);
      return reply(429, { error: "Too many requests. Please wait before trying again.", retryAfter: retry }, retry);
    }
    const admission = await deps.rpc("email_code_admit", { p_email_key: key, p_action: verify ? "verify" : "send", p_code_hash: codeHash, ...(verify ? { p_admission_hash: admissionHash } : {}) });
    if (admission.allowed !== true) {
      if (admission.reason === "invalid") return reply(400, { error: "That code is invalid or expired. Please try again." });
      const retry = Math.max(1, admission.retry_after ?? 30);
      return reply(429, { error: admission.reason === "locked" ? "Too many code attempts. Please wait 15 minutes before trying again." : "Please wait before trying again.", retryAfter: retry, locked: admission.reason === "locked" }, retry);
    }
    if (!verify) {
      await deps.sendCode(email, code);
      return reply(200, { sent: true, retryAfter: 60 });
    }
    const result = await deps.createSession(email, agent);
    // Only the provider's token hook can mark the reservation successful.
    // Missing/disabled hook or a failed DB read must never expose session tokens.
    const finish = await deps.rpc("email_code_finish", { p_email_key: key, p_admission_hash: admissionHash });
    if (!result.ok) {
      const retry = finish.retry_after ?? 0;
      return reply(retry ? 429 : 400, { error: retry ? "Too many code attempts. Please wait 15 minutes before trying again." : "That code is invalid or expired. Please try again.", retryAfter: retry, locked: retry > 0 }, retry);
    }
    if (finish.verified !== true) return reply(503, { error: "Sign-in is temporarily unavailable. Please try again shortly." });
    const session = await result.json();
    if (typeof session.access_token !== "string" || typeof session.refresh_token !== "string") throw new Error("Invalid provider response");
    return reply(200, { access_token: session.access_token, refresh_token: session.refresh_token });
  } catch {
    // An uncertain provider call still spends an attempt. Its 30-second lease
    // expires automatically; never refund it based on a client cancellation.
    const retry = verify ? 30 : 60;
    return reply(503, { error: verify ? "Sign-in is temporarily unavailable. Please request a new code and try again shortly." : "Unable to send a code right now. Please wait a minute and try again.", retryAfter: retry }, retry);
  }
}
