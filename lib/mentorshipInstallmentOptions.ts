/** Creator-approved fixed-total payment counts. Absence preserves pay-in-full.
 * This is distinct from monthly service pricing and from service duration. */
export function readMentorshipInstallmentOptions(value: unknown, type: string, monthly: boolean, totalCents: number | null): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 23) throw Error("Invalid installment choices");
  if (!value.length) return [];
  if (type !== "mentorship" || monthly || !Number.isSafeInteger(totalCents) ||
    totalCents! < 100 || totalCents! > 99999999) throw Error("Installments require a fixed-price mentorship");
  let previous = 1;
  for (const count of value) {
    if (!Number.isInteger(count) || count <= previous || count > 24 || Math.floor(totalCents! / count) < 50)
      throw Error("Choose distinct ascending payment counts from 2 to 24 with at least $0.50 per payment");
    previous = count;
  }
  return [...value];
}
type Env = Record<string, string | undefined>;
export const mentorshipInstallmentSchemaReady = (env: Env = process.env) => env.CREATOR_MENTORSHIP_INSTALLMENT_OPTIONS_SCHEMA_READY === "true";
export const mentorshipInstallmentOffersReady = (env: Env = process.env) => mentorshipInstallmentSchemaReady(env) &&
  env.CREATOR_MENTORSHIP_INSTALLMENT_OFFERS_READY === "true" && env.CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_READY === "true";
