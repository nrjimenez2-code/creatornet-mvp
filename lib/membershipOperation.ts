import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertMembershipId, type MembershipPaymentContext } from "./membershipAgreement";

export type MembershipOperationKind = "customer" | "product" | "subscription" | "hold" | "checkout" | "activate" | "collect";
export type MembershipProviderRequest = { method: "POST"; path: string; params: Record<string, unknown> };
type ProviderObject = { id: string; lastResponse?: { requestId?: string } };

// Compare immutable JSON data, not execution-realm object prototypes. Reject
// getters, cycles and non-JSON values instead of dropping fields during a
// stringify or accepting a changed request after durable admission.
function jsonSnapshot<T>(input: T): T {
  const seen = new Set<object>();
  function copy(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || seen.has(value)) throw Error("Monthly operation requires plain JSON data");
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (!array && proto !== null && Object.getPrototypeOf(proto) !== null) throw Error("Monthly operation requires plain JSON data");
    const output: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || !descriptors[key].enumerable || !("value" in descriptors[key])) throw Error("Monthly operation requires plain JSON data");
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw Error("Monthly operation requires dense JSON arrays");
      Object.defineProperty(output, key, { value: copy(descriptors[key].value), enumerable: true, configurable: false, writable: false });
    }
    if (array && keys.length !== value.length + 1) throw Error("Monthly operation requires dense JSON arrays");
    seen.delete(value); return Object.freeze(output);
  }
  return copy(input) as T;
}

/** Private execution boundary, not an HTTP endpoint. Callbacks must use the
 * pinned, account-observed Stripe client and validate all returned identities,
 * amounts, destination, context, and hold/payment state. No default dispatcher
 * exists here: merely importing or constructing a request cannot move money. */
export async function runMembershipOperation<T extends ProviderObject>(args: {
  admin: SupabaseClient; agreementId: string; actorId: string; revision: number; kind: MembershipOperationKind; scope: string;
  context: MembershipPaymentContext; request: MembershipProviderRequest; env: Record<string, string | undefined>;
  observeContext(): Promise<MembershipPaymentContext>;
  create(request: MembershipProviderRequest, options: { idempotencyKey: string; maxNetworkRetries: 0 }): Promise<T>;
  retrieve(id: string): Promise<T>;
  validate(object: T): void;
}) {
  [args.agreementId, args.actorId].forEach(assertMembershipId);
  if (!["CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_OPERATIONS_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY"].every(key => args.env[key] === "true")) throw Error("Monthly billing operations are not enabled");
  const context = jsonSnapshot(args.context), request = jsonSnapshot(args.request);
  const observe = async () => { if (!isDeepStrictEqual(jsonSnapshot(await args.observeContext()), context)) throw Error("Monthly payment context changed"); };
  await observe();
  const { data: op, error } = await args.admin.rpc("claim_monthly_mentorship_operation_v1", {
    p_agreement_id: args.agreementId, p_actor_id: args.actorId, p_kind: args.kind, p_scope: args.scope,
    p_revision: args.revision, p_context: context, p_request: request,
  });
  if (error || !op || op.agreement_id !== args.agreementId || op.kind !== args.kind || op.scope_key !== args.scope ||
      !isDeepStrictEqual(jsonSnapshot(op.request), request)) throw Error("Monthly operation could not be claimed safely");
  assertMembershipId(op.id);
  await observe();
  if (op.status === "complete") {
    if (typeof op.provider_id !== "string") throw Error("Monthly operation result is missing");
    const object = await args.retrieve(op.provider_id);
    if (object.id !== op.provider_id) throw Error("Monthly provider result identity differs");
    args.validate(object); await observe(); return object;
  }
  const dispatchedAt = Date.parse(op.dispatched_at);
  if (op.status !== "dispatched" || op.agreement_revision !== args.revision || !Number.isFinite(dispatchedAt) ||
      dispatchedAt > Date.now() + 1000 || Date.now() - dispatchedAt >= 20 * 60 * 60 * 1000) {
    throw Error("Monthly operation requires reconciliation, not another provider call");
  }
  const object = await args.create(jsonSnapshot(request), { idempotencyKey: `creatornet-membership:${op.id}`, maxNetworkRetries: 0 });
  args.validate(object); await observe();
  if (!/^req_[A-Za-z0-9]+$/.test(object.lastResponse?.requestId || "")) throw Error("Monthly provider request evidence is missing");
  const completed = await args.admin.rpc("complete_monthly_mentorship_operation_v1", { p_operation_id: op.id, p_context: context,
    p_provider_id: object.id, p_request_id: object.lastResponse!.requestId });
  if (completed.error || typeof completed.data !== "boolean") throw Error("Monthly provider completion could not be recorded");
  return object;
}
