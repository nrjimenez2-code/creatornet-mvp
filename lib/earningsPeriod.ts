export type EarningsPreset = "today" | "yesterday" | "this-week" | "this-month" | "custom";

export type EarningsPeriod = {
  preset: EarningsPreset;
  timeZone: string;
  startDate: string;
  endDate: string;
  startUtc: string;
  endExclusiveUtc: string;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function validCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

export function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function validTimeZone(value: string): boolean {
  if (!value || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const get = (part: string) => parts.find((item) => item.type === part)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Earliest UTC instant belonging to a calendar date in the creator's zone. */
export function zonedDayStartUtc(date: string, timeZone: string): string {
  if (!validCalendarDate(date) || !validTimeZone(timeZone)) throw new Error("Invalid earnings date or time zone");
  const nominal = Date.parse(`${date}T00:00:00.000Z`);
  let low = nominal - 2 * DAY_MS;
  let high = nominal + 2 * DAY_MS;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDate(new Date(middle), timeZone) < date) low = middle;
    else high = middle;
  }
  if (localDate(new Date(high), timeZone) !== date) throw new Error("Date does not exist in this time zone");
  return new Date(high).toISOString();
}

export function resolveEarningsPeriod(
  params: { period?: string; tz?: string; start?: string; end?: string },
  now = new Date(),
): EarningsPeriod | null {
  const { period, tz } = params;
  if (!tz || !validTimeZone(tz)) return null;
  if (period !== "today" && period !== "yesterday" && period !== "this-week" && period !== "this-month" && period !== "custom") return null;
  const today = localDate(now, tz);
  let startDate = today;
  let endDate = today;
  if (period === "yesterday") startDate = endDate = shiftCalendarDate(today, -1);
  if (period === "this-week") {
    const dayOfWeek = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    startDate = shiftCalendarDate(today, -dayOfWeek);
  }
  if (period === "this-month") startDate = `${today.slice(0, 7)}-01`;
  if (period === "custom") {
    if (!params.start || !params.end || !validCalendarDate(params.start) || !validCalendarDate(params.end) || params.start > params.end) return null;
    startDate = params.start;
    endDate = params.end;
  }
  try {
    return {
      preset: period,
      timeZone: tz,
      startDate,
      endDate,
      startUtc: zonedDayStartUtc(startDate, tz),
      endExclusiveUtc: zonedDayStartUtc(shiftCalendarDate(endDate, 1), tz),
    };
  } catch {
    return null;
  }
}

export function parseEarningsPage(value: string | undefined): number | null {
  if (value === undefined) return 1;
  if (!/^[1-9]\d{0,5}$/.test(value)) return null;
  return Number(value);
}

export function earningsUrl(period: EarningsPeriod, page = 1): string {
  const params = new URLSearchParams({ period: period.preset, tz: period.timeZone });
  if (period.preset === "custom") {
    params.set("start", period.startDate);
    params.set("end", period.endDate);
  }
  if (page > 1) params.set("page", String(page));
  return `/dashboard/earnings?${params.toString()}`;
}
