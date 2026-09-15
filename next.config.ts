import {withSentryConfig} from "@sentry/nextjs";
import type { NextConfig } from "next";

// Response headers that cannot change how a page renders, only who may
// embed it and what the browser leaks about it. A full Content-Security-Policy
// with script/style sources is deliberately NOT set here: it would need a
// nonce pipeline and an allowlist for Stripe, Supabase, PostHog, Sentry, R2
// and Google Fonts, and getting any of those wrong blanks the page. The
// frame-ancestors directive is the one CSP rule that is safe on its own.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];


// The three public *.vercel.app copies of production. Each is a separate Vercel
// project deploying THIS repo, so all three serve a byte-identical app against
// the same production database, are indexable, and are not redirected at the
// platform level.
//
// This is not only an SEO problem. Supabase session cookies are host-only, so a
// visitor who signs in on one of these copies and then buys is returned by
// Stripe to NEXT_PUBLIC_SITE_URL (www) carrying no session — /api/confirm-purchase
// 401s and a real buyer is charged with nothing delivered.
//
// Matched as EXACT hostnames on purpose. Preview deployments are
// `<project>-<hash>-<team>.vercel.app`, which none of these match, so review
// previews keep working.
const DUPLICATE_PROD_HOSTS = [
  "creatornet-mvp.vercel.app",
  "creatornet-mvpv2.vercel.app",
  "nextjs-7fjq.vercel.app",
];
const DUPLICATE_HOST_PATTERN = `(${DUPLICATE_PROD_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|")})`;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Drop the default `x-powered-by: Next.js` response header. It only tells an
  // attacker which framework (and therefore which CVE list) to try.
  poweredByHeader: false,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "media.creatornet.net", pathname: "/thumbnails/**", search: "" }],
  },

  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },

  async redirects() {
    // 307, not 308: reversible. These hosts have no meaningful inbound links, so
    // there is no link equity to preserve, and a permanent redirect would be
    // cached hard by browsers if one of these projects is ever repurposed.
    //
    // /api/* is deliberately NOT redirected. The Stripe webhook endpoint URL
    // lives in the Stripe dashboard and cannot be read from here; if it still
    // points at one of these hosts, redirecting it would silently drop payment
    // notifications, because Stripe does not follow redirects.
    const has = [{ type: "host" as const, value: DUPLICATE_HOST_PATTERN }];
    return [
      { source: "/", has, destination: "https://www.creatornet.net/", permanent: false },
      {
        source: "/:path((?!api/).*)",
        has,
        destination: "https://www.creatornet.net/:path",
        permanent: false,
      },
    ];
  },
};

// Sentry config - sourcemap upload will be skipped if SENTRY_AUTH_TOKEN is not set
const sentryConfig = {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "creatornet",

  project: "creatornet-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: true,

  // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
  // See the following for more information:
  // https://docs.sentry.io/product/crons/
  // https://vercel.com/docs/cron-jobs
  automaticVercelMonitors: true,
};

// Only wrap with Sentry if auth token is available, otherwise use plain config
export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, sentryConfig)
  : nextConfig;
