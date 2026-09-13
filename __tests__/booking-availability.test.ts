import { availableBookingSlots, type BookingAvailability } from "@/lib/bookingAvailability";
const policy: BookingAvailability = { timeZone: "UTC", durationMinutes: 30, stepMinutes: 30, leadMinutes: 0, horizonDays: 30,
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, windows: [{ weekday: 4, startMinute: 540, endMinute: 660 }] };
const range = { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" };
const now = Date.parse(range.start);
test("only creator-approved hours are offered and both remote and local conflicts are excluded", () => {
  const slots = availableBookingSlots(policy, range, [
    { start: "2026-10-01T09:00:00Z", end: "2026-10-01T09:30:00Z" },
    { start: "2026-10-01T10:00:00Z", end: "2026-10-01T10:15:00Z" },
  ], now);
  expect(slots.map(slot => slot.start)).toEqual(["2026-10-01T09:30:00.000Z", "2026-10-01T10:30:00.000Z"]);
});
test("lead time and buffers exclude otherwise-free slots", () => {
  const slots = availableBookingSlots({ ...policy, leadMinutes: 15, bufferAfterMinutes: 15 }, range,
    [{ start: "2026-10-01T10:00:00Z", end: "2026-10-01T10:30:00Z" }], Date.parse("2026-10-01T09:00:00Z"));
  expect(slots.map(slot => slot.start)).toEqual(["2026-10-01T10:30:00.000Z"]);
});
test("spring-forward nonexistent hours do not create fake slots", () => {
  const slots = availableBookingSlots({ ...policy, timeZone: "America/New_York", windows: [{ weekday: 0, startMinute: 120, endMinute: 180 }] },
    { start: "2027-03-14T00:00:00Z", end: "2027-03-15T00:00:00Z" }, [], Date.parse("2027-03-14T00:00:00Z"));
  expect(slots).toEqual([]);
});
test("fall-back repeated hours remain separate real appointment instants", () => {
  const slots = availableBookingSlots({ ...policy, timeZone: "America/New_York", windows: [{ weekday: 0, startMinute: 60, endMinute: 120 }] },
    { start: "2026-11-01T00:00:00Z", end: "2026-11-02T00:00:00Z" }, [], Date.parse("2026-11-01T00:00:00Z"));
  expect(slots.map(slot => slot.start)).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T06:30:00.000Z"]);
});
test("unknown busy data and invalid policies fail rather than offering unsafe slots", () => {
  expect(() => availableBookingSlots(policy, range, [{ start: "invalid", end: range.end }], now)).toThrow();
  expect(() => availableBookingSlots({ ...policy, windows: [] }, range, [], now)).toThrow();
  expect(() => availableBookingSlots({ ...policy, timeZone: "invalid" }, range, [], now)).toThrow();
});
