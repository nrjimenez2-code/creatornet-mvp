import "server-only";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { assertAgreementId } from "./agreementStore";
import { exactContextServerConfig } from "./contextServer";
import { readExactContextReservation } from "./contextReservation";
import { readContextCheckoutPayments } from "./contextCheckoutApp";
import { createExactContextRuntime, createExactContextInvoiceCollection, createExactContextBankVerification } from "./contextRuntime";
import { createExactDiscoveryStore, discoverExactRenewalUsingBinding } from "./invoiceDiscovery";

const requireMatch = (condition: unknown) => { if (!condition) throw Error("Monthly collection needs review"); };

/** #3: one explicitly selected booking per scheduled request. No synthetic
 * webhook, catch-up charge, new customer or retry permission is manufactured. */
export async function collectContextMonthlyBooking(admin: SupabaseClient, bookingId: string, env: Record<string, string | undefined>) {
  assertAgreementId(bookingId);
  requireMatch(["CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY", "CREATOR_EXACT_INSTALLMENTS_CONTEXT_MONTHLY_WORKER_READY",
    "CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY"].every(key => env[key] === "true"));
  const selected = (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_BOOKING_IDS ?? "").split(",").map(v => v.trim());
  requireMatch(selected.length <= 10 && new Set(selected).size === selected.length); selected.forEach(assertAgreementId);
  requireMatch(selected.includes(bookingId));
  const config = exactContextServerConfig(env);
  const observed = await createExactContextRuntime(config).observeContext();
  const result = await admin.from("exact_installment_context_reservations_v2").select("id,booking_id,context,terms,status,created_at")
    .eq("booking_id", bookingId).maybeSingle();
  requireMatch(!result.error);
  if (!result.data) return { status: "nothing_due" as const };
  const r = readExactContextReservation(result.data, observed.contextEvidence);
  requireMatch(r.bookingId === bookingId && isDeepStrictEqual(r.context, config.approvedContext));
  const links = await readContextCheckoutPayments(admin, r.terms.creatorId, [bookingId], env);
  const link = links.find(item => item.id === r.id);
  if (!link?.stripe_checkout_session_id) return { status: "nothing_due" as const };
  // Reuse the private correspondence resolver. Direct SELECT on its table is forbidden.
  const located = await admin.rpc("resolve_exact_context_event_v2", { p_kind: "session", p_provider_id: link.stripe_checkout_session_id, p_hint: r.id });
  const b = located.data;
  requireMatch(!located.error && b && b.reservationId === r.id && b.creatorId === r.terms.creatorId && b.buyerId === r.terms.buyerId &&
    isDeepStrictEqual(b.context, r.context) && b.sessionId === link.stripe_checkout_session_id);
  if (b.firstCredited !== true) return { status: "nothing_due" as const };
  const agreement = await admin.from("exact_installment_agreements").select("status").eq("id", r.id).maybeSingle();
  requireMatch(!agreement.error && typeof agreement.data?.status === "string");
  // A new client pins this read to the same approved account/mode/API version.
  const stripe = new Stripe(config.stripeSecretKey, { apiVersion: "2025-10-29.clover", maxNetworkRetries: 0, timeout: 10000 });
  const discovery = await discoverExactRenewalUsingBinding({ binding: { id: r.id, subscriptionId: b.subscriptionId,
    customerId: b.customerId, status: agreement.data!.status, terms: r.terms },
    discoveryStore: createExactDiscoveryStore(admin), stripe, expectedLiveMode: r.context.mode === "live" });
  if (discovery.status === "reconcile_admitted") {
    // Includes a separately authorized replacement card. Observation cannot debit again.
    return createExactContextBankVerification(config).checkPayment(r.id, r.terms.buyerId, discovery.invoiceId);
  }
  if (discovery.status !== "discovered") return discovery;
  return createExactContextInvoiceCollection(config).collectInvoice(r.id, r.terms.creatorId, discovery.invoiceId);
}
