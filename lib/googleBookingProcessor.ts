import "server-only";
import { googleBookingEventId, type GoogleBookingEvent } from "@/lib/googleCalendarProvider";

export type GoogleBookingOperation = {
  id: string; reservationId: string; revision: number; action: "create" | "reschedule" | "cancel";
  leaseId: string; leaseUntil: string;
};
export type GoogleReservation = {
  id: string; revision: number; creatorId: string; buyerId: string; originalPostId: string;
  attributionId: string | null; purchaseId: string | null; calendarId: string; status: string;
  start: string; end: string; desiredStart: string | null; desiredEnd: string | null;
  bufferBeforeMinutes: number; bufferAfterMinutes: number;
  eventId: string | null; eventEtag: string | null;
};
export type GoogleProcessorPorts = {
  now: () => number;
  loadReservation: (id: string) => Promise<GoogleReservation>;
  verifyLease: (job: GoogleBookingOperation) => Promise<void>;
  assertAvailable: (reservation: GoogleReservation, start: string, end: string) => Promise<void>;
  findEvent: (reservation: GoogleReservation) => Promise<GoogleBookingEvent | null>;
  createEvent: (reservation: GoogleReservation) => Promise<GoogleBookingEvent>;
  rescheduleEvent: (reservation: GoogleReservation, start: string, end: string) => Promise<GoogleBookingEvent>;
  cancelEvent: (reservation: GoogleReservation) => Promise<void>;
  complete: (job: GoogleBookingOperation, event: GoogleBookingEvent | null) => Promise<void>;
};

function matches(event: GoogleBookingEvent, reservation: GoogleReservation, start: string, end: string): boolean {
  return event.status === "confirmed" && !!event.etag &&
    event.id === googleBookingEventId(reservation.id) &&
    event.extendedProperties?.private?.cn_booking_id === reservation.id &&
    event.extendedProperties.private.cn_creator_id === reservation.creatorId &&
    event.extendedProperties.private.cn_attribution === (reservation.attributionId ?? "") &&
    Date.parse(event.start?.dateTime ?? "") === Date.parse(start) && Date.parse(event.end?.dateTime ?? "") === Date.parse(end);
}

/** The store completes the job and reservation atomically under the same live lease. */
export async function processGoogleBookingOperation(job: GoogleBookingOperation, ports: GoogleProcessorPorts): Promise<void> {
  const guard = async () => {
    if (!Number.isFinite(Date.parse(job.leaseUntil)) || Date.parse(job.leaseUntil) <= ports.now()) throw new Error("Booking worker lease expired");
    await ports.verifyLease(job);
  };
  await guard();
  const reservation = await ports.loadReservation(job.reservationId);
  const expectedStatus = { create: "creating", reschedule: "rescheduling", cancel: "canceling" }[job.action];
  if (reservation.id !== job.reservationId || reservation.revision !== job.revision || reservation.status !== expectedStatus)
    throw new Error("Booking operation no longer matches its reservation");
  if (reservation.eventId && reservation.eventId !== googleBookingEventId(reservation.id)) throw new Error("Calendar event identity changed");

  const existing = await ports.findEvent(reservation);
  if (existing && existing.id !== googleBookingEventId(reservation.id)) throw new Error("Calendar event identity changed");
  // Deleted-event tombstones may omit extended properties. The fixed event ID is
  // accepted only when it also matches the event already recorded in our reservation.
  if (existing && existing.status !== "cancelled" &&
      (existing.extendedProperties?.private?.cn_booking_id !== reservation.id ||
       existing.extendedProperties.private.cn_creator_id !== reservation.creatorId ||
       existing.extendedProperties.private.cn_attribution !== (reservation.attributionId ?? "")))
    throw new Error("Calendar event attribution mismatch");

  if (job.action === "cancel") {
    if (!reservation.eventId) throw new Error("Cancellation has no confirmed event");
    if (existing && existing.status !== "cancelled") {
      await guard();
      await ports.cancelEvent(reservation);
    }
    await guard();
    await ports.complete(job, null);
    return;
  }

  const start = job.action === "reschedule" ? reservation.desiredStart : reservation.start;
  const end = job.action === "reschedule" ? reservation.desiredEnd : reservation.end;
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start))
    throw new Error("Invalid reserved interval");
  // A timed-out mutation may already be committed at Google. Reconcile first;
  // do not mistake the booking's own event for a new availability conflict.
  if (existing && matches(existing, reservation, start, end)) {
    await guard();
    await ports.complete(job, existing);
    return;
  }
  if (existing?.status === "cancelled") throw new Error("Calendar booking was canceled externally");
  if (job.action === "create" && existing) throw new Error("Existing event differs from the reservation");
  if (job.action === "reschedule" && (!existing || !reservation.eventEtag || existing.etag !== reservation.eventEtag))
    throw new Error("Calendar booking changed externally; reconcile before rescheduling");
  if (Date.parse(start) <= ports.now()) throw new Error("Reserved time has already passed; choose a new time");
  await ports.assertAvailable(reservation, start, end);
  await guard();
  const result = job.action === "create" ? await ports.createEvent(reservation) : await ports.rescheduleEvent(reservation, start, end);
  if (!matches(result, reservation, start, end)) throw new Error("Calendar response does not confirm this reservation");
  await guard();
  await ports.complete(job, result);
}
