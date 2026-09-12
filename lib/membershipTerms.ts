/** #4/#6: prospective monthly service terms, never inferred from plan_months
 * or substituted for an existing fixed-total installment agreement. */
export const MONTHLY_MENTORSHIP_VERSION = "monthly-mentorship-v1";
export const MAX_MEMBERSHIP_MINIMUM_MONTHS = 24;
export type MonthlyMentorshipTerms = Readonly<{
  version: typeof MONTHLY_MENTORSHIP_VERSION;
  minimumMonths: number;
  autoRenew: boolean;
}>;

export function readMonthlyMentorshipTerms(value: unknown, productType: unknown): MonthlyMentorshipTerms | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || productType !== "mentorship") throw Error("Invalid monthly mentorship terms");
  const d = Object.getOwnPropertyDescriptors(value), keys = ["version", "minimumMonths", "autoRenew"];
  if (Reflect.ownKeys(d).length !== keys.length || keys.some(k => !d[k] || !("value" in d[k]) || !d[k].enumerable)) throw Error("Invalid monthly mentorship terms");
  const v = value as Record<string, unknown>;
  if (v.version !== MONTHLY_MENTORSHIP_VERSION || !Number.isSafeInteger(v.minimumMonths) ||
    Number(v.minimumMonths) < 1 || Number(v.minimumMonths) > MAX_MEMBERSHIP_MINIMUM_MONTHS || typeof v.autoRenew !== "boolean") throw Error("Invalid monthly mentorship terms");
  return Object.freeze({ version: MONTHLY_MENTORSHIP_VERSION, minimumMonths: Number(v.minimumMonths), autoRenew: v.autoRenew });
}

export function membershipCommitment(monthlyCents: number, terms: MonthlyMentorshipTerms) {
  const t = readMonthlyMentorshipTerms(terms, "mentorship")!;
  if (!Number.isSafeInteger(monthlyCents) || monthlyCents < 50 || monthlyCents > 99999999) throw Error("Invalid monthly price");
  return Object.freeze({ monthlyCents, minimumTotalCents: monthlyCents * t.minimumMonths,
    minimumMonths: t.minimumMonths, autoRenew: t.autoRenew });
}

export function describeMonthlyMentorship(monthlyCents: number, terms: MonthlyMentorshipTerms) {
  const c = membershipCommitment(monthlyCents, terms), usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
  const minimum = `${c.minimumMonths} ${c.minimumMonths === 1 ? "month" : "months"}`;
  return `${usd(monthlyCents)} per month. Minimum commitment: ${minimum} (${usd(c.minimumTotalCents)}). ` +
    (c.autoRenew ? `After the minimum term, renews monthly at ${usd(monthlyCents)} until canceled. ` : `Ends after ${minimum}; no automatic renewal. `) +
    "This is monthly mentorship service, not a fixed-price purchase split into installments.";
}
