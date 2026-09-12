import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseRefundStore } from "./refund-store";
import { previewAdminRefund, createAndProcessAdminRefund, processRefundOperation,
  type AdminRefundPreview, type RefundProcessResult, type RefundRequestInput } from "./refunds";
import { getStripe } from "../stripeClient";
import { createExactContextAdminRefund } from "../installments/contextRuntime";
import { exactContextServerConfig } from "../installments/contextServer";
import { CONTEXT_RESERVATION_VERSION } from "../installments/contextReservation";
import { HELD_INSTALLMENT_VERSION } from "../installments/heldInvoice";
import { assertAgreementId } from "../installments/agreementStore";

type Base = { admin: SupabaseClient; actorId: string; env?: Record<string, string | undefined> };
type Preview = { kind: "preview"; input: RefundRequestInput };
type Change = { kind: "create"; input: RefundRequestInput } | { kind: "retry"; operationId: string };
export function executeAdminRefundAction(base: Base, action: Preview): Promise<AdminRefundPreview>;
export function executeAdminRefundAction(base: Base, action: Change): Promise<RefundProcessResult>;
/** #1/#3: the existing authenticated, same-origin admin endpoints all select
 * one workflow here. No new screen, request fields, fee math or buyer policy. */
export async function executeAdminRefundAction(base: Base, action: Preview | Change): Promise<AdminRefundPreview | RefundProcessResult> {
  const env = base.env ?? process.env, store = createSupabaseRefundStore(base.admin, env);
  let ledgerId: string;
  if (action.kind === "retry") {
    const op = await store.getOperation(action.operationId);
    if (!op) throw Error("Refund operation missing"); ledgerId = op.paymentFeeLedgerId;
  } else ledgerId = action.input.paymentFeeLedgerId;
  assertAgreementId(ledgerId);
  const source = await store.getSourceContext(ledgerId);
  if (source.ledger.bookingPaymentId) {
    // select(*) also supports the earlier deployed schema, where the protocol
    // column is absent. No missing-table/lookup error is swallowed as legacy.
    const payment = await base.admin.from("booking_payments").select("*").eq("id", source.ledger.bookingPaymentId).single();
    if (payment.error || !payment.data) throw Error("Refund booking payment missing");
    const version = payment.data.installment_collection_version;
    if (version === CONTEXT_RESERVATION_VERSION) {
      const config = exactContextServerConfig(env);
      // The correspondence table deliberately has no service-role SELECT.
      // Reuse the service-only persisted-receipt locator; the owned refund
      // runtime independently verifies actor, ledger and accounting linkage.
      const link = await base.admin.rpc("resolve_exact_context_event_v2", {
        p_kind: "intent", p_provider_id: source.ledger.stripePaymentIntentId, p_hint: null,
      });
      if (link.error || !link.data || link.data.firstCredited !== true) throw Error("Refund context accounting link missing");
      assertAgreementId(link.data.reservationId);
      return createExactContextAdminRefund(config).run(link.data.reservationId, base.actorId, ledgerId, action);
    }
    if (version !== null && version !== undefined && version !== HELD_INSTALLMENT_VERSION) throw Error("Unsupported refund payment protocol");
  }
  if (action.kind === "preview") return previewAdminRefund(store, getStripe(), action.input);
  if (action.kind === "create") return createAndProcessAdminRefund(store, getStripe(), base.actorId, action.input);
  return processRefundOperation(store, getStripe(), action.operationId);
}
