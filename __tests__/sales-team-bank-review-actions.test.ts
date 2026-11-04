/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {signedSurplusDatabase} from "@/test-support/sales-team-surplus-ingress-postgres";
import {seedCompletedBeneficiary} from "@/test-support/sales-team-beneficiary-payout-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {teamFixtureId as id,addTeamMember,teamRpc} from "@/test-support/sales-team-postgres";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,advance:(ms:number)=>Promise<void>,unchanged:boolean;
const inventory=async()=>(await db.query<{v:string}>(`select md5(string_agg(pg_get_functiondef(oid)||coalesce(proacl::text,''),E'\n' order by oid::regprocedure::text collate "C")) v
 from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) and proname not in ('read_sales_team_bank_review_view_v1','record_sales_team_bank_review_action_v1')`)).rows[0].v;
const digest=async()=>(await db.query<{v:string}>("select creatornet_team_private.bank_review_contract_digest_v1() v")).rows[0].v;
beforeAll(async()=>{db=createLocalPostgres();advance=await installTeamLocalClock(db);await signedSurplusDatabase(db);
 for(const name of ["20261029171329_sales_team_daily_surplus.sql","20261029182136_sales_team_beneficiary_payout_observations.sql","20261029233544_sales_team_payout_statements.sql","20261031201235_sales_team_bank_exception_reviews.sql","20261104185509_sales_team_bank_exception_queue.sql"])await db.exec(readFileSync("supabase/migrations/"+name,"utf8"));
 const before=await inventory(),oldDigest=await digest();await db.exec(readFileSync("supabase/migrations/20261104200116_sales_team_bank_review_actions.sql","utf8"));
 unchanged=before===await inventory()&&oldDigest===await digest();
},30000);
beforeEach(()=>db.exec("begin"));afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback;reset role");});afterAll(()=>db.close());
const enabled=()=>db.exec("update sales_team_bank_review_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.bank_review_contract_digest_v1()");
const view=async(request:string,actor=1,cursor:string|null=null,limit=20)=>(await db.query<{v:{canReview:boolean;stateSha256:string;state:{bankConfirmed:false;outstanding:true};history:unknown[]}}>("select public.read_sales_team_bank_review_view_v1($1,$2,$3,$4,$5) v",[id(1),id(actor),request,cursor,limit])).rows[0].v;
const write=(request:string,hash:string,actor=1)=>db.query("select public.record_sales_team_bank_review_action_v1($1,$2,$3,$4,'acknowledged',$5)",[id(3000),id(1),id(actor),request,hash]);
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}};
test("installation retains every existing body/ACL, write digest and default-off policy",async()=>{
 expect(unchanged).toBe(true);const h=await seedCompletedBeneficiary(db),v=await view(h.q.id);
 expect(v.canReview).toBe(false);expect(v.state).toMatchObject({bankConfirmed:false,outstanding:true});
 expect((await db.query<{enabled:boolean}>("select enabled from sales_team_bank_review_policy_v1")).rows[0].enabled).toBe(false);
});
test("owner and appointed active manager capability agrees with the retained write owner",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();await addTeamMember(db,3,"manager",false);
 const v=await view(h.q.id,3);expect(v.canReview).toBe(true);expect((await view(h.q.id)).canReview).toBe(true);
 await write(h.q.id,v.stateSha256,3);const after=await view(h.q.id);
 expect(after.history).toHaveLength(1);expect(after.state).toMatchObject({bankConfirmed:false,outstanding:true});
});
test("disabled or stale contract holds capability while recorded history stays readable",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();expect((await view(h.q.id)).canReview).toBe(true);
 await db.exec("update sales_team_bank_review_policy_v1 set contract_sha256=repeat('f',64)");
 const held=await view(h.q.id);expect(held.canReview).toBe(false);await denied(()=>write(h.q.id,held.stateSha256),/BANK_REVIEW_AUTHORITY_REQUIRED/);
 await db.exec("update sales_team_bank_review_policy_v1 set enabled=false");expect((await view(h.q.id)).state.bankConfirmed).toBe(false);
});
test("a stale displayed capability cannot authorize a removed manager's later write",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();const member=await addTeamMember(db,3,"manager",false),v=await view(h.q.id,3);expect(v.canReview).toBe(true);
 await teamRpc(db,1,"remove_member",{membership_id:member});await denied(()=>write(h.q.id,v.stateSha256,3),/TEAM_MANAGER_REQUIRED/);
 await denied(()=>view(h.q.id,3),/BANK_REVIEW_ACCESS_DENIED/);expect((await view(h.q.id)).history).toHaveLength(0);
});
test("closer and removed closer keep own read-only history with new-money controls off",async()=>{
 const realNow=Date.now.bind(Date);const h=await seedCompletedBeneficiary(db,"closer",async()=>{jest.spyOn(Date,"now").mockImplementation(()=>realNow()+15*86400000);await advance(15*86400000);await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()");});
 await enabled();expect((await view(h.q.id,2)).canReview).toBe(false);
 const member=(await db.query<{id:string}>("select id from sales_team_memberships_v1 where creator_id=$1 and user_id=$2",[id(1),id(2)])).rows[0].id;await teamRpc(db,1,"remove_member",{membership_id:member});
 await db.exec("do $$declare c record;begin for c in select attname from pg_attribute where attrelid='public.sales_team_controls_v1'::regclass and atttypid='boolean'::regtype and attname<>'singleton' and not attisdropped loop execute format('update public.sales_team_controls_v1 set %I=false',c.attname);end loop;end$$");
 expect((await view(h.q.id,2))).toMatchObject({canReview:false,state:{bankConfirmed:false,outstanding:true}});
 const hash=(await view(h.q.id,2)).stateSha256;await denied(()=>write(h.q.id,hash,2),/TEAM_MANAGER_REQUIRED/);
});
test("wrapper preserves cursor/original/actor bounds and service-only execution",async()=>{
 const h=await seedCompletedBeneficiary(db);
 await denied(()=>view(h.q.id,11),/TEAM_STATEMENT_ACCESS_DENIED/);await denied(()=>view(h.q.id,1,id(9999)),/INVALID_BANK_REVIEW_CURSOR/);
 await denied(()=>view(h.q.id,1,null,51),/INVALID_BANK_REVIEW_LIMIT/);
 await db.exec("set local role service_role");expect((await view(h.q.id)).canReview).toBe(false);await db.exec("reset role");
 for(const role of ["anon","authenticated"]){await db.exec(`set local role ${role}`);await denied(()=>view(h.q.id),/permission denied/);await db.exec("reset role");}
});
test.each(["repeatable read","serializable"])("%s refuses submission before invoking the retained owner",async isolation=>{
 await db.exec(`set transaction isolation level ${isolation}`);await denied(()=>write(id(9999),"a".repeat(64)),/BANK_REVIEW_ACTION_ISOLATION_REQUIRED/);
 expect((await db.query<{n:number}>("select count(*)::int n from sales_team_bank_exception_reviews_v1")).rows[0].n).toBe(0);
});
test("guarded read-committed stale-state rejection is distinct from the legacy owner's error",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();await denied(()=>write(h.q.id,"f".repeat(64)),/BANK_REVIEW_ACTION_STATE_CHANGED/);
 await denied(()=>db.query("select public.record_sales_team_bank_exception_review_v1($1,$2,$2,$3,'acknowledged',$4)",[id(3000),id(1),h.q.id,"f".repeat(64)]),/BANK_REVIEW_STATE_CHANGED/);
 expect((await view(h.q.id)).history).toHaveLength(0);
});
