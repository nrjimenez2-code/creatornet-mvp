// NOTE: no "use client" here so this module can be imported by both
// client components and server code (route handlers, Server Components).

import { createClient as createBrowserClient, SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr"; // safe to import everywhere
import { createMfaSessionGuard } from "@/lib/mfaSessionGuard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Browser/client factory (use in React client components) */
let _clientInstance: SupabaseClient | null = null;
let _mfaGuard: ReturnType<typeof createMfaSessionGuard> | null = null;
export function createClient(): SupabaseClient {
  // Client-side: reuse singleton to avoid "Multiple GoTrueClient instances" warning
  if (typeof window !== "undefined") {
    if (!_clientInstance) {
      const storageKey = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
      try {
        const storage = window.localStorage;
        storage.getItem(storageKey);
        _mfaGuard = createMfaSessionGuard(storageKey, storage, `${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`, (input, init) => fetch(input, init));
      } catch {
        // Preserve the SDK's in-memory fallback for ordinary sign-in when a
        // browser blocks storage. MFA needs a reliable persisted commit guard.
        _mfaGuard = null;
      }
      _clientInstance = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          // Bind OAuth callbacks to this browser's saved verifier. Implicit
          // token fragments can otherwise replace identity through a link.
          flowType: "pkce",
          storageKey,
          storage: _mfaGuard?.storage,
        },
        global: _mfaGuard ? { fetch: _mfaGuard.fetch } : undefined,
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

export function runMfaAction<T>(token: string, action: () => Promise<T>): Promise<T> {
  createClient();
  if (!_mfaGuard) throw Error("Authenticator setup requires browser storage. Allow site storage or use a regular browser window and sign in again.");
  return _mfaGuard.run(token, action);
}

export function isCurrentBrowserMfaSession(token: string): boolean {
  return _mfaGuard?.currentTokenMatches(token) ?? false;
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
