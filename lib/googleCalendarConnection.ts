import "server-only";
import { randomUUID, randomBytes } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { schedulingOrigin, googleCalendarConfig } from "@/lib/schedulingConfig";
import { openSchedulingSecret, sealSchedulingSecret } from "@/lib/schedulingSecrets";
import { exchangeGoogleCalendarToken, GoogleCalendarError, getGoogleCalendarAccount, listGoogleCalendars,
  startGoogleCalendarWatch, stopGoogleCalendarWatch } from "@/lib/googleCalendarProvider";
import { validateBookingAvailability, type BookingAvailability } from "@/lib/bookingAvailability";
import type { SchedulingTokens } from "@/lib/schedulingProvider";
export { googleCalendarConfig } from "@/lib/schedulingConfig";

type Connection = { id: string; creator_id: string; status: string; account_id: string | null; account_name: string | null;
  credentials_ciphertext: string | null; lease_id: string; lease_until: string };
const secretContext = (row: Connection) => `${row.creator_id}:google:tokens`;
async function checked(result: { error: unknown }) { if (result.error) throw new Error("Could not save Google Calendar settings"); }
async function save(row: Connection, values: Record<string, unknown>) {
  const result = await db.from("scheduling_connections_v1").update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("lease_id", row.lease_id).gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
  if (result.error || !result.data) throw new Error("Google connection is unavailable or updating");
  Object.assign(row, values);
}
async function withConnection<T>(filter: { creator: string } | { id: string }, action: (row: Connection) => Promise<T>): Promise<T> {
  const lease = randomUUID();
  let query = db.from("scheduling_connections_v1").update({ lease_id: lease, lease_until: new Date(Date.now() + 120_000).toISOString() }).eq("provider", "google");
  query = "creator" in filter ? query.eq("creator_id", filter.creator) : query.eq("id", filter.id);
  const result = await query.or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).select("*").maybeSingle();
  if (result.error || !result.data) throw new Error("Google connection is unavailable or updating");
  const row = result.data as Connection;
  try { return await action(row); }
  catch (cause) {
    if (cause instanceof GoogleCalendarError && cause.requiresReconnect && row.status !== "disconnected")
      await save(row, { status: "reconnect_required", last_error_code: "google_authorization_expired" });
    throw cause;
  }
  finally { await db.from("scheduling_connections_v1").update({ lease_id: null, lease_until: null }).eq("id", row.id).eq("lease_id", lease); }
}
async function accessToken(row: Connection): Promise<string> {
  if (!["connected", "pending", "disconnecting"].includes(row.status) || !row.credentials_ciphertext) throw new Error("Reconnect Google Calendar first");
  const stored = JSON.parse(openSchedulingSecret(row.credentials_ciphertext, secretContext(row))) as SchedulingTokens;
  if (stored.expiresAt > Date.now() + 60_000) return stored.accessToken;
  try {
    const fresh = await exchangeGoogleCalendarToken(googleCalendarConfig(), { refreshToken: stored.refreshToken });
    await save(row, { credentials_ciphertext: sealSchedulingSecret(JSON.stringify(fresh), secretContext(row)), token_expires_at: new Date(fresh.expiresAt).toISOString() });
    return fresh.accessToken;
  } catch (cause) {
    if (cause instanceof GoogleCalendarError && [400,401].includes(cause.status)) await save(row, { status: "reconnect_required", last_error_code: "google_authorization_expired" });
    throw cause;
  }
}
export async function googleConnectionAccessToken(connectionId: string) {
  googleCalendarConfig();
  return withConnection({ id: connectionId }, accessToken);
}
export async function finishGoogleCalendarConnection(creator: string, code: string, verifier: string) {
  const config = googleCalendarConfig();
  await checked(await db.from("scheduling_connections_v1").upsert({ creator_id: creator, provider: "google" }, { onConflict: "creator_id,provider", ignoreDuplicates: true }));
  return withConnection({ creator }, async row => {
    const tokens = await exchangeGoogleCalendarToken(config, { code, verifier });
    const account = await getGoogleCalendarAccount(tokens.accessToken);
    if (row.account_id && row.account_id !== account.id) {
      const bookings = await db.from("google_booking_reservations_v1").select("id").eq("connection_id", row.id).not("status", "in", "(canceled,failed)").limit(1);
      if (bookings.error || bookings.data?.length || row.status !== "disconnected") throw new Error("Reconnect the Google account used by your existing bookings");
    }
    // Authorization alone does not claim that calendars, hours and notifications are ready.
    await save(row, { status: "pending", account_id: account.id, account_name: account.email,
      credentials_ciphertext: sealSchedulingSecret(JSON.stringify(tokens), secretContext(row)), token_expires_at: new Date(tokens.expiresAt).toISOString(), last_error_code: null });
  });
}
export async function getGoogleCalendarSetup(creator: string) {
  return withConnection({ creator }, async row => {
    const calendars = await listGoogleCalendars(await accessToken(row));
    const settings = await db.from("google_booking_settings_v1").select("calendar_id,conflict_calendar_ids,availability,title").eq("connection_id", row.id).maybeSingle();
    if (settings.error) throw new Error("Could not load calendar settings");
    return { accountName: row.account_name, calendars: calendars.map(({id,summary,timeZone,primary}) => ({id,summary,timeZone,primary})), settings: settings.data };
  });
}
export type GoogleCalendarSetup = { calendarId: string; conflictCalendarIds: string[]; availability: BookingAvailability; title: string };
export async function saveGoogleCalendarSetup(creator: string, input: GoogleCalendarSetup) {
  validateBookingAvailability(input.availability);
  if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 160 || !Array.isArray(input.conflictCalendarIds) ||
    !input.conflictCalendarIds.length || input.conflictCalendarIds.length > 50 || new Set(input.conflictCalendarIds).size !== input.conflictCalendarIds.length ||
    !input.conflictCalendarIds.includes(input.calendarId)) throw new Error("Choose a booking calendar and valid availability");
  return withConnection({ creator }, row => configureCalendar(row,input));
}
async function configureCalendar(row:Connection,input:GoogleCalendarSetup) {
    const creator=row.creator_id;
    const token = await accessToken(row);
    const calendars = await listGoogleCalendars(token);
    if (!input.conflictCalendarIds.every(id => calendars.some(calendar => calendar.id === id))) throw new Error("Choose calendars owned by your connected Google account");
    const watches = await db.from("google_calendar_watches_v1").select("id,resource_id,expires_at,token_ciphertext")
      .eq("connection_id", row.id).eq("calendar_id", input.calendarId).eq("status", "active").gt("expires_at", new Date(Date.now()+86400_000).toISOString()).order("expires_at", { ascending: false }).limit(1);
    if (watches.error) throw new Error("Could not check calendar notifications");
    let watch = watches.data?.[0];
    if (!watch) {
      const id = randomUUID(), secret = randomBytes(32).toString("hex");
      const encrypted = sealSchedulingSecret(secret, `${row.creator_id}:google:watch:${id}`);
      // The channel identity exists before Google can send the initial sync notification.
      await checked(await db.from("google_calendar_watches_v1").insert({ id, connection_id: row.id, calendar_id: input.calendarId,
        token_ciphertext: encrypted, expires_at: new Date(Date.now()+604800000).toISOString(), sync_requested_at: new Date().toISOString() }));
      const created = await startGoogleCalendarWatch(token, input.calendarId, { id, token: secret, address: `${schedulingOrigin()}/api/scheduling/google/notifications` });
      watch = { id, resource_id: created.resourceId, expires_at: new Date(Number(created.expiration)).toISOString(), token_ciphertext: encrypted };
      await checked(await db.from("google_calendar_watches_v1").update({ status: "active", resource_id: watch.resource_id, expires_at: watch.expires_at }).eq("id", id).eq("status", "pending"));
    }
    await checked(await db.rpc("configure_google_calendar_v1", { p_connection: row.id, p_creator: creator, p_lease: row.lease_id,
      p_calendar: input.calendarId, p_conflicts: input.conflictCalendarIds, p_availability: input.availability, p_title: input.title.trim(), p_watch: watch.id }));
}
export async function disconnectGoogleCalendar(creator: string) {
  return withConnection({ creator }, async row => {
    if (row.status === "disconnected") return;
    await checked(await db.rpc("begin_google_calendar_disconnect_v1",{p_connection:row.id,p_creator:creator,p_lease:row.lease_id}));
    row.status="disconnecting";
    let token:string|null=null;
    try { token=await accessToken(row); } catch(cause) { if(!(cause instanceof GoogleCalendarError) || ![400,401].includes(cause.status)) throw cause; }
    const watches = await db.from("google_calendar_watches_v1").select("id,resource_id,expires_at").eq("connection_id",row.id).neq("status","stopped");
    if (watches.error) throw new Error("Could not load calendar notifications");
    for (const watch of watches.data ?? []) {
      if (watch.resource_id && token) {
        try { await stopGoogleCalendarWatch(token, { id:watch.id,resourceId:watch.resource_id,expiration:String(Date.parse(watch.expires_at)) }); }
        catch(cause) { if(!(cause instanceof GoogleCalendarError) || cause.status!==401) throw cause; }
      }
      await checked(await db.from("google_calendar_watches_v1").update({status:"stopped"}).eq("id",watch.id));
    }
    await checked(await db.from("google_booking_settings_v1").update({active:false}).eq("connection_id",row.id));
    await save(row, { status:"disconnected",credentials_ciphertext:null,token_expires_at:null,webhook_id:null,webhook_secret_ciphertext:null,last_error_code:null });
  });
}
export async function refreshGoogleCalendarConnection(creator: string) {
  return withConnection({creator},async row=>{
    if(row.status!=="connected") return;
    const settings = await db.from("google_booking_settings_v1").select("calendar_id,conflict_calendar_ids,availability,title").eq("connection_id",row.id).eq("active",true).maybeSingle();
    if(settings.error) throw new Error("Could not check booking settings");
    if(!settings.data) { await save(row,{status:"pending"});return; }
    await configureCalendar(row,{calendarId:settings.data.calendar_id,conflictCalendarIds:settings.data.conflict_calendar_ids,
      availability:settings.data.availability as BookingAvailability,title:settings.data.title});
  });
}
