import { accumulate, dailyTotals, dayLabels, DEMO_TODAY_ISO } from "@/lib/admin/series";

test("real charts include the snapshot day, not the mock-data date", () => {
  const items = [
    { at: "2026-08-01T12:00:00Z", cents: 99999 },
    { at: "2026-08-29T23:59:59Z", cents: 500 },
    { at: "2026-09-04T06:00:00Z", cents: 10000 },
    { at: "2026-09-05T00:00:00Z", cents: 99999 },
  ];
  const totals = dailyTotals(items, (row) => row.at, (row) => row.cents, 7, "2026-09-04T23:59:59Z");
  expect(totals).toEqual([500, 0, 0, 0, 0, 0, 10000]);
  expect(accumulate(totals).at(-1)).toBe(10500);
  expect(dayLabels(7, "2026-09-04T23:59:59Z")).toEqual(["Aug 29", "Aug 30", "Aug 31", "Sep 1", "Sep 2", "Sep 3", "Sep 4"]);
});

test("UTC day boundaries match labels regardless of input timezone", () => {
  const rows = ["2026-09-04T23:30:00-07:00", "2026-09-04T23:30:00Z"];
  expect(dailyTotals(rows, (date) => date, () => 1, 2, "2026-09-05T07:00:00Z")).toEqual([1, 1]);
});

test("demo time is used only when explicitly requested", () => {
  expect(dayLabels(1, DEMO_TODAY_ISO)).toEqual(["Aug 1"]);
  expect(dailyTotals([], String, () => 1, 7, "2026-09-04T12:00:00Z")).toEqual([0, 0, 0, 0, 0, 0, 0]);
});
