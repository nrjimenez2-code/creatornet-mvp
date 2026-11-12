/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {teamCalendarDatabase,teamCalendarCandidate,seedTeamCalendar} from '@/test-support/sales-team-calendar-postgres';
import {teamFixtureId as id} from '@/test-support/sales-team-postgres';
import {captureRpc as rpc} from '@/test-support/sales-team-capture-postgres';
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCalendar>>;
const attr=id(12000),free=id(12001),session='cs_exact_original';
const resolve=(buyer=f.buyer,sessionId:string|null=session,attribution:string|null=attr,checkout:string|null=null,lead=false)=>
 rpc<{state:string;booking_id?:string}>(db,'resolve_original_team_booking_v1',[f.creator,buyer,f.post,sessionId,attribution,checkout,lead]);
const alias=()=>db.query('insert into discover_booking_attribution_v1(id,user_id,creator_id,post_id,setup_session_id) values($1,$2,$3,$4,$5)',[attr,f.buyer,f.creator,f.post,session]);
const seed=()=>rpc(db,'seed_sales_team_booking_v1',[f.creator,f.buyer,f.post,'attribution',attr]);
async function denied(action:()=>Promise<unknown>,pattern=/TEAM_CALENDAR_/){
 await db.exec('savepoint denied');try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec('rollback to savepoint denied;release savepoint denied');}
}
beforeAll(async()=>{db=createLocalPostgres();await teamCalendarDatabase(db);},30000);
beforeEach(async()=>{await db.exec('begin');f=await seedTeamCalendar(db);});
afterEach(async()=>{await db.exec('rollback;reset role');});
afterAll(async()=>{await db?.close();});

test('exact completed source stays owned with enrollment, sales and calendar disabled; resolver is read only',async()=>{
 await alias();await seed();
 await db.exec('update sales_team_creator_settings_v1 set routing_enabled=false;update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false;update team_calendar_policy_v1 set enabled=false');
 const before=(await db.query('select (select count(*) from sales_team_booking_sources_v1) sources,(select sum(route_count) from sales_team_destination_bindings_v1) turns,(select count(*) from google_booking_reservations_v1) appointments')).rows;
 await db.exec('set local role service_role');
 expect(await resolve()).toEqual({state:'team',booking_id:f.booking,booking_url:null});
 expect(await resolve(f.buyer,null,attr)).toEqual({state:'team',booking_id:f.booking,booking_url:null});
 expect((await db.query('select (select count(*) from sales_team_booking_sources_v1) sources,(select sum(route_count) from sales_team_destination_bindings_v1) turns,(select count(*) from google_booking_reservations_v1) appointments')).rows).toEqual(before);
});

test('reciprocal free and later attribution aliases keep the original session identity',async()=>{
 await db.query("insert into free_booking_checkouts(id,buyer_id,creator_id,post_id,status,stripe_session_id) values($1,$2,$3,$4,'complete',$5)",[free,f.buyer,f.creator,f.post,session]);
 await rpc(db,'seed_sales_team_booking_v1',[f.creator,f.buyer,f.post,'free_checkout',free]);
 await alias();expect(await resolve()).toMatchObject({state:'team',booking_id:f.booking});
 await denied(()=>db.query('update free_booking_checkouts set stripe_session_id=$2 where id=$1',[free,'cs_replacement']));
 await denied(()=>db.query('delete from free_booking_checkouts where id=$1',[free]));
 await denied(()=>db.query('update discover_booking_attribution_v1 set user_id=$2 where id=$1',[attr,id(11)]));
 await denied(()=>db.query('delete from discover_booking_attribution_v1 where id=$1',[attr]));
 await db.query("update free_booking_checkouts set status='complete' where id=$1",[free]);
 await db.query("update discover_booking_attribution_v1 set provider='google' where id=$1",[attr]);
});

test('wrong identity, contradictory alias and synthetic sessions never prove a legacy negative',async()=>{
 await alias();await seed();
 expect(await resolve(id(11))).toEqual({state:'held'});
 expect(await resolve(f.buyer,'cs_forged')).toEqual({state:'held'});
 expect(await resolve(f.buyer,'paid-call:'+free,null)).toEqual({state:'held'});
 await denied(()=>db.query("insert into free_booking_checkouts(id,buyer_id,creator_id,post_id,status,stripe_session_id) values($1,$2,$3,$4,'complete',$5)",[free,id(11),f.creator,f.post,session]));
 await denied(()=>db.query('update sales_team_booking_sources_v1 set source_session_id=$1',['cs_forged']),/immutable/i);
 await denied(()=>db.query('update bookings set buyer_id=$2 where id=$1',[f.booking,id(11)]));
});

test('literal lead is exact only as a lead; a sessionless historical setup cannot adopt it',async()=>{
 expect(await resolve(f.buyer,null,null,null,true)).toMatchObject({state:'team',booking_id:f.booking});
 expect(await resolve(f.buyer,'cs_unattributed_history',null)).toEqual({state:'held'});
 expect(await resolve(id(11),'cs_verified_legacy',null)).toEqual({state:'legacy'});
 expect(await resolve(id(11),null,null,null,true)).toEqual({state:'legacy'});
});

test.each(['routing','calendar','access','sales'])('a positive source has no new scheduling destination after %s shutdown',async gate=>{
 await alias();await seed();
 expect((await resolve()).booking_id).toBe(f.booking);
 if(gate==='routing')await db.exec('update sales_team_creator_settings_v1 set routing_enabled=false');
 if(gate==='calendar')await db.exec('update team_calendar_policy_v1 set enabled=false');
 if(gate==='access')await db.exec('update sales_team_controls_v1 set access_enabled=false');
 if(gate==='sales')await db.exec('update sales_team_controls_v1 set new_sales_enabled=false');
 expect(await resolve()).toEqual({state:'team',booking_id:f.booking,booking_url:null});
});

test('source forging and a second canonical booking for the same session are rejected',async()=>{
 await alias();await seed();
 await denied(()=>db.query("insert into sales_team_booking_sources_v1(creator_id,buyer_id,post_id,booking_id,source_identity,source_session_id) values($1,$2,$3,$4,$5,'cs_forged')",[f.creator,f.buyer,f.post,f.booking,'free_checkout:'+free]));
 await db.query('insert into bookings(id,creator_id,buyer_id,post_id,status) values($1,$2,$3,$4,\'booked\')',[id(12002),f.creator,f.buyer,f.post]);
 await db.query("insert into free_booking_checkouts(id,buyer_id,creator_id,post_id,status,stripe_session_id) values($1,$2,$3,$4,'complete',$5)",[free,f.buyer,f.creator,f.post,session]);
 await denied(()=>db.query('insert into sales_team_booking_sources_v1(creator_id,buyer_id,post_id,booking_id,source_identity) values($1,$2,$3,$4,$5)',[f.creator,f.buyer,f.post,id(12002),'free_checkout:'+free]));
});

test('ordinary native admission cannot substitute an exact team alias, including raw SQL reserve',async()=>{
 await alias();await seed();
 await db.exec('update team_calendar_policy_v1 set enabled=false');
 await denied(()=>rpc(db,'reserve_google_booking_v1',[id(12003),f.connection,f.buyer,f.post,'2030-01-01T10:00:00Z','2030-01-01T10:30:00Z',attr,null]),/TEAM_CALENDAR_EXACT_SOURCE_REQUIRED/);
 expect((await db.query('select count(*)::int n from google_booking_reservations_v1')).rows).toEqual([{n:0}]);
});

test('synthetic purchased-call attribution remains distinct from a checkout session or literal lead',async()=>{
 const purchase=id(12022);
 await db.query('insert into discover_booking_attribution_v1(id,user_id,creator_id,post_id,setup_session_id) values($1,$2,$3,$4,$5)',[attr,f.buyer,f.creator,f.post,'paid-call:'+purchase]);
 await db.query('select creatornet_calendar_team_private.admit_ordinary_source_v1($1,$2,$3,false,$4)',[f.buyer,f.post,attr,purchase]);
 await denied(()=>db.query('select creatornet_calendar_team_private.admit_ordinary_source_v1($1,$2,$3,false,$4)',[f.buyer,f.post,attr,id(12023)]));
 await denied(()=>seed());
 expect(await resolve(f.buyer,null,attr)).toEqual({state:'held'});
});

test('contract drift and browser roles cannot obtain a proven legacy result',async()=>{
 await db.exec("alter function creatornet_calendar_team_private.guard_original_alias_v1() set search_path=public");
 expect(await resolve(id(11),'cs_legacy',null)).toEqual({state:'held'});
 await db.exec('set local role authenticated');
 await denied(()=>resolve(id(11),'cs_legacy',null),/permission denied/);
});

test('a nullable lead selector and stronger isolation cannot manufacture a negative',async()=>{
 await alias();await seed();
 expect(await rpc(db,'resolve_original_team_booking_v1',[f.creator,f.buyer,f.post,session,null,null,null])).toEqual({state:'held'});
 await db.exec('rollback;begin isolation level repeatable read');
 expect(await resolve(id(11),'cs_legacy',null)).toEqual({state:'held'});
 await denied(()=>rpc(db,'reserve_google_booking_v1',[id(12003),f.connection,id(11),f.post,'2030-01-01T10:00:00Z','2030-01-01T10:30:00Z',null,null]));
});

test('preexisting team source history stops installation without adopting or marking it',async()=>{
 const historical=createLocalPostgres();try{
  await teamCalendarDatabase(historical,false);await seedTeamCalendar(historical);
  await expect(historical.exec(readFileSync(teamCalendarCandidate,'utf8'))).rejects.toThrow('TEAM_CALENDAR_SOURCE_HISTORY_REVIEW_REQUIRED');
  await historical.exec('rollback');
  expect((await historical.query("select count(*)::int n from sales_team_booking_sources_v1")).rows).toEqual([{n:1}]);
 }finally{await historical.close();}
},30000);
