import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Server-side Supabase client for Server Components / layouts.
 * - cookies() is async on your Next version -> await it here
 * - Readonly cookies during render -> provide no-op set/remove
 */
export async function createSupabaseServer() {
  const cookieStore = await cookies(); // <-- await fixes the TS "Promise<...>" error

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        // No-ops because Server Components cannot mutate cookies during render.
        set(_name: string, _value: string, _options: CookieOptions) {},
        remove(_name: string, _options: CookieOptions) {},
      },
    }
  );
}
