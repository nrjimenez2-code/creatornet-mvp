export type AvailabilityWindow = { weekday: number; startMinute: number; endMinute: number };
export type BookingAvailability = {
  timeZone: string;
  durationMinutes: number;
  stepMinutes: number;
  leadMinutes: number;
  horizonDays: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  windows: AvailabilityWindow[];
};
export type BookingInterval = { start: string; end: string };

export function validateBookingAvailability(policy: BookingAvailability): void {
  new Intl.DateTimeFormat("en-US", { timeZone: policy.timeZone });
  for (const [value, min, max] of [
    [policy.durationMinutes, 5, 240], [policy.stepMinutes, 5, 60], [policy.leadMinutes, 0, 43200],
    [policy.horizonDays, 1, 365], [policy.bufferBeforeMinutes, 0, 240], [policy.bufferAfterMinutes, 0, 240],
  ]) if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid booking availability policy");
  if (!Array.isArray(policy.windows) || !policy.windows.length || policy.windows.length > 28) throw new Error("Choose your weekly booking hours");
  const ordered = [...policy.windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  ordered.forEach((window, index) => {
    if (!Number.isInteger(window.weekday) || window.weekday < 0 || window.weekday > 6 ||
        !Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute) ||
        window.startMinute < 0 || window.endMinute > 1440 || window.endMinute <= window.startMinute)
      throw new Error("Invalid weekly booking hours");
    const previous = ordered[index - 1];
    if (previous?.weekday === window.weekday && previous.endMinute > window.startMinute)
      throw new Error("Weekly booking hours overlap");
  });
}

/** Google free/busy and CreatorNet reservations must both be passed as occupied intervals. */
export function availableBookingSlots(policy: BookingAvailability, range: BookingInterval,
  occupied: BookingInterval[], now = Date.now()): BookingInterval[] {
  validateBookingAvailability(policy);
  const start = Date.parse(range.start), end = Date.parse(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 14 * 86400000 || !Number.isFinite(now))
    throw new Error("Choose a booking range of at most fourteen days");
  const busy = occupied.map(interval => {
    const from = Date.parse(interval.start), to = Date.parse(interval.end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("Invalid occupied interval");
    return { from, to };
  });
  const format = new Intl.DateTimeFormat("en-US", { timeZone: policy.timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const localCache = new Map<number, { weekday: number; minute: number; date: string }>();
  const local = (instant: number) => {
    let result = localCache.get(instant);
    if (!result) {
      const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
      result = { weekday: weekdays.indexOf(parts.weekday), minute: Number(parts.hour) * 60 + Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
      localCache.set(instant, result);
    }
    return result;
  };
  const earliest = Math.max(start, now + policy.leadMinutes * 60000);
  const latest = Math.min(end, now + policy.horizonDays * 86400000);
  const duration = policy.durationMinutes * 60000;
  const slots: BookingInterval[] = [];
  // Enumerate actual instants: nonexistent spring-forward local times are never offered;
  // repeated fall-back local times retain distinct UTC offsets/instants.
  for (let instant = Math.ceil(earliest / 60000) * 60000; instant + duration <= latest; instant += 60000) {
    const clock = local(instant);
    const window = policy.windows.find(window => window.weekday === clock.weekday && clock.minute >= window.startMinute && clock.minute < window.endMinute && (clock.minute - window.startMinute) % policy.stepMinutes === 0);
    if (!window) continue;
    const finish = instant + duration;
    if (busy.some(interval => instant - policy.bufferBeforeMinutes * 60000 < interval.to && finish + policy.bufferAfterMinutes * 60000 > interval.from)) continue;
    let withinHours = true;
    for (let minute = instant; minute < finish; minute += 60000) {
      const part = local(minute);
      if (part.date !== clock.date || part.minute < window.startMinute || part.minute >= window.endMinute) { withinHours = false; break; }
    }
    if (withinHours) slots.push({ start: new Date(instant).toISOString(), end: new Date(finish).toISOString() });
  }
  return slots;
}
