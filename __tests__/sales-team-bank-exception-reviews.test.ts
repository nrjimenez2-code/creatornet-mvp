/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {PGlite} from "@electric-sql/pglite";
import {signedSurplusDatabase} from "@/test-support/sales-team-surplus-ingress-postgres";
import {seedCompletedBeneficiary} from "@/test-support/sales-team-beneficiary-payout-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {teamFixtureId as id,addTeamMember,teamRpc} from "@/test-support/sales-team-postgres";
declare const createLocalPostgres:()=>PGlite;
type View={state:{reason:string;payoutStatus:string;bankConfirmed:false;outstanding:true};stateSha256:string;history:Array<{reviewId:string;actorRole:string;action:string;appliesToCurrentState:boolean}>;hasMoreHistory:boolean;nextCursor:string|null};
const migration=readFileSync(join(__dirname,"..","supabase","migrations","20261031201235_sales_team_bank_exception_reviews.sql"),"utf8");
let db:PGlite,advance:(ms:number)=>Promise<void>,unchanged:boolean;
const realNow=Date.now.bind(Date);
const advanceBoth=async(ms:number)=>{jest.spyOn(Date,"now").mockImplementation(()=>realNow()+ms);await advance(ms);};
const contracts=async()=>(await db.query<{digest:string}>(`select md5(string_agg(pg_get_functiondef(oid)||coalesce(proacl::text,''),E'\n' order by oid::regprocedure::text collate "C")) digest
 from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace)
 and proname not in ('bank_exception_snapshot_v1','bank_review_contract_digest_v1','bank_review_authority_v1','read_sales_team_bank_exception_v1','record_sales_team_bank_exception_review_v1')`)).rows[0].digest;
beforeAll(async()=>{db=createLocalPostgres();advance=await installTeamLocalClock(db);await signedSurplusDatabase(db);
 for(const path of ["supabase/migrations/20261029171329_sales_team_daily_surplus.sql","supabase/migrations/20261029182136_sales_team_beneficiary_payout_observations.sql","supabase/migrations/20261029233544_sales_team_payout_statements.sql"])await db.exec(readFileSync(path,"utf8"));
 const before=await contracts();await db.exec(migration);unchanged=(await contracts())===before;
},30000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback;reset role");});afterAll(async()=>{await db.close();});
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}};
const enabled=()=>db.exec("update sales_team_bank_review_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.bank_review_contract_digest_v1()");
const view=async(request:string,actor=1,creator=1,cursor:string|null=null,limit=20)=>(await db.query<{v:View}>("select public.read_sales_team_bank_exception_v1($1,$2,$3,$4,$5) v",[id(creator),id(actor),request,cursor,limit])).rows[0].v;
const review=async(request:string,digest:string,reviewId=id(3000),actor=1,action="acknowledged",creator=1)=>(await db.query<{v:{recorded:boolean;bankConfirmed:false;outstanding:true}}>("select public.record_sales_team_bank_exception_review_v1($1,$2,$3,$4,$5,$6) v",[reviewId,id(creator),id(actor),request,action,digest])).rows[0].v;
const count=async()=>(await db.query<{n:number}>("select count(*)::int n from sales_team_bank_exception_reviews_v1")).rows[0].n;

test("installation preserves all retained function bodies and ACLs and defaults review writes off",async()=>{
 expect(unchanged).toBe(true);const h=await seedCompletedBeneficiary(db);const s=await view(h.q.id);
 expect(s.state).toMatchObject({reason:"payout_observation_missing",bankConfirmed:false,outstanding:true});
 await denied(()=>review(h.q.id,s.stateSha256),/BANK_REVIEW_AUTHORITY_REQUIRED/);expect(await count()).toBe(0);
});

test("owner review is append-only and idempotent and leaves financial accounting and BANK unchanged",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();await enabled();h.raw.mockClear();const s=await view(h.q.id);
 const money=async()=>(await db.query("select public.read_sales_team_statement_v1($1,$1,null,20) v",[id(1)])).rows;
 const before=await money();expect(await review(h.q.id,s.stateSha256)).toEqual({recorded:true,reviewId:id(3000),bankConfirmed:false,outstanding:true});
 expect(await review(h.q.id,s.stateSha256)).toMatchObject({recorded:false,bankConfirmed:false,outstanding:true});expect(await count()).toBe(1);
 const after=await view(h.q.id);expect(after.stateSha256).toBe(s.stateSha256);expect(after.state).toMatchObject({reason:"bank_confirmation_pending",payoutStatus:"paid",bankConfirmed:false,outstanding:true});
 expect(after.history).toEqual([expect.objectContaining({actorRole:"owner",action:"acknowledged",appliesToCurrentState:true})]);expect(await money()).toEqual(before);expect(h.raw).not.toHaveBeenCalled();
 expect(JSON.stringify(after)).not.toMatch(/acct_|ba_|po_|py_|tr_|txn_|req_|lease|membersSha256/);
 await denied(()=>db.query("update sales_team_bank_exception_reviews_v1 set action='escalated'"),/immutable/i);
 await denied(()=>db.query("delete from sales_team_bank_exception_reviews_v1"),/immutable/i);
});

test("state digest and review intent are stable across independent database session timezones",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();await enabled();await db.exec("set local timezone='UTC'");const utc=await view(h.q.id);
 await db.exec("set local timezone='America/Phoenix'");const phoenix=await view(h.q.id);expect(phoenix.stateSha256).toBe(utc.stateSha256);expect(phoenix.state).toEqual(utc.state);
 expect(await review(h.q.id,utc.stateSha256)).toMatchObject({recorded:true,bankConfirmed:false,outstanding:true});
});

test("an appointed active manager may escalate but removal blocks new reviews and idempotent replay",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();const member=await addTeamMember(db,3,"manager",false);const s=await view(h.q.id,3);
 await review(h.q.id,s.stateSha256,id(3000),3,"escalated");await teamRpc(db,1,"remove_member",{membership_id:member});
 await denied(()=>review(h.q.id,s.stateSha256,id(3000),3,"escalated"),/TEAM_MANAGER_REQUIRED/);
 await denied(()=>review(h.q.id,s.stateSha256,id(3001),3),/TEAM_MANAGER_REQUIRED/);await denied(()=>view(h.q.id,3),/BANK_REVIEW_ACCESS_DENIED/);
 expect((await view(h.q.id)).history[0]).toMatchObject({actorRole:"manager",action:"escalated"});expect(await count()).toBe(1);
});

test("removed closer retains only own review history with new-money controls off and cannot perform a review",async()=>{
 const h=await seedCompletedBeneficiary(db,"closer",async()=>{await advanceBoth(15*86400000);await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()");});await enabled();const s=await view(h.q.id);await review(h.q.id,s.stateSha256);
 const member=(await db.query<{id:string}>("select id from sales_team_memberships_v1 where creator_id=$1 and user_id=$2",[id(1),id(2)])).rows[0].id;await teamRpc(db,1,"remove_member",{membership_id:member});
 await db.exec("do $$declare c record;begin for c in select attname from pg_attribute where attrelid='public.sales_team_controls_v1'::regclass and atttypid='boolean'::regtype and attname<>'singleton' and not attisdropped loop execute format('update public.sales_team_controls_v1 set %I=false',c.attname);end loop;end$$");
 expect((await view(h.q.id,2)).history).toHaveLength(1);await denied(()=>review(h.q.id,s.stateSha256,id(3001),2),/TEAM_MANAGER_REQUIRED/);
 await denied(()=>view(h.q.id,11),/TEAM_STATEMENT_ACCESS_DENIED/);await denied(()=>view(h.q.id,2,12),/TEAM_STATEMENT_ACCESS_DENIED/);
});

test("closer and unrelated team member cannot inspect creator originals",async()=>{
 const h=await seedCompletedBeneficiary(db);await addTeamMember(db,4);
 for(const actor of [2,4])await denied(()=>view(h.q.id,actor),/BANK_REVIEW_ACCESS_DENIED/);
 await denied(()=>view(id(9999)),/BANK_REVIEW_ACCESS_DENIED/);
});

test("review ID cannot adopt another actor, action, original or state",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();const s=await view(h.q.id);await review(h.q.id,s.stateSha256);await addTeamMember(db,3,"manager",false);
 for(const action of [()=>review(h.q.id,s.stateSha256,id(3000),3),()=>review(h.q.id,s.stateSha256,id(3000),1,"escalated"),()=>review(id(9999),s.stateSha256),()=>review(h.q.id,"f".repeat(64))])await denied(action,/ORIGINAL_BANK_REVIEW_REQUIRED/);
 expect(await count()).toBe(1);
});

test.each(["confirmed","resolved","",null])("invalid review action %s cannot change BANK or close an exception",async action=>{
 const h=await seedCompletedBeneficiary(db);await enabled();const s=await view(h.q.id);
 await denied(()=>review(h.q.id,s.stateSha256,id(3000),1,action as string),/CURRENT_BANK_REVIEW_REQUIRED/);expect(await count()).toBe(0);
});

test("new payout observation requires a fresh state and leaves previous review history intact",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();const s=await view(h.q.id);await review(h.q.id,s.stateSha256);
 await h.observe();const fresh=await view(h.q.id);expect(fresh.stateSha256).not.toBe(s.stateSha256);expect(fresh.history[0].appliesToCurrentState).toBe(false);
 await denied(()=>review(h.q.id,s.stateSha256,id(3001)),/BANK_REVIEW_STATE_CHANGED/);
 await review(h.q.id,fresh.stateSha256,id(3001),1,"escalated");expect((await view(h.q.id)).history.map(r=>r.appliesToCurrentState)).toEqual([true,false]);
 expect(await review(h.q.id,s.stateSha256)).toMatchObject({recorded:false,bankConfirmed:false,outstanding:true});
});

test.each(["failed","canceled"])("late %s payout observations keep reviews historical and BANK unresolved",async status=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();await enabled();const s=await view(h.q.id);await review(h.q.id,s.stateSha256);await advanceBoth(1000);
 h.payout.status=status;h.payout.failure_code=status==="failed"?"account_closed":null;h.payout.failure_balance_transaction="txn_return";
 h.values["connected:/v1/balance_transactions/txn_return"]={...h.payoutDebit,id:"txn_return",type:status==="failed"?"payout_failure":"payout_cancel",reporting_category:"payout",amount:h.payout.amount,net:h.payout.amount};
 await h.observe(id(501));const fresh=await view(h.q.id);expect(fresh.state).toMatchObject({reason:status==="failed"?"payout_failed":"payout_canceled",payoutStatus:status,bankConfirmed:false,outstanding:true});
 expect(fresh.history[0].appliesToCurrentState).toBe(false);await denied(()=>review(h.q.id,s.stateSha256,id(3001)),/BANK_REVIEW_STATE_CHANGED/);
});

test("a later original reversal invalidates an old review without changing financial history",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();await enabled();const s=await view(h.q.id);await review(h.q.id,s.stateSha256);
 // Synthetic read-model original, as in F47 tests; F29 separately owns actual
 // reversal admission/execution. No provider or real reversal is performed here.
 await db.query("insert into sales_team_transfer_reversal_runs_v1(run_id) values($1)",[h.q.original_worker_run_id]);
 await db.query("insert into sales_team_transfer_reversal_checks_v1(id,task_id,worker_run_id,operation_id,transfer_request_id,context,receipt_revision) values($1,$2,$3,$4,$5,$6,$7)",[id(900),id(901),h.q.original_worker_run_id,h.q.operation_id,h.q.id,h.q.context,h.q.receipt_revision]);
 await db.query("insert into sales_team_transfer_reversal_completions_v1(operation_id,check_id,transfer_request_id,reversal_id,balance_id,amount_cents,worker_run_id,proof) values($1,$2,$3,'trr_fixture','txn_reversal',100,$4,'{}')",[h.q.operation_id,id(900),h.q.id,h.q.original_worker_run_id]);
 const fresh=await view(h.q.id);expect(fresh.state).toMatchObject({reason:"transfer_reversed",bankConfirmed:false,outstanding:true});expect(fresh.history[0].appliesToCurrentState).toBe(false);
 await denied(()=>review(h.q.id,s.stateSha256,id(3001)),/BANK_REVIEW_STATE_CHANGED/);
});

test("bounded history pagination retains equal-state reviews without duplicates and rejects foreign cursors",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();const s=await view(h.q.id);for(const n of [3000,3001,3002])await review(h.q.id,s.stateSha256,id(n));
 const first=await view(h.q.id,1,1,null,2);expect(first.history).toHaveLength(2);expect(first.hasMoreHistory).toBe(true);expect(first.nextCursor).toBe(first.history[1].reviewId);
 const second=await view(h.q.id,1,1,first.nextCursor,2);expect(second.history).toHaveLength(1);expect(second.hasMoreHistory).toBe(false);expect(new Set([...first.history,...second.history].map(r=>r.reviewId)).size).toBe(3);
 await denied(()=>view(h.q.id,1,1,id(9999)),/INVALID_BANK_REVIEW_CURSOR/);await denied(()=>view(h.q.id,1,1,null,51),/INVALID_BANK_REVIEW_LIMIT/);
});

test("service is SELECT-only on review tables and only named public entry points are executable",async()=>{
 const h=await seedCompletedBeneficiary(db);await db.exec("set local role service_role");expect((await view(h.q.id)).state.bankConfirmed).toBe(false);
 await denied(()=>db.exec("update sales_team_bank_review_policy_v1 set enabled=true"),/permission denied/);
 await denied(()=>db.exec("delete from sales_team_bank_exception_reviews_v1"),/permission denied/);
 await denied(()=>db.exec("select creatornet_team_private.bank_review_contract_digest_v1()"),/permission denied/);
 await db.exec("reset role");
 for(const role of ["anon","authenticated"]){await db.exec(`set local role ${role}`);await denied(()=>view(h.q.id),/permission denied/);await denied(()=>db.query("select * from sales_team_bank_exception_reviews_v1"),/permission denied/);await db.exec("reset role");}
});

test("loss of policy authority after insert rolls back the review and trigger mutation",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();const s=await view(h.q.id);
 await db.exec("create function public.reject_fixture_bank_review_authority() returns trigger language plpgsql as $$begin update public.sales_team_bank_review_policy_v1 set enabled=false;return new;end$$;create trigger reject_fixture_bank_review before insert on sales_team_bank_exception_reviews_v1 for each row execute function public.reject_fixture_bank_review_authority()");
 await denied(()=>review(h.q.id,s.stateSha256),/BANK_REVIEW_AUTHORITY_REQUIRED/);expect(await count()).toBe(0);expect((await db.query<{enabled:boolean}>("select enabled from sales_team_bank_review_policy_v1")).rows[0].enabled).toBe(true);
});

test("manager revocation during insert rolls back the review and revocation",async()=>{
 const h=await seedCompletedBeneficiary(db);await enabled();await addTeamMember(db,3,"manager",false);const s=await view(h.q.id,3);
 await db.exec(`create function public.reject_fixture_bank_review_actor() returns trigger language plpgsql as $$begin update public.sales_team_memberships_v1 set status='removed' where creator_id='${id(1)}' and user_id='${id(3)}';return new;end$$;create trigger reject_fixture_bank_review_actor before insert on sales_team_bank_exception_reviews_v1 for each row execute function public.reject_fixture_bank_review_actor()`);
 await denied(()=>review(h.q.id,s.stateSha256,id(3000),3),/TEAM_MANAGER_REQUIRED/);expect(await count()).toBe(0);expect((await db.query<{status:string}>("select status from sales_team_memberships_v1 where creator_id=$1 and user_id=$2",[id(1),id(3)])).rows[0].status).toBe("active");
});
