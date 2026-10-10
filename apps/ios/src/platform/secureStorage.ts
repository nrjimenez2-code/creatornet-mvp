import { Capacitor, registerPlugin } from '@capacitor/core';
import type { SupportedStorage } from '@supabase/supabase-js';

type SecureStoragePlugin = {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};
const keychain = registerPlugin<SecureStoragePlugin>('CreatorNetSecureStorage');
// Browser feasibility checks use memory only. Native sessions never fall back to web storage.
const preview = new Map<string, string>();
export const secureStorage: SupportedStorage = {
  async getItem(key) { return Capacitor.isNativePlatform() ? (await keychain.get({ key })).value : preview.get(key) ?? null; },
  async setItem(key, value) { if (Capacitor.isNativePlatform()) await keychain.set({ key, value }); else preview.set(key, value); },
  async removeItem(key) { if (Capacitor.isNativePlatform()) await keychain.remove({ key }); else preview.delete(key); },
};
