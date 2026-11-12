/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import predecessors from "@/test-support/fixtures/sales-team-pure-helper-predecessors.json";

declare const createLocalPostgres:()=>PGlite;

const candidate=readFileSync("supabase/migrations/20261112162358_sales_team_pure_helper_service_permissions.sql","utf8");
const [endHelper,feeHelper]=predecessors.helpers;
const fee={processingFeeEnabled:false,processingFeeBasisPoints:0,processingFeeFixedCents:0,feeScheduleVersion:"synthetic",
 grossAmountCents:1000,platformFeeCents:120,processingFeeCents:0,totalCreatorDeductionCents:120,creatorNetCents:880};
type FunctionCatalog={oid:number;definition:string;owner:number;acl:string};
const inventory=async(db:PGlite)=>({
 functions:(await db.query<FunctionCatalog>(`select oid,pg_catalog.pg_get_functiondef(oid) definition,proowner owner,proacl::text acl
  from pg_catalog.pg_proc where pronamespace='public'::regnamespace order by proname`)).rows,
 schema:(await db.query("select nspowner,nspacl::text from pg_catalog.pg_namespace where nspname='public'")).rows
});
async function baseline(){
 const db=createLocalPostgres();
 await db.exec(`create role service_role;create role anon;create role authenticated;create role pure_helper_other;
  revoke create on schema public from public,anon,authenticated,service_role;
  grant usage on schema public to anon,authenticated,service_role;`);
 for(const helper of predecessors.helpers){
  expect(createHash("sha256").update(helper.definition).digest("hex")).toBe(helper.sha256);
  await db.exec(helper.definition);
  await db.exec(`revoke all on function ${helper.signature} from public,anon,authenticated,service_role`);
 }
 return db;
}
const denyHelpers=async(db:PGlite)=>{
 await expect(db.query("select public.fixed_service_end_v1(1706659200,1)")).rejects.toThrow(/permission denied/);
 await expect(db.query("select public.valid_monthly_fee_snapshot_v1($1,1000)",[fee])).rejects.toThrow(/permission denied/);
};
const calculate=(db:PGlite)=>db.query<{finish:number;valid:boolean}>(
 "select public.fixed_service_end_v1(1706659200,1) finish,public.valid_monthly_fee_snapshot_v1($1,1000) valid",[fee]);

test.each([false,true])("exact helper permissions retain canonical service results with hostile installer search path=%s",async shadow=>{
 const db=await baseline();try{
  const before=await inventory(db),expected=(await calculate(db)).rows;
  expect(expected).toEqual([{finish:1709164800,valid:true}]);
  await db.exec("set role service_role");await denyHelpers(db);await db.exec("reset role");
  if(shadow)await db.exec(`create schema pure_helper_shadow;create table pure_helper_shadow.pg_proc(oid oid);
   set search_path=pure_helper_shadow,pg_catalog,public`);
  await db.exec(candidate);const after=await inventory(db);
  expect(after.schema).toEqual(before.schema);
  expect(after.functions.map(f=>({oid:f.oid,definition:f.definition,owner:f.owner})))
   .toEqual(before.functions.map(f=>({oid:f.oid,definition:f.definition,owner:f.owner})));
  expect(after.functions.map(f=>f.acl)).toEqual(predecessors.helpers.map(()=>"{postgres=X/postgres,service_role=X/postgres}"));
  await db.exec("set role service_role");expect((await calculate(db)).rows).toEqual(expected);await db.exec("reset role");
  for(const role of ["anon","authenticated"]){await db.exec("set role "+role);await denyHelpers(db);await db.exec("reset role");}
 }finally{await db.close();}
},30000);

test("unknown pure-helper predecessors, expanded authority, missing schema access and late failure preserve the original catalogs",async()=>{
 const db=await baseline();try{
  const faults:{name:string;sql:string;pattern?:RegExp;late?:boolean}[]=[
   {name:"empty ACL",sql:`revoke execute on function ${endHelper.signature} from current_user`},
   {name:"service-only ACL",sql:`grant execute on function ${endHelper.signature} to service_role;revoke execute on function ${endHelper.signature} from current_user`},
   {name:"existing service grant",sql:`grant execute on function ${endHelper.signature} to service_role`},
   {name:"owner grant option",sql:`grant execute on function ${endHelper.signature} to current_user with grant option`},
   {name:"service grant option",sql:`grant execute on function ${endHelper.signature} to service_role with grant option`},
   ...["public","anon","authenticated","pure_helper_other"].map(role=>({name:role+" grant",sql:`grant execute on function ${feeHelper.signature} to ${role}`})),
   {name:"inherited owner execution",sql:"grant postgres to service_role"},
   {name:"unknown body",sql:endHelper.definition.replace("AS $function$","AS $function$\n-- unreviewed helper body\n")},
   {name:"different owner",sql:`alter function ${endHelper.signature} owner to service_role`},
   {name:"security definer",sql:`alter function ${endHelper.signature} security definer`},
   {name:"different function search path",sql:`alter function ${endHelper.signature} set search_path=public`},
   {name:"missing helper",sql:`drop function ${feeHelper.signature}`},
   {name:"missing schema USAGE",sql:"revoke usage on schema public from public,anon,authenticated,service_role",pattern:/TEAM_PREREQUISITE_HELPER_INSTALLER_REQUIRED/},
   {name:"late atomic rollback",sql:"select 1",pattern:/SYNTHETIC_HELPER_LATE_FAILURE/,late:true}
  ];
  const original=await inventory(db);
  for(const fault of faults){
   await db.exec("begin");try{
    await db.exec(fault.sql);const changed=await inventory(db);await db.exec("savepoint before_candidate");
    const sql=fault.late?candidate.replace("commit;","do $late$ begin raise exception 'SYNTHETIC_HELPER_LATE_FAILURE';end $late$;commit;"):candidate;
    await expect(db.exec(sql)).rejects.toThrow(fault.pattern??/TEAM_PREREQUISITE_HELPER_PREDECESSOR_DIFFERS/);
    await db.exec("rollback to savepoint before_candidate;release savepoint before_candidate");
    expect({name:fault.name,catalog:await inventory(db)}).toEqual({name:fault.name,catalog:changed});
   }finally{await db.exec("rollback;reset role");}
   expect({name:fault.name,catalog:await inventory(db)}).toEqual({name:fault.name,catalog:original});
  }
 }finally{await db.close();}
},30000);
