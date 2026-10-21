/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamFixtureId as id,teamRpc,addTeamMember} from "@/test-support/sales-team-postgres";
import type {TeamStatement} from "@/lib/salesTeams/statements";
declare const createLocalPostgres:()=>PGlite;let db:PGlite,member:string;
const statement=async(actor=2,creator=1,cursor:string|null=null,limit=20)=>(await db.query<{result:TeamStatement}>(
 "select public.read_sales_team_statement_v1($1,$2,$3,$4) result",[id(creator),id(actor),cursor,limit])).rows[0].result;
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
beforeAll(async()=>{
 db=await salesTeamSaleDatabase(createLocalPostgres());
 for(const file of ["20261021215909_sales_team_provider_journal_and_ledger.sql","20261021220845_sales_team_receipt_accounting.sql","20261021230016_sales_team_financial_statements.sql"])
  await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin");member=await enableTeamSalesFixture(db);const offer=await approveTeamOffer(db,[3]);const draft=await draftTeamSale(db,offer.options.find(o=>o.kind==="installments")!.id);
 await db.query("select public.accept_sales_team_sale_v1($1,$2,$3,true)",[draft.saleId,id(10),draft.quote.fingerprint]);
 // Read-model fixtures only. Verified receipt admission is tested separately.
 for(let period=1;period<=3;period++){
  const amount=period===3?3335:3333;
  const obligation=(await db.query<{id:string}>("insert into public.sales_team_payment_obligations_v1(id,sale_id,period_number,amount_cents,due_at,status) values(gen_random_uuid(),$1,$2,$3,now(),'paid') returning id",[draft.saleId,period,amount])).rows[0].id;
  await db.query(`insert into public.sales_team_receipts_v1(sale_id,obligation_id,payment_intent_id,charge_id,subtotal_cents,processing_cost_cents,paid_at,available_on,source_event_id,proof)
    values($1,$2,$3,$4,$5,127,clock_timestamp()-interval '20 days'+make_interval(secs=>$6),now()-interval '1 day',$7,'{}')`,
   [draft.saleId,obligation,`pi_fixture${period}`,`ch_fixture${period}`,amount,period,`fixture${period}`]);
 }
 await db.query("select public.recompute_sales_team_balances_v1($1,'statement-fixture','{}')",[draft.saleId]);
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});

test("closers see only their own commission statement, without creator accounting or provider identities",async()=>{
 const own=await statement();expect(own.scope).toBe("closer");expect(own.totals.earnedCents).toBe("1000");expect(own.entries).toHaveLength(3);
 expect(own.entries.every(entry=>entry.creatorAccounting===null&&entry.bankPayoutStatus==="not_recorded")).toBe(true);
 expect(JSON.stringify(own)).not.toMatch(/acct_|pi_fixture|ch_fixture|buyer_id|providerRequest/);
 await addTeamMember(db,4);expect((await statement(4)).entries).toEqual([]);
 await denied(()=>statement(2,12),/TEAM_STATEMENT_ACCESS_DENIED/);await denied(()=>statement(11),/TEAM_STATEMENT_ACCESS_DENIED/);
});
test("removal and disabled new activity preserve historical statements without restoring customer access",async()=>{
 await teamRpc(db,1,"remove_member",{membership_id:member});await db.exec("update public.sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false");
 const own=await statement();expect(own.membershipStatus).toBe("removed");expect(own.totals.unpaidCents).toBe("1000");
 expect((await db.query<{role:string|null}>("select public.sales_team_actor_role_v1($1,$2) role",[id(1),id(2)])).rows[0].role).toBeNull();
});
test("owners and active managers see creator accounting; former managers retain only their own entries",async()=>{
 const manager=await addTeamMember(db,3,"manager",false);
 for(const actor of [1,3]){const full=await statement(actor);expect(full.scope).toBe("creator");expect(full.entries[0].creatorAccounting?.actualProcessingCostCents).toBe(127);}
 await teamRpc(db,1,"remove_member",{membership_id:manager});const former=await statement(3);expect(former.scope).toBe("closer");expect(former.entries).toEqual([]);
});
test("keyset pagination keeps global totals and rejects inaccessible cursors",async()=>{
 const first=await statement(2,1,null,1);expect(first.entries).toHaveLength(1);expect(first.totals.earnedCents).toBe("1000");expect(first.nextCursor).toBeTruthy();
 const second=await statement(2,1,first.nextCursor,2);expect(second.entries).toHaveLength(2);expect(second.nextCursor).toBeNull();
 expect(new Set([...first.entries,...second.entries].map(e=>e.receiptId)).size).toBe(3);
 await denied(()=>statement(2,1,id(27)),/INVALID_STATEMENT_CURSOR/);await denied(()=>statement(2,1,null,51),/INVALID_STATEMENT_LIMIT/);
});
test("financial holds and recipient lapses remain distinct from transfer and bank evidence",async()=>{
 expect((await statement()).entries.every(e=>e.status==="settlement_paused")).toBe(true);
 await db.exec("update public.sales_team_recipients_v1 set payouts_ready=false");expect((await statement()).entries.every(e=>e.status==="recipient_verification_required")).toBe(true);
 await db.exec("update public.sales_team_receipts_v1 set dispute_hold=true");expect((await statement()).entries.every(e=>e.status==="financial_review")).toBe(true);
 expect((await statement()).bankPayoutStatus).toBe("not_recorded");
});
test("current prospective commission changes cannot rewrite old statement earnings",async()=>{
 await teamRpc(db,1,"configure_member",{membership_id:member,role:"closer",is_closer:true,commission_bps:2000,hold_days:30,renewal_rule:"every_renewal",expected_revision:1});
 expect((await statement()).totals.earnedCents).toBe("1000");
});
test("browser database roles cannot call service-owned statements or read private financial tables",async()=>{
 await db.exec("set local role authenticated");
 await denied(()=>statement(1),/permission denied/);
 await denied(()=>db.query("select * from public.sales_team_receipts_v1"),/permission denied/);
 await db.exec("reset role");
});
