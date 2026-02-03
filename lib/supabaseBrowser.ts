// /lib/supabaseBrowser.ts
import { createClient } from "@/lib/supabaseClient";

// Use the same singleton as supabaseClient to avoid "Multiple GoTrueClient instances"
export function createBrowserClient() {
  return createClient();
}
