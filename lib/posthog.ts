// lib/posthog.ts — client-side PostHog helpers
import posthog from "posthog-js";

const CATEGORY_MAP: Record<string, string> = {
  // onboarding display names
  entrepreneurship: "business",
  "money & investing": "money",
  "social media growth": "content_creation",
  "content creation": "content_creation",
  "online skills": "skills",
  "health & fitness": "health",
  "self improvement": "self_improvement",
  "tech & ai automation": "tech",
  // direct client category keys
  business: "business",
  money: "money",
  skills: "skills",
  health: "health",
  fitness: "fitness",
  self_improvement: "self_improvement",
  content_creation: "content_creation",
  tech: "tech",
  ai: "ai",
  creative: "creative",
  lifestyle: "lifestyle",
  relationships: "relationships",
  education: "education",
};

export function normalizeCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  return CATEGORY_MAP[lower] ?? lower;
}

export function getDevice(): string {
  if (typeof window === "undefined") return "unknown";
  if (/Mobi|Android/i.test(navigator.userAgent)) return "mobile";
  if (/Tablet|iPad/i.test(navigator.userAgent)) return "tablet";
  return "desktop";
}

export function getTrafficSource(): string {
  if (typeof window === "undefined") return "direct";
  const path = window.location.pathname;
  if (path.startsWith("/dashboard")) return "feed";
  if (path.startsWith("/creators")) return "profile";
  if (path.startsWith("/search")) return "search";
  return "direct";
}

export function trackEvent(event: string, props: Record<string, unknown> = {}) {
  try {
    posthog.capture(event, {
      device_type: getDevice(),
      traffic_source: getTrafficSource(),
      ...props,
    });
  } catch {
    // never break the app for analytics
  }
}
