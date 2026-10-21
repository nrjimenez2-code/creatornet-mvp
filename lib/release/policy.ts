/** Shared, dependency-free release policy. Unknown routes are always private. */
export const FEATURES = {
  registration: { label: "Public account registration", requires: [] },
  feed: { label: "Discover and Following", requires: [] },
  profiles: { label: "Creator profiles", requires: [] },
  search: { label: "Search and hashtags", requires: ["feed", "profiles"] },
  engagement: { label: "Likes, comments, follows and reports", requires: ["feed", "profiles"] },
  publishing: { label: "Post composer and uploads", requires: ["profiles"] },
  products: { label: "Products and offers", requires: ["profiles"] },
  checkout: { label: "New purchases", requires: ["products"] },
  tips: { label: "New video tips", requires: ["feed"] },
  memberships: { label: "New memberships", requires: ["products", "checkout"] },
  scheduling: { label: "New bookings", requires: ["profiles", "checkout"] },
  notifications: { label: "Notifications", requires: [] },
  analytics: { label: "Creator analytics", requires: ["publishing"] },
  creatorTools: { label: "Creator account and payment setup", requires: ["profiles"] },
} as const;
export type Feature = keyof typeof FEATURES;
export type FeatureFlags = Record<Feature, boolean>;
export const closedFeatures = (): FeatureFlags => Object.fromEntries(Object.keys(FEATURES).map(key => [key, false])) as FeatureFlags;
export const SETTINGS_ID = "00000000-0000-4000-8000-000000000001";
export type ReleaseSettings = {
  id: string; owner_id: string | null; hidden: boolean; features: FeatureFlags;
  discord_invite: string | null; revision: number; updated_at: string;
};

export function validDiscordInvite(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/(discord\.gg\/[A-Za-z0-9-]+|discord\.com\/invite\/[A-Za-z0-9-]+)$/.test(value);
}
export function validFlags(value: unknown): value is FeatureFlags {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const flags = value as Record<string, unknown>;
  return Object.keys(flags).length === Object.keys(FEATURES).length && Object.keys(FEATURES).every(key => typeof flags[key] === "boolean");
}
export function dependenciesMet(flags: FeatureFlags): boolean {
  return (Object.keys(FEATURES) as Feature[]).every(key => !flags[key] || FEATURES[key].requires.every(dependency => flags[dependency]));
}
export function featureOpen(settings: ReleaseSettings | null, feature: Feature | null): boolean {
  return Boolean(settings && !settings.hidden && feature && settings.features[feature] && dependenciesMet(settings.features));
}
export type RoutePolicy = { kind: "public" | "operation" | "purchase" | "continuation" | "owner" | "product"; feature?: Feature };
const operationMethods: Record<string, string> = {
  "/api/stripe/webhook": "POST", "/api/webhook": "POST",
  "/api/search/enrich": "GET",
  "/api/installments/collect": "GET", "/api/memberships/collect": "GET", "/api/memberships/recover-exits": "GET",
  "/api/scheduling/google/jobs": "GET", "/api/scheduling/google/sync": "GET", "/api/scheduling/google/maintenance": "GET",
  "/api/scheduling/google/notifications": "POST",
};
const purchaseRules: Array<[RegExp, string[]]> = [
  [/^\/(library(?:\/[^/]+\/[^/]+)?|access\/[^/]+|success|cancel|payments\/recovery\/[^/]+)$/, ["GET", "HEAD"]],
  [/^\/memberships\/(complete|recovery|renewal-recovery|renewal-retry|payoff)$/, ["GET", "HEAD"]],
  [/^\/scheduling\/complete$/, ["GET", "HEAD"]],
  [/^\/api\/confirm-purchase$/, ["POST"]],
  [/^\/api\/purchases\/by-session$/, ["GET"]],
  [/^\/api\/purchases\/[^/]+\/delivery$/, ["GET"]],
  [/^\/api\/library\/eligibility$/, ["POST"]],
  [/^\/api\/private-videos\/[^/]+(?:\/(playback|download))?$/, ["GET"]],
  [/^\/api\/private-videos\/[^/]+\/download$/, ["POST"]],
  [/^\/api\/private-videos\/[^/]+$/, ["DELETE"]],
  [/^\/api\/private-videos\/[^/]+\/progress$/, ["PUT"]],
  [/^\/api\/watch\/[^/]+$/, ["GET"]],
  [/^\/api\/watch\/progress$/, ["GET", "POST"]],
  [/^\/watch\/[^/]+$/, ["GET", "HEAD"]],
  [/^\/api\/calls(?:\/[^/]+\/schedule)?$/, ["GET"]],
  [/^\/api\/memberships$/, ["GET"]],
  [/^\/memberships$/, ["GET", "HEAD"]],
  [/^\/api\/library\/creators$/, ["GET"]],
  [/^\/api\/memberships\/[^/]+\/payoff$/, ["GET"]],
  [/^\/api\/scheduling\/google\/reservations\/[^/]+$/, ["GET", "DELETE"]],
  [/^\/api\/scheduling\/google\/reservations\/[^/]+\/times$/, ["GET", "POST"]],
  [/^\/calls$/, ["GET", "HEAD"]],
  [/^\/api\/installments\/recovery$/, ["GET", "POST"]],
  // Existing setup must be allowed to finish. These handlers require a saved
  // Connect account or an unexpired, user-bound OAuth attempt and state cookie.
  [/^\/api\/stripe\/connect\/(return|refresh)$/, ["GET"]],
  [/^\/api\/scheduling\/oauth\/callback\/(calcom|calendly|google)$/, ["GET"]],
  [/^\/api\/memberships\/[^/]+\/(confirm|recovery|renewal-recovery|renewal-retry|bank-verification|payoff|exit)$/, ["POST"]],
  [/^\/api\/tips\/[^/]+\/status$/, ["GET"]],
];
export function routePolicy(path: string, method = "GET"): RoutePolicy {
  if (operationMethods[path] === method) return { kind: "operation" };
  if (path === "/admin/releases" || path === "/api/admin/releases" || path === "/api/admin/releases/testers") return { kind: "owner" };
  if (["/auth", "/auth/callback", "/api/auth/callback", "/api/auth/email-code", "/private-access", "/api/release/session"].includes(path)) return { kind: "public" };
  if (/^\/legal\/(terms|privacy|cookies|refunds|delivery|creators|support|purchase-agreement)$/.test(path) && ["GET", "HEAD"].includes(method)) return { kind: "public" };
  if (purchaseRules.some(([pattern, methods]) => pattern.test(path) && methods.includes(method))) return { kind: "purchase" };
  if (/^\/(scheduling\/book|api\/scheduling\/google\/book)\/[^/]+$/.test(path) && ["GET", "HEAD", "POST"].includes(method)) return { kind: "continuation", feature: "scheduling" };
  if (/^\/api\/checkout-link\/[^/]+$/.test(path) && method === "GET") return { kind: "continuation", feature: "checkout" };
  if (path === "/api/posts/view-counts" && method === "POST") return { kind: "continuation", feature: "feed" };
  if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/admin/")) return { kind: "owner" };
  const rules: Array<[RegExp, Feature]> = [
    [/^\/profile\/edit$/, "creatorTools"],
    [/^\/dashboard\/(analytics|earnings)$/, "analytics"],
    [/^\/api\/(video-insights(?:\/|$)|posts\/[^/]+\/insights$)/, "analytics"],
    [/^\/api\/(upload\/presign|private-videos)$/, "publishing"],
    [/^\/api\/posts(?:\/[^/]+)?$/, method === "GET" || method === "HEAD" ? "feed" : "publishing"],
    [/^\/api\/(follow|post-reports|reviews)$|^\/api\/posts\/[^/]+\/(like|comments(?:\/[^/]+)?)$|^\/api\/users\/[^/]+\/follows$/, "engagement"],
    [/^\/api\/(tips\/checkout|tips\/history|posts\/[^/]+\/tips)$/, "tips"],
    [/^\/api\/(checkout|checkout-link\/[^/]+|purchase-consent)$|^\/purchase\/review$/, "checkout"],
    [/^\/api\/memberships(?:\/|$)|^\/memberships(?:\/review)?$/, "memberships"],
    [/^\/api\/products(?:\/|$)/, "products"],
    [/^\/api\/scheduling(?:\/|$)|^\/scheduling(?:\/|$)|^\/api\/book(?:ings(?:\/|$)|$)/, "scheduling"],
    [/^\/api\/notifications(?:\/|$)/, "notifications"],
    [/^\/api\/search(?:\/|$)|^\/api\/tag\/|^\/search$|^\/tag\//, "search"],
    [/^\/api\/(profiles|profile\/mention-suggestions|posts\/creators|posts\/[^/]+\/creator)$|^\/creators\/[^/]+(?:\/reviews)?$|^\/profile\/[^/]+$/, "profiles"],
    [/^\/api\/stripe\/connect\/|^\/(profile|profile\/edit|onboarding|payments|dashboard\/closers)$/, "creatorTools"],
    [/^\/$|^\/dashboard$|^\/api\/(feed|feed-events|post-metrics|interest-score|posts\/product-ids|posts\/view-counts|posts\/feed-offers|posts\/[^/]+\/share|premium\/access)$/, "feed"],
  ];
  return { kind: "product", feature: rules.find(([pattern]) => pattern.test(path))?.[1] };
}
