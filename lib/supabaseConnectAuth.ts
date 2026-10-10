import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabaseServer";
import type { User } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve the logged-in user from Bearer token (optional) or Supabase SSR cookies.
 * Manual JWT cookie parsing fails when Supabase uses chunked cookies — use createServerClient.
 */
export async function getAuthenticatedUser(req?: NextRequest): Promise<User | null> {
  if (req) {
    const authorization = req.headers.get("authorization");
    if (authorization !== null) {
      const bearer = authorization.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/)?.[1];
      if (!bearer) return null;
      const {
        data: { user },
        error,
      } = await admin().auth.getUser(bearer);
      if (!error && user) return user;
      return null;
    }
  }

  const supabase = createServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (!error && user) return user;
  return null;
}
