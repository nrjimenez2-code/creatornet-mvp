import { fixedServiceEndAt, readFixedServiceMonths } from "@/lib/fixedServiceTerms";

export const fixedServiceSchemaReady = () =>
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY === "true";

// Creation stays closed until both purchase paths are accepted. Schema/read
// readiness remains independent so stopping new offers cannot erase old terms.
export const fixedServiceOffersReady = () =>
  fixedServiceSchemaReady() &&
  process.env.CREATOR_FIXED_SERVICE_OFFERS_READY === "true" &&
  process.env.CREATOR_FIXED_SERVICE_CONTEXT_READY === "true" &&
  process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY === "true";

export function readFixedServiceOfferMonths(
  value: unknown,
  productType: string,
  monthlyMembership: boolean,
  nowSeconds = Math.floor(Date.now() / 1000),
): number | null {
  // Absence is not a lifetime promise and does not infer a service duration.
  if (value === undefined || value === null) return null;
  if (monthlyMembership || !["video", "course", "mentorship"].includes(productType)) {
    throw Error("Fixed service duration applies only to a fixed-price video, course, or mentorship.");
  }
  const months = readFixedServiceMonths(value);
  // Match the reservation/SQL date guard, including the maximum Checkout window.
  fixedServiceEndAt(nowSeconds + 24 * 60 * 60, months);
  return months;
}
