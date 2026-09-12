import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

// Stripe retains keys for at least 24 hours. Leave margin for requests and retries.
const SAFE_RETRY_MS = 23 * 60 * 60 * 1000;
export class ConnectAccountReconciliationError extends Error {}

/** One durable creation attempt per creator, including frozen provider parameters. */
export async function createOrRecoverConnectAccount(
  db: SupabaseClient, stripe: Stripe, user: { id: string; email?: string },
): Promise<string> {
  const { error: reserveError } = await db.from("stripe_connect_account_creations")
    .insert({ creator_id: user.id, email: user.email ?? null });
  if (reserveError && reserveError.code !== "23505") throw Error("Could not reserve Stripe account creation");

  const { data: attempt, error: readError } = await db.from("stripe_connect_account_creations")
    .select("idempotency_key, email, created_at, stripe_account_id").eq("creator_id", user.id).single();
  if (readError || !attempt) throw Error("Could not load Stripe account creation");
  if (attempt.stripe_account_id) return attempt.stripe_account_id;

  const age = Date.now() - Date.parse(attempt.created_at);
  if (!Number.isFinite(age) || age < 0 || age >= SAFE_RETRY_MS) {
    // Never rotate this key or silently create another account after provider expiry.
    throw new ConnectAccountReconciliationError("Stripe account creation needs reconciliation before another attempt");
  }
  const account = await stripe.accounts.create({
    type: "express",
    email: attempt.email ?? undefined,
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { creatornet_user_id: user.id, creatornet_creation_id: attempt.idempotency_key },
  }, { idempotencyKey: `creatornet-connect-v1:${attempt.idempotency_key}` });

  const { error: saveError } = await db.from("stripe_connect_account_creations")
    .update({ stripe_account_id: account.id }).eq("creator_id", user.id)
    .eq("idempotency_key", attempt.idempotency_key).is("stripe_account_id", null);
  if (saveError) throw Error("Could not record created Stripe account");
  const { data: saved, error: savedError } = await db.from("stripe_connect_account_creations")
    .select("stripe_account_id").eq("creator_id", user.id).single();
  if (savedError || saved?.stripe_account_id !== account.id) throw Error("Stripe account creation identity changed");
  return account.id;
}
