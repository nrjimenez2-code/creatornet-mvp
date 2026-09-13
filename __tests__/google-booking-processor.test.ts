import { processGoogleBookingOperation, type GoogleBookingOperation, type GoogleReservation, type GoogleProcessorPorts } from "@/lib/googleBookingProcessor";
import { googleBookingEventId, type GoogleBookingEvent } from "@/lib/googleCalendarProvider";
const id = "11111111-1111-4111-8111-111111111111";
let reservation: GoogleReservation;
let job: GoogleBookingOperation;
let ports: GoogleProcessorPorts;
function event(): GoogleBookingEvent { return { id: googleBookingEventId(id), etag: "etag", status: "confirmed",
  start: { dateTime: reservation.desiredStart ?? reservation.start }, end: { dateTime: reservation.desiredEnd ?? reservation.end },
  extendedProperties: { private: { cn_booking_id: id, cn_creator_id: "creator", cn_attribution: "attribution" } } }; }
beforeEach(() => {
  reservation = { id, revision: 0, creatorId: "creator", buyerId: "buyer", originalPostId: "video", attributionId: "attribution", purchaseId: null, calendarId: "primary", status: "creating",
    start: "2026-10-01T10:00:00Z", end: "2026-10-01T10:30:00Z", desiredStart: null, desiredEnd: null, bufferBeforeMinutes: 5, bufferAfterMinutes: 10, eventId: null, eventEtag: null };
  job = { id: "job", reservationId: id, revision: 0, action: "create", leaseId: "worker", leaseUntil: "2026-10-01T09:30:00Z" };
  ports = { now: () => Date.parse("2026-10-01T09:00:00Z"), loadReservation: jest.fn(async () => reservation),
    verifyLease: jest.fn(async () => {}), assertAvailable: jest.fn(async () => {}), findEvent: jest.fn(async () => null),
    createEvent: jest.fn(async () => event()), rescheduleEvent: jest.fn(async () => event()), cancelEvent: jest.fn(async () => {}), complete: jest.fn(async () => {}) };
});
test("creation requires current availability and a matching attributed provider confirmation", async () => {
  await processGoogleBookingOperation(job, ports);
  expect(ports.assertAvailable).toHaveBeenCalledWith(reservation, reservation.start, reservation.end);
  expect(ports.complete).toHaveBeenCalledWith(job, event());
});
test("retry after remote success reconciles without recreating an event or blocking on itself", async () => {
  ports.findEvent = jest.fn(async () => event());
  await processGoogleBookingOperation(job, ports);
  expect(ports.createEvent).not.toHaveBeenCalled(); expect(ports.assertAvailable).not.toHaveBeenCalled();
  expect(ports.complete).toHaveBeenCalledTimes(1);
});
test("unavailable time never mutates Google or confirms the booking", async () => {
  ports.assertAvailable = jest.fn(async () => { throw new Error("busy"); });
  await expect(processGoogleBookingOperation(job, ports)).rejects.toThrow("busy");
  expect(ports.createEvent).not.toHaveBeenCalled(); expect(ports.complete).not.toHaveBeenCalled();
});
test("forged attribution in a provider result cannot confirm a reservation", async () => {
  ports.createEvent = jest.fn(async () => ({ ...event(), extendedProperties: { private: { cn_booking_id: "other" } } }));
  await expect(processGoogleBookingOperation(job, ports)).rejects.toThrow("does not confirm");
  expect(ports.complete).not.toHaveBeenCalled();
});
test("expired lease or superseded revision prevents external work", async () => {
  job.leaseUntil = "2026-10-01T08:00:00Z";
  await expect(processGoogleBookingOperation(job, ports)).rejects.toThrow("lease expired");
  job.leaseUntil = "2026-10-01T09:30:00Z"; reservation.revision = 1;
  await expect(processGoogleBookingOperation(job, ports)).rejects.toThrow("no longer matches");
  expect(ports.findEvent).not.toHaveBeenCalled();
});
test("external edit is not overwritten by an old reschedule job", async () => {
  job.action = "reschedule"; reservation.status = "rescheduling";
  reservation.eventId = googleBookingEventId(id); reservation.eventEtag = "old";
  reservation.desiredStart = "2026-10-01T11:00:00Z"; reservation.desiredEnd = "2026-10-01T11:30:00Z";
  ports.findEvent = jest.fn(async () => ({ ...event(), etag: "external-edit", start: { dateTime: reservation.start }, end: { dateTime: reservation.end } }));
  await expect(processGoogleBookingOperation(job, ports)).rejects.toThrow("changed externally");
  expect(ports.rescheduleEvent).not.toHaveBeenCalled();
});
test("failed remote cancellation never completes or releases the reservation", async () => {
  job.action = "cancel"; reservation.status = "canceling"; reservation.eventId = googleBookingEventId(id);
  ports.findEvent = jest.fn(async () => event());
  ports.cancelEvent = jest.fn(async () => { throw new Error("timeout"); });
  await expect(processGoogleBookingOperation(job, ports)).rejects.toThrow("timeout");
  expect(ports.complete).not.toHaveBeenCalled();
});
test("already deleted event completes cancellation without sending another request", async () => {
  job.action = "cancel"; reservation.status = "canceling"; reservation.eventId = googleBookingEventId(id);
  await processGoogleBookingOperation(job, ports);
  expect(ports.cancelEvent).not.toHaveBeenCalled(); expect(ports.complete).toHaveBeenCalledWith(job, null);
});

test("delayed work cannot create a new event for a time that has already passed",async()=>{ports.now=()=>Date.parse('2026-10-01T11:00:00Z');job.leaseUntil='2026-10-01T11:30:00Z';await expect(processGoogleBookingOperation(job,ports)).rejects.toThrow(/already passed/);expect(ports.createEvent).not.toHaveBeenCalled();});
