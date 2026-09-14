import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { googleConnectionAccessToken,refreshRejectedGoogleAccessToken } from "@/lib/googleCalendarConnection";
import { processGoogleBookingOperation, type GoogleBookingOperation, type GoogleReservation } from "@/lib/googleBookingProcessor";
import { getGoogleBookingEvent, createGoogleBookingEvent, changeGoogleBookingEvent, cancelGoogleBookingEvent,
  assertGoogleBookingTimeAvailable, GoogleCalendarError } from "@/lib/googleCalendarProvider";
import { authorizeGoogleBooking } from "@/lib/googleBookingAccess";
import type { BookingAvailability } from "@/lib/bookingAvailability";

/** One job per invocation keeps the external operation inside its five-minute lease. */
export async function processNextGoogleBookingJob(): Promise<{ processed: boolean; retry?: boolean }> {
  const worker = randomUUID();
  const claimed = await db.rpc("claim_google_booking_job_v1", { p_worker: worker });
  if (claimed.error) throw new Error("Could not claim Google booking job");
  const row = claimed.data?.[0];
  if (!row) return { processed: false };
  const job: GoogleBookingOperation = { id: row.id, reservationId: row.reservation_id, revision: row.revision,
    action: row.action, leaseId: worker, leaseUntil: row.lease_until };
  let token = "";
  let settings: { title: string; availability: BookingAvailability; conflict_calendar_ids: string[] };
  let connectionId = "";
  let buyerEmail = "";
  try {
    await processGoogleBookingOperation(job, {
      now: Date.now,
      verifyLease: async current => {
        const result = await db.from("google_booking_jobs_v1").select("id").eq("id", current.id).eq("lease_id", worker)
          .eq("status", "processing").gt("lease_until", new Date().toISOString()).maybeSingle();
        if (result.error || !result.data) throw new Error("Booking worker lease expired");
      },
      loadReservation: async id => {
        const reservation = await db.from("google_booking_reservations_v1").select("*").eq("id", id).single();
        if (reservation.error || !reservation.data) throw new Error("Reservation unavailable");
        const r = reservation.data; connectionId = r.connection_id;
        const connection = await db.from("scheduling_connections_v1").select("creator_id,status").eq("id", connectionId).eq("provider", "google").single();
        if (connection.error || !connection.data || !["connected", ...(job.action === "cancel" ? ["disconnecting"] : [])].includes(connection.data.status))
          throw new Error("Google Calendar is not connected");
        const config = await db.from("google_booking_settings_v1").select("title,availability,conflict_calendar_ids").eq("connection_id", connectionId).single();
        if (config.error || !config.data) throw new Error("Google booking settings unavailable");
        settings = config.data as typeof settings;
        token = await googleConnectionAccessToken(connectionId);
        if (job.action === "create") {
          const buyer = await db.auth.admin.getUserById(r.buyer_id);
          if (buyer.error || !buyer.data.user?.email) throw new Error("Booking attendee unavailable");
          buyerEmail = buyer.data.user.email;
        }
        return { id: r.id, revision: r.revision, creatorId: connection.data.creator_id, buyerId: r.buyer_id,
          originalPostId: r.original_post_id, attributionId: r.attribution_id, purchaseId: r.purchase_id, calendarId: r.calendar_id, status: r.status,
          start: r.starts_at, end: r.ends_at, desiredStart: r.desired_starts_at, desiredEnd: r.desired_ends_at,
          bufferBeforeMinutes: r.buffer_before_minutes, bufferAfterMinutes: r.buffer_after_minutes,
          eventId: r.event_id, eventEtag: r.event_etag } satisfies GoogleReservation;
      },
      assertAvailable: async (reservation, start, end) => {
        if (reservation.purchaseId) {
          const access = await authorizeGoogleBooking(connectionId, reservation.buyerId, { purchaseId: reservation.purchaseId });
          if (access.attributionId !== reservation.attributionId || access.postId !== reservation.originalPostId || access.reservationId !== reservation.id)
            throw new Error("Paid booking access changed");
        }
        const interval = { start: new Date(Date.parse(start) - reservation.bufferBeforeMinutes * 60000).toISOString(),
          end: new Date(Date.parse(end) + reservation.bufferAfterMinutes * 60000).toISOString() };
        await assertGoogleBookingTimeAvailable(token, reservation.calendarId, settings.conflict_calendar_ids, interval, reservation.eventId);
        // The database admission functions reserve old/new times atomically. Those
        // ranges remain occupied until this job is reconciled, even after a timeout.
      },
      findEvent: async reservation => {
        try { return await getGoogleBookingEvent(token, reservation.calendarId, reservation.id, reservation.eventId ?? undefined); }
        catch (cause) { if (cause instanceof GoogleCalendarError && [404, 410].includes(cause.status)) return null; throw cause; }
      },
      createEvent: reservation => createGoogleBookingEvent(token, reservation.calendarId, { bookingId: reservation.id,
        creatorId: reservation.creatorId, attributionId: reservation.attributionId ?? "", summary: settings.title, attendeeEmail: buyerEmail,
        start: reservation.start, end: reservation.end, timeZone: settings.availability.timeZone }),
      rescheduleEvent: (reservation, start, end) => changeGoogleBookingEvent(token, reservation.calendarId, reservation.id,
        { start, end, timeZone: settings.availability.timeZone }, reservation.eventEtag ?? undefined),
      cancelEvent: reservation => cancelGoogleBookingEvent(token, reservation.calendarId, reservation.id),
      beginMutation: async current => {
        const result=await db.rpc("begin_google_booking_mutation_v1",{p_job:current.id,p_worker:worker});
        if(result.error)throw new Error("Could not start calendar mutation");
      },
      failUnattempted: async (current,reason) => {
        const result=await db.rpc("fail_unattempted_google_booking_v1",{p_job:current.id,p_worker:worker,p_reason:reason});
        if(result.error)throw new Error("Could not recover unavailable booking time");
        return result.data===true;
      },
      recoverReschedule: async (current, reservation, event) => {
        const recovered = await db.rpc("recover_google_reschedule_v1", {p_job:current.id,p_worker:worker,
          p_event:reservation.eventId,p_etag:event?.etag??null,p_start:event?.start?.dateTime??null,
          p_end:event?.end?.dateTime??null,p_canceled:!event});
        if(recovered.error)throw new Error("Could not recover externally changed booking");
      },
      complete: async (current, event) => {
        const completed = await db.rpc("complete_google_booking_job_v1", { p_job: current.id, p_worker: worker,
          p_event_id: event?.id ?? null, p_event_etag: event?.etag ?? null, p_start: event?.start?.dateTime ?? null, p_end: event?.end?.dateTime ?? null });
        if (completed.error) throw new Error("Could not commit Google booking confirmation");
      },
    });
    return { processed: true };
  } catch (cause) {
    if(cause instanceof GoogleCalendarError && cause.requiresReconnect && connectionId && token){
      try{await refreshRejectedGoogleAccessToken(connectionId,token);}catch{/* The connection helper records a revoked grant; keep the job reserved. */}
    }
    // Do not release the reservation when the remote outcome is uncertain. The
    // next attempt reads the deterministic event ID before any new mutation.
    const retry = await db.from("google_booking_jobs_v1").update({ status: "retry", lease_id: null, lease_until: null,
      last_error_code: "google_booking_reconciliation_required", next_attempt_at: new Date(Date.now() + Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8)) * 1000).toISOString(),
    }).eq("id", job.id).eq("lease_id", worker).eq("status", "processing").gt("lease_until", new Date().toISOString());
    if (retry.error) throw new Error("Could not save Google booking retry");
    return { processed: true, retry: true };
  }
}
