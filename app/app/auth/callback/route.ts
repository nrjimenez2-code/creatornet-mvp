import { parseAppLink } from '@/packages/shared/src/appLinks';
export const dynamic = 'force-dynamic';
/** Universal links open the installed app; this page supplies a safe browser fallback. */
export async function GET(req: Request) {
  const query = new URL(req.url).search;
  const result = parseAppLink('creatornet://auth/callback' + query, 'https://www.creatornet.net');
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
  if (!result || result.kind !== 'auth') return new Response('<!doctype html><html lang="en"><title>CreatorNet</title><body><h1>Sign-in could not be completed</h1><p>Return to CreatorNet and try again.</p></body></html>', { status: 400, headers });
  const params = new URLSearchParams({ cn_state: result.state });
  if (result.code && !result.cancelled) params.set('code', result.code); else params.set('error', 'cancelled');
  const href = ('creatornet://auth/callback?' + params).replaceAll('&', '&amp;');
  return new Response(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CreatorNet</title><style>body{background:#000;color:#fff;font:18px system-ui;padding:32px;max-width:600px;margin:auto}a{color:#fff;background:#4A35C7;padding:16px;display:inline-block;border-radius:12px}</style></head><body><h1>Return to CreatorNet</h1><p>Continue your sign-in in the app.</p><a href="${href}">Open CreatorNet</a></body></html>`, { headers });
}
