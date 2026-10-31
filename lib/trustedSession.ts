import "server-only";
import type { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabaseServer";

export type TrustedSession = { user: User; accessToken: string };
/** Return identity and token from ONE verified credential path. A cookie user
 * must never inherit assurance from a different caller-supplied Bearer token. */
export async function getTrustedSession(req?: NextRequest): Promise<TrustedSession | null> {
  const client = createServerClient({ request: req, readOnlyAuthCookies: true });
  const bearer = req?.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (bearer) {
    const result = await client.auth.getUser(bearer);
    if (!result.error && result.data.user) return { user: result.data.user, accessToken: bearer };
  }
  // getSession supplies the cookie token only; its user/claims are untrusted
  // until Auth verifies that exact access token below. Supports chunked cookies.
  const result = await client.auth.getSession();
  const accessToken = result.data.session?.access_token;
  if (result.error || !accessToken) return null;
  const verified = await client.auth.getUser(accessToken);
  return verified.error || !verified.data.user ? null : { user: verified.data.user, accessToken };
}
