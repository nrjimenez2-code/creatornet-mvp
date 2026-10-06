// lib/supabaseServer.ts
import { cookies } from "next/headers";
import { createServerClient as createServerClientLib } from "@supabase/ssr";
import { createClient as createBearerClient } from "@supabase/supabase-js";

/**
 * Server Supabase client with a safe cookie adapter (Next 16 friendly).
 * - Works when cookies() can't be mutated (RSC renders) by swallowing writes.
 * - Supports async cookie access shapes expected by @supabase/ssr.
 */
export type ServerClientOptions = { readOnlyAuthCookies?: boolean; request?: Request };
export function createServerClient({ readOnlyAuthCookies = false, request }: ServerClientOptions = {}) {
  // A supplied bearer credential is exclusive: invalid credentials never fall
  // back to a browser cookie identity. Auth.getUser and database RLS verify it.
  const authorization = request?.headers.get("authorization");
  const mobile = request && new URL(request.url).pathname.startsWith('/api/mobile/');
  if (mobile || (authorization !== null && authorization !== undefined)) {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/)?.[1];
    return createBearerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      ...(authorization !== null && authorization !== undefined ? { global: { headers: { Authorization: `Bearer ${token ?? "invalid"}` } } } : {}),
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  const cookieAdapter = {
    get: async (name: string) => {
      const store = await cookies();
      return store.get(name)?.value;
    },
    set: async (name: string, value: string, options?: any) => {
      if (readOnlyAuthCookies) return;
      try {
        const store = await cookies();
        store.set(name, value, options as any);
      } catch {
        // In RSC render phases, Next disallows cookie mutations — ignore.
      }
    },
    remove: async (name: string, options?: any) => {
      if (readOnlyAuthCookies) return;
      try {
        const store = await cookies();
        store.set(name, "", { ...(options || {}), maxAge: 0 } as any);
      } catch {
        // Ignore where cookie mutations aren't allowed.
      }
    },
  };

  return createServerClientLib(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: cookieAdapter }
  );
}

/** Back-compat alias so older imports keep working */
export const createSupabaseServer = createServerClient;
