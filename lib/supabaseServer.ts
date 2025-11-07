// lib/supabaseServer.ts
import { cookies } from "next/headers";
import { createServerClient as createServerClientLib } from "@supabase/ssr";

/**
 * Server Supabase client with a safe cookie adapter (Next 16 friendly).
 * - Works when cookies() can't be mutated (RSC renders) by swallowing writes.
 * - Supports async cookie access shapes expected by @supabase/ssr.
 */
export function createServerClient() {
  const cookieAdapter = {
    get: async (name: string) => {
      const store = await cookies();
      return store.get(name)?.value;
    },
    set: async (name: string, value: string, options?: any) => {
      try {
        const store = await cookies();
        store.set(name, value, options as any);
      } catch {
        // In RSC render phases, Next disallows cookie mutations — ignore.
      }
    },
    remove: async (name: string, options?: any) => {
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
