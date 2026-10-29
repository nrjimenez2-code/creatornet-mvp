/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {signedSurplusDatabase} from "@/test-support/sales-team-surplus-ingress-postgres";
import {seedCompletedBeneficiary} from "@/test-support/sales-team-beneficiary-payout-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {teamFixtureId as id,addTeamMember,teamRpc} from "@/test-support/sales-team-postgres";
import type {TeamStatement} from "@/lib/salesTeams/statements";
import {teamPayoutStatementsSchemaReady} from "@/lib/salesTeams/policy";

declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261029233544_sales_team_payout_statements.sql";
let db:PGlite,advance:(ms:number)=>Promise<void>,existingContractsUnchanged:boolean;
const realNow=Date.now.bind(Date);
const advanceBoth=async(ms:number)=>{jest.spyOn(Date,"now").mockImplementation(()=>realNow()+ms);await advance(ms);};
const contracts=async()=>(await db.query<{digest:string}>(`select md5(string_agg(pg_get_functiondef(oid)||coalesce(proacl::text,''),E'\n' order by oid::regprocedure::text collate "C")) digest
 from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) and proname<>'read_sales_team_payout_statement_v1'`)).rows[0].digest;
beforeAll(async()=>{db=createLocalPostgres();advance=await installTeamLocalClock(db);await signedSurplusDatabase(db);
 for(const path of ["supabase/migrations/20261029171329_sales_team_daily_surplus.sql","supabase/migrations/20261029182136_sales_team_beneficiary_payout_observations.sql"])await db.exec(readFileSync(path,"utf8"));
 const before=await contracts();await db.exec(readFileSync(candidate,"utf8"));existingContractsUnchanged=(await contracts())===before;
},30000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback;reset role");});afterAll(async()=>{await db.close();});
const statement=async(actor=1,creator=1,cursor:string|null=null,limit=20)=>(await db.query<{result:TeamStatement}>(
 "select public.read_sales_team_payout_statement_v1($1,$2,$3,$4) result",[id(creator),id(actor),cursor,limit])).rows[0].result;
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}};

test("projection is off unless its complete schema chain is explicitly ready",()=>{
 expect(teamPayoutStatementsSchemaReady({})).toBe(false);expect(teamPayoutStatementsSchemaReady({CREATOR_TEAM_PAYOUT_STATEMENTS_SCHEMA_READY:"true"})).toBe(false);
});
test("completed transfer without payout observation is distinct from BANK",async()=>{
 const h=await seedCompletedBeneficiary(db);h.raw.mockClear();const s=await statement();
 expect(s.bankPayoutStatus).toBe("not_recorded");expect(s.entries[0].payoutEvidence).toEqual([expect.objectContaining({beneficiary:"creator",transferredCents:h.q.amount_cents.toString(),reversedCents:"0",payoutStatus:"not_recorded",observedAt:null,bankConfirmed:false})]);
 expect(s.entries[0].hasMorePayoutEvidence).toBe(false);expect(h.raw).not.toHaveBeenCalled();
});
test("paid observation is minimized, leaves accounting intact and performs no provider call",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();h.raw.mockClear();
 const old=(await db.query<{s:TeamStatement}>("select public.read_sales_team_statement_v1($1,$1,null,20) s",[id(1)])).rows[0].s;
 const s=await statement();expect(s.totals).toEqual(old.totals);expect(s.entries[0].creatorAccounting).toEqual(old.entries[0].creatorAccounting);
 expect(s.entries[0].payoutEvidence?.[0]).toMatchObject({payoutStatus:"paid",bankConfirmed:false});
 expect(Object.keys(s.entries[0].payoutEvidence![0]).sort()).toEqual(["bankConfirmed","beneficiary","observedAt","payoutStatus","reversedCents","transferredAt","transferredCents"].sort());
 expect(JSON.stringify(s)).not.toMatch(/acct_|ba_|po_|py_|tr_|txn_|req_|membersSha256|destinationId|lease_token/);expect(h.raw).not.toHaveBeenCalled();
});
test("closer cannot see creator transfers or their payout observations",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();const s=await statement(2);
 expect(s.scope).toBe("closer");expect(s.entries[0].creatorAccounting).toBeNull();expect(s.entries[0].payoutEvidence).toEqual([]);
});
test("removed closer retains only their own original with all new-money controls off",async()=>{
 const h=await seedCompletedBeneficiary(db,"closer",async()=>{await advanceBoth(15*86400000);await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()");});await h.observe();
 const member=String((await db.query<{id:string}>("select id from sales_team_memberships_v1 where user_id=$1",[id(2)])).rows[0].id);
 await teamRpc(db,1,"remove_member",{membership_id:member});
 await db.exec("do $$declare c record;begin for c in select attname from pg_attribute where attrelid='public.sales_team_controls_v1'::regclass and atttypid='boolean'::regtype and attname<>'singleton' and not attisdropped loop execute format('update public.sales_team_controls_v1 set %I=false',c.attname);end loop;end$$");
 const s=await statement(2);expect(s.membershipStatus).toBe("removed");expect(s.entries[0].payoutEvidence?.[0]).toMatchObject({beneficiary:"closer",payoutStatus:"paid",bankConfirmed:false});
 expect(s.entries[0].creatorAccounting).toBeNull();
});
test("active manager has creator scope; removal removes that scope",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();const member=await addTeamMember(db,3,"manager",false);
 expect((await statement(3)).entries[0].payoutEvidence?.[0].beneficiary).toBe("creator");await teamRpc(db,1,"remove_member",{membership_id:member});
 expect((await statement(3)).entries).toEqual([]);
});
test("unrelated actors, creators and inaccessible cursors reject through the inherited owner",async()=>{
 await seedCompletedBeneficiary(db);await addTeamMember(db,4);expect((await statement(4)).entries).toEqual([]);
 await denied(()=>statement(11),/TEAM_STATEMENT_ACCESS_DENIED/);await denied(()=>statement(2,12),/TEAM_STATEMENT_ACCESS_DENIED/);
 await denied(()=>statement(2,1,id(27)),/INVALID_STATEMENT_CURSOR/);await denied(()=>statement(1,1,null,51),/INVALID_STATEMENT_LIMIT/);
});
test("latest recorded failure is appended over earlier paid history without confirming BANK",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();await advanceBoth(1000);
 h.payout.status="failed";h.payout.failure_code="account_closed";h.payout.failure_balance_transaction="txn_return";
 h.values["connected:/v1/balance_transactions/txn_return"]={...h.payoutDebit,id:"txn_return",type:"payout_failure",reporting_category:"payout",amount:h.payout.amount,net:h.payout.amount};
 await h.observe(id(501));const s=await statement();expect(s.entries[0].payoutEvidence?.[0]).toMatchObject({payoutStatus:"failed",bankConfirmed:false});
 expect((await db.query<{n:number}>("select count(*)::int n from sales_team_beneficiary_payout_observations_v1")).rows[0].n).toBe(2);
});
test("statement refresh retains the old observation time",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();const before=await statement();await advanceBoth(3*86400000);const after=await statement();
 expect(after.entries[0].payoutEvidence).toEqual(before.entries[0].payoutEvidence);
});
test("later original reversal remains visible beside historical payout evidence",async()=>{
 const h=await seedCompletedBeneficiary(db);await h.observe();
 // Read-model fixture of an already completed reversal; F29 owns its admission.
 await db.query("insert into sales_team_transfer_reversal_runs_v1(run_id) values($1)",[h.q.original_worker_run_id]);
 await db.query("insert into sales_team_transfer_reversal_checks_v1(id,task_id,worker_run_id,operation_id,transfer_request_id,context,receipt_revision) values($1,$2,$3,$4,$5,$6,$7)",[id(900),id(901),h.q.original_worker_run_id,h.q.operation_id,h.q.id,h.q.context,h.q.receipt_revision]);
 await db.query("insert into sales_team_transfer_reversal_completions_v1(operation_id,check_id,transfer_request_id,reversal_id,balance_id,amount_cents,worker_run_id,proof) values($1,$2,$3,'trr_fixture','txn_reversal',100,$4,'{}')",[h.q.operation_id,id(900),h.q.id,h.q.original_worker_run_id]);
 expect((await statement()).entries[0].payoutEvidence?.[0]).toMatchObject({reversedCents:"100",payoutStatus:"paid",bankConfirmed:false});
});
test("bounded evidence declares overflow and leaves inherited receipt pagination and totals intact",async()=>{
 const h=await seedCompletedBeneficiary(db);
 // Synthetic read-model copies only: provider admission is covered by F27/F46.
 await db.query(`with added as (
  insert into sales_team_transfer_requests_v1(id,operation_id,receipt_id,sale_id,creator_id,beneficiary,beneficiary_user_id,destination_id,amount_cents,receipt_revision,original_worker_run_id,context,request,created_at)
  select gen_random_uuid(),gen_random_uuid(),receipt_id,sale_id,creator_id,beneficiary,beneficiary_user_id,destination_id,n,receipt_revision,original_worker_run_id,context,request,q.created_at+n*interval '1 millisecond'
  from sales_team_transfer_requests_v1 q cross join generate_series(1,25)n where q.id=$1 returning id
 ) insert into sales_team_transfer_completions_v1(request_id,transfer_id,balance_id,worker_run_id,proof)
 select added.id,'tr_fixture'||right(added.id::text,12),'txn_fixture'||right(added.id::text,12),done.worker_run_id,done.proof
 from added cross join sales_team_transfer_completions_v1 done where done.request_id=$1`,[h.q.id]);
 const s=await statement();expect(s.entries[0].payoutEvidence).toHaveLength(20);expect(s.entries[0].hasMorePayoutEvidence).toBe(true);
 expect(s.entries[0].payoutEvidence!.map(e=>e.transferredCents)).toEqual(Array.from({length:20},(_,i)=>String(25-i)));
 const old=(await db.query<{s:TeamStatement}>("select public.read_sales_team_statement_v1($1,$1,null,1) s",[id(1)])).rows[0].s;
 const page=await statement(1,1,null,1);expect(page.totals).toEqual(old.totals);expect(page.nextCursor).toEqual(old.nextCursor);
});
test.each(["anon","authenticated"])("%s cannot invoke the projection or read immutable payout history",async role=>{
 await seedCompletedBeneficiary(db);await db.exec(`set local role ${role}`);
 await denied(()=>statement(),/permission denied/i);await denied(()=>db.exec("select * from sales_team_beneficiary_payout_observations_v1"),/permission denied/i);
});
test("service can use the invoker projection; read-model install changes no financial contracts",async()=>{
 expect(existingContractsUnchanged).toBe(true);
 await seedCompletedBeneficiary(db);await db.exec("set local role service_role");expect((await statement()).entries).toHaveLength(1);await db.exec("reset role");
 expect((await db.query("select prosecdef,provolatile,proconfig from pg_proc where proname='read_sales_team_payout_statement_v1'")).rows).toEqual([{prosecdef:false,provolatile:"s",proconfig:["search_path=pg_catalog"]}]);
});
