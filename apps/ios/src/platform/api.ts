import { AppApiClient } from '@creatornet/shared/apiClient';
import { readAppConfig } from '../config';
import { supabase } from './supabase';
const transport: typeof fetch = async (input, init) => {
  if (import.meta.env.DEV && import.meta.env.VITE_CREATORNET_RENDERER_FIXTURE === 'true') {
    const { iosFixtureFetch } = await import('@/test-support/iosRendererFixtures');
    return iosFixtureFetch(input, init);
  }
  return globalThis.fetch(input, init);
};
let generation = 0;
let lastUser: string | null = null;
supabase.auth.onAuthStateChange((event, session) => {
  const next = session?.user.id ?? null;
  if (event === 'SIGNED_OUT' || next !== lastUser) generation += 1;
  lastUser = next;
});
export const appApi = new AppApiClient(readAppConfig().websiteOrigin, async () => {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error('Could not read your session.');
  return data.session ? { userId: data.session.user.id, accessToken: data.session.access_token, generation } : null;
}, transport);
export const nativeApiFetch: typeof fetch = async (input, init) => {
  const value = input instanceof Request ? input.url : String(input);
  const local = new URL(value, window.location.href);
  const here = new URL(window.location.href);
  if (local.protocol !== here.protocol || local.host !== here.host || !local.pathname.startsWith('/api/')) throw new Error('Unknown app API destination.');
  if (input instanceof Request) throw new Error('Use an explicit app API path and request options.');
  return appApi.request('/api/mobile/' + local.pathname.slice(5) + local.search, init);
};
