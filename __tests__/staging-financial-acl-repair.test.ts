/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import evidence from "../test-support/staging-financial-access-20260906.json";

declare const createLocalPostgres: () => PGlite;
const repair=readFileSync(join(process.cwd(),"docs/staging-restore-financial-acls.sql"),"utf8");
const check=readFileSync(join(process.cwd(),"docs/staging-financial-access-check.sql"),"utf8");
const functions=evidence.rows.filter(r=>r.kind==="function").map(r=>r.details as {
  signature:string;body:string;anonExecute:boolean;authenticatedExecute:boolean;serviceExecute:boolean;
});
const tables=["payment_fee_ledger","stripe_events","payment_refund_state","payment_dispute_state"];
let db:PGlite;
jest.setTimeout(60000);
beforeEach(async()=>{
  db=createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table refund_operations(id uuid primary key);
    alter table refund_operations enable row level security;
    grant select,insert,update,delete on refund_operations to service_role`);
  // Only permission behavior is modeled here; structural tests are separate.
  for(const table of tables) await db.exec(`create table ${table}(id integer primary key,secret text);
    alter table ${table} enable row level security;
    grant all on table ${table} to anon,authenticated,service_role;
    grant select(secret),update(secret) on table ${table} to public,anon,authenticated;
    insert into ${table} values(1,'synthetic')`);
  for(const f of functions) {
    await db.exec(f.body);
    // Reproduce the effective EXECUTE access observed in the snapshot.
    await db.exec(`revoke all on function ${f.signature} from public,anon,authenticated;
      grant execute on function ${f.signature} to service_role`);
    if(f.anonExecute) await db.exec(`grant execute on function ${f.signature} to public,anon,authenticated`);
  }
});
afterEach(async()=>{await db?.close();});
const functionState=async()=>(await db.query<Record<string,unknown>>(`select proname,pg_get_functiondef(p.oid) body,p.proowner,
  has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
  has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' order by proname`)).rows;

test("observed drift is eight financial RPCs; the two 021 admin RPCs are already private",()=>{
  expect(functions).toHaveLength(10);
  expect(functions.filter(f=>f.anonExecute&&f.authenticatedExecute)).toHaveLength(8);
  expect(functions.every(f=>f.serviceExecute)).toBe(true);
});
test("repair removes client/PUBLIC table and column ACLs, retaining rows and server access",async()=>{
  await db.exec(repair);
  for(const table of tables) {
    expect((await db.query(`select * from ${table}`)).rows).toEqual([{id:1,secret:"synthetic"}]);
    for(const role of ["anon","authenticated"]) {
      for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"]) {
        expect((await db.query<{ok:boolean}>("select has_table_privilege($1,$2,$3) ok",[role,table,privilege])).rows[0].ok).toBe(false);
      }
      for(const privilege of ["SELECT","INSERT","UPDATE","REFERENCES"]) {
        expect((await db.query<{ok:boolean}>("select has_any_column_privilege($1,$2,$3) ok",[role,table,privilege])).rows[0].ok).toBe(false);
      }
    }
    expect((await db.query<{ok:boolean}>("select relrowsecurity ok from pg_class where oid=$1::regclass",[table])).rows[0].ok).toBe(true);
    for(const privilege of ["SELECT","INSERT","UPDATE","DELETE"]) {
      expect((await db.query<{ok:boolean}>("select has_table_privilege('service_role',$1,$2) ok",[table,privilege])).rows[0].ok).toBe(true);
    }
  }
});
test("repair preserves all ten function bodies/owners and service execution; safe to repeat",async()=>{
  const before=await functionState(); await db.exec(repair); await db.exec(repair);
  expect(await functionState()).toEqual(before.map(r=>({...r,anon:false,authenticated:false})));
});
test("read-only acceptance check detects the twelve drifted objects and all fifteen repaired objects",async()=>{
  const result=async()=>{
    const results=await db.exec(check);
    return results.flatMap(r=>r.rows as Array<{kind:string;name:string;result:string}>);
  };
  const before=await result(); expect(before).toHaveLength(15);
  expect(before.filter(r=>r.result==="REVIEW")).toHaveLength(12);
  await db.exec(repair);
  const after=await result(); expect(after).toHaveLength(15);
  expect(after.every(r=>r.result==="PASS")).toBe(true);
});
test("missing RLS causes complete rollback rather than silently changing protection",async()=>{
  await db.exec("alter table payment_dispute_state disable row level security");
  await expect(db.exec(repair)).rejects.toThrow("RLS-enabled"); await db.exec("rollback");
  expect((await db.query<{ok:boolean}>("select has_table_privilege('anon','payment_fee_ledger','SELECT') ok")).rows[0].ok).toBe(true);
});
test("missing server permission fails closed; repair never grants wider server access",async()=>{
  await db.exec("revoke select on stripe_events from service_role");
  await expect(db.exec(repair)).rejects.toThrow("server permission missing"); await db.exec("rollback");
  expect((await db.query<{ok:boolean}>("select has_table_privilege('service_role','stripe_events','SELECT') ok")).rows[0].ok).toBe(false);
});
test("unexpected inherited function access rolls back instead of changing unreviewed roles",async()=>{
  await db.exec("create role inherited_fixture; grant inherited_fixture to anon; grant execute on function release_stripe_event(text,uuid) to inherited_fixture");
  await expect(db.exec(repair)).rejects.toThrow("review inherited roles"); await db.exec("rollback");
  expect((await db.query<{ok:boolean}>("select has_table_privilege('anon','payment_fee_ledger','SELECT') ok")).rows[0].ok).toBe(true);
});

test("server permission inherited only from PUBLIC cannot be lost by a committed repair",async()=>{
  await db.exec("revoke select on stripe_events from service_role; grant select on stripe_events to public");
  await expect(db.exec(repair)).rejects.toThrow("Server permission lost during repair"); await db.exec("rollback");
  expect((await db.query<{ok:boolean}>("select has_table_privilege('service_role','stripe_events','SELECT') ok")).rows[0].ok).toBe(true);
  expect((await db.query<{ok:boolean}>("select has_table_privilege('anon','payment_fee_ledger','SELECT') ok")).rows[0].ok).toBe(true);
});
