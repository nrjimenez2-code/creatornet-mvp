import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Service-role Supabase client for admin server code ONLY. Bypasses RLS —
 * never import from a client component, and never expose its results without
 * a requireAdmin() check first.
 */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Thrown by requireAdmin(); routes map `status` straight onto the response. */
export class AdminAuthError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AdminAuthError";
    this.status = status;
  }
}

/**
 * Map a requireAdmin() failure onto its response. AdminAuthError carries only
 * the two controlled literals thrown below — safe to show the caller. Anything
 * else is unexpected: log server-side, return a generic 500.
 *
 * Lives here rather than inline in route files for the same reason
 * lib/admin/moderation.ts hosts its own catch: the api-errors-headers
 * tripwire scans the route files under app/api for `.message` egress and cannot tell a
 * controlled message from a raw one. Bespoke admin routes that don't fit
 * runModerationAction call this instead of hand-rolling the catch.
 */
export function adminAuthErrorResponse(err: unknown, action: string): NextResponse {
  if (err instanceof AdminAuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(`[admin:${action}] auth check failed:`, err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export interface AdminContext {
  user: User;
  admin: SupabaseClient;
}

/**
 * Gate for /api/admin/* routes: resolves the caller from Bearer token or SSR
 * cookies, then verifies profiles.role === 'admin' with the service-role
 * client (so RLS can never hide the row). Throws AdminAuthError(401) when not
 * signed in, AdminAuthError(403) when signed in but not an admin; any other
 * error is a plain Error the route should surface as a 500.
 */
export async function requireAdmin(req?: NextRequest): Promise<AdminContext> {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    throw new AdminAuthError(401, "Not signed in");
  }

  const admin = adminClient();
  const { data: profile, error } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle<{ role: string }>();

  if (error) {
    throw new Error(`Admin role lookup failed: ${error.message}`);
  }
  if (profile?.role !== "admin") {
    throw new AdminAuthError(403, "Admin role required");
  }

  return { user, admin };
}
