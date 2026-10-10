import type { AppLink } from '@creatornet/shared/appLinks';
import { readAppConfig } from '../config';
import { supabase } from './supabase';
import { secureStorage } from './secureStorage';
import { openSystemBrowser } from './systemBrowser';
import { appApi } from './api';
const pendingKey = 'creatornet.ios.pending-auth';
type Pending = { state: string; started: number; provider: 'apple' | 'google' };
let callbackBusy = false;
/** The native account boundary replaces browser cookie synchronization. */
export async function validateNativeSession(userId: string): Promise<boolean> {
  const result = await appApi.json<{ profile: { id: string } }>('/api/mobile/profile/me');
  return result.profile.id === userId;
}
export async function pendingOAuth(): Promise<'apple' | 'google' | null> {
  const raw = await secureStorage.getItem(pendingKey);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as Pending;
    const age = Date.now() - pending.started;
    if (!['apple', 'google'].includes(pending.provider) || !Number.isFinite(age) || age < 0 || age > 600_000) { await cancelOAuth(); return null; }
    return pending.provider;
  } catch { await cancelOAuth(); return null; }
}
export async function beginOAuth(provider: 'apple' | 'google') {
  if (await pendingOAuth()) throw new Error('Complete or cancel your current sign-in first.');
  const pending: Pending = { state: crypto.randomUUID(), started: Date.now(), provider };
  await secureStorage.setItem(pendingKey, JSON.stringify(pending));
  try {
    const redirect = new URL(readAppConfig().authReturn);
    redirect.searchParams.set('cn_state', pending.state);
    const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: redirect.href, skipBrowserRedirect: true } });
    if (error || !data.url) throw new Error('Could not start sign-in. Please try again.');
    await openSystemBrowser(data.url);
  } catch (error) { await cancelOAuth(); throw error; }
}
export async function cancelOAuth() {
  await secureStorage.removeItem(pendingKey);
  await secureStorage.removeItem('creatornet.ios.session-code-verifier');
  window.dispatchEvent(new Event('creatornet:auth-pending-changed'));
}
export async function completeOAuth(link: Extract<AppLink, { kind: 'auth' }>): Promise<boolean> {
  if (callbackBusy) return false;
  callbackBusy = true;
  try {
    const raw = await secureStorage.getItem(pendingKey);
    if (!raw) return false;
    let pending: Pending;
    try { pending = JSON.parse(raw) as Pending; } catch { await cancelOAuth(); return false; }
    if (pending.state !== link.state) return false;
    const age = Date.now() - pending.started;
    if (!Number.isFinite(age) || age < 0 || age > 600_000 || link.cancelled || !link.code) { await cancelOAuth(); return false; }
    const { error } = await supabase.auth.exchangeCodeForSession(link.code);
    await cancelOAuth();
    if (error) throw new Error('Your sign-in expired. Please try again.');
    return true;
  } finally { callbackBusy = false; }
}
export async function emailCode(email: string, code?: string) {
  const result = await appApi.json<{ sent?: boolean; access_token?: string; refresh_token?: string }>('/api/mobile/auth/email-code', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, action: code ? 'verify' : 'send', ...(code ? { code } : {}) }),
  });
  if (result.access_token && result.refresh_token) {
    const { error } = await supabase.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
    if (error) throw new Error('Could not finish sign-in. Please try again.');
  }
  return result;
}
export async function logout() {
  await cancelOAuth();
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw new Error('Could not sign out. Please try again.');
}
