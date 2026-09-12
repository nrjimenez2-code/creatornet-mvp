import { createClient } from "@/lib/supabaseClient";

/** Refresh the local token only for an explicit protected action, never on mount.
 * Components still use the shared UserProvider for rendered identity.
 */
export function getActionSession() {
  return createClient().auth.getSession();
}
