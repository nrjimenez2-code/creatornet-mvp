import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { startAuthTrace } from "@/lib/authDiagnostics";

// Serialize cookie writes so a delayed sign-in cannot overwrite a later sign-out.
let pending: Promise<void> = Promise.resolve();
const sameSession = (a: Session | null, b: Session | null) => a?.access_token === b?.access_token;
export function syncBrowserSession(session: Session | null, event = "SIGNED_IN", client?: SupabaseClient): Promise<void> {
  const writeCookies = async (value: Session | null, nextEvent: string) => {
    const finish = startAuthTrace(`cookie-sync-${nextEvent}`);
    const response = await fetch("/auth/callback", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", ...finish.headers },
      body: JSON.stringify({ event: nextEvent, access_token: value?.access_token ?? null, refresh_token: value?.refresh_token ?? null }),
    });
    const result = response.ok ? await response.json() : null;
    finish({ status: response.status });
    if (!response.ok || !result?.ok) throw Error("Could not synchronize your sign-in. Please try again.");
  };
  const synchronize = async () => {
    // Recheck after entering the shared queue. An old event must not write over
    // a sign-out or replacement login that happened while it was waiting.
    if (client) {
      const current = await readCurrentSession(client);
      if (!sameSession(session, current)) return;
    }
    await writeCookies(session, event);
    if (client) {
      const current = await readCurrentSession(client);
      // Also repair a response that was already in flight when auth changed.
      // Shared locks prevent another tab's callback response overtaking this.
      if (!sameSession(session, current)) await writeCookies(current, current ? "SIGNED_IN" : "SIGNED_OUT");
    }
  };
  const write = pending.catch(() => {}).then(async () => {
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      await navigator.locks.request("creatornet-session-cookie-sync", synchronize);
    } else {
      await synchronize();
    }
  });
  pending = write;
  return write;
}

export async function signOutThisDevice(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) throw error;
  await syncBrowserSession(null, "SIGNED_OUT", client);
}

function invalidSession(error: { status?: number; name?: string; code?: string } | null): boolean {
  return !error || error.status === 401 || error.status === 403 || error.name === "AuthSessionMissingError" ||
    ["refresh_token_not_found", "refresh_token_already_used", "session_not_found"].includes(error.code ?? "");
}

async function readCurrentSession(client: SupabaseClient): Promise<Session | null> {
  let result = await client.auth.getSession();
  if (result.error?.name === "AuthRefreshDiscardedError") {
    // Read storage again after coordination settled. Never retry old credentials.
    result = await client.auth.getSession();
  }
  if (result.error) throw Error("Could not verify your sign-in. Please try again.");
  return result.data.session;
}

/** Validate with Auth, then establish the server cookies before protected navigation. */
export async function prepareSessionNavigation(client: SupabaseClient): Promise<boolean> {
  const finish = startAuthTrace("session-navigation");
  try {
    // A single replacement may be adopted after verifying its own access token.
    // Continued auth changes cancel this navigation; the auth event starts a new one.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await readCurrentSession(client);
      if (!current) return false;
      const { data, error } = await client.auth.getUser(current.access_token);
      const afterVerification = await readCurrentSession(client);
      if (!sameSession(current, afterVerification)) {
        if (!afterVerification) return false;
        continue;
      }
      if (error || !data.user) {
        if (invalidSession(error)) {
          await signOutThisDevice(client);
          return false;
        }
        throw Error("Could not verify your sign-in. Please try again.");
      }
      if (current.user.id !== data.user.id) return false;
      await syncBrowserSession(current, "SIGNED_IN", client);
      // Confirm that the browser sent the cookies back before navigation.
      const response = await fetch("/auth/callback", { credentials: "include", cache: "no-store", headers: finish.headers });
      const cookieUser = response.ok ? (await response.json()).userId : null;
      const afterCookies = await readCurrentSession(client);
      if (!sameSession(current, afterCookies)) {
        if (!afterCookies) return false;
        continue;
      }
      if (!response.ok || cookieUser !== data.user.id) {
        throw Error("Could not verify your sign-in on this browser. Please try again.");
      }
      return true;
    }
    return false;
  } finally {
    finish();
  }
}

export function authNextPath(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  return next === "/profile" || next === "/profile/edit" ? next : null;
}
