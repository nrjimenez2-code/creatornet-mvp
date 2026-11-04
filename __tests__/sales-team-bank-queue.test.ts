/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {signedSurplusDatabase} from "@/test-support/sales-team-surplus-ingress-postgres";
import {seedCompletedBeneficiary} from "@/test-support/sales-team-beneficiary-payout-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {teamFixtureId as id,addTeamMember,teamRpc} from "@/test-support/sales-team-postgres";
declare const createLocalPostgres:()=>PGlite;
type Queue={creatorId:string;scope:string;entries:Array<{state:{requestId:string;reason:string;bankConfirmed:false;outstanding:true};latestReview:null|{action:string;appliesToCurrentState:boolean}}>;hasMore:boolean;nextCursor:string|null};
let db:PGlite,advance:(ms:number)=>Promise<void>,retainedUnchanged:boolean;
const inventory=async()=>(await db.query<{v:string}>(`select md5(string_agg(pg_get_functiondef(oid)||coalesce(proacl::text,''),E'\n' order by oid::regprocedure::text collate "C")) v
 from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace)
 and proname<>'read_sales_team_bank_exception_queue_v1'`)).rows[0].v;
beforeAll(async()=>{
 db=createLocalPostgres();advance=await installTeamLocalClock(db);await signedSurplusDatabase(db);
 for(const name of ["20261029171329_sales_team_daily_surplus.sql","20261029182136_sales_team_beneficiary_payout_observations.sql","20261029233544_sales_team_payout_statements.sql","20261031201235_sales_team_bank_exception_reviews.sql"])
  await db.exec(readFileSync("supabase/migrations/"+name,"utf8"));
 const before=await inventory();await db.exec(readFileSync("supabase/migrations/20261104185509_sales_team_bank_exception_queue.sql","utf8"));retainedUnchanged=before===await inventory();
},30000);
beforeEach(()=>db.exec("begin"));afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback;reset role");});afterAll(()=>db.close());
const queue=async(actor=1,creator=1,cursor:string|null=null,limit=20)=>(await db.query<{v:Queue}>("select public.read_sales_team_bank_exception_queue_v1($1,$2,$3,$4) v",[id(creator),id(actor),cursor,limit])).rows[0].v;
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}};
// Synthetic immutable read-model originals only, not a second provider transfer.
async function cloneOriginal(original:string,n:number,beneficiary="creator",user=1,completed=true){
 await db.query(`insert into public.sales_team_transfer_requests_v1(id,operation_id,receipt_id,sale_id,creator_id,beneficiary,beneficiary_user_id,destination_id,amount_cents,receipt_revision,original_worker_run_id,context,request,created_at)
 select $2,$3,receipt_id,sale_id,creator_id,$4,$5,destination_id,amount_cents,receipt_revision,original_worker_run_id,context,request,created_at from public.sales_team_transfer_requests_v1 where id=$1`,[original,id(n),id(n+1000),beneficiary,id(user)]);
 if(completed)await db.query(`insert into public.sales_team_transfer_completions_v1(request_id,transfer_id,balance_id,worker_run_id,proof,created_at)
 select $2,$3,$4,worker_run_id,proof,created_at from public.sales_team_transfer_completions_v1 where request_id=$1`,[original,id(n),"tr_clone"+n,"txn_clone"+n]);
}
test("queue installation preserves retained routine bodies/ACLs and default-off review policy",async()=>{
 expect(retainedUnchanged).toBe(true);expect((await db.query<{enabled:boolean}>("select enabled from sales_team_bank_review_policy_v1")).rows[0].enabled).toBe(false);
 expect((await queue()).entries).toEqual([]);
});
test("owner discovers missing and paid originals without provider access or money mutation",async()=>{
 const h=await seedCompletedBeneficiary(db);h.raw.mockClear();
 const before=(await db.query("select public.read_sales_team_statement_v1($1,$1,null,20) v",[id(1)])).rows;
 expect((await queue()).entries[0].state).toMatchObject({requestId:h.q.id,reason:"payout_observation_missing",bankConfirmed:false,outstanding:true});
 expect(h.raw).not.toHaveBeenCalled();await h.observe();h.raw.mockClear();
 const value=await queue(),detail=(await db.query<{v:{state:unknown}}>("select public.read_sales_team_bank_exception_v1($1,$1,$2,null,20) v",[id(1),h.q.id])).rows[0].v;
 expect(value.entries[0].state).toEqual(detail.state);expect(value.entries[0].state.reason).toBe("bank_confirmation_pending");
 expect(JSON.stringify(value)).not.toMatch(/acct_|ba_|po_|py_|tr_|txn_|lease|destination|actorId|beneficiary_user_id/);
 expect((await db.query("select public.read_sales_team_statement_v1($1,$1,null,20) v",[id(1)])).rows).toEqual(before);expect(h.raw).not.toHaveBeenCalled();
});
test("acknowledged and escalated items remain discoverable; later observations mark reviews historical",async()=>{
 const h=await seedCompletedBeneficiary(db);
 await db.exec("update sales_team_bank_review_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.bank_review_contract_digest_v1()");
 const detail=(await db.query<{v:{stateSha256:string}}>("select public.read_sales_team_bank_exception_v1($1,$1,$2,null,20) v",[id(1),h.q.id])).rows[0].v;
 await db.query("select public.record_sales_team_bank_exception_review_v1($1,$2,$2,$3,'escalated',$4)",[id(3000),id(1),h.q.id,detail.stateSha256]);
 expect((await queue()).entries).toHaveLength(1);expect((await queue()).entries[0].latestReview).toMatchObject({action:"escalated",appliesToCurrentState:true});
 await h.observe();expect((await queue()).entries[0].latestReview?.appliesToCurrentState).toBe(false);
});
test("creator/closer isolation, equal-time pagination and incomplete originals use scoped immutable cursors",async()=>{
 const h=await seedCompletedBeneficiary(db);await cloneOriginal(h.q.id,100);await cloneOriginal(h.q.id,101,"closer",2);await cloneOriginal(h.q.id,102,"creator",1,false);
 const first=await queue(1,1,null,2),second=await queue(1,1,first.nextCursor,2);
 expect(first.entries).toHaveLength(2);expect(first.hasMore).toBe(true);expect(second.entries).toHaveLength(1);expect(second.hasMore).toBe(false);
 expect(new Set([...first.entries,...second.entries].map(e=>e.state.requestId)).size).toBe(3);
 expect((await queue(2)).entries.map(e=>e.state.requestId)).toEqual([id(101)]);
 await denied(()=>queue(2,1,h.q.id),/INVALID_BANK_QUEUE_CURSOR/);await denied(()=>queue(1,1,id(102)),/INVALID_BANK_QUEUE_CURSOR/);
 for(const limit of [0,51])await denied(()=>queue(1,1,null,limit),/INVALID_BANK_QUEUE_LIMIT/);
});
test("appointed manager sees creator scope; removal removes that scope immediately",async()=>{
 const h=await seedCompletedBeneficiary(db);const member=await addTeamMember(db,3,"manager",false);
 expect((await queue(3)).entries).toHaveLength(1);await teamRpc(db,1,"remove_member",{membership_id:member});
 expect((await queue(3)).scope).toBe("closer");expect((await queue(3)).entries).toEqual([]);await denied(()=>queue(3,1,h.q.id),/INVALID_BANK_QUEUE_CURSOR/);
 await denied(()=>queue(11),/TEAM_STATEMENT_ACCESS_DENIED/);await denied(()=>queue(1,12),/TEAM_STATEMENT_ACCESS_DENIED/);
});
test("removed closer retains own completed originals with every new-money control off",async()=>{
 const realNow=Date.now.bind(Date);const h=await seedCompletedBeneficiary(db,"closer",async()=>{jest.spyOn(Date,"now").mockImplementation(()=>realNow()+15*86400000);await advance(15*86400000);await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()");});
 const member=(await db.query<{id:string}>("select id from sales_team_memberships_v1 where creator_id=$1 and user_id=$2",[id(1),id(2)])).rows[0].id;
 await teamRpc(db,1,"remove_member",{membership_id:member});
 await db.exec("do $$declare c record;begin for c in select attname from pg_attribute where attrelid='public.sales_team_controls_v1'::regclass and atttypid='boolean'::regtype and attname<>'singleton' and not attisdropped loop execute format('update public.sales_team_controls_v1 set %I=false',c.attname);end loop;end$$");
 expect((await queue(2)).entries.map(e=>e.state.requestId)).toEqual([h.q.id]);expect((await queue(2)) as unknown).toMatchObject({membershipStatus:"removed",scope:"closer"});
});
test("service can execute queue; anonymous/authenticated roles cannot call the privileged entry point",async()=>{
 await seedCompletedBeneficiary(db);await db.exec("set local role service_role");expect((await queue()).entries).toHaveLength(1);await db.exec("reset role");
 for(const role of ["anon","authenticated"]){await db.exec(`set local role ${role}`);await denied(()=>queue(),/permission denied/);await db.exec("reset role");}
});
