export type AppConfig = { websiteOrigin: string; supabaseUrl: string; supabasePublishableKey: string; authReturn: string };
export function readAppConfig(): AppConfig {
  const website = new URL(import.meta.env.VITE_CREATORNET_API_ORIGIN);
  const supabase = new URL(import.meta.env.VITE_SUPABASE_URL);
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  for (const url of [website, supabase]) {
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid public app configuration.');
  }
  if (!key || key.startsWith('sb_secret_')) throw new Error('A Supabase publishable key is required.');
  if (!key.startsWith('sb_publishable_') && key !== 'ci-not-a-real-key') {
    // Existing anon keys may only carry the public anon role.
    try { if (JSON.parse(atob(key.split('.')[1])).role !== 'anon') throw new Error(); }
    catch { throw new Error('A public Supabase key is required.'); }
  }
  return { websiteOrigin: website.origin, supabaseUrl: supabase.origin, supabasePublishableKey: key, authReturn: website.origin + '/app/auth/callback' };
}
