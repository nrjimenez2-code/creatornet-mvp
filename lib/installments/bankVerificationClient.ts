import { loadStripe } from "@stripe/stripe-js/pure";

/** Called only after an explicit buyer click and an owner-verified response.
 * Keep the ephemeral secret out of React state, URLs, logs and storage. Importing
 * the pure loader does not insert Stripe.js on page load. Never confirm a new PI.
 * Receipt verification on the server is required even after SDK success/error. */
export async function completeBankVerification(publishableKey: string, clientSecret: string): Promise<void> {
  return completeContextBankVerification(publishableKey, clientSecret, "test");
}

/** Prospective context UI adapter only. The server response supplies the owned
 * capability; this does not publish a route or weaken the old Sandbox wrapper. */
export async function completeContextBankVerification(publishableKey: string, clientSecret: string, expectedMode: "test" | "live"): Promise<void> {
  if (!["test", "live"].includes(expectedMode) || !new RegExp(`^pk_${expectedMode}_[a-zA-Z0-9]+$`).test(publishableKey) ||
    !/^pi_[a-zA-Z0-9]+_secret_[a-zA-Z0-9]+$/.test(clientSecret))
    throw new Error("Bank verification unavailable");
  try {
    const stripe = await loadStripe(publishableKey);
    if (!stripe) return;
    await stripe.handleNextAction({ clientSecret });
  } catch { /* No raw provider error, secret, or unverified paid claim escapes. */ }
}
