// Temporary manual Staging test operations. No mount-time auth reads.
import type { SupabaseClient } from "@supabase/supabase-js";
import { signOutThisDevice, syncBrowserSession } from "@/lib/browserSession";

const pause = () => new Promise(resolve => setTimeout(resolve, 250));
export async function readQAAuthState(client: SupabaseClient) {
  const { data, error } = await client.auth.getSession();
  const cookie = await fetch("/auth/callback", { credentials: "include", cache: "no-store" });
  const cookieResult = await cookie.json();
  return { browserHasSession: !!data.session, errorName: error?.name, serverHasUser: !!cookieResult.userId,
    sameUser: !!data.session && cookieResult.userId === data.session.user.id };
}
export async function refreshQAOnce(client: SupabaseClient) {
  const result = await client.auth.refreshSession();
  return { errorName: result.error?.name ?? null, status: result.error?.status, returnedSession: !!result.data.session, state: await readQAAuthState(client) };
}
export async function signoutDuringQARefresh(client: SupabaseClient) {
  const pendingRefresh = client.auth.refreshSession();
  await pause();
  await signOutThisDevice(client);
  const result = await pendingRefresh;
  return { errorName: result.error?.name ?? null, status: result.error?.status, state: await readQAAuthState(client) };
}
export async function signoutDuringQACallback(client: SupabaseClient) {
  const { data } = await client.auth.getSession();
  if (!data.session) return { needsSignIn: true };
  const pendingSync = syncBrowserSession(data.session, "SIGNED_IN", client);
  await pause();
  await signOutThisDevice(client);
  await pendingSync;
  return readQAAuthState(client);
}
