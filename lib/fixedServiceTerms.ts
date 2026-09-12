/** Fixed-purchase service time is independent of installment/payment count.
 * Positive calendar months are bounded by supported timestamp arithmetic, not
 * by the installment engine's 24-payment limit. Existing missing terms stay
 * missing; no historical duration or lifetime promise is inferred. */
export const FIXED_SERVICE_VERSION = "fixed-service-months-v1";
const MAX_TIMESTAMP = 253402300799;
export function readFixedServiceMonths(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw Error("Service duration must be a positive whole number of calendar months");
  }
  return value;
}
export function fixedServiceEndAt(firstCapturedAt: number, serviceMonths: number): number {
  const months = readFixedServiceMonths(serviceMonths);
  if (!Number.isSafeInteger(firstCapturedAt) || firstCapturedAt < 1 || firstCapturedAt > MAX_TIMESTAMP) {
    throw Error("Invalid fixed service start");
  }
  const origin = new Date(firstCapturedAt * 1000);
  const first = new Date(Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const end = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(origin.getUTCDate(), lastDay),
    origin.getUTCHours(), origin.getUTCMinutes(), origin.getUTCSeconds()) / 1000;
  if (!Number.isSafeInteger(end) || end <= firstCapturedAt || end > MAX_TIMESTAMP) throw Error("Service duration exceeds supported dates");
  return end;
}
export function fixedServiceDescription(serviceMonths: number): string {
  const months = readFixedServiceMonths(serviceMonths);
  return `Service: ${months} calendar ${months === 1 ? "month" : "months"} from the first captured payment, independent of payment count.`;
}
