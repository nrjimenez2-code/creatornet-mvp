import { Capacitor, registerPlugin } from '@capacitor/core';
type SystemBrowser = { open(options: { url: string }): Promise<void> };
const system = registerPlugin<SystemBrowser>('CreatorNetSystemBrowser');
export async function openSystemBrowser(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => /^(access_token|refresh_token)$/i.test(key)) || /access_token|refresh_token/.test(url.hash)) throw new Error('Invalid browser destination.');
  if (Capacitor.isNativePlatform()) await system.open({ url: url.href });
  else {
    const opened = window.open(url.href, '_blank', 'noopener,noreferrer');
    if (!opened) throw new Error('Please allow CreatorNet to open your browser.');
  }
}
