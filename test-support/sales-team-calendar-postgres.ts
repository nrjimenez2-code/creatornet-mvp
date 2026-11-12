import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {monthlySharedAccountingDatabase,installDiscoverLossFixture} from "./sales-team-monthly-shared-postgres";
import {teamFixtureId as id,teamRpc} from "./sales-team-postgres";
import {enableTeamSalesFixture} from "./sales-team-sale-postgres";
import type {BookingAvailability} from "@/lib/bookingAvailability";

export const teamCalendarCandidate="supabase/migrations/20261106181247_sales_team_exact_calendar_ownership.sql";
export const calendarOrigin="https://fixture.vercel.app";
export const calendarConnection=id(9800),calendarWatch=id(9801);
export const calendarAvailability:BookingAvailability={timeZone:"UTC",durationMinutes:30,stepMinutes:15,leadMinutes:0,horizonDays:30,
 bufferBeforeMinutes:10,bufferAfterMinutes:10,windows:Array.from({length:7},(_,weekday)=>({weekday,startMinute:0,endMinute:1440}))};
export const googleCalendarPredecessors=[
 "20260913220917_scheduling_oauth_connections.sql","20260913222716_google_calendar_reservations.sql",
 "20260913223807_google_booking_attribution.sql","20260913224148_google_calendar_setup.sql",
 "20260913225146_google_booking_admission.sql","20260913230334_google_booking_reschedule_admission.sql",
 "20260913231348_google_booking_dashboard.sql","20260913232056_google_calendar_reconciliation.sql",
 "20260913233649_google_reschedule_recovery.sql","20260913234159_google_unattempted_booking_recovery.sql",
 "20260913235026_google_unattempted_reschedule_recovery.sql","20260914000350_google_booking_worker_capacity.sql",
 "20260914003852_google_reconnect_retry_wakeup.sql","20260914012650_google_watch_renewal_fairness.sql"];
/** Actual native calendar owners over the existing structural/pinned team
 * predecessor fixture. No provider, hosted or complete installed-schema proof. */
export async function teamCalendarDatabase(db:PGlite,install=true){
 await monthlySharedAccountingDatabase(db);await installDiscoverLossFixture(db);
 await db.exec(`alter table profiles add column full_name text,add column username text;
  alter table posts add column video_action text default 'book',add column active boolean default true,add column hidden_at timestamptz,add column removed_at timestamptz;
  alter table discover_booking_attribution_v1 add column setup_session_id text unique,add column provider text,
  add column provider_booking_id text,add column provider_event_at timestamptz,add column scheduled_at timestamptz;
  create unique index team_calendar_fixture_discover_entity_v1 on discover_events_v1(kind,entity_key);
  create table free_booking_checkouts(id uuid primary key,buyer_id uuid,creator_id uuid,post_id uuid,status text,stripe_session_id text unique);
  grant select,insert,update,delete on free_booking_checkouts to service_role;grant insert on bookings to service_role;`);
 await db.exec(readFileSync("supabase/migrations/20261021222610_sales_team_booking_source_routing.sql","utf8"));
 for(const migration of googleCalendarPredecessors)await db.exec(readFileSync("supabase/migrations/"+migration,"utf8"));
 if(install)await db.exec(readFileSync(teamCalendarCandidate,"utf8"));
 return db;
}
export async function configureTeamCalendarFixture(db:PGlite){
 await db.exec("update sales_team_controls_v1 set access_enabled=true,new_sales_enabled=true");
 await db.query("update posts set product_id=null,video_action='book' where id=$1",[id(20)]);
 const member=await enableTeamSalesFixture(db,{assignBooking:false});await teamRpc(db,1,"configure_routing",{enabled:true});
 await db.query("update booking_targets set booking_url=$1 where id=$2",[calendarOrigin+"/scheduling/book/"+calendarConnection,id(102)]);
 await db.query(`insert into scheduling_connections_v1(id,creator_id,provider,status,account_id,credentials_ciphertext,webhook_id,webhook_secret_ciphertext,token_expires_at)
  values($1,$2,'google','connected','google-account-2','fixture-encrypted',$3,'fixture-encrypted',now()+interval '1 day')`,[calendarConnection,id(2),calendarWatch]);
 await db.query(`insert into google_booking_settings_v1(connection_id,calendar_id,conflict_calendar_ids,availability,title)
  values($1,'primary',array['primary'],$2,'Your sales call')`,[calendarConnection,calendarAvailability]);
 await db.query(`insert into google_calendar_watches_v1(id,connection_id,calendar_id,token_ciphertext,resource_id,status,expires_at)
  values($1,$2,'primary','fixture-encrypted','fixture-resource','active',now()+interval '1 day')`,[calendarWatch,calendarConnection]);
 if((await db.query<{present:boolean}>("select to_regclass('public.team_calendar_policy_v1') is not null present")).rows[0].present)
  await db.query("update team_calendar_policy_v1 set enabled=true,origin=$1,contract_sha256=creatornet_calendar_team_private.contract_digest_v1()",[calendarOrigin]);
 return {member,buyer:id(10),creator:id(1),post:id(20),connection:calendarConnection};
}
export async function seedTeamCalendar(db:PGlite){
 const fixture=await configureTeamCalendarFixture(db);
 const booking=(await db.query<{v:{booking_id:string;assignment:{revision:number}}}>("select public.seed_sales_team_booking_v1($1,$2,$3) v",[fixture.creator,fixture.buyer,fixture.post])).rows[0].v;
 return {...fixture,booking:booking.booking_id};
}
