import { earningsUrl, parseEarningsPage, resolveEarningsPeriod, validCalendarDate } from "@/lib/earningsPeriod";

test("presets use the browser zone's calendar date and Sunday week start", () => {
  const now = new Date("2026-10-01T06:30:00.000Z");
  expect(resolveEarningsPeriod({ period: "today", tz: "America/Phoenix" }, now)).toMatchObject({
    startDate: "2026-09-30", endDate: "2026-09-30", startUtc: "2026-09-30T07:00:00.000Z",
  });
  expect(resolveEarningsPeriod({ period: "yesterday", tz: "America/Phoenix" }, now)?.startDate).toBe("2026-09-29");
  expect(resolveEarningsPeriod({ period: "this-week", tz: "America/Phoenix" }, now)).toMatchObject({
    startDate: "2026-09-27", endDate: "2026-09-30",
  });
  expect(resolveEarningsPeriod({ period: "this-month", tz: "America/Phoenix" }, now)).toMatchObject({
    startDate: "2026-09-01", endDate: "2026-09-30", endExclusiveUtc: "2026-10-01T07:00:00.000Z",
  });
  expect(resolveEarningsPeriod({ period: "today", tz: "Asia/Tokyo" }, now)?.startDate).toBe("2026-10-01");
});

test("custom dates are inclusive across daylight saving changes", () => {
  const custom = resolveEarningsPeriod({ period: "custom", tz: "America/Los_Angeles", start: "2026-03-07", end: "2026-03-09" })!;
  expect(custom).toMatchObject({
    startUtc: "2026-03-07T08:00:00.000Z", endExclusiveUtc: "2026-03-10T07:00:00.000Z",
  });
  const url = new URL(earningsUrl(custom, 2), "https://creatornet.example");
  expect(url.searchParams.get("page")).toBe("2");
  expect(resolveEarningsPeriod({
    period: url.searchParams.get("period")!, tz: url.searchParams.get("tz")!,
    start: url.searchParams.get("start")!, end: url.searchParams.get("end")!,
  })).toMatchObject(custom);
});

test("rejects impossible dates, inverted custom ranges, bad zones and page values", () => {
  expect(validCalendarDate("2026-02-29")).toBe(false);
  expect(validCalendarDate("2028-02-29")).toBe(true);
  for (const input of [
    { period: "custom", tz: "UTC", start: "2026-02-30", end: "2026-03-01" },
    { period: "custom", tz: "UTC", start: "2026-03-02", end: "2026-03-01" },
    { period: "today", tz: "not/a-zone" },
    { period: "lifetime", tz: "UTC" },
  ]) expect(resolveEarningsPeriod(input)).toBeNull();
  expect(parseEarningsPage(undefined)).toBe(1);
  for (const value of ["0", "-1", "1.5", "no", "1000000"]) expect(parseEarningsPage(value)).toBeNull();
});
