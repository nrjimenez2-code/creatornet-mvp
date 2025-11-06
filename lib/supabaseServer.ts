// lib/supabaseServer.ts
import { cookies } from "next/headers";
import { createServerClient as createServerClientLib } from "@supabase/ssr";

/**
 * Server Supabase client with safe cookie adapter for Next 16.
 * - Uses async cookie access (cookies() is a Promise in your setup)
 * - Swallows cookie writes in RSC renders to avoid runtime errors
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
        // In RSC renders, Next disallows cookie mutations — ignore.
      }
    },
    remove: async (name: string, options?: any) => {
      try {
        const store = await cookies();
        store.set(name, "", { ...(options || {}), maxAge: 0 } as any);
      } catch {
        // Ignore in RSC renders.
      }
    },
  };

  return createServerClientLib(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: cookieAdapter }
  );
}
