// lib/siteUrl.ts
export function getSiteUrl() {
    // Prefer explicit public URL for client-visible redirects
    const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.trim();
    if (fromEnv) return fromEnv.replace(/\/+$/, "");
    // Vercel fallback
    const vercel = process.env.VERCEL_URL?.trim();
    if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
    // Dev fallback
    return "http://localhost:3000";
  }
  