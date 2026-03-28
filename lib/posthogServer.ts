// lib/posthogServer.ts — server-side PostHog client (Node.js only)
import "server-only";
import { PostHog } from "posthog-node";

let _client: PostHog | null = null;

function getClient(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!_client) {
    _client = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return _client;
}

export async function trackServerEvent(
  event: string,
  userId: string | null,
  props: Record<string, unknown> = {}
) {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({ distinctId: userId ?? "anonymous", event, properties: props });
    await ph.flush();
  } catch {
    // silently fail — never break a request for analytics
  }
}
