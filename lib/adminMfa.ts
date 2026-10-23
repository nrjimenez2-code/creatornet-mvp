import "server-only";
import type { NextRequest } from "next/server";
import { getTrustedSession, type TrustedSession } from "@/lib/trustedSession";

export const MFA_FRESH_SECONDS = 600;
export class MfaRequiredError extends Error {
  readonly status = 403;
  readonly securityUrl = "/account/security";
  constructor(readonly code: "MFA_ENROLLMENT_REQUIRED" | "MFA_REQUIRED" | "MFA_REFRESH_REQUIRED") {
    super(code === "MFA_ENROLLMENT_REQUIRED" ? "Set up an authenticator before using administrator controls." : "Verify your authenticator before using administrator controls.");
    this.name = "MfaRequiredError";
  }
}

/** Only call with a token verified by getTrustedSession; never raw cookies. */
export function trustedMfaStatus(session: TrustedSession, now = Date.now()) {
  const verifiedFactors = (session.user.factors ?? []).filter(factor => factor.factor_type === "totp" && factor.status === "verified");
  let aal2 = false, recent = false;
  try {
    const claims = JSON.parse(Buffer.from(session.accessToken.split(".")[1], "base64url").toString("utf8"));
    aal2 = claims.sub === session.user.id && claims.aal === "aal2";
    recent = Array.isArray(claims.amr) && claims.amr.some((method: { method?: unknown; timestamp?: unknown }) => method?.method === "totp" && typeof method.timestamp === "number" && Number.isFinite(method.timestamp) && method.timestamp <= now / 1000 + 30 && method.timestamp >= now / 1000 - MFA_FRESH_SECONDS);
  } catch { /* malformed claims never grant assurance */ }
  return { verifiedFactorCount: verifiedFactors.length, aal2: aal2 && verifiedFactors.length > 0, recent };
}

export async function requireAdminMfa(userId: string, req?: NextRequest) {
  const session = await getTrustedSession(req);
  if (!session || session.user.id !== userId) throw new MfaRequiredError("MFA_REQUIRED");
  const status = trustedMfaStatus(session);
  if (!status.verifiedFactorCount) throw new MfaRequiredError("MFA_ENROLLMENT_REQUIRED");
  if (!status.aal2) throw new MfaRequiredError("MFA_REQUIRED");
  if (req && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !status.recent) throw new MfaRequiredError("MFA_REFRESH_REQUIRED");
  return session;
}
