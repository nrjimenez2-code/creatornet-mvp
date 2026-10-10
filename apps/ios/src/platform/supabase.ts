import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { readAppConfig } from '../config';
import { secureStorage } from './secureStorage';
const config = readAppConfig();
export const supabase = createSupabaseClient(config.supabaseUrl, config.supabasePublishableKey, {
  auth: { storage: secureStorage, storageKey: 'creatornet.ios.session', flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
export function createClient() { return supabase; }
