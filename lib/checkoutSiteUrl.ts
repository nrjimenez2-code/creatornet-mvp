import { getSiteUrl } from './siteUrl';

// Metadata can remain canonical to production; transactional links must return
// to the deployment that owns their database rows and sandbox checkout.
export function getCheckoutSiteUrl(): string {
  if (process.env.VERCEL_ENV !== 'preview') return getSiteUrl();
  const host = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  const raw = process.env.SCHEDULING_OAUTH_ORIGIN || (host ? `https://${host}` : '');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Preview checkout origin is not configured');
  return url.origin;
}
