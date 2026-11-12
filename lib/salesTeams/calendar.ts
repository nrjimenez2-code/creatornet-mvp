import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {googleBookingConnectionFromUrl} from "@/lib/googleBookingUrl";
import {googleCalendarAvailable,schedulingOrigin} from "@/lib/schedulingConfig";
import {TeamSalesError,teamId,teamCalendarReady,teamCalendarSchemaReady} from "./policy";
import type {TeamAppointment,TeamAppointmentStatus} from "./calendarTypes";

export type TeamCalendarContext={
 bookingId:string;creatorId:string;buyerId:string;postId:string;sourceIdentity:string;assignmentRevision:number;membershipId:string;targetId:string;
 connectionId:string;calendarOwnerId:string;accountId:string;calendarId:string;destinationUrl:string;origin:string;generation:number;reservationId:string;
};
export type TeamCalendarReservation={
 bookingId:string;connectionId:string;postId:string;calendarOwnerId:string;assignmentChanged:boolean;canReschedule:boolean;rebookingUrl:string|null;
};
export type TeamSchedulingRow={bookingId:string;buyerId:string;postId:string;teamManaged:boolean;scheduling:TeamAppointment[]};
const invalid=()=>new TeamSalesError("TEAM_CALENDAR_RESPONSE_INVALID","The appointment needs review. Refresh its current status.");
const record=(value:unknown):Record<string,unknown>=>{
 if(!value||typeof value!=="object"||Array.isArray(value))throw invalid();
 return value as Record<string,unknown>;
};
const uuid=(value:unknown)=>{
 try{return teamId(value).toLowerCase();}catch{throw invalid();}
};
const positive=(value:unknown)=>{
 if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1)throw invalid();
 return value;
};
const text=(value:unknown)=>{
 if(typeof value!=="string"||!value)throw invalid();return value;
};
const date=(value:unknown)=>{
 if(value===null)return null;if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw invalid();return value;
};
const boolean=(value:unknown)=>{
 if(typeof value!=="boolean")throw invalid();return value;
};
async function call(admin:SupabaseClient,name:string,args:Record<string,unknown>):Promise<unknown>{
 const result=await admin.rpc(name,args);if(result.error)throw result.error;return result.data;
}
export const TEAM_CALENDAR_APPOINTMENT_PENDING_MESSAGE="Your earlier appointment stays with its original closer. Cancel it before booking with your new closer.";
export class TeamCalendarAppointmentPending extends TeamSalesError{
 constructor(public readonly manageUrl:string){
  super("TEAM_CALENDAR_ORIGINAL_APPOINTMENT_PENDING",TEAM_CALENDAR_APPOINTMENT_PENDING_MESSAGE);
 }
}
function nativeUrl(connectionId:string,query:Record<string,string>){
 const url=new URL("/scheduling/book/"+uuid(connectionId),schedulingOrigin());
 for(const [key,value] of Object.entries(query))url.searchParams.set(key,uuid(value));
 return url.toString();
}
export function teamCalendarRoutingOrigin(){
 if(!teamCalendarReady()||!googleCalendarAvailable())
  throw new TeamSalesError("TEAM_CALENDAR_NOT_ENABLED","The team calendar is temporarily unavailable.");
 return schedulingOrigin();
}
export function teamNativeBookingUrl(raw:string,bookingId:string){
 const origin=teamCalendarRoutingOrigin();
 const connection=googleBookingConnectionFromUrl(raw,origin),canonicalPath=connection?"/scheduling/book/"+connection.toLowerCase():null;
 // External providers do not yet bind canonical team appointment ownership.
 // Match the exact stored destinations accepted by the native SQL owner.
 if(!connection||!canonicalPath||(raw!==canonicalPath&&raw!==origin+canonicalPath))
  throw new TeamSalesError("TEAM_CALENDAR_REQUIRED","The assigned calendar needs manager review.");
 return nativeUrl(connection,{team_booking_id:bookingId});
}
export async function readTeamGoogleContext(admin:SupabaseClient,booking:string,buyer:string,connection:string):Promise<TeamCalendarContext>{
 if(!teamCalendarReady())throw new TeamSalesError("TEAM_CALENDAR_NOT_ENABLED","Team appointment booking is temporarily unavailable.");
 const origin=schedulingOrigin(),bookingId=uuid(booking),buyerId=uuid(buyer),connectionId=uuid(connection);
 const value=record(await call(admin,"read_team_google_booking_v1",{p_booking:bookingId,p_buyer:buyerId,p_connection:connectionId,p_origin:origin}));
 if(value.blockedBy){
  const prior=record(value.blockedBy);
  throw new TeamCalendarAppointmentPending(nativeUrl(uuid(prior.connectionId),{reservation_id:uuid(prior.reservationId)}));
 }
 const result:TeamCalendarContext={
  bookingId:uuid(value.bookingId),creatorId:uuid(value.creatorId),buyerId:uuid(value.buyerId),postId:uuid(value.postId),
  sourceIdentity:text(value.sourceIdentity),assignmentRevision:positive(value.assignmentRevision),membershipId:uuid(value.membershipId),targetId:uuid(value.targetId),
  connectionId:uuid(value.connectionId),calendarOwnerId:uuid(value.calendarOwnerId),accountId:text(value.accountId),calendarId:text(value.calendarId),
  destinationUrl:text(value.destinationUrl),origin:text(value.origin),generation:positive(value.generation),reservationId:uuid(value.reservationId)
 };
 if(result.bookingId!==bookingId||result.buyerId!==buyerId||result.connectionId!==connectionId||result.origin!==origin||
  googleBookingConnectionFromUrl(result.destinationUrl,origin)!==connectionId)throw invalid();
 return result;
}
export async function reserveTeamGoogleCalendar(admin:SupabaseClient,context:TeamCalendarContext,start:string,end:string,policy:unknown){
 const result=await call(admin,"reserve_team_google_booking_v1",{p_booking:context.bookingId,p_buyer:context.buyerId,p_connection:context.connectionId,
  p_origin:context.origin,p_generation:context.generation,p_assignment_revision:context.assignmentRevision,p_id:context.reservationId,
  p_start:start,p_end:end,p_calendar:context.calendarId,p_policy:policy});
 if(uuid(result)!==context.reservationId)throw invalid();
}
export async function readTeamCalendarReservation(admin:SupabaseClient,reservation:string,buyer:string,installed=false):Promise<TeamCalendarReservation|null>{
 if(!installed&&!teamCalendarSchemaReady())return null;
 const data=await call(admin,"read_team_calendar_reservation_v1",{p_id:uuid(reservation),p_buyer:uuid(buyer)});
 if(data===null)return null;
 const value=record(data),bookingId=uuid(value.bookingId);
 let rebookingUrl:string|null=null;
 if(value.rebookingUrl!==null&&teamCalendarReady()){
  const url=new URL(text(value.rebookingUrl)),connection=googleBookingConnectionFromUrl(url.toString(),schedulingOrigin());
  if(!connection||url.searchParams.get("team_booking_id")?.toLowerCase()!==bookingId||[...url.searchParams.keys()].some(k=>k!=="team_booking_id"))throw invalid();
  rebookingUrl=url.toString();
 }
 return {bookingId,connectionId:uuid(value.connectionId),postId:uuid(value.postId),calendarOwnerId:uuid(value.calendarOwnerId),
  assignmentChanged:boolean(value.assignmentChanged),canReschedule:boolean(value.canReschedule)&&teamCalendarReady(),rebookingUrl};
}
export async function recoverUnsentTeamCalendarJob(admin:SupabaseClient,job:string,worker:string,installed=false){
 if(!installed&&!teamCalendarSchemaReady())return false;
 const result=await call(admin,"recover_unsent_team_calendar_job_v1",{p_job:uuid(job),p_worker:uuid(worker),p_new_work_enabled:teamCalendarReady()});
 if(typeof result!=="boolean")throw invalid();return result;
}
const statuses=new Set<TeamAppointmentStatus>(["awaiting_confirmation","scheduled","rescheduling","canceling","canceled","not_scheduled","review_required"]);
export async function readTeamBookingScheduling(admin:SupabaseClient,creator:string,actor:string,bookings:{id:string;buyer_id:string;post_id:string}[]){
 const result=new Map<string,TeamSchedulingRow>();
 if(!teamCalendarSchemaReady()||!bookings.length)return result;
 const scope=new Map(bookings.map(b=>[uuid(b.id),b]));
 const data=await call(admin,"read_team_booking_scheduling_v1",{p_creator:uuid(creator),p_actor:uuid(actor),p_bookings:[...scope.keys()]});
 if(!Array.isArray(data)||data.length>100)throw invalid();
 for(const raw of data){
  const value=record(raw),bookingId=uuid(value.bookingId),source=scope.get(bookingId);
  if(!source||uuid(value.buyerId)!==uuid(source.buyer_id)||uuid(value.postId)!==uuid(source.post_id)||result.has(bookingId))throw invalid();
  if(!Array.isArray(value.scheduling)||value.scheduling.length>1)throw invalid();
  const scheduling=value.scheduling.map((raw:unknown):TeamAppointment=>{
   const item=record(raw),status=item.status as TeamAppointmentStatus;
   if(item.provider!=="google"||!statuses.has(status))throw invalid();
   const scheduledAt=date(item.scheduledAt),observedAt=date(item.observedAt);
   if(["scheduled","rescheduling","canceling","canceled"].includes(status)&&(!scheduledAt||!observedAt))throw invalid();
   return {provider:"google",status,assignmentRevision:positive(item.assignmentRevision),membershipId:uuid(item.membershipId),targetId:uuid(item.targetId),
    scheduledAt,requestedAt:date(item.requestedAt),observedAt,previousAssignment:boolean(item.previousAssignment)};
  });
  result.set(bookingId,{bookingId,buyerId:uuid(value.buyerId),postId:uuid(value.postId),teamManaged:boolean(value.teamManaged),scheduling});
 }
 return result;
}
