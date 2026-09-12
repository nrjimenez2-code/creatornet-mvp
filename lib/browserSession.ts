import type { Session, SupabaseClient } from "@supabase/supabase-js";

// Serialize cookie writes so a delayed sign-in cannot overwrite a later sign-out.
let pending: Promise<void> = Promise.resolve();
export function syncBrowserSession(session: Session | null, event = "SIGNED_IN"): Promise<void> {
  const write = pending.catch(() => {}).then(async () => {
    const response = await fetch("/auth/callback", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, access_token: session?.access_token ?? null, refresh_token: session?.refresh_token ?? null }),
    });
    if (!response.ok || !(await response.json()).ok) throw Error("Could not synchronize your sign-in. Please try again.");
  });
  pending = write;
  return write;
}

export async function signOutThisDevice(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) throw error;
  await syncBrowserSession(null, "SIGNED_OUT");
}

/** Validate with Auth, then establish the server cookies before protected navigation. */
export async function prepareSessionNavigation(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    if (!error || error.status === 401 || error.status === 403 || error.name === "AuthSessionMissingError" ||
        ["refresh_token_not_found", "refresh_token_already_used", "session_not_found"].includes(error.code ?? "")) {
      await signOutThisDevice(client);
      return false;
    }
    throw Error("Could not verify your sign-in. Please try again.");
  }
  const current = await client.auth.getSession();
  if (current.error) throw Error("Could not verify your sign-in. Please try again.");
  if (!current.data.session || current.data.session.user.id !== data.user.id) return false;
  await syncBrowserSession(current.data.session);
  // Confirm the browser actually sent the new cookies back. Without this,
  // rejected cookies could loop /profile -> /auth -> /profile indefinitely.
  const response = await fetch("/auth/callback", { credentials: "include", cache: "no-store" });
  if (!response.ok || (await response.json()).userId !== data.user.id) {
    throw Error("Could not verify your sign-in on this browser. Please try again.");
  }
  return true;
}

export function authNextPath(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  return next === "/profile" || next === "/profile/edit" ? next : null;
}
