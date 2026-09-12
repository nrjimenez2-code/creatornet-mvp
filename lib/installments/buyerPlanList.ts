import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { assertAgreementId } from "./agreementStore";
import { buyerRecoveryEnabled } from "./buyerRecovery";
import { exactContextServerConfig } from "./contextServer";
import { CONTEXT_RESERVATION_VERSION } from "./contextReservation";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";

const pageSize = 50;
function check(v: unknown): asserts v { if (!v) throw Error("Payment plans could not be loaded"); }
/** #3: authenticated buyer's navigation only. Never grants content access,
 * calculates a balance, or touches Stripe. Recovery rechecks ownership/state. */
export async function listBuyerPaymentPlans(admin: SupabaseClient, buyerId: string, page: number,
  env: Record<string, string | undefined>) {
  assertAgreementId(buyerId); check(Number.isSafeInteger(page) && page >= 1 && page <= 10000);
  const legacy = buyerRecoveryEnabled({ ...env, CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RECOVERY_READY: "false" });
  const context = env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RECOVERY_READY === "true" &&
    env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY === "true" ? exactContextServerConfig(env).approvedContext : null;
  check(legacy || context);
  const versions = [...(legacy ? [HELD_INSTALLMENT_VERSION] : []), ...(context ? [CONTEXT_RESERVATION_VERSION] : [])];
  const { data, error, count } = await admin.from("exact_installment_agreements")
    .select("id,terms,first_fulfilled_at", { count: "exact" }).eq("terms->>buyerId", buyerId)
    .in("terms->>version", versions).not("first_fulfilled_at", "is", null)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  check(!error && Array.isArray(data) && Number.isSafeInteger(count) && count! >= 0);
  const ids: string[] = [];
  const plans = data.map(r => {
    assertAgreementId(r.id); check(r.terms?.buyerId === buyerId && versions.includes(r.terms.version) &&
      typeof r.terms.title === "string" && r.terms.title.trim().length > 0 && r.terms.title.length <= 200 && r.first_fulfilled_at);
    if (r.terms.version === CONTEXT_RESERVATION_VERSION) ids.push(r.id);
    return { id: r.id as string, title: r.terms.title as string };
  });
  if (ids.length) {
    const r = await admin.from("exact_installment_context_reservations_v2").select("id,context,terms")
      .eq("terms->>buyerId", buyerId).in("id", ids);
    check(!r.error && Array.isArray(r.data) && r.data.length === ids.length);
    for (const id of ids) {
      const bound = r.data.find(v => v.id === id), agreement = data.find(v => v.id === id);
      check(bound && agreement && bound.terms.buyerId === buyerId && isDeepStrictEqual(bound.context, context) &&
        isDeepStrictEqual(agreement.terms, { ...bound.terms, bookingPaymentId: agreement.terms.bookingPaymentId }));
    }
  }
  return { plans, hasMore: page * pageSize < count! };
}
