import "server-only";
import type Stripe from "stripe";

/** Check fresh debit/activation admission and unpaid bank-capability release
 * using an independently retrieved, owner/context-checked Stripe method.
 * Billing eligibility is not proof of residency. Never apply this guard to
 * accounting for captured money or read-only payment-status recovery. */
export function assertMembershipUsBilling(method: Pick<Stripe.PaymentMethod, "type" | "billing_details">) {
  const address = method.billing_details?.address;
  if (method.type !== "card" || address?.country !== "US" ||
      typeof address.line1 !== "string" || !address.line1.trim() ||
      typeof address.city !== "string" || !address.city.trim() ||
      typeof address.state !== "string" || !/^[A-Z]{2}$/.test(address.state) ||
      typeof address.postal_code !== "string" || !/^\d{5}(?:-\d{4})?$/.test(address.postal_code)) {
    throw Error("Monthly payment requires a complete US billing address before debit");
  }
}
