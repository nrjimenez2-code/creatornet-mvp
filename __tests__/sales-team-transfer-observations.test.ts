/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import {inspectTeamReceiptFinancials} from "@/lib/salesTeams/financialChecks";
import {reserveTeamEarnedTransfer,type TeamTransferRequest} from "@/lib/salesTeams/transferReservations";
import {observeTeamAdmittedTransfer} from "@/lib/salesTeams/transferObservations";
import {readTeamBoundTransfer} from "@/lib/salesTeams/transferReadback";
import {teamTransferObservationsReady} from "@/lib/salesTeams/policy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261023182527_sales_team_transfer_observations.sql";
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,raw:jest.Mock,q:TeamTransferRequest,run:{runId:string;leaseToken:string};
let transfer:Record<string,unknown>,balance:Record<string,unknown>,events:Record<string,unknown>[];
beforeAll(async()=>{db=await sharedCashDatabase(createLocalPostgres());for(const path of [sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql","supabase/migrations/20261023180144_sales_team_transfer_reservations.sql",candidate])await db.exec(readFileSync(path,"utf8"));},30000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");});afterAll(async()=>{await db?.close();});
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function fixture(unknown=false,fee=12,beneficiary:"creator"|"closer"="creator"){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,settlement_enabled=true,transfer_reservations_enabled=true,transfer_observations_enabled=true");
 f=await seedTeamCapture(db);const stamp=Math.floor(Date.now()/1000);f.base.balance.available_on=stamp;f.base.balance.status="available";receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic transfer observation fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 let sequence=0;raw=jest.fn(async(method:string,path:string)=>{if(method!=="GET")throw Error("Observation fixture permits GET only");
  const value=path==="/v1/balance"?teamCashBalanceFixture:path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:["/v1/refunds","/v1/disputes"].includes(path)?{object:"list",data:[],has_more:false}:path==="/v1/transfers/tr_original"?transfer:path==="/v1/balance_transactions/txn_transfer"?balance:path==="/v1/events"?{object:"list",data:events,has_more:false}:null;
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_observation${++sequence}`}}));});
 c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
 await inspectTeamReceiptFinancials(c,receiptId,id(29));
 if(beneficiary==="closer")await db.exec("update sales_team_receipts_v1 set paid_at=clock_timestamp()-interval '15 days';update sales_team_commission_balances_v1 b set hold_until=r.paid_at+interval '14 days' from sales_team_receipts_v1 r where r.id=b.receipt_id");
 run=await f.rpc("claim_sales_team_settlement_run_v1",[id(80),c.context]);q=await reserveTeamEarnedTransfer(c,{...run,taskId:id(82),requestId:id(81),receiptId,beneficiary});
 const journal=await f.rpc<{operation:{lease_token:string}}>("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request]);
 if(unknown)await f.rpc("mark_sales_team_provider_unknown_v1",[q.operation_id,journal.operation.lease_token]);else await f.rpc("bind_sales_team_provider_operation_v1",[q.operation_id,"tr_original","req_originalPost",false]);
 transfer={id:"tr_original",object:"transfer",amount:Number(q.amount_cents),amount_reversed:0,balance_transaction:"txn_transfer",created:stamp,currency:"usd",destination:q.destination_id,destination_payment:"py_destination",livemode:false,metadata:q.request.params.metadata,reversed:false,reversals:{object:"list",data:[],has_more:false,total_count:0,url:"/v1/transfers/tr_original/reversals"},source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${q.sale_id}`};
 balance={id:"txn_transfer",object:"balance_transaction",source:"tr_original",type:"transfer",reporting_category:"transfer",balance_type:"payments",currency:"usd",amount:-Number(q.amount_cents),fee,net:-Number(q.amount_cents)-fee,exchange_rate:null,created:stamp,available_on:stamp,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]};
 events=[{id:"evt_original",object:"event",type:"transfer.created",account:null,livemode:false,created:stamp,request:{id:"req_originalPost",idempotency_key:`cn-team-v1:${q.operation_id}`},data:{object:transfer}}];raw.mockClear();
}
const observe=(checkId=id(85))=>observeTeamAdmittedTransfer(c,{...run,taskId:id(82),requestId:q.id,checkId});
test("the actual observation candidate installs default off",async()=>{expect((await db.query("select transfer_observations_enabled from sales_team_controls_v1")).rows).toEqual([{transfer_observations_enabled:false}]);});
test("bound original transfer and fees update released accounting once while bank status remains unrecorded",async()=>{
 await fixture();expect(await observe()).toMatchObject({completed:true,recorded:true,actualTransferCostCents:12});
 expect((await db.query("select creator_released_cents::int released,actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{released:Number(q.amount_cents),fee:12}]);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:0}]);
 expect((await db.query("select count(*)::int n from sales_team_transfer_completions_v1")).rows).toEqual([{n:1}]);
 const statement=await f.rpc<{bankPayoutStatus:string;entries:{creatorAccounting:{actualTransferCostCents:number}}[]}>("read_sales_team_statement_v1",[id(1),id(1),null,20]);expect(statement.bankPayoutStatus).toBe("not_recorded");expect(statement.entries[0].creatorAccounting.actualTransferCostCents).toBe(12);
 raw.mockClear();expect(await observe()).toMatchObject({completed:true,recorded:false});expect(raw).not.toHaveBeenCalled();
 expect((await db.query("select count(*)::int n from sales_team_financial_ledger_v1 where entry_kind='transfer'")).rows).toEqual([{n:1}]);
});
test("an uncertain original binds only after its original event proof and never repeats the POST",async()=>{
 await fixture(true);expect(await observe()).toMatchObject({completed:true,recorded:true});expect((await db.query("select provider_id from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{provider_id:"tr_original"}]);
 expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_proofs_v1")).rows).toEqual([{n:1}]);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});
const begin=(checkId=id(85))=>f.rpc<{request:TeamTransferRequest}>("begin_sales_team_transfer_check_v1",[run.runId,run.leaseToken,c.context,id(82),q.id,checkId]);
const proof=async()=>readTeamBoundTransfer(c,(await begin()).request);
const complete=(p:unknown,checkId=id(85))=>f.rpc("complete_sales_team_transfer_check_v1",[run.runId,run.leaseToken,c.context,id(82),checkId,p]);
test("actual creator transfer cost survives later independent financial recomputation and shared accounting sync",async()=>{
 await fixture();await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receiptId]);await observe();const before=(await db.query("select creator_proceeds_cents,actual_processing_cost_cents,actual_transfer_cost_cents from sales_team_creator_balances_v1")).rows;
 await inspectTeamReceiptFinancials(c,receiptId,id(29));expect((await db.query("select creator_proceeds_cents,actual_processing_cost_cents,actual_transfer_cost_cents from sales_team_creator_balances_v1")).rows).toEqual(before);
 expect((await db.query("select team_transfer_cost_cents::int fee from payment_fee_ledger where sales_team_receipt_id is not null")).rows).toEqual([{fee:12}]);
 expect((await db.query("select sum(amount_cents)::int n from sales_team_financial_ledger_v1 where entry_kind='payout_cost'")).rows).toEqual([{n:12}]);
});
test("actual costs above the original allowance are accounted, alert and hold further new transfers",async()=>{
 await fixture(false,31);expect(await observe()).toMatchObject({completed:true,recorded:true,held:true,actualTransferCostCents:31});
 expect((await db.query("select code from sales_team_financial_alerts_v1 where code='TRANSFER_COST_RESERVE_EXCEEDED'")).rows).toEqual([{code:"TRANSFER_COST_RESERVE_EXCEEDED"}]);
 expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:true}]);
 expect((await db.query("select creatornet_team_private.transfer_share_v1($1,'creator') share",[receiptId])).rows).toEqual([{share:null}]);
});
test("a structural matured-commission fixture credits only the closer and allocates the actual cost to its creator",async()=>{
 await fixture(false,12,"closer");expect(await observe()).toMatchObject({completed:true,recorded:true});
 expect((await db.query("select released_cents::int released from sales_team_commission_balances_v1")).rows).toEqual([{released:Number(q.amount_cents)}]);
 expect((await db.query("select creator_released_cents::int released,actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{released:0,fee:12}]);
 expect((await db.query("select creator_id from sales_team_transfer_costs_v1")).rows).toEqual([{creator_id:id(1)}]);
});
test("service callers can use the narrow verified consumer but cannot insert its immutable facts",async()=>{
 await fixture(true);await db.exec("set role service_role");expect(await observe()).toMatchObject({completed:true,recorded:true});
 await denied(()=>db.exec("insert into sales_team_transfer_costs_v1(request_id,receipt_id,creator_id,balance_id,fee_cents) select request_id,receipt_id,creator_id,'txn_fake',0 from sales_team_transfer_costs_v1"),/permission denied/i);
 await denied(()=>db.exec("delete from sales_team_transfer_completions_v1"),/permission denied/i);
 await denied(()=>f.rpc("bind_sales_team_operation_before_transfer_proof_v1",[q.operation_id,"tr_fake","req_fake",true]),/permission denied/i);
});
test("ordinary roles cannot call the definer or read financial observation history",async()=>{
 await fixture();await db.exec("set role authenticated");await denied(observe,/permission denied/i);await denied(()=>db.exec("select * from sales_team_transfer_checks_v1"),/permission denied/i);
 await denied(()=>complete({}),/permission denied/i);
});
test("wrong worker tokens and expired current runs cannot record transferred principal",async()=>{
 await fixture();const p=await proof();await denied(()=>f.rpc("complete_sales_team_transfer_check_v1",[run.runId,id(86),c.context,id(82),id(85),p]),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);await denied(()=>complete(p),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_transfer_completions_v1")).rows).toEqual([{n:0}]);
});
test("a receipt changed after the observation began cannot consume the stale proof",async()=>{
 await fixture();const p=await proof();await db.exec("update sales_team_receipts_v1 set observation_revision=observation_revision+1");await denied(()=>complete(p),/CURRENT_ORIGINAL_TRANSFER_REQUIRED/);
 expect((await db.query("select creator_released_cents::int n from sales_team_creator_balances_v1")).rows).toEqual([{n:0}]);
});
test.each(["amount","destination","charge","debit_owner","debit_amount","fee","request","context","null","fraction","extra"])("a forged SQL %s proof cannot consume money or its reservation",async change=>{
 await fixture();const p:Record<string,unknown>&{transfer:Record<string,unknown>;balance:Record<string,unknown>}=JSON.parse(JSON.stringify(await proof()));
 if(change==="amount")p.transfer.amountCents=Number(q.amount_cents)+1;if(change==="destination")p.transfer.destinationId="acct_other";if(change==="charge")p.transfer.sourceChargeId="ch_other";
 if(change==="debit_owner")p.balance.sourceId="tr_other";if(change==="debit_amount")p.balance.amountCents=1;if(change==="fee")p.balance.feeDetails=[];if(change==="request")p.originalRequestId="req_other";
 if(change==="context")p.context={...c.context,platformAccountId:"acct_other"};if(change==="null")p.transfer.reversed=null;if(change==="fraction")p.balance.feeCents=0.5;if(change==="extra")p.privateProviderText="not allowed";
 await denied(()=>complete(p),/REQUIRED|CHANGED/);expect((await db.query("select count(*)::int n from sales_team_transfer_completions_v1")).rows).toEqual([{n:0}]);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:30}]);
});
test("metadata without the original event request key leaves the exact uncertain original and all cash held",async()=>{
 await fixture(true);(events[0].request as Record<string,unknown>).idempotency_key="foreign";expect(await observe()).toMatchObject({completed:false,held:true});
 expect((await db.query("select provider_id from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{provider_id:null}]);
 await denied(()=>f.rpc("bind_sales_team_provider_operation_v1",[q.operation_id,"tr_original","req_originalPost",true]),/ORIGINAL_TRANSFER_EVENT_REQUIRED/);
});
test("a new actual observation worker can recover an admitted original with new-money controls off",async()=>{
 await fixture(true);await db.exec("update sales_team_controls_v1 set settlement_enabled=false,transfer_reservations_enabled=false");
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);
 run=await f.rpc("claim_sales_team_transfer_observation_run_v1",[id(86),c.context]);expect(await observeTeamAdmittedTransfer(c,{...run,taskId:id(87),requestId:q.id,checkId:id(88)})).toMatchObject({completed:true,recorded:true});
 expect((await db.query("select original_worker_run_id from sales_team_transfer_requests_v1")).rows).toEqual([{original_worker_run_id:id(80)}]);
 expect((await db.query("select worker_run_id from sales_team_transfer_completions_v1")).rows).toEqual([{worker_run_id:id(86)}]);
});
test("source observation readiness defaults off and does not require new transfer admission",()=>{
 const env={CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY:"true",CREATOR_TEAM_PAYMENT_SCHEMA_READY:"true",CREATOR_TEAM_RECEIPT_SCHEMA_READY:"true",CREATOR_TEAM_EVENT_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_SCHEMA_READY:"true",CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY:"true",CREATOR_TEAM_CASH_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY:"true"};
 expect(teamTransferObservationsReady(env)).toBe(false);expect(teamTransferObservationsReady({...env,CREATOR_TEAM_TRANSFER_OBSERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_OBSERVATIONS_READY:"true"})).toBe(true);
});
test("fulfillment created after original transfer observation conserves the same shared principal and costs",async()=>{
 await fixture();await observe();await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receiptId]);
 expect((await db.query("select team_transfer_cost_cents::int fee,total_creator_deduction_cents+creator_net_cents=gross_amount_cents-team_loss_subtotal_cents+team_processing_credit_cents+team_creator_deficit_cents conserved from payment_fee_ledger where sales_team_receipt_id is not null")).rows).toEqual([{fee:12,conserved:true}]);
});
test("a final accounting failure rolls back unknown binding, released principal, costs and completion together",async()=>{
 await fixture(true);await db.exec("create function public.reject_transfer_accounting_fixture() returns trigger language plpgsql as $$ begin if new.entry_kind='transfer' then raise exception 'synthetic late accounting failure';end if;return new;end $$;create trigger late_transfer_failure before insert on sales_team_financial_ledger_v1 for each row execute function public.reject_transfer_accounting_fixture()");
 await denied(observe,/synthetic late accounting failure/);
 expect((await db.query("select provider_id from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{provider_id:null}]);
 expect((await db.query("select creator_released_cents::int n from sales_team_creator_balances_v1")).rows).toEqual([{n:0}]);
 for(const table of ['sales_team_transfer_completions_v1','sales_team_transfer_costs_v1','sales_team_transfer_recovery_proofs_v1'])expect((await db.query(`select count(*)::int n from ${table}`)).rows).toEqual([{n:0}]);
});
test("legacy ledger conservation is retained and legacy rows cannot absorb team transfer costs",async()=>{
 await fixture();await db.query("insert into payment_fee_ledger(id,creator_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values($1,$2,'pi_legacy','ch_legacy',1000,120,50,170,830,'usd','fixture')",[id(90),id(1)]);
 await denied(()=>db.exec("update payment_fee_ledger set team_transfer_cost_cents=1 where stripe_payment_intent_id='pi_legacy'"),/check constraint/i);
 await denied(()=>db.exec("update payment_fee_ledger set creator_net_cents=831 where stripe_payment_intent_id='pi_legacy'"),/payment_fee_ledger_split_check/);
});
test.each(["unknown_arithmetic","final_grant"])("migration %s failure preserves the complete prior cash and ledger state",async kind=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  for(const path of [sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql","supabase/migrations/20261023180144_sales_team_transfer_reservations.sql"])await isolated.exec(readFileSync(path,"utf8"));
  const original=(await isolated.query<{source:string}>("select pg_get_functiondef('public.recompute_sales_team_balances_before_shared_v1(uuid,text,jsonb)'::regprocedure) source")).rows[0].source;
  if(kind==="unknown_arithmetic")await isolated.exec(original.replace("v_aux bigint;v_creator bigint;","v_aux bigint; /* unsupported structural fixture */v_creator bigint;"));
  const before=(await isolated.query("select pg_get_constraintdef(oid) source from pg_constraint where conrelid='public.payment_fee_ledger'::regclass and conname='payment_fee_ledger_split_check'")).rows;
  const source=readFileSync(candidate,"utf8");expect(source.match(/commit;/g)).toHaveLength(1);
  await expect(isolated.exec(kind==="final_grant"?source.replace("commit;","grant execute on function public.missing_transfer_observation_final_grant() to service_role;commit;"):source)).rejects.toThrow(kind==="final_grant"?/missing_transfer_observation_final_grant/:/TRANSFER_ACCOUNTING_DEPENDENCY_DIFFERS/);
  await isolated.exec("rollback");expect((await isolated.query("select to_regclass('public.sales_team_transfer_checks_v1') relation")).rows).toEqual([{relation:null}]);
  expect((await isolated.query("select pg_get_constraintdef(oid) source from pg_constraint where conrelid='public.payment_fee_ledger'::regclass and conname='payment_fee_ledger_split_check'")).rows).toEqual(before);
  expect((await isolated.query("select count(*)::int n from pg_attribute where attrelid='public.sales_team_creator_balances_v1'::regclass and attname='actual_transfer_cost_cents' and not attisdropped")).rows).toEqual([{n:0}]);
 }finally{await isolated.close();}
},30000);
