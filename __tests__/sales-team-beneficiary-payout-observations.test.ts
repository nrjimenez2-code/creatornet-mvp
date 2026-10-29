/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {signedSurplusDatabase} from "@/test-support/sales-team-surplus-ingress-postgres";
import {seedCompletedBeneficiary} from "@/test-support/sales-team-beneficiary-payout-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {readTeamBeneficiaryPayout,type TeamBeneficiaryPayoutSource} from "@/lib/salesTeams/beneficiaryPayoutReadback";
import {teamBeneficiaryPayoutSchemaReady} from "@/lib/salesTeams/policy";
import {observeTeamBeneficiaryPayout} from "@/lib/salesTeams/beneficiaryPayoutObservations";

declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261029182136_sales_team_beneficiary_payout_observations.sql";
let db:PGlite,advance:(ms:number)=>Promise<void>,h:Awaited<ReturnType<typeof seedCompletedBeneficiary>>;
beforeAll(async()=>{db=createLocalPostgres();advance=await installTeamLocalClock(db);await signedSurplusDatabase(db);await db.exec(readFileSync("supabase/migrations/20261029171329_sales_team_daily_surplus.sql","utf8"));await db.exec(readFileSync(candidate,"utf8"));},30000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback;reset role");});afterAll(async()=>{await db?.close();});
const setup=async()=>{h=await seedCompletedBeneficiary(db);};
type Begun={status:string;checkId:string;leaseToken:string;source:TeamBeneficiaryPayoutSource};
const begin=(checkId=id(500),requestId=h.q.id,payoutId=h.payout.id)=>h.invoke<Begun>("begin_sales_team_beneficiary_payout_check_v1",{p_check_id:checkId,p_request_id:requestId,p_payout_id:payoutId,p_context:h.c.context});
const complete=(b:Begun,p:unknown,token=b.leaseToken)=>h.invoke("complete_sales_team_beneficiary_payout_check_v1",{p_check_id:b.checkId,p_lease_token:token,p_context:h.c.context,p_proof:p});
const proof=(b:Begun)=>readTeamBeneficiaryPayout(h.c,b.source,h.payout.id);
const count=async(table:string)=>(await db.query<{n:number}>(`select count(*)::int n from ${table}`)).rows[0].n;
const denied=async(action:()=>Promise<unknown>,pattern=/permission denied|immutable/i)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}};

test("schema and database observation controls install disabled",async()=>{
 expect(teamBeneficiaryPayoutSchemaReady({})).toBe(false);expect(teamBeneficiaryPayoutSchemaReady({CREATOR_TEAM_BENEFICIARY_PAYOUT_SCHEMA_READY:"true"})).toBe(false);
 expect((await db.query("select enabled,contract_sha256 from sales_team_bank_observation_policy_v1")).rows).toEqual([{enabled:false,contract_sha256:null}]);
});
test("service resolves the original and records payout observation without changing money or claiming BANK",async()=>{
 await setup();const before=(await db.query("select * from sales_team_financial_ledger_v1 order by id")).rows;
 await db.exec("set local role service_role");expect(await h.observe()).toMatchObject({status:"recorded",recorded:true,bankConfirmed:false});
 expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(1);expect(await count("sales_team_beneficiary_payout_reads_v1")).toBe(10);
 expect((await db.query("select * from sales_team_financial_ledger_v1 order by id")).rows).toEqual(before);
 expect(h.raw.mock.calls.every(([m])=>m==="GET")).toBe(true);
 const o=(await db.query<{proof:unknown}>("select proof from sales_team_beneficiary_payout_observations_v1")).rows[0];expect(o.proof).toMatchObject({beneficiaryUserId:h.q.beneficiary_user_id,payout:{destinationId:"ba_original",status:"paid"},bankConfirmed:false});
});
test("one active check serializes competing attempts and a consumed ID never reveals its token",async()=>{
 await setup();const b=await begin();expect(b.status).toBe("admitted");expect(await begin(id(501))).toEqual({status:"busy",bankConfirmed:false});
 expect(await begin()).toEqual({status:"consumed",bankConfirmed:false});expect(await count("sales_team_beneficiary_payout_checks_v1")).toBe(1);
});
test("an identical completion is idempotent; changed content cannot replace immutable history",async()=>{
 await setup();const b=await begin(),p=await proof(b);expect(await complete(b,p)).toMatchObject({recorded:true});expect(await complete(b,p)).toMatchObject({recorded:false});
 await expect(complete(b,{...p,observedAt:p.observedAt+1})).rejects.toThrow(/IMMUTABLE/);expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(1);
});
test.each(["disabled","digest","context"])("%s authority fails before admitting a provider read",async fault=>{
 await setup();if(fault==="disabled")await db.exec("update sales_team_bank_observation_policy_v1 set enabled=false");
 if(fault==="digest")await db.exec("update sales_team_bank_observation_policy_v1 set contract_sha256=repeat('0',64)");
 if(fault==="context")await db.exec("update sales_team_financial_config_v1 set context=jsonb_set(context,'{platformAccountId}','\"acct_foreign\"')");
 await expect(h.observe()).rejects.toThrow(/AUTHORITY/);expect(h.raw).not.toHaveBeenCalled();expect(await count("sales_team_beneficiary_payout_checks_v1")).toBe(0);
});
test("unknown originals and foreign reuse of a check ID cannot obtain a source",async()=>{
 await setup();await expect(begin(id(500),id(999))).rejects.toThrow(/ORIGINAL/);await begin();
 await expect(begin(id(500),h.q.id,"po_other")).rejects.toThrow(/CHECK_CHANGED/);
});
test("wrong lease or context cannot complete a check",async()=>{
 await setup();const b=await begin(),p=await proof(b);await expect(complete(b,p,id(999))).rejects.toThrow(/CURRENT_BENEFICIARY/);
 await expect(h.invoke("complete_sales_team_beneficiary_payout_check_v1",{p_check_id:b.checkId,p_lease_token:b.leaseToken,p_context:{...h.c.context,platformAccountId:"acct_foreign"},p_proof:p})).rejects.toThrow(/CURRENT_BENEFICIARY/);
 expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(0);
});
test("expired attempts remain immutable and a new check fences the old token",async()=>{
 await setup();const b=await begin(),p=await proof(b);await advance(91000);
 await expect(complete(b,p)).rejects.toThrow(/CURRENT_BENEFICIARY/);const next=await begin(id(501));expect(next.status).toBe("admitted");
 expect(next.leaseToken).not.toBe(b.leaseToken);await expect(complete(next,p,b.leaseToken)).rejects.toThrow(/CURRENT_BENEFICIARY/);
 expect(await count("sales_team_beneficiary_payout_checks_v1")).toBe(2);
});
test.each(["request","operation","receipt","sale","creator","beneficiary","user","account","transfer","payment","amount","payout","bank","automatic","method","credit_source","credit_amount","debit_source","debit_amount","member_count","digest","old","fraction","extra","null","confirmed"])("SQL rejects forged %s proof without recording history",async fault=>{
 await setup();const b=await begin(),p:Record<string,unknown>&{payout:Record<string,unknown>;credit:Record<string,unknown>;debit:Record<string,unknown>}=JSON.parse(JSON.stringify(await proof(b)));
 const keys:Record<string,string>={request:"requestId",operation:"operationId",receipt:"receiptId",sale:"saleId",creator:"creatorId",beneficiary:"beneficiary",user:"beneficiaryUserId",account:"connectedAccountId",transfer:"transferId",payment:"destinationPaymentId"};
 if(keys[fault])p[keys[fault]]="foreign";
 if(fault==="amount")p.transferAmountCents=1;if(fault==="payout")p.payout.id="po_other";if(fault==="bank")p.payout.destinationId="card_other";
 if(fault==="automatic")p.payout.automatic=false;if(fault==="method")p.payout.method="instant";if(fault==="credit_source")p.credit.sourceId="py_other";
 if(fault==="credit_amount")p.credit.amountCents=1;if(fault==="debit_source")p.debit.sourceId="po_other";if(fault==="debit_amount")p.debit.amountCents=-1;
 if(fault==="member_count")p.memberCount=301;if(fault==="digest")p.membersSha256="bad";if(fault==="old")p.readStartedAt=Date.now()-66000;
 if(fault==="fraction")p.memberCount=1.1;if(fault==="extra")p.privateBankNumber="must not persist";if(fault==="null")p.beneficiaryUserId=null;if(fault==="confirmed")p.bankConfirmed=true;
 await expect(complete(b,p)).rejects.toThrow();expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(0);expect(await count("sales_team_beneficiary_payout_reads_v1")).toBe(0);
});
test.each(["post","retained","duplicate","count","null"])("SQL fences %s provider-request provenance",async fault=>{
 await setup();const b=await begin(),p=await proof(b);
 if(fault==="post")p.connectedReadRequestIds[0]="req_originalPost";
 if(fault==="retained")p.connectedReadRequestIds[0]=b.source.completion.proof.transferReadRequestIds[0];
 if(fault==="duplicate")p.connectedReadRequestIds[0]=p.transferReadRequestIds[0];if(fault==="count")p.connectedReadRequestIds.pop();
 if(fault==="null")p.connectedReadRequestIds[0]=null as unknown as string;
 await expect(complete(b,p)).rejects.toThrow(/DISTINCT/);expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(0);
});
test("a later check cannot recycle provider reads from an accepted observation",async()=>{
 await setup();const b=await begin(),p=await proof(b);await complete(b,p);const next=await begin(id(501)),fresh=await proof(next);
 fresh.connectedReadRequestIds[0]=p.connectedReadRequestIds[0];await expect(complete(next,fresh)).rejects.toThrow(/DISTINCT/);
 expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(1);
});
test("late payout failure appends history and preserves the original paid observation",async()=>{
 await setup();await h.observe();const before=(await db.query("select * from sales_team_beneficiary_payout_observations_v1")).rows[0];
 Object.assign(h.payout,{status:"failed",failure_balance_transaction:"txn_return",failure_code:"account_closed"});
 h.values["connected:/v1/balance_transactions/txn_return"]={...h.payoutDebit,id:"txn_return",type:"payout_failure",amount:h.payout.amount,net:h.payout.amount};
 expect(await h.observe(id(501))).toMatchObject({recorded:true,bankConfirmed:false});
 const rows=(await db.query<{proof:unknown}>("select * from sales_team_beneficiary_payout_observations_v1 order by created_at,check_id")).rows;
 expect(rows[0]).toEqual(before);expect(rows[1].proof).toMatchObject({payout:{status:"failed"},returned:{id:"txn_return"},bankConfirmed:false});
});
test("an established original cannot change its payout or bank destination",async()=>{
 await setup();await h.observe();await expect(begin(id(501),h.q.id,"po_other")).rejects.toThrow(/ASSOCIATION/);
 h.payout.destination="ba_other";await expect(h.observe(id(501))).rejects.toThrow(/ASSOCIATION/);expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(1);
});
test("new-money controls can stay off while the admitted original is observed",async()=>{
 await setup();await db.exec("do $$ declare c record;begin for c in select attname from pg_attribute where attrelid='public.sales_team_controls_v1'::regclass and atttypid='boolean'::regtype and attname<>'singleton' and not attisdropped loop execute format('update public.sales_team_controls_v1 set %I=false',c.attname);end loop;end $$");
 expect(await h.observe()).toMatchObject({recorded:true,bankConfirmed:false});
});
test("revoking observation authority before completion prevents admission",async()=>{
 await setup();const b=await begin(),p=await proof(b);await db.exec("update sales_team_bank_observation_policy_v1 set enabled=false");
 await expect(complete(b,p)).rejects.toThrow(/AUTHORITY/);expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(0);
});
test("authority loss during insertion rolls back the observation and consumed requests",async()=>{
 await setup();const b=await begin(),p=await proof(b);
 await db.exec("create function public.fixture_revoke_bank_observation() returns trigger language plpgsql as $$begin update public.sales_team_bank_observation_policy_v1 set enabled=false;return new;end$$;create trigger fixture_revoke_bank before insert on sales_team_beneficiary_payout_observations_v1 for each row execute function public.fixture_revoke_bank_observation()");
 await expect(complete(b,p)).rejects.toThrow(/AUTHORITY/);expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(0);expect(await count("sales_team_beneficiary_payout_reads_v1")).toBe(0);
});
test.each(["anon","authenticated"])("%s cannot read history or call public/private owners",async role=>{
 await setup();await db.exec(`set local role ${role}`);await expect(begin()).rejects.toThrow(/permission denied/i);
 for(const table of ["sales_team_bank_observation_policy_v1","sales_team_beneficiary_payout_checks_v1","sales_team_beneficiary_payout_observations_v1","sales_team_beneficiary_payout_reads_v1"])await denied(()=>db.exec(`select * from ${table}`));
 await denied(()=>db.query("select creatornet_team_private.beneficiary_payout_source_v1($1,$2)",[h.q.id,h.c.context]));
});
test("service has named execution and SELECT only, with immutable histories even for table owner",async()=>{
 await setup();await h.observe();await db.exec("set local role service_role");
 for(const table of ["sales_team_bank_observation_policy_v1","sales_team_beneficiary_payout_checks_v1","sales_team_beneficiary_payout_observations_v1","sales_team_beneficiary_payout_reads_v1"]){
  await denied(()=>db.exec(`delete from ${table}`));await denied(()=>db.exec(`insert into ${table} select * from ${table}`));
 }
 await denied(()=>db.exec("update sales_team_bank_observation_policy_v1 set enabled=false"));await db.exec("reset role");
 await denied(()=>db.exec("delete from sales_team_beneficiary_payout_observations_v1"));
 const rows=(await db.query("select prosecdef,proconfig from pg_proc where proname in ('begin_sales_team_beneficiary_payout_check_v1','complete_sales_team_beneficiary_payout_check_v1') order by proname")).rows;
 expect(rows).toEqual(Array.from({length:2},()=>({prosecdef:true,proconfig:["search_path=pg_catalog"]})));
});
test("contract body or ACL drift invalidates the reviewed observation contract",async()=>{
 await setup();await db.exec("grant execute on function public.begin_sales_team_beneficiary_payout_check_v1(uuid,uuid,text,jsonb) to authenticated");
 await expect(begin()).rejects.toThrow(/AUTHORITY/);expect(h.raw).not.toHaveBeenCalled();
});
test("provider failure retains the check and never retries or creates bank receipt",async()=>{
 await setup();h.raw.mockRejectedValue(Error("fixture provider unavailable"));await expect(h.observe()).rejects.toThrow(/unavailable/);
 expect(h.raw).toHaveBeenCalledTimes(1);expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(0);expect(await count("sales_team_beneficiary_payout_checks_v1")).toBe(1);
});
test("a busy bridge admits no provider reads",async()=>{
 await setup();await begin();expect(await h.observe(id(501))).toEqual({status:"busy",bankConfirmed:false});expect(h.raw).not.toHaveBeenCalled();
});
test("a later transfer reversal prevents another fresh unreversed observation",async()=>{
 await setup();h.transfer.amount_reversed=1;await expect(h.observe()).rejects.toThrow(/reconciliation/);expect(await count("sales_team_beneficiary_payout_observations_v1")).toBe(0);
});
test("a substituted admission source is rejected before provider transport",async()=>{
 await setup();const original=h.rpc.getMockImplementation()!;
 h.rpc.mockImplementation(async(name,args)=>{const r=await original(name,args);if(name==="begin_sales_team_beneficiary_payout_check_v1"&&r.data)r.data.source.request.id=id(999);return r;});
 await expect(h.observe()).rejects.toThrow(/source changed/);expect(h.raw).not.toHaveBeenCalled();
});
test("changed provider context prevents database admission",async()=>{
 await setup();const c={...h.c,observeContext:async()=>({...h.c.context,platformAccountId:"acct_foreign"})};
 await expect(observeTeamBeneficiaryPayout(c,{checkId:id(500),requestId:h.q.id,payoutId:h.payout.id})).rejects.toThrow(/context changed/);
 expect(h.rpc).not.toHaveBeenCalled();expect(h.raw).not.toHaveBeenCalled();
});
test("a delayed admitted read drains and cannot consume an expired observation",async()=>{
 await setup();const raw=h.raw.getMockImplementation()!;let settled=false;
 h.raw.mockImplementation(async(...args)=>{const value=await raw(...args);jest.spyOn(Date,"now").mockReturnValue(Date.now()+85000);settled=true;return value;});
 await expect(h.observe()).rejects.toThrow();expect(settled).toBe(true);expect(h.raw).toHaveBeenCalledTimes(1);
 expect(h.rpc.mock.calls.some(([name])=>name==="complete_sales_team_beneficiary_payout_check_v1")).toBe(false);
});
test.each(["parent","late_grant"])("%s installation failure rolls back every new observation object",async fault=>{
 const local=createLocalPostgres();try{
  await signedSurplusDatabase(local);
  if(fault==="late_grant")await local.exec(readFileSync("supabase/migrations/20261029171329_sales_team_daily_surplus.sql","utf8"));
  let sql=readFileSync(candidate,"utf8");if(fault==="late_grant")sql=sql.replace(" to service_role;\ncommit;"," to absent_fixture_role;\ncommit;");
  await expect(local.exec(sql)).rejects.toThrow(fault==="parent"?/does not exist/:/absent_fixture_role/);await local.exec("rollback");
  expect((await local.query("select to_regclass('public.sales_team_bank_observation_policy_v1') policy,to_regclass('public.sales_team_beneficiary_payout_checks_v1') checks,to_regclass('public.sales_team_beneficiary_payout_observations_v1') observations")).rows).toEqual([{policy:null,checks:null,observations:null}]);
 }finally{await local.close();}
},60000);
