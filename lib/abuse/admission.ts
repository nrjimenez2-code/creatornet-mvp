import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";

export type AbuseAction = "feed_page" | "feed_session" | "search" | "search_suggest" | "public_upload" | "premium_upload";
export class AdmissionError extends Error {
  constructor(public readonly status: 429 | 503, public readonly retryAfter = 30) { super(status === 429 ? "Please wait before trying again." : "Temporarily unavailable. Please try again shortly."); }
}
// Domain separation reuses a server-only key without a new credential. Rotation
// changes privacy hashes/counter identities; retain old reservation keys during
// planned rotations if in-flight upload recovery must span that rotation.
export function abuseHash(domain: string, value: string): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.length < 32) throw new AdmissionError(503);
  return createHmac("sha256", key).update(`CreatorNetAbuse:v1:${domain}:${value}`).digest("hex");
}
export function trustedClientIp(req: Request): string {
  // Vercel overwrites its own single-IP header. Generic XFF is caller-controlled
  // off-platform and must never select a production quota key.
  const raw = process.env.VERCEL === "1" ? req.headers.get("x-vercel-forwarded-for") : null;
  if (raw && isIP(raw)) return raw.includes(":") ? new URL(`http://[${raw}]/`).hostname.slice(1,-1) : raw;
  if (process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1") return "127.0.0.1";
  throw new AdmissionError(503);
}
export function admissionResponse(error: unknown): NextResponse | null {
  return error instanceof AdmissionError ? NextResponse.json({ error: error.message, code: error.status === 429 ? "RATE_LIMITED" : "ADMISSION_UNAVAILABLE" },
    {status:error.status,headers:{"Cache-Control":"private, no-store","Retry-After":String(error.retryAfter)}}) : null;
}
export type UploadAdmission = { operation: string; contract: string; resource: string; bytes: number; seconds?: number };
export async function admitRequest(req: Request, action: AbuseAction, identity?: string | null, upload?: UploadAdmission): Promise<{resource: string | null; reused: boolean}> {
  const ip = trustedClientIp(req);
  if (identity === undefined) {
    try {
      const user = await getAuthenticatedUser(new NextRequest(req.url, {headers:req.headers}), {readOnlyAuthCookies:true});
      identity = user ? `user:${user.id}` : `ip:${ip}`;
    } catch { throw new AdmissionError(503); }
  }
  identity ??= `ip:${ip}`;
  let result;
  try {
    result = await supabaseAdmin.rpc("abuse_admit_v1", {
      p_action:action,p_actor:identity === `ip:${ip}` ? abuseHash("ip",ip) : abuseHash("actor",identity),p_ip:abuseHash("ip",ip),
      p_operation:upload ? abuseHash("operation",upload.operation) : null,
      p_contract:upload ? abuseHash("contract",upload.contract) : null,
      p_resource:upload?.resource ?? null,p_bytes:upload?.bytes ?? 0,p_seconds:upload?.seconds ?? 0,
    }).abortSignal(AbortSignal.timeout(5000));
  } catch { throw new AdmissionError(503); }
  if (result.error || !result.data || typeof result.data.allowed !== "boolean") throw new AdmissionError(503);
  if (!result.data.allowed) throw new AdmissionError(429, Math.max(1,Math.min(86400,Number(result.data.retry_after)||30)));
  if (upload && (typeof result.data.resource !== "string" || !result.data.resource)) throw new AdmissionError(503);
  return {resource:result.data.resource ?? null,reused:result.data.reused === true};
}
