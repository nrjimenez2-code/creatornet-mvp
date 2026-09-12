import "server-only";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";

export const EXACT_INSTALLMENT_PROTOCOL_KEY = "installment_collection_version";
export const EXACT_INSTALLMENT_PROTOCOL_ERROR = "Unsupported exact installment protocol";
export type ExactInstallmentProtocolClassification = "legacy" | "exact-v1";

const absent = Symbol("absent protocol field");
const failure = () => new Error(EXACT_INSTALLMENT_PROTOCOL_ERROR);

/** Inspect own data properties only. Provider JSON may omit nullable metadata
 * containers, but inherited fields/accessors cannot authorize legacy fallback.
 * No irrelevant metadata field, error detail or payment payload is returned. */
function own(value: unknown, key: string): unknown {
  if (value === absent || value === undefined || value === null) return absent;
  if (typeof value !== "object" || Array.isArray(value)) throw failure();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // structuredClone/JSON may cross a VM realm. Its native Object prototype
    // is a different reference, but custom/class prototype chains still fail.
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (Object.getPrototypeOf(prototype) !== null || !constructor || !("value" in constructor) ||
      typeof constructor.value !== "function" ||
      Function.prototype.toString.call(constructor.value) !== Function.prototype.toString.call(Object)) throw failure();
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (key in value) throw failure();
    return absent;
  }
  if (!("value" in descriptor) || !descriptor.enumerable) throw failure();
  return descriptor.value;
}

/** Rejection-only routing boundary, not proof of ownership or payment.
 * Presence of the reserved key must NEVER be mistaken for an unmarked legacy
 * event. In particular, unsupported future protocols remain quarantined even
 * when all feature flags are off. The legacy installment_fee_setup key is not
 * this protocol selector and remains untouched. Call again on fresh provider
 * objects before their markers can influence fallback or financial delegation. */
export function classifyExactInstallmentProtocol(object: unknown): ExactInstallmentProtocolClassification {
  return classifyProtocol(object, false) as ExactInstallmentProtocolClassification;
}

/** Only the context-aware handoff opts into v2. Old handlers continue to reject
 * it, including when their schema or financial feature flags are disabled. */
export function classifyContextInstallmentProtocol(object: unknown): ExactInstallmentProtocolClassification | "exact-context-v2" {
  return classifyProtocol(object, true);
}

function classifyProtocol(object: unknown, allowContext: boolean): ExactInstallmentProtocolClassification | "exact-context-v2" {
  try {
    const direct = own(own(object, "metadata"), EXACT_INSTALLMENT_PROTOCOL_KEY);
    const parent = own(own(own(own(object, "parent"), "subscription_details"), "metadata"), EXACT_INSTALLMENT_PROTOCOL_KEY);
    if (direct !== absent && parent !== absent && direct !== parent) throw failure();
    for (const marker of [direct, parent]) {
      if (marker !== absent && marker !== HELD_INSTALLMENT_VERSION &&
          !(allowContext && marker === "exact-cents-context-v2")) throw failure();
    }
    if (direct === absent && parent === absent) return "legacy";
    return (direct === absent ? parent : direct) === HELD_INSTALLMENT_VERSION ? "exact-v1" : "exact-context-v2";
  } catch { throw failure(); }
}
