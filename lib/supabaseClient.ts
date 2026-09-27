// NOTE: no "use client" here so this module can be imported by both
// client components and server code (route handlers, Server Components).

import { createClient as createBrowserClient, SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr"; // safe to import everywhere

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Browser/client factory (use in React client components) */
let _clientInstance: SupabaseClient | null = null;
export function createClient(): SupabaseClient {
  // Client-side: reuse singleton to avoid "Multiple GoTrueClient instances" warning
  if (typeof window !== "undefined") {
    if (!_clientInstance) {
      _clientInstance = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.localStorage,
        },
      });
    }
    return _clientInstance;
  }
  
  // Server-side: always create new instance
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Server factory (use in route handlers / Server Components).
 * Avoids a static `import { cookies } from "next/headers"` so this file
 * remains importable by client bundles.
 */
export async function createServerSupabase(): Promise<SupabaseClient> {
  if (typeof window !== "undefined") {
    throw new Error("createServerSupabase() must be called on the server.");
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cookies } = require("next/headers");
  const store = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      get(name: string) {
        return store.get(name)?.value;
      },
      set() {},
      remove() {},
    },
  });
}

/** Back-compat singleton so old code `import { supabase } ...` keeps working (browser use) */
let _singleton: SupabaseClient | null = null;
export const supabase: SupabaseClient = (_singleton ||= createClient());
