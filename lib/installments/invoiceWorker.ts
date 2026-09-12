import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId } from "./agreementStore";
import { assertExactInstallmentEnvironment, assertExactInstallmentSandbox } from "./checkoutPreparation";
import { discoverExactRenewalSandbox, type ExactDiscoveryStore } from "./invoiceDiscovery";
import { collectExactRenewalSandbox } from "./renewal";

export interface ExactInvoiceBatchStore {
  page(after: string | null): Promise<Readonly<{ ids: string[]; hasMore: boolean }>>;
}
export function createExactInvoiceBatchStore(admin: SupabaseClient): ExactInvoiceBatchStore {
  return { async page(after) {
    if (after !== null) assertAgreementId(after);
    let query = admin.from("exact_installment_agreements").select("id").in("status", ["active", "complete", "review_required"])
      .not("stripe_subscription_id", "is", null).order("id").limit(11);
    if (after) query = query.gt("id", after);
    const { data, error } = await query;
    if (error || !Array.isArray(data) || data.length > 11) throw new Error("Invoice batch unavailable");
    const ids = data.map(row => { assertAgreementId(row.id); return row.id as string; });
    if (ids.some((id, i) => id <= (i ? ids[i - 1] : after ?? ""))) throw new Error("Invalid invoice batch order");
    return { ids: ids.slice(0, 10), hasMore: ids.length > 10 };
  } };
}

type Base = Omit<Parameters<typeof collectExactRenewalSandbox>[0], "agreementId" | "invoiceId">;
export type ExactBatchResult = Readonly<{
  rows: Array<{ agreementId: string; status: string; paymentNumber?: number }>;
  nextCursor: string | null;
  halted: boolean;
}>;

/** Bounded service worker candidate. No public HTTP/cron entry point or new
 * collection permission. Inspection mode is read-only. Explicit prepare mode
 * may configure an unpaid invoice or reconcile an ORIGINAL admission using the
 * existing durable guards. pay() is hard-disabled here even if an env switch is
 * accidentally true. Collection remains a separate staged acceptance gate.
 * No invented webhook event, failed-payment retry, skipped unpaid period,
 * subscription resume, or asynchronous fire-and-forget work. */
export async function runExactInvoiceBatchSandbox(args: Base & {
  batchStore: ExactInvoiceBatchStore; discoveryStore: ExactDiscoveryStore;
  mode: "inspect" | "prepare"; after?: string | null;
}): Promise<ExactBatchResult> {
  assertExactInstallmentEnvironment(args.env, args.env.NEXT_PUBLIC_SITE_URL || "");
  if (args.env.CREATOR_EXACT_INSTALLMENTS_WORKER_READY !== "true" ||
    args.env.CREATOR_EXACT_INSTALLMENTS_DISCOVERY_READY !== "true" || args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY !== "true" ||
    !["inspect", "prepare"].includes(args.mode)) throw new Error("Invoice worker not enabled");
  if (args.mode === "prepare") {
    assertExactInstallmentSandbox(args.env, args.env.NEXT_PUBLIC_SITE_URL || "");
    if (args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY !== "true" ||
      args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY !== "true") throw new Error("Invoice worker recovery not enabled");
  }
  const after = args.after ?? null;
  if (after !== null) assertAgreementId(after);
  const page = await args.batchStore.page(after);
  if (!Array.isArray(page.ids) || page.ids.length > 10 || typeof page.hasMore !== "boolean" || page.hasMore && page.ids.length !== 10) {
    throw new Error("Invalid invoice batch");
  }
  for (const [i,id] of page.ids.entries()) {
    assertAgreementId(id);
    if (id <= (i ? page.ids[i - 1] : after ?? "")) throw new Error("Invalid invoice batch order");
  }
  const rows: ExactBatchResult["rows"] = [];
  let previous = after;
  for (const agreementId of page.ids) {
    try {
      const found = await discoverExactRenewalSandbox({ ...args, agreementId });
      if (args.mode === "prepare" && (found.status === "discovered" || found.status === "reconcile_admitted")) {
        // Returned discovery is only a candidate; collector re-retrieves the
        // invoice and independently claims it. Other workers may have won.
        const result = await collectExactRenewalSandbox({ ...args, agreementId, invoiceId: found.invoiceId,
          env: { ...args.env, CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT: "false" } });
        rows.push({ agreementId, ...result });
      } else {
        rows.push({ agreementId, status: found.status, ...("paymentNumber" in found ? { paymentNumber: found.paymentNumber } : {}) });
      }
      previous = agreementId;
    } catch {
      // A provider/database failure may follow a durable claim or a successful
      // unpaid preparation. Preserve the original operation; don't skip it or
      // claim that nothing happened. Expose no raw errors or payment URLs.
      rows.push({ agreementId, status: "reconciliation_required" });
      return { rows, nextCursor: previous, halted: true };
    }
  }
  return { rows, nextCursor: page.hasMore ? previous : null, halted: false };
}
