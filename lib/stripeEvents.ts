// lib/stripeEvents.ts — webhook idempotency guard
import "server-only";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Result of trying to claim a Stripe event id.
 *
 * - `new`        this worker owns the event lease and may process it
 * - `duplicate`  the event completed previously; acknowledge without side effects
 * - `busy`       another worker currently owns the event; return a retryable error
 * - `unrecorded` the idempotency store could not make a durable decision
 */
export type EventClaim =
  | { status: "new"; claimToken: string }
  | { status: "duplicate" }
  | { status: "busy" }
  | { status: "unrecorded" };

const EVENT_LEASE_SECONDS = 5 * 60;
let _admin: SupabaseClient | null = null;

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

/**
 * Atomically claim a Stripe event.
 *
 * Migration 019 installs the database function that locks the row, distinguishes
 * in-progress work from completed work, and reclaims an abandoned claim only
 * after the lease expires. A concurrent delivery is therefore never mistaken
 * for a completed duplicate and acknowledged while the first worker can still
 * fail.
 */
export async function claimStripeEvent(
  eventId: string,
  eventType: string
): Promise<EventClaim> {
  const db = admin();
  if (!db) {
    console.error(
      "[stripe-events] no service-role client (missing SUPABASE_SERVICE_ROLE_KEY or URL)"
    );
    return { status: "unrecorded" };
  }

  // The token fences this worker from a later worker that reclaims an expired
  // lease. A stale worker must never be able to complete or release the newer
  // worker's claim using only the shared Stripe event id.
  const claimToken = randomUUID();
  try {
    const { data, error } = await db.rpc("claim_stripe_event", {
      p_event_id: eventId,
      p_event_type: eventType,
      p_lease_seconds: EVENT_LEASE_SECONDS,
      p_claim_token: claimToken,
    });
    if (error) {
      console.error(
        "[stripe-events] could not claim event:",
        eventId,
        error.code,
        error.message
      );
      return { status: "unrecorded" };
    }
    if (data === "new") {
      return { status: "new", claimToken };
    }
    if (data === "duplicate" || data === "busy") {
      return { status: data };
    }
    console.error("[stripe-events] claim function returned an invalid result:", eventId, data);
    return { status: "unrecorded" };
  } catch (error: unknown) {
    console.error(
      "[stripe-events] unexpected error claiming event:",
      eventId,
      error instanceof Error ? error.message : error
    );
    return { status: "unrecorded" };
  }
}

/** Mark a successfully handled event complete before returning a 2xx to Stripe. */
export async function completeStripeEvent(
  eventId: string,
  claimToken: string
): Promise<void> {
  const db = admin();
  if (!db) throw new Error("Stripe event completion store is unavailable.");

  const { data, error } = await db.rpc("complete_stripe_event", {
    p_event_id: eventId,
    p_claim_token: claimToken,
  });
  if (error) {
    throw new Error(`Stripe event completion failed: ${error.message}`);
  }
  if (data !== true) {
    throw new Error(`Stripe event ${eventId} was not owned when completion was attempted.`);
  }
}

/**
 * Release an in-progress claim after a handler failure so Stripe can retry.
 * The database function will not delete a row that has already been completed.
 */
export async function releaseStripeEvent(
  eventId: string,
  claimToken: string
): Promise<void> {
  const db = admin();
  if (!db) return;

  try {
    const { error } = await db.rpc("release_stripe_event", {
      p_event_id: eventId,
      p_claim_token: claimToken,
    });
    if (error) {
      console.error(
        "[stripe-events] could not release event claim:",
        eventId,
        error.code,
        error.message
      );
    }
  } catch (error: unknown) {
    console.error(
      "[stripe-events] unexpected error releasing event claim:",
      eventId,
      error instanceof Error ? error.message : error
    );
  }
}
