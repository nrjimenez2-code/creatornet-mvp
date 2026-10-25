/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {inspectTeamReceiptFinancials,reviewTeamRefundResponsibility} from "@/lib/salesTeams/financialChecks";
import {reserveTeamEarnedTransfer,type TeamTransferRequest} from "@/lib/salesTeams/transferReservations";
import {dispatchTeamEarnedTransfer} from "@/lib/salesTeams/transferExecution";
import {observeTeamBoundTransferReversal} from "@/lib/salesTeams/transferReversalObservations";
import {readTeamBoundTransferReversal,type TeamTransferReversalOriginal} from "@/lib/salesTeams/transferReversalReadback";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {teamTransferReversalObservationsReady,teamTransferExecutionReady} from "@/lib/salesTeams/policy";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261024210829_sales_team_transfer_reversal_observations.sql";
const predecessors=[sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql","supabase/migrations/20261023180144_sales_team_transfer_reservations.sql","supabase/migrations/20261023182527_sales_team_transfer_observations.sql","supabase/migrations/20261023184139_sales_team_transfer_execution.sql","supabase/migrations/20261023190044_sales_team_automatic_settlement.sql"];
type Run={runId:string;leaseToken:string};
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,q:TeamTransferRequest,operationId:string,run:Run,raw:jest.Mock;
let transfer:Record<string,unknown>,reversal:Record<string,unknown>,returned:Record<string,unknown>,values:Record<string,Record<string,unknown>>,advanceClock:(ms:number)=>Promise<void>;
const realNow=Date.now.bind(Date);let clockOffset=0;
beforeAll(async()=>{db=createLocalPostgres();advanceClock=await installTeamLocalClock(db);await sharedCashDatabase(db);for(const path of [...predecessors,candidate,"supabase/migrations/20261024213841_sales_team_transfer_recovery_reservations.sql","supabase/migrations/20261024215948_sales_team_transfer_recovery_execution.sql"])await db.exec(readFileSync(path,"utf8"));},30000);
beforeEach(async()=>{clockOffset=0;await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
async function advanceBy(ms:number){clockOffset+=ms;jest.spyOn(Date,"now").mockImplementation(()=>realNow()+clockOffset);await advanceClock(clockOffset);}
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function fixture(beneficiary:"creator"|"closer"="creator",fee=12){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,settlement_enabled=true,transfer_reservations_enabled=true,transfer_observations_enabled=true,transfer_execution_enabled=true,transfer_reversal_observations_enabled=true");
 f=await seedTeamCapture(db);f.base.balance.available_on=Math.floor(Date.now()/1000);f.base.balance.status="available";receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,transfer_reversal_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic original reversal observer fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 values={};let sequence=0;
 raw=jest.fn(async(method:string,path:string,params:unknown,options:Record<string,unknown>)=>{
  if(method==="POST"){if(path!=="/v1/transfers"||options.idempotencyKey!==`cn-team-v1:${q.operation_id}`||JSON.stringify(params)!==JSON.stringify(q.request.params))throw Error("Only original fixture transfer is allowed");return JSON.parse(JSON.stringify({...transfer,lastResponse:{requestId:"req_transferPost"}}));}
  if(method!=="GET")throw Error("Original reversal observation permits GET only");
  const value=values[path]??(path==="/v1/balance"?teamCashBalanceFixture:path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:["/v1/refunds","/v1/disputes"].includes(path)?{object:"list",data:[],has_more:false}:null);
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_return${++sequence}`}}));
 });
 const base=teamSupabaseFixture(db),admin={rpc:async(name:string,args:Record<string,unknown>)=>{await db.exec("savepoint reversal_rpc");const result=await base.rpc(name,args);if(result.error)await db.exec("rollback to savepoint reversal_rpc");await db.exec("release savepoint reversal_rpc");return result;}} as unknown as TeamReceiptComposition["admin"];
 c={admin,context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
 if(beneficiary==="closer"){await advanceBy(15*86400000);await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()");}
 await inspectTeamReceiptFinancials(c,receiptId,id(29));const original=await f.rpc<Run>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 q=await reserveTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:id(81),receiptId,beneficiary});const stamp=Math.floor(Date.now()/1000);
 transfer={object:"transfer",id:"tr_original",amount:Number(q.amount_cents),currency:"usd",amount_reversed:0,reversed:false,livemode:false,created:stamp,destination:q.destination_id,destination_payment:"py_original",source_transaction:q.chargeId,source_type:"card",transfer_group:`cn_team_${q.sale_id}`,metadata:q.request.params.metadata,balance_transaction:"txn_transfer",reversals:{object:"list",data:[],has_more:false,total_count:0,url:"/v1/transfers/tr_original/reversals"}};
 values["/v1/transfers/tr_original"]=transfer;values["/v1/balance_transactions/txn_transfer"]={object:"balance_transaction",id:"txn_transfer",source:"tr_original",type:"transfer",reporting_category:"transfer",balance_type:"payments",currency:"usd",exchange_rate:null,amount:-Number(q.amount_cents),fee:0,net:-Number(q.amount_cents),fee_details:[],created:stamp,available_on:stamp,status:"available"};
 expect(await dispatchTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:q.id,checkId:id(85)},true)).toMatchObject({completed:true});
 const scope:TeamOperationScope={scopeId:id(91),scopeKey:"recovery:v1",kind:"reversal",saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:original.runId};operationId=teamOperationId(scope);
 const request={apiVersion:q.request.apiVersion,method:"POST",path:"/v1/transfers/tr_original/reversals",params:{amount:100,metadata:{team_protocol:"creatornet-team-recovery-v1",team_sale_id:q.sale_id,team_receipt_id:q.receipt_id,team_transfer_request_id:q.id,team_recovery_request_id:id(91),team_provider_operation_id:operationId,team_beneficiary:beneficiary}}};
 // Structural fixture of an already-admitted bound original, not new reversal
 // admission proof. F29 never claims or dispatches this provider operation.
 await db.query("insert into sales_team_provider_operations_v1(id,scope_id,scope_key,kind,sale_id,creator_id,worker_run_id,context,request,idempotency_key,status,first_dispatch_at,provider_id,provider_request_id,bound_at) values($1,$2,'recovery:v1','reversal',$3,$4,$5,$6,$7,$8,'bound',clock_timestamp(),'trr_original','req_reversalPost',clock_timestamp())",[operationId,id(91),q.sale_id,q.creator_id,original.runId,c.context,request,`cn-team-v1:${operationId}`]);
 transfer.amount_reversed=100;reversal={object:"transfer_reversal",id:"trr_original",transfer:"tr_original",amount:100,currency:"usd",created:stamp,metadata:request.params.metadata,balance_transaction:"txn_return",source_refund:null,destination_payment_refund:"pyr_original"};
 returned={object:"balance_transaction",id:"txn_return",source:"trr_original",type:"transfer_refund",reporting_category:"transfer_reversal",balance_type:"payments",currency:"usd",exchange_rate:null,amount:100,fee,net:100-fee,fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[],created:stamp,available_on:stamp,status:"available"};
 values["/v1/transfers/tr_original/reversals/trr_original"]=reversal;values["/v1/balance_transactions/txn_return"]=returned;
 transfer.reversals={object:"list",data:[reversal],has_more:false,total_count:1,url:"/v1/transfers/tr_original/reversals"};
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[original.runId]);
 run=await f.rpc<Run>("claim_sales_team_reversal_observation_run_v1",[id(100),c.context]);raw.mockClear();
}
const observe=(checkId=id(105),taskId=id(102))=>observeTeamBoundTransferReversal(c,{...run,taskId,operationId,checkId});
const begin=(checkId=id(105),taskId=id(102))=>f.rpc<{original:TeamTransferReversalOriginal}>("begin_sales_team_reversal_check_v1",[run.runId,run.leaseToken,c.context,taskId,operationId,checkId]);
const proof=async()=>readTeamBoundTransferReversal(c,(await begin()).original);
const complete=(p:unknown)=>f.rpc("complete_sales_team_reversal_check_v1",[run.runId,run.leaseToken,c.context,id(102),id(105),p]);

test("the reversal observer is independently default off and its actual cost reserve has no default",async()=>{
 expect((await db.query("select transfer_reversal_observations_enabled from sales_team_controls_v1")).rows).toEqual([{transfer_reversal_observations_enabled:false}]);expect((await db.query("select transfer_reversal_cost_reserve_cents from sales_team_cash_policy_v1")).rows).toEqual([{transfer_reversal_cost_reserve_cents:null}]);
});
test("a bound original return records principal, real creator cost and audit once with GETs only",async()=>{
 await fixture();expect(await observe()).toMatchObject({completed:true,recorded:true,returnedPrincipalCents:100,actualTransferReversalCostCents:12});expect(raw).toHaveBeenCalledTimes(6);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect((await db.query("select creator_reversed_cents::int principal,actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{principal:100,fee:12}]);
 expect((await db.query("select entry_kind,amount_cents::int amount from sales_team_financial_ledger_v1 where entry_kind='transfer_reversal'")).rows).toEqual([{entry_kind:"transfer_reversal",amount:-100}]);
 raw.mockClear();expect(await observe()).toMatchObject({completed:true,recorded:false});expect(raw).not.toHaveBeenCalled();await db.exec("set constraints all immediate");
});
test("closer principal returns to its own accepted relationship while its creator bears actual cost",async()=>{
 await fixture("closer");await db.exec("update sales_team_memberships_v1 set status='removed'");expect(await observe()).toMatchObject({completed:true,recorded:true});
 expect((await db.query("select reversed_cents::int principal from sales_team_commission_balances_v1")).rows).toEqual([{principal:100}]);expect((await db.query("select creator_reversed_cents::int principal,actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{principal:0,fee:12}]);
});
test("cost survives recomputation and shared Library accounting before or after return",async()=>{
 await fixture();await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receiptId]);await observe();await inspectTeamReceiptFinancials(c,receiptId,id(29));
 expect((await db.query("select actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{fee:12}]);expect((await db.query("select team_transfer_cost_cents::int fee from payment_fee_ledger where sales_team_receipt_id is not null")).rows).toEqual([{fee:12}]);
 const statement=await f.rpc<{bankPayoutStatus:string}>("read_sales_team_statement_v1",[id(1),id(1),null,20]);expect(statement.bankPayoutStatus).toBe("not_recorded");
});
test("service callers can consume proof but cannot fabricate immutable facts",async()=>{
 await fixture();await db.exec("set role service_role");expect(await observe()).toMatchObject({recorded:true});
 for(const table of ["sales_team_transfer_reversal_runs_v1","sales_team_transfer_reversal_checks_v1","sales_team_transfer_reversal_completions_v1","sales_team_transfer_reversal_costs_v1"]){await denied(()=>db.exec(`insert into ${table} default values`),/permission denied/i);await denied(()=>db.exec(`delete from ${table}`),/permission denied/i);}
});
test.each(["anon","authenticated"])("%s cannot claim the observer, read its source or consume proof",async role=>{
 await fixture();await db.exec(`set role ${role}`);await denied(()=>observe(),/permission denied/i);await denied(()=>db.exec("select * from sales_team_transfer_reversal_checks_v1"),/permission denied/i);await denied(()=>f.rpc("claim_sales_team_reversal_observation_run_v1",[id(101),c.context]),/permission denied/i);
});
test.each(["token","task","context","expiry","digest"])("changed %s cannot complete or mutate the original return",async change=>{
 await fixture();const p=await proof();if(change==="expiry")await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);if(change==="digest")await db.exec("update sales_team_cash_policy_v1 set transfer_contract_sha256=repeat('0',64)");
 await denied(()=>f.rpc("complete_sales_team_reversal_check_v1",[run.runId,change==="token"?id(103):run.leaseToken,change==="context"?{...c.context,mode:"live"}:c.context,change==="task"?id(104):id(102),id(105),p]),/CURRENT_.*REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);
});

test("new-money-off and loss of the original human's admin role preserve actual-worker original observation",async()=>{
 await fixture();await db.exec("update sales_team_controls_v1 set new_sales_enabled=false,settlement_enabled=false,transfer_reservations_enabled=false,transfer_execution_enabled=false;update profiles set role=null");
 expect(await observe()).toMatchObject({completed:true,recorded:true});expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect((await db.query("select worker_run_id from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{worker_run_id:run.runId}]);
});

test.each(["amount","transfer_destination","transfer_balance","transfer_created","aggregate","reversal","key","metadata","balance_owner","balance_amount","balance_fee","balance_net","balance_type","balance_available","duplicate_request","context","stale","private"])("invalid %s proof cannot credit principal or cost",async change=>{
 await fixture();const p=await proof();
 if(change==="amount")p.reversal.amountCents=101;if(change==="transfer_destination")p.transfer.destinationId="acct_foreign";if(change==="transfer_balance")p.transfer.balanceId="txn_foreign";if(change==="transfer_created")p.transfer.created--;
 if(change==="aggregate")p.transfer.amountReversedCents=0;if(change==="reversal")p.reversal.id="trr_foreign";if(change==="key")p.idempotencyKey="foreign";if(change==="metadata")p.reversal.metadata={};
 if(change==="balance_owner")p.balance.sourceId="trr_foreign";if(change==="balance_amount")p.balance.amountCents=101;if(change==="balance_fee")p.balance.feeDetails=[];if(change==="balance_net")p.balance.netCents=100;if(change==="balance_type")(p.balance as unknown as Record<string,unknown>).balanceType="issuing";
 if(change==="balance_available")p.balance.availableOn=Math.floor(Date.now()/1000)+1;if(change==="duplicate_request")p.reversalReadRequestIds[0]=p.transferReadRequestIds[0];if(change==="context")p.context={...c.context,mode:"live"};if(change==="stale")p.readStartedAt-=30000;
 if(change==="private")(p as unknown as Record<string,unknown>).private="synthetic private provider field";
 await denied(()=>complete(p),/REQUIRED|DIFFERS|PRIVATE_PROVIDER_DATA/);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);expect((await db.query("select creator_reversed_cents::int principal,actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{principal:0,fee:0}]);
});

test.each(["txn_original","txn_transfer"])("a balance already owned as %s cannot be reused for returned principal",async balanceId=>{
 await fixture();const p=await proof();p.reversal.balanceId=balanceId;p.balance.id=balanceId;await denied(()=>complete(p),/REVERSAL_BALANCE_ALREADY_OWNED/);
});

test("once recorded, return ownership also prevents later financial/shared/transfer claims",async()=>{
 await fixture();await observe();
 await denied(()=>db.query("insert into sales_team_financial_balance_entries_v1(transaction_id,receipt_id,identity,check_id) values('txn_return',$1,'{}',(select id from sales_team_financial_checks_v1 limit 1))",[receiptId]),/REVERSAL_BALANCE_ALREADY_OWNED/);
 await denied(()=>db.exec("insert into sales_team_shared_cash_balance_entries_v1(transaction_id,source_kind,source_id,check_id,identity) values('txn_return','legacy_refund','fixture',gen_random_uuid(),'{}')"),/REVERSAL_BALANCE_ALREADY_OWNED/);
 await denied(()=>db.exec("insert into sales_team_transfer_completions_v1(request_id,transfer_id,balance_id,worker_run_id,proof) values(gen_random_uuid(),'tr_other','txn_return',gen_random_uuid(),'{}')"),/REVERSAL_BALANCE_ALREADY_OWNED/);
 await denied(()=>db.query("update sales_team_receipts_v1 set balance_transaction_id='txn_return' where id=$1",[receiptId]),/REVERSAL_BALANCE_ALREADY_OWNED/);
});

test.each(["overrun","missing","negative_net"])("%s cost evidence is recorded as actual creator cost and held",async change=>{
 const fee=change==="missing"?0:change==="negative_net"?150:31;await fixture("creator",fee);if(change==="missing")await db.exec("update sales_team_cash_policy_v1 set transfer_reversal_cost_reserve_cents=null");
 expect(await observe()).toMatchObject({completed:true,recorded:true,held:true,returnedPrincipalCents:100,actualTransferReversalCostCents:fee});
 expect((await db.query("select creator_reversed_cents::int principal,actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{principal:100,fee}]);expect((await db.query("select code from sales_team_financial_alerts_v1 where source_identity like 'transfer-reversal-cost:%'")).rows).toEqual([{code:"TRANSFER_COST_RESERVE_EXCEEDED"}]);
});

test("an additional unaccounted provider reversal stays held after recording only the known principal",async()=>{
 await fixture();transfer.amount_reversed=200;expect(await observe()).toMatchObject({completed:true,recorded:true,held:true,returnedPrincipalCents:100});
 await inspectTeamReceiptFinancials(c,receiptId,id(29));expect((await db.query("select creator_reversed_cents::int principal from sales_team_creator_balances_v1")).rows).toEqual([{principal:100}]);
 expect((await db.query("select creatornet_team_private.transfer_share_v1($1,'creator') share",[receiptId])).rows).toEqual([{share:null}]);expect((await db.query("select status from sales_team_financial_alerts_v1 where code='TRANSFER_REVERSAL_REVIEW_REQUIRED'")).rows).toEqual([{status:"open"}]);
});

test("observation authority cannot reserve new transfers or admit another provider POST kind",async()=>{
 await fixture();await denied(()=>f.rpc("reserve_sales_team_transfer_v1",[run.runId,run.leaseToken,c.context,id(160),id(161),receiptId,"creator",id(162)]),/REVERSAL_OBSERVATION_ONLY_RUN/);
 for(const kind of ["transfer","reversal","withdrawal","customer","intent"]){expect(await f.rpc("sales_team_operation_admitted_v1",[{scopeId:id(163),scopeKey:"fixture",kind,saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:run.runId},c.context])).toBe(false);}
 await db.exec("set role service_role");await denied(()=>f.rpc("reserve_sales_team_transfer_before_automatic_v1",[run.runId,run.leaseToken,c.context,id(160),id(161),receiptId,"creator",id(162)]),/permission denied/i);
});

test("receipt revision changed after independent reads requires a new exact check",async()=>{
 await fixture();const p=await proof();await db.exec("update sales_team_receipts_v1 set observation_revision=observation_revision+1");await denied(()=>complete(p),/CURRENT_REVERSAL_RECEIPT_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);
});

test("late failure atomically restores principal, costs, ledger, shared accounting, proof and cash epoch",async()=>{
 await fixture();await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receiptId]);const p=await proof();
 const state=()=>db.query("select (select to_jsonb(c) from sales_team_creator_balances_v1 c) creator,(select to_jsonb(b) from sales_team_commission_balances_v1 b) commission,(select to_jsonb(r) from sales_team_receipts_v1 r) receipt,(select to_jsonb(f) from payment_fee_ledger f where sales_team_receipt_id is not null) shared,(select count(*)::int from sales_team_financial_ledger_v1) ledger,(select epoch::text from sales_team_cash_epoch_v1) epoch");const before=(await state()).rows;
 await db.exec("create function public.reject_fixture_reversal_epoch() returns trigger language plpgsql as $$begin if exists(select 1 from public.payment_fee_ledger where sales_team_receipt_id is not null and team_transfer_cost_cents=12) then raise exception 'synthetic_late_reversal_failure';end if;return new;end$$;create trigger reject_fixture_reversal_epoch before update on sales_team_cash_epoch_v1 for each row execute function public.reject_fixture_reversal_epoch()");
 await denied(()=>complete(p),/synthetic_late_reversal_failure/);expect((await state()).rows).toEqual(before);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_costs_v1")).rows).toEqual([{n:0}]);
});

test("finish derives incomplete/held status and only permits outcome drain after worker expiry",async()=>{
 await fixture();await begin();await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);
 await f.rpc("finish_sales_team_reversal_observation_run_v1",[run.runId,run.leaseToken,c.context,false]);expect((await db.query("select status from sales_team_worker_runs_v1 where id=$1",[run.runId])).rows).toEqual([{status:"review_required"}]);
 await denied(()=>observe(),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
});

test("a reconciled creator refund followed by an actual return reduces only that creator's debt by actual net",async()=>{
 await fixture();const stamp=Math.floor(Date.now()/1000),refund={object:"refund",id:"re_original",charge:"ch_original",payment_intent:"pi_original",amount:1000,currency:"usd",status:"succeeded",created:stamp,balance_transaction:"txn_refund",failure_balance_transaction:null,transfer_reversal:null,source_transfer_reversal:null,metadata:{}};
 values["/v1/refunds"]={object:"list",data:[refund],has_more:false};values["/v1/refunds/re_original"]=refund;values["/v1/balance_transactions/txn_refund"]={object:"balance_transaction",id:"txn_refund",source:refund.id,type:"refund",reporting_category:"refund",balance_type:"payments",currency:"usd",exchange_rate:null,amount:-1000,fee:0,net:-1000,fee_details:[],created:stamp,available_on:stamp,status:"available"};f.base.charge.amount_refunded=1000;
 await inspectTeamReceiptFinancials(c,receiptId,id(29));const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1")).rows[0].r);await db.exec("update sales_team_controls_v1 set refund_review_enabled=true");await reviewTeamRefundResponsibility(c,{actorId:id(29),receiptId,requestId:id(140),expectedRevision:revision,refundId:refund.id,responsibility:"creator",reasonCode:"creator_discretionary"});await inspectTeamReceiptFinancials(c,receiptId,id(29));
 const debt=async()=>Number((await db.query<{n:number}>("select (creator_released_cents-creator_reversed_cents-creator_proceeds_cents)::int n from sales_team_creator_balances_v1")).rows[0].n),before=await debt();expect(before).toBeGreaterThan(100);
 expect(await observe()).toMatchObject({held:true,recorded:true});expect(await debt()).toBe(before-100+12);expect((await db.query("select creator_id from sales_team_transfer_reversal_costs_v1")).rows).toEqual([{creator_id:q.creator_id}]);
});

async function extraOriginal(n:number,amount=100){
 const scope:TeamOperationScope={scopeId:id(200+n),scopeKey:"recovery:v1",kind:"reversal",saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:q.original_worker_run_id},opId=teamOperationId(scope);
 const saved=(await db.query<{request:Record<string,unknown>&{params:{amount:number;metadata:Record<string,string>}}}>("select request from sales_team_provider_operations_v1 where id=$1",[operationId])).rows[0].request;
 saved.params.amount=amount;saved.params.metadata.team_recovery_request_id=scope.scopeId;saved.params.metadata.team_provider_operation_id=opId;
 const providerId=`trr_extra${n}`,providerRequestId=`req_extraPost${n}`;
 await db.query("insert into sales_team_provider_operations_v1(id,scope_id,scope_key,kind,sale_id,creator_id,worker_run_id,context,request,idempotency_key,status,first_dispatch_at,provider_id,provider_request_id,bound_at) values($1,$2,'recovery:v1','reversal',$3,$4,$5,$6,$7,$8,'bound',clock_timestamp(),$9,$10,clock_timestamp())",[opId,scope.scopeId,q.sale_id,q.creator_id,q.original_worker_run_id,c.context,saved,`cn-team-v1:${opId}`,providerId,providerRequestId]);
 const stamp=Math.floor(Date.now()/1000),nextReversal={...reversal,id:providerId,amount,created:stamp,metadata:saved.params.metadata,balance_transaction:`txn_extra${n}`},nextBalance={...returned,id:`txn_extra${n}`,source:providerId,amount,fee:0,net:amount,fee_details:[],created:stamp,available_on:stamp};
 values[`/v1/transfers/tr_original/reversals/${providerId}`]=nextReversal;values[`/v1/balance_transactions/txn_extra${n}`]=nextBalance;
 return {operationId:opId,checkId:id(250+n),taskId:id(260+n)};
}

test("a run accepts at most three immutable original checks and replays only their exact task identities",async()=>{
 await fixture();await begin();
 for(let n=1;n<=2;n++){const next=await extraOriginal(n);await f.rpc("begin_sales_team_reversal_check_v1",[run.runId,run.leaseToken,c.context,next.taskId,next.operationId,next.checkId]);}
 const fourth=await extraOriginal(3);await denied(()=>f.rpc("begin_sales_team_reversal_check_v1",[run.runId,run.leaseToken,c.context,fourth.taskId,fourth.operationId,fourth.checkId]),/REVERSAL_TASK_LIMIT_REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_checks_v1")).rows).toEqual([{n:3}]);expect((await begin()).original.id).toBe(id(91));await denied(()=>begin(id(105),id(170)),/ORIGINAL_REVERSAL_CHECK_CHANGED/);
});

test("two distinct real-return proofs accumulate principal once without crediting the same balance twice",async()=>{
 await fixture();await observe();const next=await extraOriginal(1);transfer.amount_reversed=200;transfer.reversals={object:"list",data:[],has_more:true,url:"/v1/transfers/tr_original/reversals"};
 expect(await observeTeamBoundTransferReversal(c,{...run,...next})).toMatchObject({recorded:true,returnedPrincipalCents:100,actualTransferReversalCostCents:0});
 expect((await db.query("select creator_reversed_cents::int principal,actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{principal:200,fee:12}]);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:2}]);
});

test("conflicting structural originals cannot exceed the original transferred principal cumulatively",async()=>{
 await fixture("closer");await observe();const next=await extraOriginal(1,Number(q.amount_cents));transfer.amount_reversed=Number(q.amount_cents);transfer.reversed=true;
 await denied(()=>observeTeamBoundTransferReversal(c,{...run,...next}),/ORIGINAL_REVERSAL_PRINCIPAL_CAP_REQUIRED/);
 expect((await db.query("select reversed_cents::int principal from sales_team_commission_balances_v1")).rows).toEqual([{principal:100}]);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:1}]);
});

test("the 15-minute original observation slot is consumed once and finished workers cannot complete checks",async()=>{
 await fixture();await observe();await f.rpc("finish_sales_team_reversal_observation_run_v1",[run.runId,run.leaseToken,c.context,false]);expect((await db.query("select status from sales_team_worker_runs_v1 where id=$1",[run.runId])).rows).toEqual([{status:"complete"}]);
 await extraOriginal(1);expect(await f.rpc("claim_sales_team_reversal_observation_run_v1",[id(101),c.context])).toMatchObject({status:"slot_consumed"});await denied(()=>observe(),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 await advanceBy(16*60000);expect(await f.rpc("claim_sales_team_reversal_observation_run_v1",[id(101),c.context])).toMatchObject({status:"claimed"});
});

test("source readiness is independently default off without enabling new transfer execution",()=>{
 const base={CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY:"true",CREATOR_TEAM_PAYMENT_SCHEMA_READY:"true",CREATOR_TEAM_RECEIPT_SCHEMA_READY:"true",CREATOR_TEAM_EVENT_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_SCHEMA_READY:"true",CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY:"true",CREATOR_TEAM_CASH_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_OBSERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_OBSERVATIONS_READY:"true"};
 expect(teamTransferReversalObservationsReady(base)).toBe(false);const ready={...base,CREATOR_TEAM_TRANSFER_REVERSAL_OBSERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_REVERSAL_OBSERVATIONS_READY:"true"};expect(teamTransferReversalObservationsReady(ready)).toBe(true);expect(teamTransferExecutionReady(ready)).toBe(false);
});

test.each(["cost_source","late_grant"])("migration %s failure preserves the previous cost/authority definitions and grants",async change=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  for(const path of predecessors)await isolated.exec(readFileSync(path,"utf8"));
  if(change==="cost_source"){
   const src=(await isolated.query<{s:string}>("select pg_get_functiondef('creatornet_team_private.transfer_cost_total_v1(uuid)'::regprocedure) s")).rows[0].s;await isolated.exec(src.replace("coalesce(sum(cost.fee_cents),0)","coalesce(sum(cost.fee_cents),1)"));
  }
  const state=()=>isolated.query("select pg_get_functiondef('creatornet_team_private.transfer_cost_total_v1(uuid)'::regprocedure) cost,pg_get_functiondef('public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid)'::regprocedure) reserve,has_function_privilege('service_role','public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid)','execute') allowed");const before=(await state()).rows;
  const source=readFileSync(candidate,"utf8"),sql=change==="late_grant"?source.replace("commit;","grant execute on function public.missing_reversal_observation_final_grant() to service_role;commit;"):source;
  await expect(isolated.exec(sql)).rejects.toThrow(change==="late_grant"?/missing_reversal_observation_final_grant/:/REVERSAL_TRANSFER_COST_DEPENDENCY_DIFFERS/);await isolated.exec("rollback");expect((await state()).rows).toEqual(before);
  expect((await isolated.query("select to_regclass('public.sales_team_transfer_reversal_completions_v1') relation,to_regprocedure('creatornet_team_private.guard_reversal_balance_owner_v1()') helper")).rows).toEqual([{relation:null,helper:null}]);
 }finally{await isolated.close();}
},30000);

test("the exact owner guard is covered by transfer, shared, retained and recovery reviewed digests",async()=>{
 await fixture();const hashes=()=>db.query("select creatornet_team_private.transfer_contract_digest_v1() transfer,creatornet_team_private.shared_cash_contract_digest_v1() shared,creatornet_team_private.retained_cash_contract_digest_v1() retained,creatornet_team_private.recovery_contract_digest_v1() recovery");const before=(await hashes()).rows[0] as Record<string,string>;
 const source=(await db.query<{s:string}>("select pg_get_functiondef('creatornet_team_private.guard_reversal_balance_owner_v1()'::regprocedure) s")).rows[0].s;
 await db.exec(source.replace("REVERSAL_BALANCE_ALREADY_OWNED","synthetic_changed_owner_guard"));const after=(await hashes()).rows[0] as Record<string,string>;
 for(const key of ["transfer","shared","retained","recovery"])expect(after[key]).not.toBe(before[key]);await denied(()=>observe(),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);expect(raw).not.toHaveBeenCalled();
});

test("authority expiring during check creation cannot leave an admitted observation task",async()=>{
 await fixture();await db.exec("create function public.expire_fixture_reversal_check() returns trigger language plpgsql as $$begin update public.sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=new.worker_run_id;return new;end$$;create trigger expire_fixture_reversal_check before insert on sales_team_transfer_reversal_checks_v1 for each row execute function public.expire_fixture_reversal_check()");
 await denied(()=>begin(),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_checks_v1")).rows).toEqual([{n:0}]);
});

test("authority expiring during principal admission cannot commit late reversal accounting",async()=>{
 await fixture();const p=await proof();await db.exec("create function public.expire_fixture_reversal_completion() returns trigger language plpgsql as $$begin update public.sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=new.worker_run_id;return new;end$$;create trigger expire_fixture_reversal_completion before insert on sales_team_transfer_reversal_completions_v1 for each row execute function public.expire_fixture_reversal_completion()");
 await denied(()=>complete(p),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);expect((await db.query("select creator_reversed_cents::int n from sales_team_creator_balances_v1")).rows).toEqual([{n:0}]);
});
