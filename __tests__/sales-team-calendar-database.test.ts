/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {teamCalendarDatabase,teamCalendarCandidate,seedTeamCalendar,configureTeamCalendarFixture,calendarOrigin,calendarAvailability} from "@/test-support/sales-team-calendar-postgres";
import {teamFixtureId as id,addTeamMember} from "@/test-support/sales-team-postgres";
import {captureRpc as rpc} from "@/test-support/sales-team-capture-postgres";
declare const createLocalPostgres:()=>PGlite;
type Context={bookingId:string;creatorId:string;buyerId:string;postId:string;sourceIdentity:string;assignmentRevision:number;membershipId:string;targetId:string;
 connectionId:string;calendarOwnerId:string;accountId:string;calendarId:string;destinationUrl:string;origin:string;generation:number;reservationId:string;blockedBy?:{reservationId:string;connectionId:string;status:string}};
type Job={id:string;revision:number;action:string;mutation_started_at:string|null};
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCalendar>>,time:{start:string;finish:string};
const rows=async(sql:string,args:unknown[]=[]) => (await db.query<Record<string,unknown>>(sql,args)).rows;
const call=<T=Record<string,unknown>>(name:string,args:unknown[]=[])=>rpc<T>(db,name,args);
const context=(connection=f.connection,buyer=f.buyer)=>call<Context>("read_team_google_booking_v1",[f.booking,buyer,connection,calendarOrigin]);
const enable=()=>db.query("update team_calendar_policy_v1 set enabled=true,origin=$1,contract_sha256=creatornet_calendar_team_private.contract_digest_v1()",[calendarOrigin]);
async function reserve(c?:Context,start=time.start,end=time.finish){
 const value=c??await context();
 return call<string>("reserve_team_google_booking_v1",[f.booking,f.buyer,value.connectionId,calendarOrigin,value.generation,value.assignmentRevision,value.reservationId,start,end,value.calendarId,calendarAvailability]);
}
const event=(reservation:string)=>createHash("sha256").update("creatornet-booking:"+reservation).digest("hex");
const claim=async()=> (await db.query<Job>("select * from public.claim_google_booking_job_v1($1)",[id(9880)])).rows[0];
async function confirm(c:Context){
 await reserve(c);const job=await claim();expect(job.action).toBe("create");
 await call("begin_google_booking_mutation_v1",[job.id,id(9880)]);
 await call("complete_google_booking_job_v1",[job.id,id(9880),event(c.reservationId),"fixture-etag",time.start,time.finish]);
 return job;
}
const denied=async(action:()=>Promise<unknown>,pattern:RegExp=/TEAM_CALENDAR_/)=>{
 await db.exec("savepoint denied");
 try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}
};
async function insertBinding(c:Context,patch:Record<string,unknown>={}){
 const value={reservation_id:c.reservationId,booking_id:c.bookingId,generation:c.generation,creator_id:c.creatorId,buyer_id:c.buyerId,post_id:c.postId,
  source_identity:c.sourceIdentity,assignment_revision:c.assignmentRevision,membership_id:c.membershipId,target_id:c.targetId,connection_id:c.connectionId,
  calendar_owner_id:c.calendarOwnerId,account_id:c.accountId,calendar_id:c.calendarId,destination_url:c.destinationUrl,origin:c.origin,...patch};
 const keys=Object.keys(value),values=Object.values(value);
 return db.query("insert into team_calendar_bindings_v1("+keys.join(",")+") values("+keys.map((_,n)=>"$"+(n+1)).join(",")+")",values);
}
async function addNativeCloser(user:number){
 const member=await addTeamMember(db,user),connection=id(10000+user),watch=id(10100+user);
 await db.query("insert into scheduling_connections_v1(id,creator_id,provider,status,account_id,credentials_ciphertext,webhook_id,webhook_secret_ciphertext,token_expires_at) values($1,$2,'google','connected',$3,'fixture-encrypted',$4,'fixture-encrypted',now()+interval '1 day')",[connection,id(user),'google-account-'+user,watch]);
 await db.query("insert into google_booking_settings_v1(connection_id,calendar_id,conflict_calendar_ids,availability,title) values($1,'primary',array['primary'],$2,'Another call')",[connection,calendarAvailability]);
 await db.query("insert into google_calendar_watches_v1(id,connection_id,calendar_id,token_ciphertext,resource_id,status,expires_at) values($1,$2,'primary','fixture-encrypted',$3,'active',now()+interval '1 day')",[watch,connection,'resource-'+user]);
 await db.query('update booking_targets set booking_url=$1 where id=$2',[calendarOrigin+'/scheduling/book/'+connection,id(100+user)]);
 return {member,connection,watch};
}
const routingInventory=()=>rows("select (select count(*)::int from bookings) bookings,(select count(*)::int from sales_team_booking_sources_v1) sources,(select count(*)::int from sales_team_assignments_v1) assignments,(select sum(route_count)::int from sales_team_destination_bindings_v1) turns,(select count(*)::int from sales_team_audit_v1) audits");
beforeAll(async()=>{db=createLocalPostgres();await teamCalendarDatabase(db);},30000);
beforeEach(async()=>{
 await db.exec("begin");f=await seedTeamCalendar(db);
 time=(await db.query<{start:string;finish:string}>("select to_jsonb(date_trunc('day',clock_timestamp())+interval '2 days 10 hours') start,to_jsonb(date_trunc('day',clock_timestamp())+interval '2 days 10 hours 30 minutes') finish")).rows[0];
 await enable();
});
afterEach(async()=>{await db.exec("rollback;reset role");});
afterAll(async()=>{await db?.close();});

test("new policy is off until privileged approval and cannot be enabled by the service caller",async()=>{
 await db.exec("update team_calendar_policy_v1 set enabled=false,origin=null,contract_sha256=null;set role service_role");
 await denied(()=>context(),/TEAM_CALENDAR_NOT_ENABLED/);
 await denied(()=>enable(),/permission denied/);
 expect(await rows("select count(*)::int n from team_calendar_bindings_v1")).toEqual([{n:0}]);
});
test("exact team source keeps content creator separate from the individually owned calendar",async()=>{
 const c=await context();expect(c).toMatchObject({bookingId:f.booking,creatorId:f.creator,buyerId:f.buyer,postId:f.post,
  calendarOwnerId:id(2),membershipId:f.member,connectionId:f.connection,assignmentRevision:1,sourceIdentity:"lead",generation:1});
 expect(c.creatorId).not.toBe(c.calendarOwnerId);
 await denied(()=>context(f.connection,id(11)),/TEAM_CALENDAR_BOOKING_UNAVAILABLE/);
 await denied(()=>context(id(9899)),/TEAM_CALENDAR_CURRENT_ASSIGNMENT_REQUIRED/);
});
test.each([
 ["creator_id",id(3)],["buyer_id",id(11)],["post_id",id(22)],["source_identity","attribution:"+id(9899)],
 ["assignment_revision",2],["membership_id",id(9899)],["target_id",id(103)],["connection_id",id(9899)],
 ["calendar_owner_id",id(3)],["account_id","other-account"],["calendar_id","other-calendar"],
 ["destination_url","https://attacker.invalid/scheduling/book/"+id(9800)],["origin","https://attacker.invalid"],["reservation_id",id(9899)]
] as const)("binding refuses substituted %s",async(field,value)=>{
 const c=await context();await denied(()=>insertBinding(c,{[field]:value}));
 expect(await rows("select count(*)::int n from team_calendar_bindings_v1")).toEqual([{n:0}]);
});
test("two bindings inserted before either reservation cannot bypass the canonical outstanding gate",async()=>{
 const first=await context();await insertBinding(first);
 const second=(await db.query<{v:string}>("select creatornet_calendar_team_private.intent_id_v1($1,2) v",[f.booking])).rows[0].v;
 await denied(()=>insertBinding({...first,generation:2,reservationId:second}),/TEAM_CALENDAR_ORIGINAL_APPOINTMENT_PENDING/);
 await call("reserve_google_booking_checked_v1",[first.reservationId,f.connection,f.buyer,f.post,time.start,time.finish,null,null,"primary",calendarAvailability]);
 await call("enqueue_google_booking_create_v1",[first.reservationId,f.buyer]);
 expect(await rows("select count(*)::int n from google_booking_reservations_v1")).toEqual([{n:1}]);
});
test("native confirmation is idempotent, uses no invented legacy attribution and exposes no provider or financial objects",async()=>{
 const c=await context();await confirm(c);await reserve(c);
 expect(await rows("select attribution_id,purchase_id,status from google_booking_reservations_v1")).toEqual([{attribution_id:null,purchase_id:null,status:"confirmed"}]);
 expect(await rows("select count(*)::int n from google_booking_jobs_v1")).toEqual([{n:1}]);
 const result=await call<{bookingId:string;scheduling:{status:string}[]}[]>("read_team_booking_scheduling_v1",[f.creator,f.creator,[f.booking]]);
 expect(result[0].scheduling[0].status).toBe("scheduled");
 for(const secret of ["account_id","credentials","event_id","payment_intent","financial"])expect(JSON.stringify(result)).not.toContain(secret);
});
test("another source alias for one lead preserves one canonical intent",async()=>{
 const first=await context();
 await db.query("insert into discover_booking_attribution_v1(id,user_id,creator_id,post_id,setup_session_id) values($1,$2,$3,$4,'cs_alias_fixture')",[id(9850),f.buyer,f.creator,f.post]);
 await call("seed_sales_team_booking_v1",[f.creator,f.buyer,f.post,"attribution",id(9850)]);
 expect((await context()).reservationId).toBe(first.reservationId);
 await reserve(first);await reserve(await context());
 expect(await rows("select count(*)::int n from team_calendar_bindings_v1")).toEqual([{n:1}]);
});
test("a legacy reservation preempting an intent ID cannot be adopted or produce team status",async()=>{
 const c=await context();
 await call("reserve_google_booking_v1",[c.reservationId,f.connection,id(11),f.post,time.start,time.finish,null,null]);
 await denied(()=>reserve(c),/TEAM_CALENDAR_LEGACY_ADOPTION_DENIED/);
 const result=await call<{scheduling:unknown[]}[]>("read_team_booking_scheduling_v1",[f.creator,f.creator,[f.booking]]);
 expect(result[0].scheduling).toEqual([]);
});
test.each([
 ["id",id(9898)],["buyer_id",id(11)],["original_post_id",id(22)],["connection_id",id(9898)],
 ["calendar_id","foreign-calendar"],["attribution_id",id(9898)],["purchase_id",id(9898)],["event_id","foreign-event"]
] as const)("bound reservation refuses replacement of %s",async(field,value)=>{
 const c=await context();await reserve(c);
 await denied(()=>db.query("update google_booking_reservations_v1 set "+field+"=$1 where id=$2",[value,c.reservationId]),/TEAM_CALENDAR_|Google booking attribution mismatch/);
 expect(await rows("select id,buyer_id,connection_id,attribution_id,purchase_id from google_booking_reservations_v1")).toEqual([{id:c.reservationId,buyer_id:f.buyer,connection_id:f.connection,attribution_id:null,purchase_id:null}]);
});
test("removed member loses new dispatch, while a proved unsent job releases no provider identity",async()=>{
 const c=await context();await reserve(c);const job=await claim();
 await db.query("update sales_team_memberships_v1 set status='removed' where id=$1",[f.member]);
 await denied(()=>call("begin_google_booking_mutation_v1",[job.id,id(9880)]),/TEAM_CALENDAR_CURRENT_ASSIGNMENT_REQUIRED/);
 expect(await call("recover_unsent_team_calendar_job_v1",[job.id,id(9880)])).toBe(true);
 expect(await rows("select status,event_id from google_booking_reservations_v1")).toEqual([{status:"failed",event_id:null}]);
 expect(await rows("select status,mutation_started_at,last_error_code from google_booking_jobs_v1")).toEqual([{status:"failed",mutation_started_at:null,last_error_code:"team_calendar_authority_changed"}]);
});
test("possibly delivered create remains reserved after removal and can reconcile only its original event",async()=>{
 const c=await context();await reserve(c);const job=await claim();await call("begin_google_booking_mutation_v1",[job.id,id(9880)]);
 await db.query("update sales_team_memberships_v1 set status='removed' where id=$1",[f.member]);
 expect(await call("recover_unsent_team_calendar_job_v1",[job.id,id(9880)])).toBe(false);
 await denied(()=>call("begin_google_booking_mutation_v1",[job.id,id(9880)]),/TEAM_CALENDAR_CURRENT_ASSIGNMENT_REQUIRED/);
 await denied(()=>call("reserve_google_booking_v1",[id(9890),f.connection,id(11),f.post,time.start,time.finish,null,null]),/no longer available/);
 await call("complete_google_booking_job_v1",[job.id,id(9880),event(c.reservationId),"original-etag",time.start,time.finish]);
 expect(await rows("select id,status,event_id from google_booking_reservations_v1")).toEqual([{id:c.reservationId,status:"confirmed",event_id:event(c.reservationId)}]);
});
test("account change during an attempted cancellation cannot falsely release the original appointment",async()=>{
 const c=await context();await confirm(c);
 await call("request_google_booking_change_v1",[c.reservationId,f.buyer,0,"cancel"]);
 const job=await claim();expect(job.action).toBe("cancel");await call("begin_google_booking_mutation_v1",[job.id,id(9880)]);
 await db.query("update scheduling_connections_v1 set account_id='different-google-account' where id=$1",[f.connection]);
 await denied(()=>call("complete_google_booking_job_v1",[job.id,id(9880),null,null,null,null]),/TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS/);
 expect(await rows("select status,event_id from google_booking_reservations_v1")).toEqual([{status:"canceling",event_id:event(c.reservationId)}]);
 await denied(()=>call("reserve_google_booking_v1",[id(9890),f.connection,id(11),f.post,time.start,time.finish,null,null]),/no longer available/);
});
test("lead reassignment preserves the original appointment and blocks replacement until buyer cancellation",async()=>{
 const c=await context();await confirm(c);const original=await rows("select * from google_booking_reservations_v1");
 const nextMember=await addTeamMember(db,3);
 await call("assign_sales_team_booking_v1",[f.booking,f.creator,nextMember]);
 expect(await rows("select * from google_booking_reservations_v1")).toEqual(original);
 expect((await context()).blockedBy).toMatchObject({reservationId:c.reservationId,connectionId:f.connection,status:"confirmed"});
 await denied(()=>reserve(c),/TEAM_CALENDAR_ORIGINAL_APPOINTMENT_PENDING/);
 await call("request_google_booking_change_v1",[c.reservationId,f.buyer,0,"cancel"]);
 const cancel=await claim();await call("begin_google_booking_mutation_v1",[cancel.id,id(9880)]);
 await call("complete_google_booking_job_v1",[cancel.id,id(9880),null,null,null,null]);
 expect(await rows("select status,event_id from google_booking_reservations_v1")).toEqual([{status:"canceled",event_id:event(c.reservationId)}]);
 expect(await rows("select assignment_revision,membership_id from team_calendar_bindings_v1")).toEqual([{assignment_revision:1,membership_id:f.member}]);
});
test("ordinary callers and other buyers compete in the same buffered connection-wide capacity",async()=>{
 const c=await context();await reserve(c);
 await denied(()=>call("reserve_google_booking_v1",[id(9890),f.connection,id(11),f.post,time.start,time.finish,null,null]),/no longer available/);
 const adjacent=(await db.query<{start:string;finish:string}>("select to_jsonb($1::timestamptz+interval '30 minutes') start,to_jsonb($2::timestamptz+interval '30 minutes') finish",[time.start,time.finish])).rows[0];
 await denied(()=>call("reserve_google_booking_v1",[id(9890),f.connection,id(11),f.post,adjacent.start,adjacent.finish,null,null]),/no longer available/);
});
test('persisted marker binds new team reservations and leaves historical ordinary rows unbound',async()=>{
 const c=await context();await reserve(c);
 expect(await rows('select team_calendar_binding_id from google_booking_reservations_v1 where id=$1',[c.reservationId])).toEqual([{team_calendar_binding_id:c.reservationId}]);
 await denied(()=>db.query('update google_booking_reservations_v1 set team_calendar_binding_id=null where id=$1',[c.reservationId]),/TEAM_CALENDAR_ORIGINAL_IDENTITY_DIFFERS/);
 const later=(await db.query<{start:string;finish:string}>("select to_jsonb($1::timestamptz+interval '2 hours') start,to_jsonb($2::timestamptz+interval '2 hours') finish",[time.start,time.finish])).rows[0];
 await call('reserve_google_booking_v1',[id(9890),f.connection,id(11),f.post,later.start,later.finish,null,null]);
 expect(await rows('select team_calendar_binding_id from google_booking_reservations_v1 where id=$1',[id(9890)])).toEqual([{team_calendar_binding_id:null}]);
});
test('replacement link requires the same proven-unsent predicate as canonical admission',async()=>{
 const c=await context();await reserve(c);
 expect((await call('read_team_calendar_reservation_v1',[c.reservationId,f.buyer])).rebookingUrl).toBeNull();
 await db.query("update google_booking_reservations_v1 set status='failed' where id=$1",[c.reservationId]);
 expect((await call('read_team_calendar_reservation_v1',[c.reservationId,f.buyer])).rebookingUrl).toBeNull();
 expect(await context()).toMatchObject({reservationId:c.reservationId,generation:1});
 await db.query("update google_booking_jobs_v1 set status='failed' where reservation_id=$1",[c.reservationId]);
 expect((await call('read_team_calendar_reservation_v1',[c.reservationId,f.buyer])).rebookingUrl).toContain('?team_booking_id='+f.booking);
 expect(await context()).toMatchObject({reservationId:c.reservationId,generation:1});
});
test('readiness-off unsent recovery settles the original job without requiring membership loss',async()=>{
 const c=await context();await reserve(c);const job=await claim();
 expect(await call('recover_unsent_team_calendar_job_v1',[job.id,id(9880),false])).toBe(true);
 expect(await rows('select status,team_calendar_binding_id from google_booking_reservations_v1')).toEqual([{status:'failed',team_calendar_binding_id:c.reservationId}]);
 expect(await rows('select status,mutation_started_at from google_booking_jobs_v1')).toEqual([{status:'failed',mutation_started_at:null}]);
});
test.each([
 ['google_booking_reservations_v1','google_booking_attribution_guard_v1'],
 ['google_booking_reservations_v1','clear_google_booking_recovery_v1'],
 ['scheduling_connections_v1','google_reconnect_retry_wakeup_v1']
])('post-install trigger drift disables readiness: %s/%s',async(table,trigger)=>{
 await db.exec(`alter table public.${table} disable trigger ${trigger}`);
 expect(await rows('select creatornet_calendar_team_private.ready_v1() ready')).toEqual([{ready:false}]);
 await denied(()=>context(),/TEAM_CALENDAR_NOT_ENABLED/);
});
test('post-install revocation-writer drift disables new admission',async()=>{
 const original=(await db.query<{v:string}>("select pg_get_functiondef('public.manage_sales_team_v1(uuid,uuid,text,jsonb)'::regprocedure) v")).rows[0].v;
 await db.exec(original.replace('AS $function$','AS $function$\n-- changed revocation owner\n'));
 expect(await rows('select creatornet_calendar_team_private.ready_v1() ready')).toEqual([{ready:false}]);
});
test.each(['claim_google_booking_job_v1(uuid)','configure_google_calendar_v1(uuid,uuid,uuid,text,text[],jsonb,text,uuid)','seed_sales_team_booking_v1(uuid,uuid,uuid,text,uuid)'])('ongoing readiness detects retained owner/ACL drift: %s',async signature=>{
 const definition=(await db.query<{v:string}>('select pg_get_functiondef($1::regprocedure) v',['public.'+signature])).rows[0].v;
 await db.exec('savepoint contract_drift');
 await db.exec(definition.replace('AS $function$','AS $function$\n-- unknown installed definition\n'));
 expect(await rows('select creatornet_calendar_team_private.ready_v1() ready')).toEqual([{ready:false}]);
 await db.exec('rollback to savepoint contract_drift;release savepoint contract_drift');
 await db.exec('revoke execute on function public.'+signature+' from service_role');
 expect(await rows('select creatornet_calendar_team_private.ready_v1() ready')).toEqual([{ready:false}]);
});
test.each(['canceled','held'])('an attempted create cannot release capacity through a malformed %s transition',async status=>{
 const c=await context();await reserve(c);const job=await claim();await call('begin_google_booking_mutation_v1',[job.id,id(9880)]);
 await db.exec('set role service_role');
 await denied(()=>db.query("update google_booking_reservations_v1 set status=$2,hold_expires_at=clock_timestamp()-interval '1 minute' where id=$1",[c.reservationId,status]),/TEAM_CALENDAR_UNCERTAIN_OUTCOME_REMAINS_RESERVED/);
 expect(await rows('select status from google_booking_reservations_v1')).toEqual([{status:'creating'}]);
 await denied(()=>call('reserve_google_booking_v1',[id(9890),f.connection,id(11),f.post,time.start,time.finish,null,null]),/no longer available/);
});
test('acquired original event evidence cannot be detached',async()=>{
 const c=await context();await confirm(c);
 await denied(()=>db.query('update google_booking_reservations_v1 set event_id=null where id=$1',[c.reservationId]),/TEAM_CALENDAR_ORIGINAL_EVENT_IMMUTABLE/);
});
test('watch cancellation and restoration retain the original event and remain authoritative',async()=>{
 const c=await context();await confirm(c);const watch=id(9801),worker=id(9881);
 await db.query("update google_calendar_watches_v1 set lease_id=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[watch,worker]);
 expect(await call('reconcile_google_calendar_booking_v1',[watch,worker,c.reservationId,0,event(c.reservationId),'cancel-etag',null,null,true])).toBe(true);
 expect(await rows('select status,event_id from google_booking_reservations_v1')).toEqual([{status:'canceled',event_id:event(c.reservationId)}]);
 expect(await call('reconcile_google_calendar_booking_v1',[watch,worker,c.reservationId,1,event(c.reservationId),'restored-etag',time.start,time.finish,false])).toBe(true);
 expect(await rows('select status,event_id,revision from google_booking_reservations_v1')).toEqual([{status:'confirmed',event_id:event(c.reservationId),revision:2}]);
});
test('reschedule recovery can retain an authoritative external cancellation',async()=>{
 const c=await context();await confirm(c);
 const next=(await db.query<{start:string;finish:string}>("select to_jsonb($1::timestamptz+interval '2 hours') start,to_jsonb($2::timestamptz+interval '2 hours') finish",[time.start,time.finish])).rows[0];
 await call('reschedule_google_booking_checked_v1',[c.reservationId,f.buyer,0,next.start,next.finish,calendarAvailability]);const job=await claim();
 await call('recover_google_reschedule_v1',[job.id,id(9880),event(c.reservationId),null,null,null,true]);
 expect(await rows('select status,event_id from google_booking_reservations_v1')).toEqual([{status:'canceled',event_id:event(c.reservationId)}]);
});
test('self booking with no other eligible host is rejected before a lead, assignment or routing turn commits',async()=>{
 const before=await routingInventory();
 await denied(()=>call('seed_sales_team_booking_v1',[f.creator,id(2),f.post]),/NO_ELIGIBLE_TEAM_DESTINATION/);
 expect(await routingInventory()).toEqual(before);
 expect(await rows('select count(*)::int n from team_calendar_bindings_v1')).toEqual([{n:0}]);
});
test('automatic routing skips the buyer as host and selects another eligible closer',async()=>{
 const other=await addNativeCloser(3);
 const lead=await call<{booking_id:string;assignment:{membership_id:string;source:string}}>('seed_sales_team_booking_v1',[f.creator,id(2),f.post]);
 expect(lead.assignment).toMatchObject({membership_id:other.member,source:'weighted'});
 expect(await call('read_team_google_booking_v1',[lead.booking_id,id(2),other.connection,calendarOrigin])).toMatchObject({calendarOwnerId:id(3)});
});
test('a mixed provider pool retains native weighting and never consumes an unsupported target turn',async()=>{
 const other=await addNativeCloser(3);await addTeamMember(db,4);
 for(let buyer=11;buyer<=21;buyer++)await call('seed_sales_team_booking_v1',[f.creator,id(buyer),f.post]);
 expect(await rows('select target_id,route_count::int turns from sales_team_destination_bindings_v1 order by target_id')).toEqual([
  {target_id:id(102),turns:3},{target_id:id(103),turns:9},{target_id:id(104),turns:0}]);
 const repeat=await call<{booking_id:string;assignment:{membership_id:string}}>('seed_sales_team_booking_v1',[f.creator,id(11),f.post]);
 expect(repeat.assignment.membership_id).toBe(other.member);
 const before=await routingInventory();await call('seed_sales_team_booking_v1',[f.creator,id(11),f.post]);expect(await routingInventory()).toEqual(before);
});
test.each([
 "update booking_targets set booking_url='https://calendly.com/closer/call'",
 "update booking_targets set booking_url=booking_url||'?extra=1'",
 "update scheduling_connections_v1 set status='disconnected'",
 "update scheduling_connections_v1 set creator_id='00000000-0000-4000-8000-000000000003'",
 'update google_booking_settings_v1 set active=false',
 "update google_calendar_watches_v1 set expires_at=clock_timestamp()-interval '1 minute'",
 "update google_calendar_watches_v1 set calendar_id='other-calendar'"
])('an all-invalid pool rolls back the source, booking, assignment, turn and audit: %s',async sql=>{
 await db.exec(sql);const before=await routingInventory();
 await denied(()=>call('seed_sales_team_booking_v1',[f.creator,id(11),f.post]),/NO_ELIGIBLE_TEAM_DESTINATION/);
 expect(await routingInventory()).toEqual(before);
});
test('reassignment to an unsupported provider holds new routing while preserving original buyer cancellation with policy off',async()=>{
 const original=await context();await confirm(original);const next=await addTeamMember(db,3);
 await db.exec('update team_calendar_policy_v1 set enabled=false');
 await call('assign_sales_team_booking_v1',[f.booking,f.creator,next]);
 await call('request_google_booking_change_v1',[original.reservationId,f.buyer,0,'cancel']);
 expect(await call('read_team_calendar_reservation_v1',[original.reservationId,f.buyer])).toMatchObject({assignmentChanged:true,canReschedule:false,rebookingUrl:null});
 await enable();const before=await routingInventory();
 await denied(()=>call('seed_sales_team_booking_v1',[f.creator,f.buyer,f.post]),/TEAM_CALENDAR_DESTINATION_REVIEW_REQUIRED/);
 expect(await routingInventory()).toEqual(before);
 expect(await rows('select connection_id,status from google_booking_reservations_v1')).toEqual([{connection_id:f.connection,status:'canceling'}]);
});
test('automatic admission requires active policy and an explicit actor while manager reassignment remains separate',async()=>{
 const before=await routingInventory();await db.exec('update team_calendar_policy_v1 set enabled=false');
 await denied(()=>call('seed_sales_team_booking_v1',[f.creator,id(11),f.post]),/TEAM_CALENDAR_NOT_ENABLED/);
 await denied(()=>call('assign_sales_team_booking_v1',[f.booking,null,null]),/BOOKING_UNAVAILABLE/);
 expect(await routingInventory()).toEqual(before);
 await denied(()=>call('assign_sales_team_booking_v1',[f.booking,f.buyer,f.member]),/TEAM_MANAGER_REQUIRED/);
});
test('automatic assignment cannot bypass creator enrollment or invent a source for an older lead',async()=>{
 const before=await routingInventory();
 await denied(()=>call('assign_sales_team_booking_v1',['10000000-0000-4000-8000-000000000001',f.buyer,null]),/TEAM_CALENDAR_EXACT_SOURCE_REQUIRED/);
 await db.exec('update sales_team_creator_settings_v1 set routing_enabled=false');
 await denied(()=>call('assign_sales_team_booking_v1',[f.booking,f.buyer,null]),/TEAM_ROUTING_NOT_ENABLED/);
 expect(await routingInventory()).toEqual(before);
 expect(await rows("select creatornet_calendar_team_private.eligible_native_destination_v1($1,$2,$3,$4,null) allowed",[f.creator,f.member,id(102),f.buyer])).toEqual([{allowed:false}]);
});
test('different canonical bookings for the same buyer and post retain separate calendar status',async()=>{
 const first=await context();await confirm(first);const second=id(9910),source=id(9911);
 await db.query("insert into bookings(id,creator_id,buyer_id,post_id,created_at) values($1,$2,$3,$4,clock_timestamp()+interval '1 second')",[second,f.creator,f.buyer,f.post]);
 await db.query("insert into free_booking_checkouts(id,buyer_id,creator_id,post_id,status,stripe_session_id) values($1,$2,$3,$4,'complete','cs_second_original')",[source,f.buyer,f.creator,f.post]);
 const next=await call<{booking_id:string}>('seed_sales_team_booking_v1',[f.creator,f.buyer,f.post,'free_checkout',source]);expect(next.booking_id).toBe(second);
 const c=await call<Context>('read_team_google_booking_v1',[second,f.buyer,f.connection,calendarOrigin]);expect(c.reservationId).not.toBe(first.reservationId);
 const result=await call<{bookingId:string;scheduling:{status:string}[]}[]>('read_team_booking_scheduling_v1',[f.creator,f.creator,[f.booking,second]]);
 expect(result.find(r=>r.bookingId===f.booking)?.scheduling[0].status).toBe('scheduled');expect(result.find(r=>r.bookingId===second)?.scheduling).toEqual([]);
});
test('full native reschedule completion retains binding and event identity while moving the confirmed interval',async()=>{
 const c=await context();await confirm(c);const original=await rows('select * from team_calendar_bindings_v1');
 const next=(await db.query<{start:string;finish:string}>("select to_jsonb($1::timestamptz+interval '2 hours') start,to_jsonb($2::timestamptz+interval '2 hours') finish",[time.start,time.finish])).rows[0];
 await call('reschedule_google_booking_checked_v1',[c.reservationId,f.buyer,0,next.start,next.finish,calendarAvailability]);
 const job=await claim();expect(job.action).toBe('reschedule');await call('begin_google_booking_mutation_v1',[job.id,id(9880)]);
 await call('complete_google_booking_job_v1',[job.id,id(9880),event(c.reservationId),'new-etag',next.start,next.finish]);
 expect(await rows('select id,status,event_id,revision,to_jsonb(starts_at) start,to_jsonb(ends_at) finish from google_booking_reservations_v1')).toEqual([{id:c.reservationId,status:'confirmed',event_id:event(c.reservationId),revision:1,...next}]);
 expect(await rows('select * from team_calendar_bindings_v1')).toEqual(original);
});
test('installation preserves a preexisting ordinary reservation and adds only a null team marker',async()=>{
 const isolated=createLocalPostgres();try{
  await teamCalendarDatabase(isolated,false);const seed=await configureTeamCalendarFixture(isolated);
  await isolated.exec("create function public.begin_google_booking_mutation_v1(text) returns void language sql as $$select$$;revoke all on function public.begin_google_booking_mutation_v1(text) from public,anon,authenticated,service_role");
  const overload=(await isolated.query("select proacl::text from pg_proc where oid='public.begin_google_booking_mutation_v1(text)'::regprocedure")).rows;
  await rpc(isolated,'reserve_google_booking_v1',[id(9890),seed.connection,seed.buyer,seed.post,time.start,time.finish,null,null]);
  const before=(await isolated.query('select to_jsonb(r) row from google_booking_reservations_v1 r')).rows;
  await isolated.exec(readFileSync(teamCalendarCandidate,'utf8'));
  expect((await isolated.query("select to_jsonb(r)-'team_calendar_binding_id' row from google_booking_reservations_v1 r")).rows).toEqual(before);
  expect((await isolated.query('select team_calendar_binding_id from google_booking_reservations_v1')).rows).toEqual([{team_calendar_binding_id:null}]);
  expect((await isolated.query('select count(*)::int n from team_calendar_bindings_v1')).rows).toEqual([{n:0}]);
  expect((await isolated.query("select proacl::text from pg_proc where oid='public.begin_google_booking_mutation_v1(text)'::regprocedure")).rows).toEqual(overload);
  expect((await isolated.query("select has_function_privilege('service_role','public.begin_google_booking_mutation_v1(text)','execute') allowed")).rows).toEqual([{allowed:false}]);
 }finally{await isolated.close();}
},30000);
test("the existing job, mutation marker and binding cannot be erased to release an uncertain attempt",async()=>{
 const c=await context();await reserve(c);const job=await claim();await call("begin_google_booking_mutation_v1",[job.id,id(9880)]);
 await denied(()=>db.query("delete from team_calendar_bindings_v1 where reservation_id=$1",[c.reservationId]),/TEAM_CALENDAR_ORIGINAL_BINDING_IMMUTABLE/);
 await denied(()=>db.query("delete from google_booking_jobs_v1 where id=$1",[job.id]),/TEAM_CALENDAR_ORIGINAL_JOB_IMMUTABLE/);
 await denied(()=>db.query("update google_booking_jobs_v1 set mutation_started_at=null where id=$1",[job.id]),/TEAM_CALENDAR_MUTATION_EVIDENCE_IMMUTABLE/);
 await denied(()=>db.query("delete from google_booking_reservations_v1 where id=$1",[c.reservationId]),/TEAM_CALENDAR_ORIGINAL_RESERVATION_IMMUTABLE/);
});
test.each(["anon","authenticated"])("%s cannot read team calendar identities or invoke booking/status owners",async role=>{
 await db.exec("set role "+role);
 await denied(()=>db.exec("select * from team_calendar_bindings_v1"),/permission denied/);
 await denied(()=>context(),/permission denied/);
 await denied(()=>call("read_team_booking_scheduling_v1",[f.creator,f.creator,[f.booking]]),/permission denied/);
});
test("unknown predecessor, expanded privilege, changed owner and late failure all roll back",async()=>{
 const isolated=createLocalPostgres();
 try{
  await teamCalendarDatabase(isolated,false);
  const inventory=async()=>(await isolated.query("select oid,proowner,proacl::text,prosrc,prosecdef,proconfig from pg_proc where oid='public.begin_google_booking_mutation_v1(uuid,uuid)'::regprocedure")).rows;
  const original=await inventory(),definition=(await isolated.query<{v:string}>("select pg_get_functiondef('public.begin_google_booking_mutation_v1(uuid,uuid)'::regprocedure) v")).rows[0].v;
  const seedDefinition=(await isolated.query<{v:string}>("select pg_get_functiondef('public.seed_sales_team_booking_v1(uuid,uuid,uuid,text,uuid)'::regprocedure) v")).rows[0].v;
  const candidate=readFileSync(teamCalendarCandidate,"utf8");
  const faults:[()=>Promise<unknown>,RegExp,boolean][]=[
   [()=>isolated.exec(definition.replace("AS $function$","AS $function$\n-- unknown body\n")),/TEAM_CALENDAR_PREDECESSOR_DIFFERS/,false],
   [()=>isolated.exec(seedDefinition.replace("AS $function$","AS $function$\n-- unknown seed body\n")),/TEAM_CALENDAR_PREDECESSOR_DIFFERS/,false],
   [()=>isolated.exec("grant execute on function public.begin_google_booking_mutation_v1(uuid,uuid) to public"),/TEAM_CALENDAR_PREDECESSOR_DIFFERS/,false],
   [()=>isolated.exec("alter function public.begin_google_booking_mutation_v1(uuid,uuid) owner to service_role"),/TEAM_CALENDAR_PREDECESSOR_DIFFERS/,false],
   ...(['google_booking_attribution_guard_v1','clear_google_booking_recovery_v1'].map(name=>[()=>isolated.exec('alter table public.google_booking_reservations_v1 disable trigger '+name),/TEAM_CALENDAR_PREDECESSOR_TRIGGER_DIFFERS/,false] as [()=>Promise<unknown>,RegExp,boolean])),
   [()=>isolated.exec('alter table public.scheduling_connections_v1 disable trigger google_reconnect_retry_wakeup_v1'),/TEAM_CALENDAR_PREDECESSOR_TRIGGER_DIFFERS/,false],
   [()=>isolated.exec('drop trigger google_booking_attribution_guard_v1 on public.google_booking_reservations_v1'),/TEAM_CALENDAR_PREDECESSOR_TRIGGER_DIFFERS/,false],
   [()=>isolated.exec('drop trigger google_booking_attribution_guard_v1 on public.google_booking_reservations_v1;create trigger google_booking_attribution_guard_v1 before update of attribution_id on public.google_booking_reservations_v1 for each row execute function public.validate_google_booking_attribution_v1()'),/TEAM_CALENDAR_PREDECESSOR_TRIGGER_DIFFERS/,false],
   [()=>isolated.exec('drop trigger google_reconnect_retry_wakeup_v1 on public.scheduling_connections_v1;create trigger google_reconnect_retry_wakeup_v1 after update of status on public.scheduling_connections_v1 for each row execute function public.wake_google_booking_retries_v1()'),/TEAM_CALENDAR_PREDECESSOR_TRIGGER_DIFFERS/,false],
   [async()=>{},/SYNTHETIC_CALENDAR_LATE_FAILURE/,true]
  ];
  for(const [mutate,pattern,late] of faults){
   await isolated.exec("begin");await mutate();
   await expect(isolated.exec(late?candidate.replace("commit;","do $late$ begin raise exception 'SYNTHETIC_CALENDAR_LATE_FAILURE';end $late$;commit;"):candidate)).rejects.toThrow(pattern);
   await isolated.exec("rollback");
   expect(await inventory()).toEqual(original);
   expect((await isolated.query("select to_regclass('public.team_calendar_policy_v1') policy")).rows).toEqual([{policy:null}]);
  }
 }finally{await isolated.close();}
},30000);
