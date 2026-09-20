import { handleEmailCode } from "@/lib/emailCode";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isIP } from "node:net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ip = process.env.VERCEL === "1" ? req.headers.get("x-vercel-forwarded-for") : null;
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_CODE_FROM || !process.env.SUPABASE_AUTH_SECRET_KEY?.startsWith("sb_secret_") || !ip || !isIP(ip)) {
    return Response.json({ error: "Sign-in is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store, private" } });
  }
  return handleEmailCode(req, {
    secret: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    clientIp: ip,
    async rpc(name, args) {
      const { data, error } = await supabaseAdmin.rpc(name, args);
      if (error) throw new Error("Email code admission unavailable");
      return data;
    },
    async sendCode(email, code) {
      const key = process.env.RESEND_API_KEY;
      const from = process.env.EMAIL_CODE_FROM;
      if (!key || !from) throw new Error("Email configuration unavailable");
      const sent = await fetch("https://api.resend.com/emails", {
        method: "POST", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [email], subject: "Your CreatorNet sign-in code", text: `Your CreatorNet sign-in code is ${code}.\n\nEnter it on CreatorNet to sign in. It expires in 10 minutes and can only be used once.\n\nIf you did not request this code, you can ignore this email.` }),
      });
      if (!sent.ok) throw new Error("Email delivery unavailable");
    },
    async createSession(email, agent) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      // Supabase accepts forwarded client IPs only with modern secret keys.
      // Vercel overwrites this header; never trust a caller-selected generic XFF.
      const key = process.env.SUPABASE_AUTH_SECRET_KEY;
      const ip = process.env.VERCEL === "1" ? req.headers.get("x-vercel-forwarded-for") : null;
      if (!url || !key?.startsWith("sb_secret_") || !ip || !isIP(ip)) throw new Error("Auth configuration unavailable");
      // Admin generation sends no email. Its provider credential never leaves
      // the server; only our separately verified six-digit code admits this call.
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email });
      if (error || !data.properties?.hashed_token) throw new Error("Session generation unavailable");
      return fetch(`${url}/auth/v1/verify`, {
        method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { apikey: key, "Sb-Forwarded-For": ip, "Content-Type": "application/json", ...(agent ? { "User-Agent": agent } : {}) },
        body: JSON.stringify({ token_hash: data.properties.hashed_token, type: data.properties.verification_type }),
      });
    },
  });
}
