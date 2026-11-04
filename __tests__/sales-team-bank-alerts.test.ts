/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {signedSurplusDatabase} from "@/test-support/sales-team-surplus-ingress-postgres";
import {bankAlertMigrations} from "@/test-support/sales-team-bank-alerts-postgres";
import {seedCompletedBeneficiary} from "@/test-support/sales-team-beneficiary-payout-postgres";
import {teamFixtureId as id,addTeamMember,teamRpc} from "@/test-support/sales-team-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import type {BankAlerts} from "@/lib/salesTeams/bankAlerts";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,retainedUnchanged:boolean,advance:(ms:number)=>Promise<void>;
const inventory=async()=>(await db.query<{v:string}>(`select md5(string_agg(pg_get_functiondef(oid)||coalesce(proacl::text,''),E'\n' order by oid::regprocedure::text collate "C")) v
 from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) and proname not in
 ('bank_alert_signal_v1','bank_alert_contract_digest_v1','bank_alert_ready_v1','bank_alert_access_v1','capture_bank_alert_v1','read_sales_team_bank_alerts_v1','mark_sales_team_bank_alert_read_v1')`)).rows[0].v;
const enable=()=>db.exec("update sales_team_bank_alert_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.bank_alert_contract_digest_v1()");
const alerts=async(actor=1,creator=1,cursor:string|null=null,limit=20)=>(await db.query<{v:BankAlerts}>("select public.read_sales_team_bank_alerts_v1($1,$2,$3,$4) v",[id(creator),id(actor),cursor,limit])).rows[0].v;
const mark=async(alert:string,actor=1,creator=1)=>(await db.query<{v:{readAt:string}}>("select public.mark_sales_team_bank_alert_read_v1($1,$2,$3) v",[id(creator),id(actor),alert])).rows[0].v;
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}};
beforeAll(async()=>{
 db=createLocalPostgres();advance=await installTeamLocalClock(db);await signedSurplusDatabase(db);
 for(const name of bankAlertMigrations.slice(0,-1))await db.exec(readFileSync("supabase/migrations/"+name,"utf8"));
 const before=await inventory();await db.exec(readFileSync("supabase/migrations/"+bankAlertMigrations.at(-1),"utf8"));retainedUnchanged=before===await inventory();
},30000);
beforeEach(()=>db.exec("begin"));afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback;reset role");});afterAll(()=>db.close());

test("default-off installation preserves all retained routines/ACLs and never backfills",async()=>{
 expect(retainedUnchanged).toBe(true);expect((await db.query("select enabled from sales_team_bank_alert_policy_v1")).rows[0]).toEqual({enabled:false});
 await seedCompletedBeneficiary(db);expect((await db.query("select * from sales_team_bank_alerts_v1")).rows).toEqual([]);
 await denied(()=>alerts(),/BANK_ALERT_AUTHORITY_REQUIRED/);await enable();expect((await alerts()).entries).toEqual([]);
});
test("completion and meaningful observations emit immutable alerts; duplicate checks do not, recurring states do",async()=>{
 await enable();const h=await seedCompletedBeneficiary(db);expect((await alerts()).entries[0].state.reason).toBe("payout_observation_missing");
 await h.observe();const paid=await alerts();expect(paid.entries).toHaveLength(2);expect(paid.entries[0].state.payoutStatus).toBe("paid");
 await h.observe(id(501));expect((await alerts()).entries).toHaveLength(2);
 h.payout.status="pending";await h.observe(id(502));h.payout.status="paid";await h.observe(id(503));
 expect((await alerts()).entries.map(e=>e.state.payoutStatus)).toEqual(["paid","pending","paid","not_recorded"]);
 expect(JSON.stringify(await alerts())).not.toMatch(/acct_|ba_|po_|py_|tr_|txn_|destination|lease|actorId/);
 expect(h.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 await denied(()=>db.exec("update sales_team_bank_alerts_v1 set kind='escalated'"),/immutable|HISTORY|APPEND/i);
});
test("reviews create separate alerts without closing exceptions or changing financial rows",async()=>{
 await enable();const h=await seedCompletedBeneficiary(db);
 const before=(await db.query("select public.read_sales_team_statement_v1($1,$1,null,20) v",[id(1)])).rows;
 await db.exec("update sales_team_bank_review_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.bank_review_contract_digest_v1();update sales_team_bank_review_actions_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.bank_review_actions_contract_digest_v1()");
 const hash=(await db.query<{v:{stateSha256:string}}>("select public.read_sales_team_bank_exception_v1($1,$1,$2,null,20) v",[id(1),h.q.id])).rows[0].v.stateSha256;
 const args=[id(3000),id(1),id(1),h.q.id,"escalated",hash];
 await db.query("select public.record_sales_team_bank_review_action_v1($1,$2,$3,$4,$5,$6)",args);await db.query("select public.record_sales_team_bank_review_action_v1($1,$2,$3,$4,$5,$6)",args);
 expect((await alerts()).entries.map(e=>e.kind)).toEqual(["escalated","payout_state"]);
 expect((await alerts()).entries.every(e=>!e.state.bankConfirmed&&e.state.outstanding)).toBe(true);
 expect((await db.query("select public.read_sales_team_statement_v1($1,$1,null,20) v",[id(1)])).rows).toEqual(before);
 await h.observe();expect((await alerts()).entries.find(e=>e.kind==="escalated")?.appliesToCurrentState).toBe(false);
});
test("read receipts are personal, idempotent and never hide alerts",async()=>{
 await enable();await seedCompletedBeneficiary(db);await addTeamMember(db,3,"manager",false);
 const alert=(await alerts()).entries[0].alertId,first=await mark(alert);expect(await mark(alert)).toEqual(first);
 expect((await alerts()).entries[0].readAt).toBe(first.readAt);expect((await alerts(3)).entries[0].readAt).toBeNull();
 await mark(alert,3);expect((await alerts()).entries).toHaveLength(1);
 await denied(()=>db.exec("delete from sales_team_bank_alert_reads_v1"),/immutable|HISTORY|APPEND/i);
});
test("removed manager immediately loses creator reads, cursors and mark-read authority",async()=>{
 await enable();await seedCompletedBeneficiary(db);const member=await addTeamMember(db,3,"manager",false),alert=(await alerts(3)).entries[0].alertId;
 await teamRpc(db,1,"remove_member",{membership_id:member});expect((await alerts(3)).entries).toEqual([]);
 await denied(()=>alerts(3,1,alert),/INVALID_BANK_ALERT_CURSOR/);await denied(()=>mark(alert,3),/BANK_ALERT_ACCESS_DENIED/);
 await denied(()=>alerts(11),/TEAM_STATEMENT_ACCESS_DENIED/);await denied(()=>alerts(1,12),/TEAM_STATEMENT_ACCESS_DENIED/);
});
test("removed closer retains only own financial alert and read history with new sales off",async()=>{
 await enable();const now=Date.now.bind(Date),h=await seedCompletedBeneficiary(db,"closer",async()=>{jest.spyOn(Date,"now").mockImplementation(()=>now()+15*86400000);await advance(15*86400000);await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()");});
 const alert=(await alerts(2)).entries[0].alertId,member=(await db.query<{id:string}>("select id from sales_team_memberships_v1 where creator_id=$1 and user_id=$2",[id(1),id(2)])).rows[0].id;
 await teamRpc(db,1,"remove_member",{membership_id:member});await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false");
 expect((await alerts(2))).toMatchObject({scope:"closer",membershipStatus:"removed"});expect((await alerts(2)).entries.map(e=>e.state.requestId)).toEqual([h.q.id]);await mark(alert,2);
});
test("scoped cursor pages are bounded, read records do not reorder, invalid scope cannot probe",async()=>{
 await enable();const h=await seedCompletedBeneficiary(db);await h.observe();const first=await alerts(1,1,null,1);await mark(first.entries[0].alertId);
 const second=await alerts(1,1,first.nextCursor,1);expect(second.entries).toHaveLength(1);expect(second.entries[0].alertId).not.toBe(first.entries[0].alertId);expect(second.hasMore).toBe(false);
 for(const limit of [0,51])await denied(()=>alerts(1,1,null,limit),/INVALID_BANK_ALERT_LIMIT/);
 await denied(()=>alerts(2,1,first.entries[0].alertId),/INVALID_BANK_ALERT_CURSOR/);await denied(()=>mark(first.entries[0].alertId,2),/BANK_ALERT_ACCESS_DENIED/);
});
test("transaction rollback removes alert and source; contract loss holds writes; service only can invoke",async()=>{
 await enable();const h=await seedCompletedBeneficiary(db);await db.exec("savepoint source");await h.observe();expect((await alerts()).entries).toHaveLength(2);await db.exec("rollback to savepoint source;release savepoint source");expect((await alerts()).entries).toHaveLength(1);
 await db.exec("update sales_team_bank_alert_policy_v1 set contract_sha256=repeat('f',64)");await denied(()=>h.observe(),/BANK_ALERT_AUTHORITY_REQUIRED/);await denied(()=>alerts(),/BANK_ALERT_AUTHORITY_REQUIRED/);await enable();
 await db.exec("set local role service_role");expect((await alerts()).entries).toHaveLength(1);await mark((await alerts()).entries[0].alertId);await denied(()=>db.exec("select * from sales_team_bank_alerts_v1"),/permission denied/);await db.exec("reset role");
 for(const role of ["anon","authenticated"]){await db.exec(`set local role ${role}`);await denied(()=>alerts(),/permission denied/);await db.exec("reset role");}
});
test("recorded original reversal creates a new outstanding alert without hiding earlier payout history",async()=>{
 await enable();const h=await seedCompletedBeneficiary(db);await h.observe();
 // Synthetic immutable projection only; retained F29 owns real reversal proof.
 await db.query("insert into sales_team_transfer_reversal_runs_v1(run_id) values($1)",[h.q.original_worker_run_id]);
 await db.query("insert into sales_team_transfer_reversal_checks_v1(id,task_id,worker_run_id,operation_id,transfer_request_id,context,receipt_revision) values($1,$2,$3,$4,$5,$6,$7)",[id(900),id(901),h.q.original_worker_run_id,h.q.operation_id,h.q.id,h.q.context,h.q.receipt_revision]);
 await db.query("insert into sales_team_transfer_reversal_completions_v1(operation_id,check_id,transfer_request_id,reversal_id,balance_id,amount_cents,worker_run_id,proof) values($1,$2,$3,'trr_fixture','txn_reversal',100,$4,'{}')",[h.q.operation_id,id(900),h.q.id,h.q.original_worker_run_id]);
 const result=await alerts();expect(result.entries).toHaveLength(3);expect(result.entries[0].state).toMatchObject({reason:"transfer_reversed",reversedCents:"100",bankConfirmed:false,outstanding:true});expect(result.entries[1].appliesToCurrentState).toBe(false);
});
test("trigger disablement changes the contract and holds reads until explicitly reconciled",async()=>{
 await enable();await seedCompletedBeneficiary(db);await db.exec("alter table sales_team_transfer_completions_v1 disable trigger sales_team_bank_alert_transfer_v1");await denied(()=>alerts(),/BANK_ALERT_AUTHORITY_REQUIRED/);
});
