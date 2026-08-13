// lib/stripeEvents.ts — webhook idempotency guard
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Result of trying to claim a Stripe event id.
 *
 * - `new`        first time we have seen this event id. Process it.
 * - `duplicate`  we have processed this event before. Skip the side effects.
 * - `unrecorded` we could not reach the table. See the note on failure mode below.
 */
export type EventClaim = "new" | "duplicate" | "unrecorded";

let _admin: SupabaseClient | null = null;

/**
 * Service-role client, built lazily.
 *
 * This deliberately does NOT reuse the caller's client. `app/api/webhook/route.ts`
 * uses a request-scoped (user) client, and a Stripe webhook has no logged-in user,
 * so its writes are subject to row-level security with `auth.uid()` NULL. The event
 * ledger has to be written with the service role or it silently records nothing.
 */
function admin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!_admin) {
    _admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

/** Postgres unique-violation, surfaced through PostgREST. */
function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  // Belt and braces: the code has been the reliable signal in practice, but the
  // message check costs nothing and covers a driver that does not forward it.
  return /duplicate key|already exists/i.test(error.message ?? "");
}

/**
 * Claim a Stripe event id exactly once.
 *
 * Call this immediately after signature verification and before ANY side effect.
 * Stripe retries a webhook until it gets a 2xx, and it can also deliver the same
 * event to more than one registered endpoint. Without this, a retry re-runs
 * everything: re-granting access, re-sending mail, re-incrementing earnings.
 *
 * The insert itself is the lock. `stripe_events.id` is the primary key, so two
 * concurrent deliveries of the same event race on the same row and exactly one
 * of them wins. There is no read-then-write window to lose.
 *
 * ## Failure mode, chosen deliberately
 *
 * When the ledger write fails for any reason other than a conflict, this returns
 * `unrecorded` and the caller PROCESSES THE EVENT ANYWAY.
 *
 * The alternative — return 500 and let Stripe retry — is the more common pattern
 * and is stricter. It was rejected here because it converts any problem writing
 * one bookkeeping table into a total outage of payment recording, and because
 * this is not the only defence:
 *
 *   - `purchases` has UNIQUE constraints on `session_id` and on
 *     `payment_intent_id`, so genuinely duplicated purchase rows are already
 *     impossible at the database level.
 *   - the large handler additionally checks per-record before acting
 *     (`app/api/stripe/webhook/route.ts` L124, L323, L397, L452, L570).
 *
 * So this guard removes duplicate *side effects*; it is not the last line against
 * duplicate *rows*. Failing open degrades to today's behaviour, which has been
 * running in production. Failing closed would be a new way to lose every payment.
 *
 * If you would rather fail closed, the change is one line in each caller: treat
 * `unrecorded` the same as an error and return a 500.
 */
export async function claimStripeEvent(
  eventId: string,
  eventType: string
): Promise<EventClaim> {
  const db = admin();
  if (!db) {
    console.error(
      "[stripe-events] no service-role client (missing SUPABASE_SERVICE_ROLE_KEY or URL) — processing without an idempotency guard"
    );
    return "unrecorded";
  }

  try {
    const { error } = await db
      .from("stripe_events")
      .insert({ id: eventId, type: eventType });

    if (!error) return "new";

    if (isUniqueViolation(error)) {
      console.log("[stripe-events] duplicate event, skipping:", eventId, eventType);
      return "duplicate";
    }

    console.error(
      "[stripe-events] could not record event, processing anyway:",
      eventId,
      error.code,
      error.message
    );
    return "unrecorded";
  } catch (e) {
    console.error(
      "[stripe-events] unexpected error recording event, processing anyway:",
      eventId,
      e instanceof Error ? e.message : e
    );
    return "unrecorded";
  }
}
