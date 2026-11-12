/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {teamCalendarCandidate,teamCalendarDatabase} from "@/test-support/sales-team-calendar-postgres";

declare const createLocalPostgres:()=>PGlite;

const candidate=readFileSync(teamCalendarCandidate,"utf8");
const clear="public.clear_google_booking_recovery_v1()";
const inventory=async(db:PGlite)=>({
 function:(await db.query(`select oid,proowner,proacl::text,prosecdef,proconfig,pg_get_functiondef(oid) definition
  from pg_proc where oid='${clear}'::regprocedure`)).rows,
 trigger:(await db.query(`select oid,tgfoid,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger
  where tgrelid='public.google_booking_reservations_v1'::regclass and tgname='clear_google_booking_recovery_v1' and not tgisinternal`)).rows
});

test.each([false,true])("installer preserves the retained clear trigger with direct service EXECUTE=%s",async service=>{
 const db=createLocalPostgres();
 try{
  await teamCalendarDatabase(db,false);
  if(service)await db.exec(`grant execute on function ${clear} to service_role`);
  const before=await inventory(db);
  await db.exec(candidate);
  expect(await inventory(db)).toEqual(before);
  expect((await db.query("select enabled,origin,contract_sha256 from team_calendar_policy_v1")).rows)
   .toEqual([{enabled:false,origin:null,contract_sha256:null}]);
  expect((await db.query(`select has_function_privilege('service_role','${clear}','execute') allowed`)).rows)
   .toEqual([{allowed:service}]);
 }finally{await db.close();}
},30000);

test("installer rejects clear-trigger privilege or definition drift without repairing its predecessor",async()=>{
 const db=createLocalPostgres();
 try{
  await teamCalendarDatabase(db,false);
  await db.exec("create role clear_acl_fixture nologin");
  const definition=(await db.query<{definition:string}>(`select pg_get_functiondef('${clear}'::regprocedure) definition`)).rows[0].definition;
  const owner=(await db.query<{owner:string}>("select current_user owner")).rows[0].owner;
  const faults=[
   ["empty ACL",`revoke execute on function ${clear} from current_user`],
   ["service-only ACL",`grant execute on function ${clear} to service_role;revoke execute on function ${clear} from current_user`],
   ...["public","anon","authenticated","clear_acl_fixture"].map(role=>[
    role+" EXECUTE",`grant execute on function ${clear} to service_role,${role}`]),
   ["service grant option",`grant execute on function ${clear} to service_role with grant option`],
   ["owner grant option",`grant execute on function ${clear} to current_user with grant option`],
   ["service inherits owner without direct entry",`grant "${owner.replaceAll('"','""')}" to service_role`],
   ["non-owner grantor",`grant execute on function ${clear} to clear_acl_fixture with grant option;
    set role clear_acl_fixture;grant execute on function ${clear} to service_role;reset role`],
   ["unknown body",definition.replace("AS $function$","AS $function$\n-- unreviewed clear body\n")],
   ["different owner",`alter function ${clear} owner to service_role`],
   ["security definer",`alter function ${clear} security definer`],
   ["different search path",`alter function ${clear} set search_path=public`],
   ["disabled trigger","alter table public.google_booking_reservations_v1 disable trigger clear_google_booking_recovery_v1"],
   ["missing trigger","drop trigger clear_google_booking_recovery_v1 on public.google_booking_reservations_v1"],
   ["different trigger shape",`drop trigger clear_google_booking_recovery_v1 on public.google_booking_reservations_v1;
    create trigger clear_google_booking_recovery_v1 before update of status on public.google_booking_reservations_v1
    for each row execute function ${clear}`]
  ];
  const original=await inventory(db);
  for(const [name,sql] of faults){
   await db.exec("begin");
   try{
    await db.exec(sql);const faulted=await inventory(db);
    await db.exec("savepoint before_candidate");
    await expect(db.exec(candidate)).rejects.toThrow(/TEAM_CALENDAR_PREDECESSOR_(DIFFERS|TRIGGER_DIFFERS)/);
    await db.exec("rollback to savepoint before_candidate;release savepoint before_candidate");
    expect({name,inventory:await inventory(db)}).toEqual({name,inventory:faulted});
    expect((await db.query("select to_regclass('public.team_calendar_policy_v1') policy,to_regnamespace('creatornet_calendar_team_private') namespace")).rows)
     .toEqual([{policy:null,namespace:null}]);
   }finally{await db.exec("rollback;reset role");}
   expect({name,inventory:await inventory(db)}).toEqual({name,inventory:original});
  }
 }finally{await db.close();}
},30000);
