// lib/posthogServer.ts — server-side PostHog client (Node.js only)
import "server-only";
import { after } from "next/server";
import { PostHog } from "posthog-node";

let _client: PostHog | null = null;

function getClient(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!_client) {
    _client = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      // flushAt/flushInterval stay at 1/0 on purpose. In a serverless function
      // there is no reliable later moment to flush a buffer, so each event is
      // sent immediately. What changed is WHEN that send is awaited: it now
      // happens after the response, not before it.
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return _client;
}

/**
 * Record a server-side analytics event WITHOUT making the user wait for it.
 *
 * This used to `await ph.flush()` inline, so every caller paid a full HTTP
 * round trip to PostHog before its own response could be returned. On checkout
 * that delayed the buyer's redirect to Stripe; on the Stripe webhook it delayed
 * the 200 back to Stripe, which makes Stripe more likely to retry.
 *
 * The flush is now handed to Next's `after()`, which runs it once the response
 * has been sent while keeping the serverless invocation alive. That is the
 * important part: a bare fire-and-forget promise can be killed when the
 * instance freezes, which silently loses events.
 *
 * Analytics must never break or slow a request, so every failure path here is
 * swallowed deliberately.
 */
export async function trackServerEvent(
  event: string,
  userId: string | null,
  props: Record<string, unknown> = {}
) {
  const ph = getClient();
  if (!ph) return;
  try {
    // Buffers locally; does not perform network I/O itself.
    ph.capture({ distinctId: userId ?? "anonymous", event, properties: props });

    try {
      after(async () => {
        try {
          await ph.flush();
        } catch {
          // never surface an analytics failure
        }
      });
    } catch {
      // `after()` throws outside a request scope (e.g. during a build or from
      // a script). Fall back to a detached flush so the event still has a
      // chance to land, without making anyone wait for it.
      void ph.flush().catch(() => {});
    }
  } catch {
    // silently fail — never break a request for analytics
  }
}
